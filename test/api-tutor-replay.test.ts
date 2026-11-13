/**
 * The experiment 8 replay runner, on a tiny fixture database and a fake Messages API client.
 * Nothing here calls a model: the client is a fake and the key file is a temp file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { openDb } from "../src/backend/db";
import type { ApiClient } from "../src/backend/providers/claude-api";
import { STREAM_MAX_TOKENS, STRUCTURED_MAX_TOKENS, worstCaseUsd } from "../src/backend/providers/claude-api";
import { allowedFromPrompt, loadCalls, main, parseArgs, reservationUsd } from "../scripts/experiments/api-tutor-replay";
import type { Results } from "../scripts/experiments/api-tutor-replay";

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "afterclass-replay-"));
  scratch.push(d);
  return d;
};

const T0 = Date.parse("2026-11-11T09:00:00Z");
const SYSTEM = "You are the tutor.\n\nUsable claims: clm_x";
const TUTOR_PROMPT = "Allowed moves this turn: ask_main, wrap_up\n\nReview so far:\n(no turns yet)";
const HINT = '{"kind":"hint","threadId":"thr_aaaaaaaaaaaaaaaaaaaaaaaaaa"}';

type Seed = { key: string; purpose: string; atMs: number; input?: unknown };

/** A copy of a live database, with only the tables the runner reads filled in. */
function fixtureDb(seeds: readonly Seed[], cli: Readonly<Record<string, number>> = {}): string {
  const path = join(dir(), "afterclass.sqlite");
  const db = openDb(path);
  for (const s of seeds) {
    const input = s.input ?? { system: s.purpose === "wrap_up" ? "You close a review." : SYSTEM, prompt: s.purpose === "wrap_up" ? "Threads: thr_a" : TUTOR_PROMPT, effort: "medium" };
    db.sql.run(`INSERT INTO memo_inputs (key, provider, purpose, version, model, input_json, first_seen_ms) VALUES (?, 'claude', ?, 'v', 'opus', ?, ?)`, [s.key, s.purpose, JSON.stringify(input), s.atMs]);
  }
  for (const [key, usd] of Object.entries(cli)) {
    const purpose = seeds.find((s) => s.key === key)!.purpose;
    db.sql.run(
      `INSERT INTO usage_events (id, memo_key, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens, cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
       VALUES (?, ?, 1, 'claude', 'claude-opus-5-5', ?, 'ok', 1, 1, 0, 'notional', ?, 'claude_subscription', NULL, 1, 1)`,
      [`use_${key}`, key, purpose, usd],
    );
  }
  db.close();
  return path;
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

type Reply = { readonly text: string; readonly stop?: string; readonly input?: number; readonly creation?: number; readonly read?: number; readonly output?: number; readonly fail?: unknown };

function msg(r: Reply): Message {
  return {
    id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null, stop_details: null,
    content: [{ type: "text", text: r.text, citations: null }],
    stop_reason: r.stop ?? "end_turn",
    usage: { input_tokens: r.input ?? 100, output_tokens: r.output ?? 50, cache_creation_input_tokens: r.creation ?? 0, cache_read_input_tokens: r.read ?? 0, cache_creation: null },
  } as unknown as Message;
}

/** Replies are consumed in order, one per call. The client counts its calls. */
function fakeApi(replies: readonly Reply[]): { client: ApiClient; calls: () => number } {
  let n = 0;
  const next = (): Reply => {
    const r = replies[n++];
    if (r === undefined) throw new Error("the fake API was called more times than scripted");
    return r;
  };
  const settle = (r: Reply): Promise<Message> => (r.fail === undefined ? Promise.resolve(msg(r)) : Promise.reject(r.fail));
  const client: ApiClient = {
    messages: {
      stream: () => {
        const r = next();
        let listener: (d: string) => void = () => {};
        return {
          on: (_e, l) => {
            listener = l;
            return {};
          },
          abort: () => {},
          finalMessage: async () => {
            for (const piece of [r.text.slice(0, 5), r.text.slice(5)]) if (piece !== "") listener(piece);
            return settle(r);
          },
        };
      },
      create: () => settle(next()),
    },
  };
  return { client, calls: () => n };
}

const WRAP = '{"observations":[],"notes":[]}';

function run(argv: readonly string[], client?: ApiClient, extra: { now?: () => number } = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  let t = 0;
  return main(argv, { ...(client ? { client } : {}), log: (s) => void logs.push(s), error: (s) => void errors.push(s), now: extra.now ?? (() => (t += 10)) }).then((code) => ({ code, logs, errors }));
}

describe("parseArgs", () => {
  const base = ["--db", "/tmp/x.sqlite", "--since", "2026-11-11", "--out", "/tmp/out"];

  test("defaults to opus, a $5 cap and the real keys file", () => {
    const o = parseArgs(base);
    expect(typeof o).toBe("object");
    if (typeof o === "string") throw new Error(o);
    expect(o.model).toBe("opus");
    expect(o.capUsd).toBe(5);
    expect(o.dryRun).toBe(false);
    expect(o.sinceMs).toBe(Date.parse("2026-11-11"));
    expect(o.keys).toEndWith(".config/afterclass/keys.env");
  });

  test("a dry run needs no --out, and a live run does", () => {
    expect(typeof parseArgs(["--db", "d", "--since", "2026-11-11", "--dry-run"])).toBe("object");
    expect(parseArgs(["--db", "d", "--since", "2026-11-11"])).toContain("--out is required");
  });

  test("bad values name the flag", () => {
    expect(parseArgs([...base, "--model", "haiku"])).toContain("--model");
    expect(parseArgs([...base, "--cap-usd", "0"])).toContain("--cap-usd");
    expect(parseArgs([...base, "--cap-usd", "lots"])).toContain("--cap-usd");
    expect(parseArgs(["--db", "d", "--since", "yesterday-ish", "--out", "o"])).toContain("--since");
    expect(parseArgs([...base, "--surprise"])).toContain("unknown argument");
    expect(parseArgs(["--since", "2026-11-11", "--out", "o"])).toContain("--db is required");
  });
});

describe("loadCalls", () => {
  test("reads only tutor turns and wrap-ups since the date, oldest first, with the CLI's notional cost", () => {
    const path = fixtureDb(
      [
        { key: "old", purpose: "tutor_turn", atMs: T0 - 86_400_000 },
        { key: "wrap", purpose: "wrap_up", atMs: T0 + 3000 },
        { key: "boundary", purpose: "boundary", atMs: T0 + 500, input: { anything: true } },
        { key: "t2", purpose: "tutor_turn", atMs: T0 + 2000 },
        { key: "t1", purpose: "tutor_turn", atMs: T0 + 1000 },
      ],
      { t1: 0.1, wrap: 0.05 },
    );
    const calls = loadCalls(path, T0);
    expect(calls.map((c) => c.key)).toEqual(["t1", "t2", "wrap"]);
    expect(calls[0]).toMatchObject({ purpose: "tutor_turn", effort: "medium", system: SYSTEM, cliNotionalUsd: 0.1, cliAttempts: 1 });
    expect(calls[0]!.inputBytes).toBe(Buffer.byteLength(SYSTEM) + Buffer.byteLength(TUTOR_PROMPT));
    expect(calls[1]!.cliNotionalUsd).toBeNull();
  });

  test("an input that is not {system, prompt, effort} is an error that names its key", () => {
    const path = fixtureDb([{ key: "bad", purpose: "tutor_turn", atMs: T0, input: { nope: 1 } }]);
    expect(() => loadCalls(path, 0)).toThrow("memo input bad");
  });

  test("the database file is byte for byte the same after a full run, so nothing was written to it", async () => {
    const path = fixtureDb([{ key: "t1", purpose: "tutor_turn", atMs: T0 }]);
    const before = sha(path);
    loadCalls(path, 0);
    const { client } = fakeApi([{ text: `${HINT}\nHere is a hint.` }]);
    await run(["--db", path, "--since", "2026-11-01", "--out", join(dir(), "out")], client);
    expect(sha(path)).toBe(before);
    // A read-only handle on a WAL database may create empty -wal and -shm files beside it. They hold no rows of this run.
  });

  test("a missing file is a clear error", () => {
    expect(() => loadCalls("/nonexistent/afterclass.sqlite", 0)).toThrow("does not exist");
  });
});

describe("allowedFromPrompt", () => {
  test("reads the allowed moves line", () => {
    expect(allowedFromPrompt(TUTOR_PROMPT)).toEqual(["ask_main", "wrap_up"]);
    expect(allowedFromPrompt("Allowed moves this turn: ask_followup\n\nrest")).toEqual(["ask_followup"]);
  });
  test("is null when the prompt names none", () => {
    expect(allowedFromPrompt("Threads: none")).toBeNull();
    expect(allowedFromPrompt("Allowed moves this turn: \n")).toBeNull();
  });
});

describe("--dry-run", () => {
  test("lists each call with its input size, makes no call and writes nothing", async () => {
    const path = fixtureDb([
      { key: "t1", purpose: "tutor_turn", atMs: T0 },
      { key: "wrap", purpose: "wrap_up", atMs: T0 + 1000 },
    ]);
    const out = join(dir(), "out");
    const api = fakeApi([]);
    const { code, logs } = await run(["--db", path, "--since", "2026-11-11", "--out", out, "--dry-run"], api.client);
    expect(code).toBe(0);
    expect(api.calls()).toBe(0);
    expect(existsSync(out)).toBe(false);
    const text = logs.join("\n");
    expect(text).toContain("dry run: 2 calls on claude-opus-5-5, none made");
    expect(text).toContain("1. 2026-11-11T09:00:00.000Z tutor_turn effort=medium");
    expect(text).toContain(`input=${Buffer.byteLength(SYSTEM) + Buffer.byteLength(TUTOR_PROMPT)} bytes`);
    expect(text).toContain("2. 2026-11-11T09:00:01.000Z wrap_up");
  });

  test("needs no key file", async () => {
    const path = fixtureDb([{ key: "t1", purpose: "tutor_turn", atMs: T0 }]);
    const { code } = await run(["--db", path, "--since", "2026-11-11", "--dry-run", "--keys", join(dir(), "absent.env")]);
    expect(code).toBe(0);
  });

  test("an empty range is an error, not a silent success", async () => {
    const path = fixtureDb([{ key: "t1", purpose: "tutor_turn", atMs: T0 }]);
    const { code, errors } = await run(["--db", path, "--since", "2026-12-01", "--dry-run"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no tutor_turn or wrap_up inputs");
  });
});

describe("a live run on a fake client", () => {
  const seeds: Seed[] = [
    { key: "t1", purpose: "tutor_turn", atMs: T0 },
    { key: "t2", purpose: "tutor_turn", atMs: T0 + 1000 },
    { key: "wrap", purpose: "wrap_up", atMs: T0 + 2000 },
  ];

  test("records every field per call, labels every row live and totals them", async () => {
    const path = fixtureDb(seeds, { t1: 0.2, t2: 0.1, wrap: 0.05 });
    const out = join(dir(), "out");
    const api = fakeApi([
      { text: `{"kind":"wrap_up"}\nThat is the end.`, input: 20, creation: 3000, read: 0, output: 100 },
      // A header that parses but is a kind the stored prompt does not allow.
      { text: `${HINT}\nTry this.`, input: 20, creation: 0, read: 3000, output: 80 },
      { text: WRAP, input: 400, output: 60 },
    ]);
    const { code } = await run(["--db", path, "--since", "2026-11-11", "--out", out], api.client);
    expect(code).toBe(0);
    expect(api.calls()).toBe(3);

    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Results;
    expect(results.label).toBe("live");
    expect(results.model).toBe("claude-opus-5-5");
    expect(results.rows.map((r) => r.data)).toEqual(["live", "live", "live"]);
    const [r1, r2, r3] = results.rows;
    expect(r1).toMatchObject({ n: 1, purpose: "tutor_turn", originalAt: "2026-11-11T09:00:00.000Z", stopReason: "end_turn", error: null, firstOfContext: true });
    expect(r1!.tokens).toEqual({ fresh: 20, cacheCreation: 3000, cacheRead: 0, output: 100 });
    // 20 * 4 + 3000 * 8 + 100 * 20, per million
    expect(r1!.costUsd).toBeCloseTo(0.026080, 6);
    expect(r1!.firstTextMs).not.toBeNull();
    expect(r1!.totalMs).toBeGreaterThan(r1!.firstTextMs!);
    expect(r1!.header).toEqual({ parsed: true, moveKind: "wrap_up", kindAllowedByPrompt: true, why: null });
    expect(r2!.header).toMatchObject({ parsed: true, moveKind: "hint", kindAllowedByPrompt: false });
    expect(r2!.firstOfContext).toBe(false);
    expect(r3).toMatchObject({ purpose: "wrap_up", schemaValid: true, header: null, firstTextMs: null });

    expect(results.totals.calls).toBe(3);
    expect(results.totals.tokens).toEqual({ fresh: 440, cacheCreation: 3000, cacheRead: 3000, output: 240 });
    expect(results.totals.headerChecks).toEqual({ tutorTurns: 2, headerParsed: 2, kindAllowedByPrompt: 1, bothPassed: 1 });
    expect(results.totals.cacheReadFromTurn2).toEqual({ tutorTurnsAfterFirst: 1, withCacheRead: 1 });
    expect(results.totals.cliNotional.usd).toBeCloseTo(0.35, 9);
    expect(results.totals.apiAtOrBelowCliNotional).toBe(true);
    expect(results.stoppedAtCap).toBeNull();

    const md = readFileSync(join(out, "results.md"), "utf8");
    expect(md).toContain("live Messages API calls");
    expect(md).toContain("| 1 | live | tutor_turn |");
    expect(md).toContain("Header checks passed: 1 of 2 tutor turns");
    expect(md).toContain("which is not the first sentence");
  });

  test("a failed call is recorded with its stop reason and error, and the run goes on", async () => {
    const path = fixtureDb(seeds);
    const out = join(dir(), "out");
    const api = fakeApi([
      { text: "I cannot help with that.", stop: "refusal", output: 5 },
      { text: `{"kind":"wrap_up"}\nDone.` },
      { text: WRAP },
    ]);
    await run(["--db", path, "--since", "2026-11-11", "--out", out], api.client);
    const { rows, totals } = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Results;
    expect(rows[0]).toMatchObject({ stopReason: "refusal" });
    expect(rows[0]!.error).toContain("refused");
    expect(rows[0]!.header).toBeNull();
    expect(rows[1]!.error).toBeNull();
    expect(totals).toMatchObject({ calls: 3, callsFailed: 1, callsCompleted: 2 });
  });

  test("stops before a call whose worst case could pass the cap, and says so", async () => {
    // The first call is cheap in the cap's terms to begin with and then reports 20000 output tokens, $0.40.
    const path = fixtureDb(seeds);
    const out = join(dir(), "out");
    const worst = worstCaseUsd("claude-opus-5-5", Buffer.byteLength(SYSTEM) + Buffer.byteLength(TUTOR_PROMPT), STREAM_MAX_TOKENS, 0)!;
    const cap = worst + 0.1;
    const api = fakeApi([{ text: `{"kind":"wrap_up"}\nok`, input: 0, output: 20_000 }, { text: "never" }, { text: "never" }]);
    const { code, logs } = await run(["--db", path, "--since", "2026-11-11", "--out", out, "--cap-usd", String(cap)], api.client);
    expect(code).toBe(0);
    expect(api.calls()).toBe(1);
    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Results;
    expect(results.rows).toHaveLength(1);
    expect(results.stoppedAtCap).toMatchObject({ beforeCall: 2, capUsd: cap });
    expect(results.stoppedAtCap!.cumulativeUsd).toBeCloseTo(0.4, 9);
    expect(results.stoppedAtCap!.cumulativeUsd + results.stoppedAtCap!.worstCaseUsd).toBeGreaterThan(cap);
    expect(logs.join("\n")).toContain("stopping before call 2");
    expect(readFileSync(join(out, "results.md"), "utf8")).toContain("STOPPED before call 2");
  });

  test("a cap below the first call's worst case makes no call at all", async () => {
    const path = fixtureDb(seeds);
    const out = join(dir(), "out");
    const api = fakeApi([]);
    const { code } = await run(["--db", path, "--since", "2026-11-11", "--out", out, "--cap-usd", "0.01"], api.client);
    expect(code).toBe(0);
    expect(api.calls()).toBe(0);
    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Results;
    expect(results.rows).toEqual([]);
    expect(results.stoppedAtCap).toMatchObject({ beforeCall: 1 });
  });

  test("a call that fails without usage is counted at its worst case, so the cap still holds", async () => {
    const path = fixtureDb(seeds);
    const out = join(dir(), "out");
    const worst = worstCaseUsd("claude-opus-5-5", Buffer.byteLength(SYSTEM) + Buffer.byteLength(TUTOR_PROMPT), STREAM_MAX_TOKENS, 0)!;
    const api = fakeApi([{ text: "", fail: new TypeError("socket") }, { text: "never" }]);
    await run(["--db", path, "--since", "2026-11-11", "--out", out, "--cap-usd", String(worst * 1.5)], api.client);
    expect(api.calls()).toBe(1);
    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Results;
    expect(results.rows[0]!.error).not.toBeNull();
    expect(results.rows[0]!.costUsd).toBeNull();
    expect(results.totals.callsWithUnknownCost).toBe(1);
    expect(results.stoppedAtCap).toMatchObject({ beforeCall: 2 });
  });
});

describe("the key", () => {
  const seeded = () => fixtureDb([{ key: "t1", purpose: "tutor_turn", atMs: T0 }]);

  test("a missing keys file exits with a clear message and no call", async () => {
    const { code, errors } = await run(["--db", seeded(), "--since", "2026-11-11", "--out", join(dir(), "out"), "--keys", join(dir(), "absent.env")]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no keys file");
    expect(errors.join("\n")).toContain("AFTERCLASS_ANTHROPIC_API_KEY");
  });

  test("a keys file wider than 0600 is refused, and the message holds no key", async () => {
    const keys = join(dir(), "keys.env");
    writeFileSync(keys, "AFTERCLASS_ANTHROPIC_API_KEY=sk-ant-secret-0123456789\n", { mode: 0o644 });
    chmodSync(keys, 0o644);
    const { code, errors } = await run(["--db", seeded(), "--since", "2026-11-11", "--out", join(dir(), "out"), "--keys", keys]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("0644");
    expect(errors.join("\n")).not.toContain("sk-ant-secret");
  });

  test("a keys file without the Messages API key says which name is missing", async () => {
    const keys = join(dir(), "keys.env");
    writeFileSync(keys, "TYPESAFE_API_KEY=k\n", { mode: 0o600 });
    const { code, errors } = await run(["--db", seeded(), "--since", "2026-11-11", "--out", join(dir(), "out"), "--keys", keys]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("has no AFTERCLASS_ANTHROPIC_API_KEY");
  });
});

describe("the key in a recorded failure", () => {
  test("no part of it reaches results.json, results.md or the log, wherever it falls against the clips", async () => {
    const key = "fake-client-key";
    const leaks = (text: string) => Array.from({ length: key.length - 4 }, (_, i) => key.slice(0, i + 5)).some((prefix) => text.includes(prefix));
    const path = fixtureDb([{ key: "t1", purpose: "tutor_turn", atMs: T0 }]);
    for (const offset of [60, 90, 100, 105, 110, 115, 118, 119, 120, 380, 450, 480, 490, 495, 499, 500]) {
      const out = join(dir(), "out");
      const fail = new Anthropic.BadRequestError(400, { type: "error", error: { type: "x", message: "a".repeat(offset) + key } }, undefined, new Headers());
      const { client } = fakeApi([{ text: "", fail }]);
      const { logs, errors } = await run(["--db", path, "--since", "2026-11-11", "--out", out], client);
      for (const text of [readFileSync(join(out, "results.json"), "utf8"), readFileSync(join(out, "results.md"), "utf8"), logs.join("\n"), errors.join("\n")]) expect(leaks(text)).toBe(false);
    }
  });
});

describe("the spend cap is an upper bound", () => {
  const tiny = () => fixtureDb([{ key: "t1", purpose: "tutor_turn", atMs: T0, input: { system: "a", prompt: "b", effort: "medium" } }, { key: "t2", purpose: "tutor_turn", atMs: T0 + 1000, input: { system: "a", prompt: "b", effort: "medium" } }]);
  const header = `{"kind":"wrap_up"}\nok`;

  test("two text bytes and a cap at the old estimate make no call, because the request has overhead the old estimate left out", async () => {
    // The verifier's case: 2 bytes, cap $0.640016, and a response of 100 fresh input tokens and 32,000 output tokens, which prices at $0.6404.
    const api = fakeApi([{ text: header, input: 100, output: 32_000 }, { text: "never" }]);
    const out = join(dir(), "out");
    const { code } = await run(["--db", tiny(), "--since", "2026-11-11", "--out", out, "--cap-usd", "0.640016"], api.client);
    expect(code).toBe(0);
    expect(api.calls()).toBe(0);
    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Results;
    expect(results.stoppedAtCap).toMatchObject({ beforeCall: 1 });
  });

  test("a wrap-up is reserved for its serialized schema too", () => {
    const call = { key: "w", purpose: "wrap_up" as const, version: "v", atMs: T0, system: "a", prompt: "b", effort: "medium" as const, inputBytes: 2, cliNotionalUsd: null, cliAttempts: 0 };
    expect(reservationUsd("opus", call)).toBeGreaterThan(worstCaseUsd("claude-opus-5-5", 2, STRUCTURED_MAX_TOKENS, 0)! + 0.001);
  });

  test("a response that costs more than its reservation stops the run at once and says so plainly", async () => {
    // A surprising usage report on a call the reservation allowed: 1,000,000 fresh input tokens on a 2 byte input.
    // The cap is large enough that the next call's reservation would still fit, so only the second guard stops the run.
    const api = fakeApi([{ text: header, input: 1_000_000, output: 100 }, { text: header }]);
    const out = join(dir(), "out");
    const { code, errors, logs } = await run(["--db", tiny(), "--since", "2026-11-11", "--out", out, "--cap-usd", "5"], api.client);
    expect(code).toBe(4);
    expect(api.calls()).toBe(1);
    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Results;
    expect(results.rows).toHaveLength(1);
    expect(results.overrun).toMatchObject({ atCall: 1, capUsd: 5 });
    expect(results.overrun!.actualUsd).toBeCloseTo(4.002, 6);
    expect(results.overrun!.actualUsd).toBeGreaterThan(results.overrun!.reservedUsd);
    const text = [...errors, ...logs].join("\n");
    expect(text).toContain("more than the");
    expect(text).toContain("stopped");
    expect(readFileSync(join(out, "results.md"), "utf8")).toContain("OVERRUN at call 1");
  });
});

describe("the input database and earlier results are never overwritten", () => {
  const seeded = () => fixtureDb([{ key: "t1", purpose: "tutor_turn", atMs: T0 }]);
  const args = (db: string, out: string) => ["--db", db, "--since", "2026-11-11", "--out", out];
  const okReply = { text: `{"kind":"wrap_up"}\nok` };

  async function refused(db: string, out: string, watch: readonly string[], pattern: string) {
    const before = watch.map(sha);
    const api = fakeApi([okReply, okReply]);
    const { code, errors } = await run(args(db, out), api.client);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(pattern);
    expect(api.calls()).toBe(0);
    expect(watch.map(sha)).toEqual(before);
  }

  test("--db <out>/results.json --out <out>, the verifier's case, is refused and the database is untouched", async () => {
    const out = dir();
    const db = join(out, "results.json");
    copyFileSync(seeded(), db);
    await refused(db, out, [db], "inside the output directory");
  });

  test("a database anywhere inside the output directory is refused", async () => {
    const out = dir();
    mkdirSync(join(out, "sub"));
    const db = join(out, "sub", "afterclass.sqlite");
    copyFileSync(seeded(), db);
    await refused(db, out, [db], "inside the output directory");
  });

  test("a symlink to a file the runner writes is refused, whichever side the link is on", async () => {
    const out = dir();
    const real = join(out, "results.md");
    copyFileSync(seeded(), real);
    const link = join(dir(), "db-link.sqlite");
    symlinkSync(real, link);
    await refused(link, out, [real], "inside the output directory");
  });

  test("an output directory that is a symlink to the database's folder is refused", async () => {
    const folder = dir();
    const db = join(folder, "afterclass.sqlite");
    copyFileSync(seeded(), db);
    const link = join(dir(), "out-link");
    symlinkSync(folder, link);
    await refused(db, link, [db], "inside the output directory");
  });

  test("a relative path with dot segments is normalized before the check", async () => {
    const out = dir();
    const db = join(out, "x", "..", "results.json");
    mkdirSync(join(out, "x"));
    copyFileSync(seeded(), join(out, "results.json"));
    await refused(db, out, [join(out, "results.json")], "inside the output directory");
  });

  test("a database elsewhere is fine", async () => {
    const out = join(dir(), "out");
    const { code } = await run(args(seeded(), out), fakeApi([okReply]).client);
    expect(code).toBe(0);
    expect(existsSync(join(out, "results.json"))).toBe(true);
  });

  test("an existing results.json from an earlier run is never overwritten", async () => {
    const out = join(dir(), "out");
    const db = seeded();
    expect((await run(args(db, out), fakeApi([okReply]).client)).code).toBe(0);
    const files = [join(out, "results.json"), join(out, "results.md")];
    await refused(db, out, files, "already holds results");
  });

  test("an existing results.md alone is enough to refuse, and results.json is not created", async () => {
    const out = dir();
    writeFileSync(join(out, "results.md"), "earlier\n");
    const { code, errors } = await run(args(seeded(), out), fakeApi([okReply]).client);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("already holds results");
    expect(existsSync(join(out, "results.json"))).toBe(false);
    expect(readFileSync(join(out, "results.md"), "utf8")).toBe("earlier\n");
  });

  test("a dangling symlink where results.json goes is refused, not written through", async () => {
    const out = dir();
    const target = join(dir(), "elsewhere.json");
    symlinkSync(target, join(out, "results.json"));
    const { code } = await run(args(seeded(), out), fakeApi([okReply]).client);
    expect(code).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  test("a dry run needs neither check and writes nothing", async () => {
    const out = dir();
    writeFileSync(join(out, "results.json"), "earlier\n");
    const { code } = await run([...args(seeded(), out), "--dry-run"]);
    expect(code).toBe(0);
    expect(readFileSync(join(out, "results.json"), "utf8")).toBe("earlier\n");
  });
});
