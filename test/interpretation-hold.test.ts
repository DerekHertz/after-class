/**
 * What an interpretation reserves on the Messages API: its counted input at the cache write rate plus 24,000 output tokens (Derek,
 * 2026-11-18), or the flat figure when the count fails. Driven through the real adapter, memo and budget with a fake network.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import { createBudget, ESTIMATE_USD } from "../src/backend/providers/budget";
import { createClaudeApi, RESERVED_OUTPUT_TOKENS } from "../src/backend/providers/claude-api";
import type { ApiClient, ApiStream } from "../src/backend/providers/claude-api";
import type { ClaudeCli } from "../src/backend/providers/claude";
import { createMemo } from "../src/backend/providers/memo";
import type { Task } from "../src/backend/providers/memo";
import { deferred, testUserDb } from "./fakes";

const KEY = "sk-ant-api03-interpretation-hold-0123456789";
const Out = z.object({ ok: z.boolean() });
/** The head of a measured chunk, per docs/trail/sdk-consult-2026-11-17.md. */
const CHUNK_TOKENS = 20_900;

const reply = (): Message =>
  ({
    id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    content: [{ type: "text", text: '{"ok":true}', citations: null }],
    usage: { input_tokens: 1_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as unknown as Message;

/** Streams that end only when the test says so, and a token count that answers `count` or throws it. */
function network(count: number | Error) {
  const open: (() => void)[] = [];
  const counted: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const client: ApiClient = {
    messages: {
      stream(params) {
        sent.push(params as unknown as Record<string, unknown>);
        const done = deferred<void>();
        open.push(() => done.resolve());
        const stream: ApiStream = { on: () => stream, finalMessage: () => done.promise.then(reply), abort: () => {} };
        return stream;
      },
      create: () => Promise.reject(new Error("no create call expected")),
      countTokens: async (params) => {
        counted.push(params as unknown as Record<string, unknown>);
        if (count instanceof Error) throw count;
        return { input_tokens: count };
      },
    },
  };
  return { client, open, counted, sent };
}

/** One chunk's interpretation as the adapter sees it: a long, structured answer. */
function interpretation(claude: ClaudeCli): Task<{ readonly n: number }, z.infer<typeof Out>> {
  return {
    provider: "claude", purpose: "interpretation", model: "opus", version: "v1", maxAttempts: 1, canonicalInput: (i) => i,
    attempt: (i, ctx) => claude.structured({ model: "opus", effort: "high", system: "Interpret.", prompt: `chunk ${i.n}`, images: [], webTools: false, timeoutMs: 60_000, longOutput: true }, Out, ctx),
    decode: (stored) => Out.parse(stored),
  };
}

function world(count: number | Error) {
  const db = testUserDb();
  const budget = createBudget(db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => false });
  const net = network(count);
  const claude = createClaudeApi({ apiKey: KEY, maxConcurrent: 8, client: net.client });
  const memo = createMemo(db, "live", { retryDelayMs: () => 0, budget });
  const task = interpretation(claude);
  const run = (n: number) => memo.run(task, { n });
  const held = () => budget.allowance(db.userId).reservedUsd;
  return { net, run, held };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("an interpretation on the Messages API reserves its counted input", () => {
  test("four chunks preparing at once hold under half of a $5 cap, so a fifth still starts", async () => {
    const w = world(CHUNK_TOKENS);
    const runs = [1, 2, 3, 4, 5].map(w.run);
    await settle();
    expect(w.net.sent).toHaveLength(5);
    // 20,900 tokens written at the 5 minute rate ($5 per million on Opus) plus 24,000 output tokens at $20 per million.
    const each = (CHUNK_TOKENS * 5 + RESERVED_OUTPUT_TOKENS * 20) / 1_000_000;
    expect(each).toBeCloseTo(0.5845, 9);
    expect(w.held()).toBeCloseTo(5 * each, 5);
    expect(w.held()).toBeLessThan(5);
    for (const open of w.net.open) open();
    for (const r of await Promise.all(runs)) expect(r.kind).toBe("hit");
  });

  test("the count is of the request that is sent: same model, system, messages and output format, with its 32,000 limit kept", async () => {
    const w = world(CHUNK_TOKENS);
    const run = w.run(1);
    await settle();
    const [counted, sent] = [w.net.counted[0]!, w.net.sent[0]!];
    expect(counted.model).toBe(sent.model);
    expect(counted.messages).toEqual(sent.messages);
    expect(counted.output_config).toEqual(sent.output_config);
    expect(counted.system).toBe((sent.system as { text: string }[])[0]!.text);
    expect(sent.max_tokens).toBe(32_000);
    w.net.open[0]!();
    expect((await run).kind).toBe("hit");
  });

  test("a count that fails never blocks preparation: the request is sent at today's flat hold", async () => {
    const w = world(new Error("count_tokens rate limited"));
    const runs = [1, 2, 3, 4, 5].map(w.run);
    await settle();
    // Four flat holds fit under $5; the fifth would pass it, so it is held back and never sent.
    expect(w.net.sent).toHaveLength(4);
    expect(w.held()).toBeCloseTo(4 * ESTIMATE_USD.interpretation, 9);
    for (const open of w.net.open) open();
    const kinds = (await Promise.all(runs)).map((r) => r.kind);
    expect(kinds.filter((k) => k === "hit")).toHaveLength(4);
    expect(kinds.filter((k) => k === "held")).toHaveLength(1);
  });

  test("a huge counted input never reserves more than the flat figure the claude -p adapter keeps", async () => {
    const w = world(2_000_000);
    const run = w.run(1);
    await settle();
    expect(w.held()).toBeCloseTo(ESTIMATE_USD.interpretation, 9);
    w.net.open[0]!();
    await run;
  });
});
