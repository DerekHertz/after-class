/**
 * The budget at the moment a request is sent, through the real Messages API adapter with a fake network: a request that
 * waited in the concurrency queue, and each continuation of a paused resource search.
 */
import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import { createBudget, ESTIMATE_USD } from "../src/backend/providers/budget";
import type { BudgetLimits } from "../src/backend/providers/budget";
import { createClaudeApi } from "../src/backend/providers/claude-api";
import type { ApiClient } from "../src/backend/providers/claude-api";
import type { ClaudeCli } from "../src/backend/providers/claude";
import { createMemo } from "../src/backend/providers/memo";
import type { Task } from "../src/backend/providers/memo";
import type { Purpose } from "../src/shared/domain";
import { productBoundaryTask } from "../src/backend/providers/jev-tasks";
import { deferred, testUserDb } from "./fakes";
import { boundaryInput, cli, fakeJev, successEnvelope } from "./providers-fixtures";

const KEY = "sk-ant-api03-budget-send-0123456789";
const Out = z.object({ ok: z.boolean() });

const message = (o: { stop?: string; content?: unknown[]; usage?: Record<string, unknown> } = {}): Message =>
  ({
    id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: o.stop ?? "end_turn", stop_sequence: null, stop_details: null,
    content: o.content ?? [{ type: "text", text: '{"ok":true}', citations: null }],
    usage: o.usage ?? { input_tokens: 1_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as unknown as Message;

/** A paused search turn that wrote 100,000 tokens to the 1 hour cache and spent 16,000 on output: $0.80 + $0.32 at Opus list price. */
const PAUSED_1_12 = message({
  stop: "pause_turn",
  content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] }],
  usage: { input_tokens: 0, output_tokens: 16_000, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 }, cache_read_input_tokens: 0 },
});

/** Each `create` waits for the test to answer it. */
function network() {
  const pending: { resolve: (m: Message | Error) => void }[] = [];
  const client: ApiClient = {
    messages: {
      stream: () => {
        throw new Error("no stream call expected");
      },
      create: () => {
        const d = deferred<Message | Error>();
        pending.push(d);
        return d.promise.then((m) => (m instanceof Error ? Promise.reject(m) : m));
      },
    },
  };
  return { client, pending };
}

function apiTask(claude: ClaudeCli, purpose: Purpose, webTools: boolean): Task<{ readonly n: number }, z.infer<typeof Out>> {
  return {
    provider: "claude",
    purpose,
    model: "opus",
    version: "v1",
    maxAttempts: 1,
    canonicalInput: (i) => i,
    attempt: (_i, ctx) => claude.structured({ model: "opus", effort: "low", system: "s", prompt: "p", images: [], webTools, timeoutMs: 60_000 }, Out, ctx),
    decode: (stored) => Out.parse(stored),
  };
}

function world(limits: BudgetLimits, claudeFor?: ClaudeCli) {
  const db = testUserDb();
  let stopped = false;
  const budget = createBudget(db, { limits, stopped: () => stopped });
  const net = network();
  const claude = claudeFor ?? createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client: net.client });
  const memo = createMemo(db, "live", { retryDelayMs: () => 0, budget });
  const holds = () => db.sql.query<{ settled_micros: number | null }, []>("SELECT settled_micros FROM budget_holds ORDER BY reserved_ms, rowid").all().map((h) => h.settled_micros);
  const events = () => db.sql.query<{ purpose: string; cost_kind: string; cost_usd: number | null }, []>("SELECT purpose, cost_kind, cost_usd FROM usage_events ORDER BY rowid").all();
  return { db, budget, net, claude, memo, holds, events, stop: () => (stopped = true) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the stop switch at the moment of sending", () => {
  test("requests waiting in the concurrency queue when the switch goes on are never sent, the wrap-up included", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const running = w.memo.run(apiTask(w.claude, "interpretation", false), { n: 1 });
    await tick();
    expect(w.net.pending).toHaveLength(1);
    const queuedWrapUp = w.memo.run(apiTask(w.claude, "wrap_up", false), { n: 2 });
    const queuedPrep = w.memo.run(apiTask(w.claude, "interpretation", false), { n: 3 });
    await tick();
    w.stop();
    w.net.pending[0]!.resolve(message());
    expect((await running).kind).toBe("hit");
    expect(await queuedWrapUp).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
    expect(await queuedPrep).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
    expect(w.net.pending).toHaveLength(1);
    expect(w.events().map((e) => e.purpose)).toEqual(["interpretation"]);
    expect(w.holds()).toHaveLength(1);
  });

  test("a paused resource search is not continued once the switch is on, and the response already billed keeps its cost", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const run = w.memo.run(apiTask(w.claude, "resource_search", true), { n: 1 });
    await tick();
    w.stop();
    w.net.pending[0]!.resolve(PAUSED_1_12);
    expect(await run).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
    expect(w.net.pending).toHaveLength(1);
    expect(w.events()).toEqual([{ purpose: "resource_search", cost_kind: "estimated", cost_usd: expect.closeTo(1.12, 9) as unknown as number }]);
    expect(w.holds()).toEqual([1_120_000]);
    expect(w.memo.lookup(apiTask(w.claude, "resource_search", true), { n: 1 }).kind).toBe("missing");
  });

  test("each continuation reserves for itself, so one the cap cannot cover is not sent", async () => {
    const w = world({ userUsd: 1.5, totalUsd: 50 });
    const run = w.memo.run(apiTask(w.claude, "resource_search", true), { n: 1 });
    await tick();
    w.net.pending[0]!.resolve(PAUSED_1_12);
    expect(await run).toMatchObject({ kind: "held", hold: { reason: "user_budget", usedUp: false } });
    expect(w.net.pending).toHaveLength(1);
    expect(w.events()).toHaveLength(1);
  });

  test("a continuation the budget admits is sent, and both requests settle at their own prices", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const run = w.memo.run(apiTask(w.claude, "resource_search", true), { n: 1 });
    await tick();
    w.net.pending[0]!.resolve(PAUSED_1_12);
    await tick();
    expect(w.net.pending).toHaveLength(2);
    w.net.pending[1]!.resolve(message());
    expect((await run).kind).toBe("hit");
    expect(w.holds()).toEqual([1_120_000, 6_000]);
  });
});

describe("the other adapters ask at the moment of sending too", () => {
  test("the claude -p adapter: a call queued behind a running one is never spawned once the switch is on", async () => {
    const release = deferred<void>();
    const c = cli((n) => (n === 1 ? { stdout: [JSON.stringify({ ...successEnvelope, structured_output: { ok: true } })], hold: release.promise } : { stdout: [JSON.stringify(successEnvelope)] }), { maxConcurrent: 1 });
    const w = world({ userUsd: 5, totalUsd: 50 }, c.claude);
    const running = w.memo.run(apiTask(c.claude, "interpretation", false), { n: 1 });
    await c.spawned(1);
    const queued = w.memo.run(apiTask(c.claude, "wrap_up", false), { n: 2 });
    await tick();
    w.stop();
    release.resolve();
    expect((await running).kind).toBe("hit");
    expect(await queued).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
    expect(c.calls).toHaveLength(1);
  });

  test("a Jev task asks before its request, so a stopped switch sends nothing", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const { jev, requests } = fakeJev(() => new Error("no Jev request expected"));
    w.stop();
    expect(await w.memo.run(productBoundaryTask(jev), boundaryInput())).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
    expect(requests).toEqual([]);
  });
});

/** A paused search turn that wrote 600,000 tokens to the 1 hour cache and spent 16,000 on output: $4.80 + $0.32, past a $5 cap alone. */
const PAUSED_5_12 = message({
  stop: "pause_turn",
  content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] }],
  usage: { input_tokens: 0, output_tokens: 16_000, cache_creation_input_tokens: 600_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600_000 }, cache_read_input_tokens: 0 },
});

describe("a response's known price counts from the moment it is read", () => {
  test("a first response that alone costs $5.12 holds the continuation under a $5 cap, and the hold says used up", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const run = w.memo.run(apiTask(w.claude, "resource_search", true), { n: 1 });
    await tick();
    w.net.pending[0]!.resolve(PAUSED_5_12);
    await tick();
    await tick();
    expect(w.net.pending.length, "the continuation was sent after the first response had already cost $5.12").toBe(1);
    expect(await run).toMatchObject({ kind: "held", hold: { reason: "user_budget", usedUp: true } });
    expect(w.events()).toEqual([{ purpose: "resource_search", cost_kind: "estimated", cost_usd: expect.closeTo(5.12, 9) as unknown as number }]);
    expect(w.holds()).toEqual([5_120_000]);
  });

  test("a process that ends during the continuation is reconciled at the $5.12 already known plus the continuation's reservation (R17)", async () => {
    const w = world({ userUsd: null, totalUsd: null });
    void w.memo.run(apiTask(w.claude, "resource_search", true), { n: 1 });
    await tick();
    w.net.pending[0]!.resolve(PAUSED_5_12);
    await tick();
    expect(w.net.pending).toHaveLength(2);

    const next = createBudget(w.db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => false });
    expect(next.reconcileInterrupted()).toBe(1);
    expect(w.holds()).toEqual([5_120_000, ESTIMATE_USD.resource_search * 1_000_000]);
    expect(next.allowance(w.db.userId).usedUsd).toBeCloseTo(5.12 + ESTIMATE_USD.resource_search, 9);
    expect(w.events()).toEqual([{ purpose: "resource_search", cost_kind: "unknown", cost_usd: null }]);
  });
});

describe("a continuation whose cost is unknown", () => {
  test("keeps the known cost of the earlier response and adds the continuation's reservation; the usage event stays unknown (R17)", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const run = w.memo.run(apiTask(w.claude, "resource_search", true), { n: 1 });
    await tick();
    w.net.pending[0]!.resolve(PAUSED_1_12);
    await tick();
    w.net.pending[1]!.resolve(new Anthropic.APIConnectionError({ message: "connection reset" }));
    expect((await run).kind).toBe("failed");
    expect(w.events()).toEqual([{ purpose: "resource_search", cost_kind: "unknown", cost_usd: null }]);
    expect(w.holds()).toEqual([1_120_000, ESTIMATE_USD.resource_search * 1_000_000]);
    expect(w.budget.allowance(w.db.userId).usedUsd).toBeCloseTo(1.12 + ESTIMATE_USD.resource_search, 9);
  });
});
