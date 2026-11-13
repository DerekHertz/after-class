/**
 * Experiment 8, the Messages API tutor replay (docs/experiments/08-api-tutor.md is the protocol).
 *
 *   bun run scripts/experiments/api-tutor-replay.ts --db <copy of afterclass.sqlite> --since <ISO date>
 *        [--model opus|sonnet] [--cap-usd <n>] --out <dir> [--dry-run] [--keys <path>]
 *
 * It reads the stored inputs of past tutor turns and wrap-ups from `memo_inputs` in a COPY of a live database (opened
 * read-only, never written) and replays each one, in time order, through `createClaudeApi` directly. The memo is not used,
 * so nothing is cached locally and the copy is untouched. Tutor turns stream and the wrap-up is structured output.
 *
 * Every call is a live paid Messages API call, so every row is labelled live. Cost is computed from the response's usage
 * and list prices in claude-api.ts, so it is an estimate and not a bill. A call that could take the cumulative cost over
 * the cap is never made: the run stops before it and says so. `--dry-run` lists the calls and makes none, and needs no key.
 * A live run refuses to start when the database (symlinks resolved) is inside `--out` or is a file the runner writes, and when `--out`
 * already holds a results.json or results.md. It creates both result files exclusively, so an earlier run's results are never overwritten.
 *
 * What the checks cover: `validateMove` needs the original `TutorInput`, and the memo stores only its rendered system and
 * prompt text. Rebuilding it needs the review's usable claims and evidence bundle as they stood at the time of each call.
 * Those come from the preparation and evidence modules, which compute them from state a later copy of the database no
 * longer reflects, and which write to the database when they open. So the runner makes the weaker check: the reply's
 * header parses with `parseMoveHeader`, and its move kind is one of the allowed moves the stored prompt names.
 * It does not check thread ids, claim ids, evidence scope or the question counts that `validateMove` also checks.
 */
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readKeys } from "../../src/backend/main";
import type { ApiCallDetail, ApiClient } from "../../src/backend/providers/claude-api";
import { API_MODELS, STREAM_MAX_TOKENS, STRUCTURED_MAX_TOKENS, createClaudeApi, outputFormatOf, redactThenClip, worstCaseUsd } from "../../src/backend/providers/claude-api";
import type { ClaudeCli, ClaudeRequest, Effort } from "../../src/backend/providers/claude";
import { ProviderError } from "../../src/backend/providers/memo";
import { parseMoveHeader, wrapUpSchema } from "../../src/backend/review/tutor";

export const DEFAULT_KEYS_PATH = join(homedir(), ".config", "afterclass", "keys.env");
export const DEFAULT_CAP_USD = 5;
/** Exit codes: 0 done or stopped at the cap, 1 refused to start, 2 bad arguments, 4 a finished call cost more than its reservation. */
const EXIT = { overrun: 4 } as const;
/** The key a run with an injected fake client hands the adapter. */
const FAKE_CLIENT_KEY = "fake-client-key";

/** The timeouts the product's own tasks use (tutor.ts TUTOR_REQUEST and WRAP_UP_REQUEST). */
const TIMEOUT_MS = { tutor_turn: 120_000, wrap_up: 180_000 } as const;
const PURPOSES = ["tutor_turn", "wrap_up"] as const;
type Purpose = (typeof PURPOSES)[number];

export type Options = {
  readonly db: string;
  readonly sinceMs: number;
  readonly since: string;
  readonly model: "opus" | "sonnet";
  readonly capUsd: number;
  readonly out: string | null;
  readonly dryRun: boolean;
  readonly keys: string;
};

const USAGE = "usage: api-tutor-replay.ts --db <copy of afterclass.sqlite> --since <ISO date> [--model opus|sonnet] [--cap-usd <n>] --out <dir> [--dry-run] [--keys <path>]";

/** The parsed options, or a one-line reason the arguments are not usable. */
export function parseArgs(argv: readonly string[]): Options | string {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!["--db", "--since", "--model", "--cap-usd", "--out", "--keys"].includes(flag)) return `unknown argument ${flag}. ${USAGE}`;
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) return `${flag} needs a value. ${USAGE}`;
    values.set(flag, value);
  }
  const db = values.get("--db");
  if (db === undefined) return `--db is required. ${USAGE}`;
  const since = values.get("--since");
  if (since === undefined) return `--since is required. ${USAGE}`;
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return `--since must be an ISO date, got "${since}"`;
  const model = values.get("--model") ?? "opus";
  if (model !== "opus" && model !== "sonnet") return `--model must be opus or sonnet, got "${model}"`;
  const capText = values.get("--cap-usd");
  const capUsd = capText === undefined ? DEFAULT_CAP_USD : Number(capText);
  if (!Number.isFinite(capUsd) || capUsd <= 0) return `--cap-usd must be a positive number, got "${capText}"`;
  const out = values.get("--out") ?? null;
  if (out === null && !dryRun) return `--out is required unless --dry-run. ${USAGE}`;
  return { db: resolve(db), sinceMs, since, model, capUsd, out: out === null ? null : resolve(out), dryRun, keys: values.get("--keys") ?? DEFAULT_KEYS_PATH };
}

// ───────────────────────────── stored inputs ─────────────────────────────

const storedInput = z.object({ system: z.string(), prompt: z.string(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]) });

export type StoredCall = {
  readonly key: string;
  readonly purpose: Purpose;
  readonly version: string;
  readonly atMs: number;
  readonly system: string;
  readonly prompt: string;
  readonly effort: Effort;
  readonly inputBytes: number;
  /** What the CLI run of this same input reported, from `usage_events`, summed over its attempts. Null when the copy has none. */
  readonly cliNotionalUsd: number | null;
  readonly cliAttempts: number;
};

/** The tutor and wrap-up inputs first seen at or after `sinceMs`, oldest first. The database is opened read-only. */
export function loadCalls(dbPath: string, sinceMs: number): StoredCall[] {
  if (!existsSync(dbPath)) throw new Error(`--db ${dbPath} does not exist`);
  const sql = new Database(dbPath, { readonly: true });
  try {
    const rows = sql
      .query<{ key: string; purpose: Purpose; version: string; input_json: string; first_seen_ms: number }, [number]>(
        `SELECT key, purpose, version, input_json, first_seen_ms FROM memo_inputs
         WHERE purpose IN ('tutor_turn', 'wrap_up') AND first_seen_ms >= ?
         ORDER BY first_seen_ms, rowid`,
      )
      .all(sinceMs);
    const notional = sql.query<{ usd: number | null; n: number }, [string]>(
      `SELECT SUM(cost_usd) AS usd, COUNT(*) AS n FROM usage_events WHERE memo_key = ? AND cost_kind = 'notional'`,
    );
    return rows.map((row) => {
      const parsed = storedInput.safeParse((() => {
        try {
          return JSON.parse(row.input_json);
        } catch {
          return null;
        }
      })());
      if (!parsed.success) throw new Error(`memo input ${row.key} (${row.purpose}) is not a {system, prompt, effort} object: ${z.prettifyError(parsed.error)}`);
      const cli = notional.get(row.key);
      return {
        key: row.key,
        purpose: row.purpose,
        version: row.version,
        atMs: row.first_seen_ms,
        ...parsed.data,
        inputBytes: Buffer.byteLength(parsed.data.system) + Buffer.byteLength(parsed.data.prompt),
        cliNotionalUsd: cli?.usd ?? null,
        cliAttempts: cli?.n ?? 0,
      };
    });
  } finally {
    sql.close();
  }
}

/** The allowed move kinds the stored tutor prompt names on its first line, or null when it names none. */
export function allowedFromPrompt(prompt: string): readonly string[] | null {
  const line = prompt.match(/^Allowed moves this turn: (.*)$/m)?.[1];
  if (line === undefined) return null;
  const kinds = line.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return kinds.length === 0 ? null : kinds;
}

// ───────────────────────────── results ─────────────────────────────

export type Row = {
  /** Every row is a live Messages API call. */
  readonly data: "live";
  readonly n: number;
  readonly purpose: Purpose;
  readonly originalAt: string;
  readonly memoKey: string;
  readonly model: string;
  readonly effort: Effort;
  readonly inputBytes: number;
  readonly repair: boolean;
  /** First tutor turn seen with this system prompt (the review's lecture context), so a cache read is not expected on it. */
  readonly firstOfContext: boolean;
  readonly tokens: { readonly fresh: number; readonly cacheCreation: number; readonly cacheRead: number; readonly output: number } | null;
  readonly costUsd: number | null;
  readonly cliNotionalUsd: number | null;
  readonly firstTextMs: number | null;
  readonly totalMs: number;
  readonly stopReason: string | null;
  /** Tutor turns: the weaker check. Null for a wrap-up. */
  readonly header: { readonly parsed: boolean; readonly moveKind: string | null; readonly kindAllowedByPrompt: boolean | null; readonly why: string | null } | null;
  /** Wrap-up: the reply passed `wrapUpSchema`. Null for a tutor turn. */
  readonly schemaValid: boolean | null;
  readonly error: string | null;
};

/** A finished call whose measured cost was above what it was reserved at. The cap may be exceeded by the difference. */
export type Overrun = { readonly atCall: number; readonly reservedUsd: number; readonly actualUsd: number; readonly totalUsd: number; readonly capUsd: number };

export type Stop = { readonly beforeCall: number; readonly cumulativeUsd: number; readonly worstCaseUsd: number; readonly capUsd: number };

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export function totalsOf(rows: readonly Row[]) {
  const tutor = rows.filter((r) => r.purpose === "tutor_turn");
  const later = tutor.filter((r) => !r.firstOfContext && r.error === null);
  const known = rows.filter((r) => r.costUsd !== null);
  const cli = rows.filter((r) => r.cliNotionalUsd !== null);
  const apiCost = known.reduce((sum, r) => sum + r.costUsd!, 0);
  const cliCost = cli.reduce((sum, r) => sum + r.cliNotionalUsd!, 0);
  const first = tutor.map((r) => r.firstTextMs).filter((x): x is number => x !== null);
  return {
    calls: rows.length,
    callsCompleted: rows.filter((r) => r.error === null).length,
    callsFailed: rows.filter((r) => r.error !== null).length,
    tokens: {
      fresh: rows.reduce((s, r) => s + (r.tokens?.fresh ?? 0), 0),
      cacheCreation: rows.reduce((s, r) => s + (r.tokens?.cacheCreation ?? 0), 0),
      cacheRead: rows.reduce((s, r) => s + (r.tokens?.cacheRead ?? 0), 0),
      output: rows.reduce((s, r) => s + (r.tokens?.output ?? 0), 0),
    },
    costUsd: apiCost,
    callsWithUnknownCost: rows.length - known.length,
    headerChecks: {
      tutorTurns: tutor.length,
      headerParsed: tutor.filter((r) => r.header?.parsed === true).length,
      kindAllowedByPrompt: tutor.filter((r) => r.header?.kindAllowedByPrompt === true).length,
      bothPassed: tutor.filter((r) => r.header?.parsed === true && r.header.kindAllowedByPrompt === true).length,
    },
    cacheReadFromTurn2: { tutorTurnsAfterFirst: later.length, withCacheRead: later.filter((r) => (r.tokens?.cacheRead ?? 0) > 0).length },
    wrapUpSchemaValid: rows.filter((r) => r.purpose === "wrap_up" && r.schemaValid === true).length,
    cliNotional: { usd: cliCost, callsWithFigure: cli.length, allCallsHaveFigure: cli.length === rows.length && rows.length > 0 },
    apiAtOrBelowCliNotional: cli.length === rows.length && rows.length > 0 && rows.every((r) => r.costUsd !== null) ? apiCost <= cliCost : null,
    firstTextDeltaMs: { tutorTurnMedian: median(first), tutorTurnMax: first.length === 0 ? null : Math.max(...first) },
  };
}

export type Results = {
  readonly label: "live";
  readonly experiment: "08-api-tutor";
  readonly generatedAt: string;
  readonly model: string;
  readonly effort: "as stored in each input";
  readonly db: string;
  readonly since: string;
  readonly capUsd: number;
  readonly costBasis: "estimated from response usage and list prices, not a bill";
  readonly checkNote: "tutor turns: the header parses and its move kind is among the allowed moves the stored prompt names (weaker than validateMove)";
  readonly stoppedAtCap: Stop | null;
  readonly overrun: Overrun | null;
  readonly totals: ReturnType<typeof totalsOf>;
  readonly rows: readonly Row[];
};

const usd = (x: number | null) => (x === null ? "unknown" : `$${x.toFixed(4)}`);
const ms = (x: number | null) => (x === null ? "-" : String(Math.round(x)));

export function markdownOf(r: Results): string {
  const t = r.totals;
  const lines = [
    `# Experiment 8 results (${r.generatedAt})`,
    "",
    `All ${t.calls} rows are live Messages API calls on ${r.model}, replayed from stored inputs. Cost is estimated from response usage and list prices, not billed. The header check is the weaker one: the header parses and its move kind is among the allowed moves the stored prompt names.`,
    "",
    "| # | data | purpose | original time | input | cache write | cache read | output | cost | first text ms | total ms | stop | header | move | CLI notional |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.rows.map((row) => {
      const tk = row.tokens;
      const header = row.header === null ? (row.schemaValid === null ? "-" : row.schemaValid ? "schema ok" : "schema fail") : row.header.parsed && row.header.kindAllowedByPrompt === true ? "pass" : `fail${row.header.why ? ` (${row.header.why})` : ""}`;
      return `| ${row.n} | ${row.data} | ${row.purpose}${row.repair ? " (repair)" : ""} | ${row.originalAt} | ${tk?.fresh ?? "-"} | ${tk?.cacheCreation ?? "-"} | ${tk?.cacheRead ?? "-"} | ${tk?.output ?? "-"} | ${usd(row.costUsd)} | ${ms(row.firstTextMs)} | ${ms(row.totalMs)} | ${row.stopReason ?? "-"} | ${row.error === null ? header : `error: ${row.error.replace(/\|/g, "/").slice(0, 120)}`} | ${row.header?.moveKind ?? "-"} | ${usd(row.cliNotionalUsd)} |`;
    }),
    "",
    "## Totals",
    "",
    `- Calls: ${t.calls}, completed ${t.callsCompleted}, failed ${t.callsFailed}.`,
    `- Tokens: ${t.tokens.fresh} input, ${t.tokens.cacheCreation} cache write, ${t.tokens.cacheRead} cache read, ${t.tokens.output} output.`,
    `- Estimated cost: ${usd(t.costUsd)} (${t.callsWithUnknownCost} calls with unknown cost). Cap ${usd(r.capUsd)}.`,
    `- The CLI's notional cost for the same inputs: ${usd(t.cliNotional.usd)}${t.cliNotional.allCallsHaveFigure ? "" : ` (only ${t.cliNotional.callsWithFigure} of ${t.calls} calls have a figure)`}. API at or below it: ${t.apiAtOrBelowCliNotional === null ? "not comparable" : t.apiAtOrBelowCliNotional ? "yes" : "no"}.`,
    `- Header checks passed: ${t.headerChecks.bothPassed} of ${t.headerChecks.tutorTurns} tutor turns (header parsed ${t.headerChecks.headerParsed}, kind allowed by prompt ${t.headerChecks.kindAllowedByPrompt}). Wrap-ups that passed the schema: ${t.wrapUpSchemaValid}.`,
    `- Cache read from the second turn of a context on: ${t.cacheReadFromTurn2.withCacheRead} of ${t.cacheReadFromTurn2.tutorTurnsAfterFirst} tutor turns.`,
    `- Time to first text delta on tutor turns, in ms: median ${ms(t.firstTextDeltaMs.tutorTurnMedian)}, max ${ms(t.firstTextDeltaMs.tutorTurnMax)}. This is the first streamed text, which is not the first sentence.`,
  ];
  if (r.overrun !== null) {
    const o = r.overrun;
    lines.push(`- OVERRUN at call ${o.atCall}: it cost ${usd(o.actualUsd)}, more than the ${usd(o.reservedUsd)} it was reserved at, so the computed total ${usd(o.totalUsd)} may be above the cap of ${usd(o.capUsd)}. The run stopped there and made no later call.`);
  }
  if (r.stoppedAtCap !== null) {
    const s = r.stoppedAtCap;
    lines.push(`- STOPPED before call ${s.beforeCall}: cumulative ${usd(s.cumulativeUsd)} plus a worst case of ${usd(s.worstCaseUsd)} for it could pass the cap of ${usd(s.capUsd)}. Later calls were not made.`);
  }
  return `${lines.join("\n")}\n`;
}

// ───────────────────────────── the run ─────────────────────────────

export type Deps = {
  /** A fake Messages API client, so a test makes no network call. */
  readonly client?: ApiClient;
  readonly log?: (text: string) => void;
  readonly error?: (text: string) => void;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
};

const maxTokensOf = (purpose: Purpose) => (purpose === "tutor_turn" ? STREAM_MAX_TOKENS : STRUCTURED_MAX_TOKENS);
/** The serialized wrap-up schema as it goes on the wire. A tutor turn sends none. */
const WRAP_UP_SCHEMA_BYTES = Buffer.byteLength(JSON.stringify(outputFormatOf(wrapUpSchema)));
const schemaBytesOf = (purpose: Purpose) => (purpose === "wrap_up" ? WRAP_UP_SCHEMA_BYTES : 0);

/** What one call is reserved at: the upper bound in `worstCaseUsd`. Infinite for a model with no price, so it never runs. */
export const reservationUsd = (model: Options["model"], call: StoredCall): number =>
  worstCaseUsd(API_MODELS[model], call.inputBytes, maxTokensOf(call.purpose), schemaBytesOf(call.purpose)) ?? Number.POSITIVE_INFINITY;
const worstOf = reservationUsd;

// ───────────────────────────── paths ─────────────────────────────

/** The absolute path with every symlink resolved. The part that does not exist yet is resolved against its nearest existing parent. */
export function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}

const isInside = (dir: string, file: string): boolean => {
  const rel = relative(dir, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export type Paths = { readonly db: string; readonly out: string; readonly resultsJson: string; readonly resultsMd: string };

/**
 * The paths a live run uses, each normalized once here and checked only in this form: the database and the output
 * directory with symlinks resolved, and the two files the runner writes. A one-line reason when the run must not start.
 */
export function resolvePaths(dbArg: string, outArg: string): Paths | string {
  const db = canonicalPath(dbArg);
  const out = canonicalPath(outArg);
  const paths: Paths = { db, out, resultsJson: join(out, "results.json"), resultsMd: join(out, "results.md") };
  if (isInside(out, db) || db === paths.resultsJson || db === paths.resultsMd) {
    return `--db ${db} is inside the output directory ${out}, so a run could overwrite it. Put the database copy somewhere else or choose another --out.`;
  }
  // lstat, not existsSync: a dangling symlink at either name would be written through.
  for (const file of [paths.resultsJson, paths.resultsMd]) {
    try {
      lstatSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    return `${out} already holds results (${basename(file)} exists). A paid run's results are never overwritten. Choose a new --out or move the earlier results.`;
  }
  return paths;
}

/**
 * Creates both result files empty, failing if either exists, so a file that appeared since `resolvePaths` still cannot be
 * overwritten. A null on success, else the reason.
 */
function claimOutputs(paths: Paths): string | null {
  const made: string[] = [];
  try {
    mkdirSync(paths.out, { recursive: true });
    for (const file of [paths.resultsJson, paths.resultsMd]) {
      writeFileSync(file, "", { flag: "wx" });
      made.push(file);
    }
    return null;
  } catch (e) {
    for (const file of made) unlinkSync(file);
    return (e as NodeJS.ErrnoException).code === "EEXIST" ? `${paths.out} already holds results. A paid run's results are never overwritten.` : `cannot create the results in ${paths.out}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function writeResults(paths: Paths, results: Results): void {
  writeFileSync(paths.resultsJson, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(paths.resultsMd, markdownOf(results));
}

/** Returns the process exit code. */
export async function main(argv: readonly string[], deps: Deps = {}): Promise<number> {
  const log = deps.log ?? ((t: string) => console.log(t));
  const error = deps.error ?? ((t: string) => console.error(t));
  const now = deps.now ?? (() => performance.now());
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    error(parsed);
    return 2;
  }
  // A live run's paths are normalized once, here, and every later use and check is on these values. A dry run writes nothing, so it needs only the database.
  let paths: Paths | null = null;
  let options: Options = parsed;
  if (!parsed.dryRun) {
    const resolved = resolvePaths(parsed.db, parsed.out!);
    if (typeof resolved === "string") {
      error(resolved);
      return 1;
    }
    paths = resolved;
    options = { ...parsed, db: resolved.db, out: resolved.out };
  }

  let calls: StoredCall[];
  try {
    calls = loadCalls(options.db, options.sinceMs);
  } catch (e) {
    error(`cannot read the replay inputs: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const modelId = API_MODELS[options.model];
  if (calls.length === 0) {
    error(`no tutor_turn or wrap_up inputs in ${options.db} since ${options.since}`);
    return 1;
  }

  if (options.dryRun) {
    log(`dry run: ${calls.length} calls on ${modelId}, none made. Cap ${usd(options.capUsd)}.`);
    let worstTotal = 0;
    for (const [i, c] of calls.entries()) {
      const worst = worstOf(options.model, c);
      worstTotal += worst;
      log(`${i + 1}. ${new Date(c.atMs).toISOString()} ${c.purpose} effort=${c.effort} input=${c.inputBytes} bytes worst-case=${usd(worst)} CLI notional=${usd(c.cliNotionalUsd)}`);
    }
    log(`total input ${calls.reduce((s, c) => s + c.inputBytes, 0)} bytes. Worst case for every call ${usd(worstTotal)}, which is a bound and not a forecast (every input and schema byte plus a fixed request overhead priced as a 1 hour cache write, every output limit spent). The run stops before any call that could pass the cap.`);
    return 0;
  }

  // The key is read only for a live run, from the same 0600 keys file the backend uses. Nothing here prints it.
  let apiKey: string | undefined;
  if (deps.client === undefined) {
    if (!existsSync(options.keys)) {
      error(`no keys file at ${options.keys}. Create it (mode 0600) with a line AFTERCLASS_ANTHROPIC_API_KEY=<key>, or pass --keys <path>.`);
      return 1;
    }
    try {
      apiKey = readKeys(options.keys).AFTERCLASS_ANTHROPIC_API_KEY;
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
      return 1;
    }
    if (apiKey === undefined) {
      error(`${options.keys} has no AFTERCLASS_ANTHROPIC_API_KEY. Add it, then run again.`);
      return 1;
    }
  }

  const claimed = claimOutputs(paths!);
  if (claimed !== null) {
    error(claimed);
    return 1;
  }
  const secret = apiKey ?? FAKE_CLIENT_KEY;
  let last: ApiCallDetail | null = null;
  const claude: ClaudeCli = createClaudeApi({
    apiKey: secret,
    maxConcurrent: 1,
    ...(deps.client ? { client: deps.client } : {}),
    onResponse: (detail) => {
      last = detail;
    },
  });

  const rows: Row[] = [];
  const seenContexts = new Set<string>();
  /** Cost counted against the cap: known cost, or the worst case for a call that left none. */
  let committed = 0;
  let stoppedAtCap: Stop | null = null;
  let overrun: Overrun | null = null;
  const snapshot = (): Results => ({
    label: "live",
    experiment: "08-api-tutor",
    generatedAt: new Date().toISOString(),
    model: modelId,
    effort: "as stored in each input",
    db: options.db,
    since: options.since,
    capUsd: options.capUsd,
    costBasis: "estimated from response usage and list prices, not a bill",
    checkNote: "tutor turns: the header parses and its move kind is among the allowed moves the stored prompt names (weaker than validateMove)",
    stoppedAtCap,
    overrun,
    totals: totalsOf(rows),
    rows,
  });

  for (const [i, call] of calls.entries()) {
    const worst = worstOf(options.model, call);
    if (committed + worst > options.capUsd) {
      stoppedAtCap = { beforeCall: i + 1, cumulativeUsd: committed, worstCaseUsd: worst, capUsd: options.capUsd };
      log(`stopping before call ${i + 1}: cumulative ${usd(committed)} plus a worst case of ${usd(worst)} could pass the cap of ${usd(options.capUsd)}`);
      break;
    }

    last = null;
    const req: ClaudeRequest = { model: options.model, effort: call.effort, system: call.system, prompt: call.prompt, images: [], webTools: false, timeoutMs: TIMEOUT_MS[call.purpose] };
    const started = now();
    let firstTextMs: number | null = null;
    let text: string | null = null;
    let schemaValid: boolean | null = null;
    let failure: string | null = null;
    let usageCost: number | null = null;
    try {
      if (call.purpose === "tutor_turn") {
        const result = await claude.streamText(req, () => {
          firstTextMs ??= now() - started;
        }, deps.signal ?? new AbortController().signal);
        text = result.text;
        usageCost = result.usage.cost.kind === "estimated" ? result.usage.cost.usd : null;
      } else {
        const result = await claude.structured(req, wrapUpSchema, deps.signal ?? new AbortController().signal);
        schemaValid = true;
        usageCost = result.usage.cost.kind === "estimated" ? result.usage.cost.usd : null;
      }
    } catch (e) {
      // Redacted in full before any clip, here and in every later cut of this text (the log line, the table cell).
      failure = redactThenClip(e instanceof Error ? `${e.name}: ${e.message}` : String(e), secret);
      if (e instanceof ProviderError) {
        usageCost = e.usage?.cost.kind === "estimated" ? e.usage.cost.usd : null;
        if (call.purpose === "wrap_up" && e.usage !== null) schemaValid = false;
      }
    }
    const totalMs = now() - started;
    const detail = last as ApiCallDetail | null;
    const costUsd = usageCost ?? detail?.costUsd ?? null;
    committed += costUsd ?? worst;
    // The second guard. The reservation fits under the cap, so a call that costs no more than its reservation cannot take the
    // total over it. A call that does cost more has broken that, so it is recorded and the run stops here.
    if (costUsd !== null && costUsd > worst) overrun = { atCall: i + 1, reservedUsd: worst, actualUsd: costUsd, totalUsd: committed, capUsd: options.capUsd };

    let header: Row["header"] = null;
    if (call.purpose === "tutor_turn" && text !== null) {
      const parsed = parseMoveHeader(text.includes("\n") ? text : `${text}\n`);
      const allowed = allowedFromPrompt(call.prompt);
      const kind = parsed.kind === "header" ? parsed.move.kind : null;
      header = {
        parsed: parsed.kind === "header",
        moveKind: kind,
        kindAllowedByPrompt: kind === null ? null : allowed === null ? null : allowed.includes(kind),
        why: parsed.kind === "invalid" ? parsed.why : parsed.kind === "pending" ? "empty reply" : null,
      };
    }
    const context = `${call.purpose}\n${call.system}`;
    const firstOfContext = !seenContexts.has(context);
    seenContexts.add(context);

    rows.push({
      data: "live",
      n: i + 1,
      purpose: call.purpose,
      originalAt: new Date(call.atMs).toISOString(),
      memoKey: call.key,
      model: detail?.model ?? modelId,
      effort: call.effort,
      inputBytes: call.inputBytes,
      repair: /Your previous reply was rejected/.test(call.prompt),
      firstOfContext,
      tokens: detail === null ? null : { fresh: detail.fresh, cacheCreation: detail.creation5m + detail.creation1h, cacheRead: detail.read, output: detail.output },
      costUsd,
      cliNotionalUsd: call.cliNotionalUsd,
      firstTextMs,
      totalMs,
      stopReason: detail?.stopReason ?? null,
      header,
      schemaValid,
      error: failure,
    });
    // Written after every call, so an interrupted run keeps what it paid for.
    writeResults(paths!, snapshot());
    log(`call ${i + 1} of ${calls.length} ${call.purpose}: ${failure === null ? "ok" : `failed (${redactThenClip(failure, secret, 120)})`}, ${usd(costUsd)}, cumulative ${usd(committed)}`);
    if (overrun !== null) {
      error(`call ${i + 1} cost ${usd(overrun.actualUsd)}, more than the ${usd(overrun.reservedUsd)} it was reserved at. The computed total is ${usd(overrun.totalUsd)} against a cap of ${usd(overrun.capUsd)}. The run stopped and made no further call. Check the cost in the console.`);
      break;
    }
    if (deps.signal?.aborted) break;
  }

  writeResults(paths!, snapshot());
  log(`wrote ${paths!.resultsJson} and ${paths!.resultsMd}`);
  return overrun === null ? 0 : EXIT.overrun;
}

if (import.meta.main) {
  const ctl = new AbortController();
  process.on("SIGINT", () => ctl.abort());
  process.exit(await main(Bun.argv.slice(2), { signal: ctl.signal }));
}
