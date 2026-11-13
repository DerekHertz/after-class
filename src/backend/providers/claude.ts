/**
 * `claude -p` adapter (W5). Transport only: spawn, args, parse, usage. Prompts
 * and output schemas live with the domain task that owns them. Importable only
 * inside providers/ (tasks get a ClaudeCli injected by main.ts).
 *
 * Auth: Derek's subscription. `--bare` never reads subscription login, so it is
 * NOT passed (SYNTHESIS correction), and ANTHROPIC_API_KEY is removed from the
 * child's environment so a stray key cannot silently switch a call to API billing.
 * ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are removed too: a Claude Code shell may set them,
 * and either would move billing or the endpoint off the login.
 * One arg builder:
 *   claude -p --model <m> --effort <e> --system-prompt-file <f>
 *          --restricted --tools Read --strict-mcp-config --disable-slash-commands
 *          --no-session-persistence
 *          --output-format json --json-schema <z.toJSONSchema>                (structured calls)
 *          --output-format stream-json --verbose --include-partial-messages   (tutor)
 *          --add-dir <dir>                                                    (only when images are attached)
 *   resource search only: WebSearch, WebFetch added to --tools.
 * The prompt goes in on stdin and the system prompt in a private temp file: a single argv
 * entry is capped near 128 KiB on Linux, and the tutor's system prompt carries the review's
 * claims and evidence (#135).
 * Untested: the first live call confirms login works with these flags.
 *
 * Images: Claude reads them with the Read tool. Each call copies its images into a
 * private temp dir, names the files in the prompt, grants only that dir with
 * --add-dir (--restricted confines file tools to the working dirs), and deletes it afterwards.
 *
 * Cost: { kind: "notional", usd: total_cost_usd, basis: "claude_subscription" }; unknown if not reported.
 *
 * Stateless: every call is a fresh process with the full context built from
 * our DB. No --resume, so Claude's session store is never a second copy of a review.
 * No @anthropic-ai/sdk here: this file is the subscription path to Claude. The other path, the Messages
 * API through the SDK, is claude-api.ts, and main.ts routes only the tutor turn and the wrap-up to it,
 * and only when AFTERCLASS_CLAUDE_BACKEND=api. It reuses this file's request type, limiter and abort error.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProviderError } from "./memo";
import type { UsageReport } from "./memo";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeImage = { readonly label: string; readonly mediaType: "image/jpeg" | "image/png"; readonly bytes: Uint8Array };

export type ClaudeRequest = {
  readonly model: string; // "opus" (default per stack) | "sonnet" (lab comparison arm)
  readonly effort: Effort;
  readonly system: string;
  readonly prompt: string;
  readonly images: readonly ClaudeImage[];
  readonly webTools: boolean; // true only for resource search
  readonly timeoutMs: number;
};

export type ClaudeCli = {
  /** --output-format json + --json-schema. Output re-validated with `schema`; the CLI's validation is not trusted alone. */
  structured<O>(req: ClaudeRequest, schema: z.ZodType<O>, signal: AbortSignal): Promise<{ readonly output: O; readonly usage: UsageReport }>;
  /**
   * --output-format stream-json. Calls onText per assistant text delta; resolves with the CLI's final answer text
   * (the `result` field, else the streamed deltas). If the model takes tool turns first, deltas include the text
   * of those turns while `text` is only the last one, so streaming callers should not attach images.
   */
  streamText(req: ClaudeRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<{ readonly text: string; readonly usage: UsageReport }>;
};

/** Pure, unit-tested: the exact argv for a request. The one place auth policy lives. */
export function claudeArgs(req: ClaudeRequest, output: "json" | "stream-json", jsonSchema: string | null, addDir: string | null = null, systemFile: string | null = null): readonly string[] {
  return [
    "-p",
    "--model", req.model,
    "--effort", req.effort,
    ...(systemFile === null ? ["--system-prompt", req.system] : ["--system-prompt-file", systemFile]),
    "--restricted",
    "--tools", req.webTools ? "Read,WebSearch,WebFetch" : "Read",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format", output,
    ...(output === "stream-json" ? ["--verbose", "--include-partial-messages"] : []),
    ...(jsonSchema === null ? [] : ["--json-schema", jsonSchema]),
    ...(addDir === null ? [] : ["--add-dir", addDir]),
  ];
}

/** The slice of a child process this adapter uses; Bun.spawn satisfies it, tests fake it. */
export type ClaudeProcess = {
  readonly stdin: { write(chunk: string): unknown; end(): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
};

export type SpawnFn = (argv: readonly string[], opts: { readonly cwd: string; readonly env: Record<string, string> }) => ClaudeProcess;

const bunSpawn: SpawnFn = (argv, opts) =>
  Bun.spawn([...argv], { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as ClaudeProcess;

export type Limiter = { acquire(signal: AbortSignal): Promise<() => void> };

export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`maxConcurrent must be a positive integer, got ${max}`);
  let active = 0;
  const waiting: { grant: () => void }[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next.grant();
    else active--;
  };
  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(abortError());
      if (active < max) {
        active++;
        return Promise.resolve(release);
      }
      return new Promise((resolve, reject) => {
        const entry = {
          grant: () => {
            signal.removeEventListener("abort", onAbort);
            resolve(release);
          },
        };
        const onAbort = () => {
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          reject(abortError());
        };
        waiting.push(entry);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The CLI's final `{type:"result"}` message. Accepts one object, an array of messages, or NDJSON, and ignores unknown fields. */
function findResult(stdout: string): Json | null {
  const text = stdout.trim();
  if (text === "") return null;
  const lastResult = (items: readonly unknown[]): Json | null => {
    for (let i = items.length - 1; i >= 0; i--) {
      const r = asRecord(items[i]);
      if (r?.type === "result") return r;
    }
    return null;
  };
  try {
    const whole: unknown = JSON.parse(text);
    return Array.isArray(whole) ? lastResult(whole) : lastResult([whole]);
  } catch {
    // not a single JSON document: read it as NDJSON
  }
  const items: unknown[] = [];
  for (const line of text.split("\n")) {
    try {
      items.push(JSON.parse(line));
    } catch {
      // progress noise or a truncated line
    }
  }
  return lastResult(items);
}

function usageOf(result: Json | null, requestedModel: string): UsageReport {
  const usage = asRecord(result?.usage);
  const perModel = asRecord(result?.modelUsage);
  const cost = asNumber(result?.total_cost_usd);

  let model = requestedModel;
  let busiest = -1;
  for (const [name, raw] of Object.entries(perModel ?? {})) {
    const m = asRecord(raw);
    const volume = (asNumber(m?.inputTokens) ?? 0) + (asNumber(m?.outputTokens) ?? 0) + (asNumber(m?.cacheReadInputTokens) ?? 0);
    if (volume > busiest) {
      busiest = volume;
      model = name;
    }
  }

  const fresh = asNumber(usage?.input_tokens);
  const created = asNumber(usage?.cache_creation_input_tokens);
  return {
    model,
    inputTokens: fresh === null && created === null ? null : (fresh ?? 0) + (created ?? 0),
    outputTokens: asNumber(usage?.output_tokens),
    cacheReadTokens: asNumber(usage?.cache_read_input_tokens),
    cost:
      cost === null
        ? { kind: "unknown", reason: result === null ? "claude produced no result message" : "claude did not report total_cost_usd" }
        : { kind: "notional", usd: cost, basis: "claude_subscription" },
  };
}

const TRANSIENT = /overload|rate.?limit|too many requests|temporar|try again|timed? ?out|econnreset|etimedout|socket hang up|\b(408|429|500|502|503|504|529)\b/i;

function isTransient(text: string, status: number | null): boolean {
  if (status !== null) return status === 408 || status === 429 || status >= 500;
  return TRANSIENT.test(text);
}

function failureOf(result: Json, usage: UsageReport): ProviderError {
  const status = asNumber(result.api_error_status);
  const detail = asString(result.result) ?? (Array.isArray(result.errors) ? result.errors.map(String).join("; ") : null) ?? "no detail";
  const subtype = asString(result.subtype);
  return new ProviderError(`claude error${subtype ? ` (${subtype})` : ""}: ${detail.slice(0, 500)}`, usage, isTransient(detail, status));
}

/** Structured output, from the dedicated field or, failing that, JSON text in the answer (code fences allowed). */
function structuredPayload(result: Json): unknown {
  if (result.structured_output !== undefined && result.structured_output !== null) return result.structured_output;
  const text = asString(result.result)?.trim();
  if (!text) return undefined;
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    return undefined;
  }
}

function toJsonSchema<O>(schema: z.ZodType<O>): string {
  try {
    const { $schema: _dropped, ...rest } = z.toJSONSchema(schema) as Json;
    return JSON.stringify(rest);
  } catch (err) {
    throw new ProviderError(`output schema cannot be expressed as JSON Schema: ${err instanceof Error ? err.message : String(err)}`, null, false);
  }
}

/** Assistant text deltas from stream-json events; falls back to whole messages when the CLI sent no partials. */
function createDeltaReader(emit: (delta: string) => void): { readonly read: (event: unknown) => void; readonly text: () => string } {
  let streamedInMessage = "";
  let all = "";
  const push = (s: string) => {
    if (s === "") return;
    all += s;
    emit(s);
  };
  return {
    text: () => all,
    read(event) {
      const e = asRecord(event);
      if (e === null || e.parent_tool_use_id != null) return;
      if (e.type === "stream_event") {
        const inner = asRecord(e.event);
        if (inner?.type === "message_start") streamedInMessage = "";
        const delta = asRecord(inner?.delta);
        if (inner?.type === "content_block_delta" && delta?.type === "text_delta") {
          const piece = asString(delta.text);
          if (piece !== null) {
            streamedInMessage += piece;
            push(piece);
          }
        }
      } else if (e.type === "assistant") {
        const content = asRecord(e.message)?.content;
        const full = Array.isArray(content)
          ? content.map((b) => (asRecord(b)?.type === "text" ? (asString(asRecord(b)?.text) ?? "") : "")).join("")
          : "";
        if (full.startsWith(streamedInMessage)) push(full.slice(streamedInMessage.length));
        streamedInMessage = "";
      }
    },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let all = "";
  let pending = "";
  for await (const chunk of stream) {
    const piece = decoder.decode(chunk, { stream: true });
    all += piece;
    if (!onLine) continue;
    pending += piece;
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line !== "") onLine(line);
    }
  }
  const tail = decoder.decode();
  all += tail;
  pending += tail;
  if (onLine && pending.trim() !== "") onLine(pending.trim());
  return all;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "image";

/** Writes the system prompt, and any images, into one private temp dir for this call. */
async function stageFiles(req: ClaudeRequest, root: string): Promise<{ readonly dir: string; readonly systemFile: string; readonly imageDir: string | null; readonly note: string }> {
  const dir = await mkdtemp(join(root, "afterclass-call-"));
  try {
    const systemFile = join(dir, "system.txt");
    await writeFile(systemFile, req.system);
    if (req.images.length === 0) return { dir, systemFile, imageDir: null, note: "" };
    const imageDir = join(dir, "images");
    await mkdir(imageDir);
    const lines: string[] = [];
    for (const [n, img] of req.images.entries()) {
      const path = join(imageDir, `${n}-${safeName(img.label)}.${img.mediaType === "image/png" ? "png" : "jpg"}`);
      await writeFile(path, img.bytes);
      lines.push(`- ${img.label}: ${path}`);
    }
    return { dir, systemFile, imageDir, note: `\n\nImages for this task. View each one with the Read tool before answering:\n${lines.join("\n")}\n` };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

type Outcome = { readonly stdout: string; readonly stderr: string; readonly code: number };

const BILLING_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;

export function createClaudeCli(opts: {
  readonly bin: string;
  readonly cwd: string;
  readonly maxConcurrent: number;
  readonly spawn?: SpawnFn;
  readonly imageRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How long a cancelled child gets to exit on SIGTERM before SIGKILL. */
  readonly killGraceMs?: number;
}): ClaudeCli {
  const spawn = opts.spawn ?? bunSpawn;
  const limiter = createLimiter(opts.maxConcurrent);
  const imageRoot = opts.imageRoot ?? tmpdir();
  const killGraceMs = opts.killGraceMs ?? 2_000;

  const childEnv = (): Record<string, string> => {
    const merged: Record<string, string | undefined> = { ...(opts.env ?? process.env) };
    for (const name of BILLING_ENV) delete merged[name];
    return Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined));
  };

  async function execute(req: ClaudeRequest, output: "json" | "stream-json", jsonSchema: string | null, signal: AbortSignal, onLine?: (line: string) => void): Promise<Outcome> {
    const release = await limiter.acquire(signal);
    let staged: Awaited<ReturnType<typeof stageFiles>> | null = null;
    try {
      signal.throwIfAborted();
      staged = await stageFiles(req, imageRoot);
      signal.throwIfAborted();
      const proc = spawn([opts.bin, ...claudeArgs(req, output, jsonSchema, staged.imageDir, staged.systemFile)], { cwd: opts.cwd, env: childEnv() });

      let killTimer: ReturnType<typeof setTimeout> | undefined;
      // A child that ignores SIGTERM would hold this call, and its limiter slot, forever.
      const stop = () => {
        proc.kill();
        killTimer ??= setTimeout(() => proc.kill("SIGKILL"), killGraceMs);
      };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, req.timeoutMs);
      const onAbort = stop;
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        try {
          proc.stdin.write(req.prompt + staged.note);
          proc.stdin.end();
        } catch {
          // the process already exited; its exit code and stderr explain why
        }
        const reading = Promise.all([readAll(proc.stdout, onLine), readAll(proc.stderr)]);
        reading.catch(() => {});
        const code = await proc.exited;
        // Once the child is gone a timeout or abort has nothing to kill: a late signal would hit a dead (or reused) pid while we only drain pipes.
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        // A killed process can leave a grandchild holding the pipes open, so a cancelled call never waits for them to drain.
        if (signal.aborted) throw abortError();
        if (timedOut) throw new ProviderError(`claude timed out after ${req.timeoutMs}ms`, null, true);
        const [stdout, stderr] = await reading;
        return { stdout, stderr, code };
      } finally {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
      }
    } finally {
      if (staged) await rm(staged.dir, { recursive: true, force: true });
      release();
    }
  }

  /** The result message, or the ProviderError that explains why there is none. */
  function settle(req: ClaudeRequest, run: Outcome): { readonly result: Json; readonly usage: UsageReport } {
    const result = findResult(run.stdout);
    if (result === null) {
      const why = run.stderr.trim().slice(-500) || run.stdout.trim().slice(-200) || "no output";
      throw new ProviderError(`claude exited ${run.code} without a result: ${why}`, null, run.code !== 0 && isTransient(why, null));
    }
    const usage = usageOf(result, req.model);
    if (result.is_error === true || (asString(result.subtype)?.startsWith("error") ?? false)) throw failureOf(result, usage);
    return { result, usage };
  }

  return {
    async structured<O>(req: ClaudeRequest, schema: z.ZodType<O>, signal: AbortSignal) {
      const run = await execute(req, "json", toJsonSchema(schema), signal);
      const { result, usage } = settle(req, run);
      const payload = structuredPayload(result);
      if (payload === undefined) throw new ProviderError("claude returned no structured output", usage, false);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new ProviderError(`claude output failed validation: ${parsed.error.message.slice(0, 500)}`, usage, false);
      return { output: parsed.data, usage };
    },

    async streamText(req, onText, signal) {
      const deltas = createDeltaReader(onText);
      const run = await execute(req, "stream-json", null, signal, (line) => {
        try {
          deltas.read(JSON.parse(line));
        } catch {
          // a line that is not an event is not a delta
        }
      });
      const { result, usage } = settle(req, run);
      const final = asString(result.result);
      return { text: final !== null && final !== "" ? final : deltas.text(), usage };
    },
  };
}
