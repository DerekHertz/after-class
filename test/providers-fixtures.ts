import { z } from "zod";
import type { ClaudeProcess, ClaudeRequest, SpawnFn } from "../src/backend/providers/claude";
import { createClaudeCli } from "../src/backend/providers/claude";
import type { JevClient, JevRequest } from "../src/backend/providers/jev";
import type { BoundaryInput, ClaimSupportInput } from "../src/backend/providers/jev-tasks";
import type { UsageReport } from "../src/backend/providers/memo";
import type { Frame, Passage } from "../src/shared/domain";

// ───────────────────────────── fixtures ─────────────────────────────────────

export function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

/** SOI, an APP0 segment to skip, then a baseline frame header carrying the size. */
export function jpeg(w: number, h: number): Uint8Array {
  const b = new Uint8Array(2 + 2 + 16 + 2 + 17 + 2);
  const v = new DataView(b.buffer);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  v.setUint16(4, 16);
  b.set([0xff, 0xc0], 20);
  v.setUint16(22, 17);
  b[24] = 8;
  v.setUint16(25, h);
  v.setUint16(27, w);
  b[29] = 3;
  b.set([0xff, 0xd9], b.length - 2);
  return b;
}

export const passage = (id: string, start: number, text: string) =>
  ({ kind: "passage", id, interval: { start, end: start + 5 }, text }) as unknown as Passage;

export const frame = (id: string, width = 1280, height = 720) => ({ kind: "frame", id, width, height }) as unknown as Frame;

export const withBytes = (f: Frame, bytes: Uint8Array = jpeg(f.width, f.height)) => ({ frame: f, bytes: () => bytes });

export const NEVER = new AbortController().signal;

export const ctx = { signal: NEVER, streamTo: null };

export const answersBody = (answers: unknown, usage: unknown = { input_tokens: 1234, output_tokens: 5 }) => ({ model: "jev-1.13.0", answers, usage });

type Seen = { url: string; headers: Record<string, string>; body: any };

export function scriptedFetch(respond: (seen: Seen) => Response | Promise<Response> | Error): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) };
    seen.push(s);
    const r = respond(s);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch: f as unknown as typeof fetch, seen };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const noulReq = (over: Partial<JevRequest<"q">> = {}): JevRequest<"q"> => ({
  model: "jev-1.13",
  state: { passage: "a" },
  questions: { q: { type: "noul", instructions: "Is state.passage short?" } },
  images: [],
  ...over,
});

// ───────────────────────────── Jev tasks ────────────────────────────────────

type Answered = Record<string, unknown>;

export function fakeJev(respond: (req: JevRequest<string>, call: number) => Answered | Error): { jev: JevClient; requests: JevRequest<string>[] } {
  const requests: JevRequest<string>[] = [];
  const jev: JevClient = {
    async ask(req) {
      requests.push(req as JevRequest<string>);
      const r = respond(req as JevRequest<string>, requests.length);
      if (r instanceof Error) throw r;
      const usage: UsageReport = { model: "jev-1.13.0", inputTokens: 100, outputTokens: 2, cacheReadTokens: null, cost: { kind: "unknown", reason: "typesafe pricing not published" } };
      return { answers: r as never, usage };
    },
  };
  return { jev, requests };
}

export const p = (x: number) => ({ type: "noul" as const, p: x });

export const window = { id: "win_1", ordinal: 3 } as unknown as BoundaryInput["window"];

export const boundaryInput = (over: Partial<BoundaryInput> = {}): BoundaryInput => ({
  window,
  newPassages: [passage("ev_n1", 120, "Now consider the column picture.")],
  contextPassages: [passage("ev_c1", 30, "We solved the row picture."), passage("ev_c2", 60.04, "Each equation is a line.")],
  frames: [],
  ...over,
});

export const claim = (over: Partial<ClaimSupportInput["claim"]> = {}): ClaimSupportInput["claim"] => ({
  text: "Two lines in the plane meet at one point unless parallel.",
  evidence: ["ev_p1" as never],
  visualDependent: false,
  assumptions: ["lines are not identical"],
  ...over,
});

// ───────────────────────────── Claude CLI ───────────────────────────────────

export const req = (over: Partial<ClaudeRequest> = {}): ClaudeRequest => ({
  model: "opus",
  effort: "high",
  system: "You are a careful tutor.",
  prompt: "Summarise the chunk.",
  images: [],
  webTools: false,
  timeoutMs: 5_000,
  ...over,
});

/** A fake `claude` process: scripted stdout chunks, optionally held open until released or killed. */
type Script = { readonly stdout?: readonly (string | Uint8Array)[]; readonly stderr?: string; readonly code?: number; readonly hold?: Promise<void>; readonly ignoreSigterm?: boolean };

type Spawned = { argv: readonly string[]; cwd: string; env: Record<string, string>; stdin: string[]; killed: boolean; signals: (string | number | undefined)[]; ended: boolean };

export function fakeSpawn(script: Script | ((n: number) => Script)): { spawn: SpawnFn; calls: Spawned[]; live: () => number; peak: () => number } {
  const calls: Spawned[] = [];
  let live = 0;
  let peak = 0;
  const spawn: SpawnFn = (argv, opts) => {
    const s = typeof script === "function" ? script(calls.length + 1) : script;
    const call: Spawned = { argv, cwd: opts.cwd, env: opts.env, stdin: [], killed: false, signals: [], ended: false };
    calls.push(call);
    live++;
    peak = Math.max(peak, live);
    const enc = new TextEncoder();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (err = c) });
    let exit!: (code: number) => void;
    const exited = new Promise<number>((r) => (exit = r));
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      live--;
      out.close();
      err.close();
      exit(code);
    };
    void (async () => {
      if (s.hold) await s.hold;
      if (done) return;
      if (s.stderr) err.enqueue(enc.encode(s.stderr));
      for (const chunk of s.stdout ?? []) out.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
      finish(s.code ?? 0);
    })();
    const proc: ClaudeProcess = {
      stdin: { write: (c) => void call.stdin.push(c), end: () => void (call.ended = true) },
      stdout,
      stderr,
      exited,
      kill: (signal) => {
        call.killed = true;
        call.signals.push(signal);
        if (s.ignoreSigterm && signal !== "SIGKILL") return;
        finish(signal === "SIGKILL" ? 137 : 143);
      },
    };
    return proc;
  };
  return { spawn, calls, live: () => live, peak: () => peak };
}

export const cli = (s: Script | ((n: number) => Script), extra: { maxConcurrent?: number; env?: Record<string, string | undefined>; killGraceMs?: number } = {}) => {
  const fake = fakeSpawn(s);
  return { ...fake, claude: createClaudeCli({ bin: "claude", cwd: "/work", maxConcurrent: extra.maxConcurrent ?? 2, spawn: fake.spawn, ...(extra.env ? { env: extra.env } : {}), ...(extra.killGraceMs !== undefined ? { killGraceMs: extra.killGraceMs } : {}) }) };
};

export const Out = z.object({ concepts: z.array(z.string()) });

export const successEnvelope = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 4200,
  num_turns: 1,
  result: "ok",
  session_id: "s-1",
  total_cost_usd: 0.0421,
  structured_output: { concepts: ["row picture", "column picture"] },
  usage: { input_tokens: 120, cache_creation_input_tokens: 30, cache_read_input_tokens: 900, output_tokens: 75, service_tier: "standard", server_tool_use: { web_search_requests: 0 } },
  modelUsage: { "claude-opus-5-5": { inputTokens: 150, outputTokens: 75, cacheReadInputTokens: 900, costUSD: 0.0421 } },
  permission_denials: [],
  a_field_from_the_future: { nested: [1, 2, 3] },
};
