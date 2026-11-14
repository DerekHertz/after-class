/**
 * Keeping an idle review's cached tutor prompt warm. A real review, memo, budget and Messages API adapter run against a fake
 * client and a fake clock, so no test opens a socket or waits for a real timer.
 */
import { describe, expect, test } from "bun:test";
import type { ParseableMessageCreateParams as MessageStreamParams } from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { createBudget } from "../src/backend/providers/budget";
import { createClaudeCli } from "../src/backend/providers/claude";
import { createClaudeApi } from "../src/backend/providers/claude-api";
import type { ApiClient, ApiStream } from "../src/backend/providers/claude-api";
import { createMemo } from "../src/backend/providers/memo";
import { createReviews } from "../src/backend/review";
import type { Reviews } from "../src/backend/review";
import { IDLE_LIMIT_MS, PING_AFTER_MS, keepAliveFor } from "../src/backend/review/keepalive";
import { nextThreadId, tutorTask } from "../src/backend/review/tutor";
import type { TutorModel } from "../src/backend/review/tutor";
import type { LearnerAct, TutorMove } from "../src/shared/domain";
import { randomId } from "../src/shared/ids";
import type { ClaimId, ReviewId } from "../src/shared/ids";
import { LOCAL_USER, MIGRATIONS, ensureLocalUser, openDb } from "../src/backend/db";
import { serve } from "../src/backend/http";
import { createLedger } from "../src/backend/providers/ledger";
import { fakeTask, ok, usage } from "./fakes";
import { EXT_ID, TOKEN, fixtureApp, post, world as httpWorld } from "./http-fixtures";
import { answer, collect, rig } from "./review-fixtures";

const KEY = "sk-ant-api03-keepalive-test-0123456789";
/** Experiment 8's lecture context, in tokens. */
const CONTEXT = 69_251;

type Sent = { readonly via: "stream" | "create"; readonly params: MessageStreamParams | MessageCreateParamsNonStreaming; readonly atMs: number };

function apiMessage(text: string | null, usage: Record<string, unknown>, model: string): Message {
  return {
    id: "msg_test", type: "message", role: "assistant", model,
    content: text === null ? [] : [{ type: "text", text, citations: null }],
    stop_reason: text === null ? "max_tokens" : "end_turn", stop_sequence: null, stop_details: null, usage,
  } as unknown as Message;
}

/** Replies to each tutor stream with the next scripted text, and to each keep-alive with a cache read of the whole context. */
function fakeClient(now: () => number, model: string) {
  const sent: Sent[] = [];
  const replies: string[] = [];
  const client: ApiClient = {
    messages: {
      stream(params) {
        sent.push({ via: "stream", params, atMs: now() });
        const text = replies.shift() ?? "";
        let listener: (d: string) => void = () => {};
        const stream: ApiStream = {
          on: (_event, l) => {
            listener = l;
            return stream;
          },
          async finalMessage() {
            listener(text);
            return apiMessage(text, { input_tokens: 900, output_tokens: 40, cache_creation_input_tokens: CONTEXT, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: CONTEXT, ephemeral_1h_input_tokens: 0 } }, model);
          },
          abort: () => {},
        };
        return stream;
      },
      async create(params) {
        sent.push({ via: "create", params, atMs: now() });
        return apiMessage(null, { input_tokens: 3, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: CONTEXT }, model);
      },
    },
  };
  return { client, sent, replies };
}

function world(opts: { model?: TutorModel } = {}) {
  const model = opts.model ?? "sonnet";
  const r = rig();
  r.world.close(0, 0, 300);
  const claim: ClaimId = r.world.claim(1, 10, 20);
  let at = Date.UTC(2026, 10, 13, 12);
  let stopped = false;
  const timers: { due: number; fn: () => void; live: boolean }[] = [];
  const after = (ms: number, fn: () => void) => {
    const t = { due: at + ms, fn, live: true };
    timers.push(t);
    return () => void (t.live = false);
  };
  const budget = createBudget(r.db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => stopped, now: () => at });
  const memo = createMemo(r.db, "live", { retryDelayMs: () => 0, now: () => at, budget });
  const api = fakeClient(() => at, model === "opus" ? "claude-opus-5-5" : "claude-sonnet-5-5");
  const claude = createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client: api.client });
  const errors: unknown[] = [];
  let reviews: Reviews | null = null;
  const keepAlive = keepAliveFor(claude, model, {
    memo,
    ended: (id) => reviews!.view(id).state.phase === "ended",
    now: () => at,
    after,
    onError: (_id, e) => errors.push(e),
  })!;
  const tutor = tutorTask(claude, model, keepAlive.sent);
  reviews = createReviews(r.db, { ...r.world.deps, runTutor: (input, streamTo, signal, onRetry) => memo.run(tutor, input, { signal, streamTo, onRetry }), clearFailures: memo.clearFailures }, { now: () => at });
  const reviewId: ReviewId = randomId("rvw");
  const start = reviews.start(r.capture, "prepared_only", reviewId);
  if (start.kind !== "started") throw new Error(`expected a started review, got ${start.kind}`);

  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** Moves the clock, firing each timer that falls due on the way, in order, and letting what it starts finish. */
  async function advance(ms: number) {
    const end = at + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (next === undefined) break;
      at = next.due;
      next.live = false;
      next.fn();
      await flush();
    }
    at = end;
  }
  const say = (move: TutorMove, text: string) => api.replies.push(`${JSON.stringify(move)}\n${text}`);
  async function turn(act: LearnerAct) {
    const events = await collect(reviews!.turn(reviewId, randomId("turn"), act));
    await flush();
    return events;
  }
  /** The learner opens the review and the tutor asks its first question: one streamed tutor request. */
  async function open() {
    say({ kind: "ask_main", threadId: nextThreadId({ reviewId, mainQuestions: 0 }), claimIds: [claim] }, "In your own words, what was the main idea?");
    const events = await turn({ kind: "begin" });
    expect(events.some((e) => e.type === "move")).toBe(true);
  }
  const pings = () => api.sent.filter((s) => s.via === "create");
  const streams = () => api.sent.filter((s) => s.via === "stream");
  const keepAliveEvents = () =>
    r.db.sql.query<{ outcome: string; model: string; cost_kind: string; cost_usd: number | null; cache_read_tokens: number | null }, []>(
      "SELECT outcome, model, cost_kind, cost_usd, cache_read_tokens FROM usage_events WHERE purpose = 'cache_keepalive' ORDER BY started_ms",
    ).all();
  const keepAliveHolds = () => r.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM budget_holds WHERE purpose = 'cache_keepalive'").get()!.n;
  return { reviewId, keepAlive, memo, db: r.db, reviews, advance, open, turn, say, pings, streams, keepAliveEvents, keepAliveHolds, errors, stop: (on: boolean) => (stopped = on), now: () => at };
}

describe("the tutor's cached prompt", () => {
  test("is written to the 5 minute cache", async () => {
    const w = world();
    await w.open();
    const params = w.streams()[0]!.params;
    expect(params.system).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral", ttl: "5m" } })]);
  });
});

describe("keep-alive while the review is idle", () => {
  test("re-sends the same prefix with max_tokens 0 and streaming off, a minute before the 5 minute entry expires", async () => {
    const w = world();
    await w.open();
    const turnAt = w.streams()[0]!.atMs;
    await w.advance(PING_AFTER_MS - 1);
    expect(w.pings()).toHaveLength(0);
    await w.advance(1);
    expect(w.pings()).toHaveLength(1);
    const ping = w.pings()[0]!;
    expect(ping.atMs - turnAt).toBeLessThan(5 * 60_000);
    const real = w.streams()[0]!.params as unknown as Record<string, unknown>;
    const sent = ping.params as unknown as Record<string, unknown>;
    expect(sent.max_tokens).toBe(0);
    expect(sent.stream).toBeUndefined();
    for (const field of ["model", "system", "tools", "thinking", "output_config", "tool_choice"]) expect(sent[field], field).toEqual(real[field]);
    expect(sent.model).toBe("claude-sonnet-5-5");
    expect(sent.output_config).toEqual({ effort: "medium" });
    expect(sent.messages).toEqual([{ role: "user", content: expect.any(String) }]);
  });

  test("keeps going every PING_AFTER_MS while idle, and a learner turn restarts the clock", async () => {
    const w = world();
    await w.open();
    await w.advance(3 * PING_AFTER_MS);
    expect(w.pings()).toHaveLength(3);
    w.say({ kind: "ask_followup", threadId: nextThreadId({ reviewId: w.reviewId, mainQuestions: 0 }) }, "Say more about that.");
    await w.turn(answer("rows are equations"));
    expect(w.streams().length).toBeGreaterThan(1);
    const before = w.pings().length;
    await w.advance(PING_AFTER_MS - 1);
    expect(w.pings()).toHaveLength(before);
    await w.advance(1);
    expect(w.pings()).toHaveLength(before + 1);
  });

  test("stops after 60 minutes with no tutor request", async () => {
    const w = world();
    await w.open();
    await w.advance(IDLE_LIMIT_MS + 3 * PING_AFTER_MS);
    const last = w.pings().at(-1)!.atMs - w.streams()[0]!.atMs;
    expect(last).toBeLessThan(IDLE_LIMIT_MS);
    expect(w.pings()).toHaveLength(Math.ceil(IDLE_LIMIT_MS / PING_AFTER_MS) - 1);
  });

  test("stops once the review has ended", async () => {
    const w = world();
    await w.open();
    w.say({ kind: "wrap_up" }, "Let's wrap up here.");
    await w.turn({ kind: "end" });
    await w.advance(IDLE_LIMIT_MS);
    expect(w.pings()).toHaveLength(0);
  });

  test("the app's leave request stops it, and a review that is not this user's answers 404", async () => {
    const w = world();
    await w.open();
    const server = serve({
      modules: { ledger: createLedger(w.db), evidence: httpWorld().evidence, reviews: w.reviews, keepAlive: w.keepAlive },
      auth: { port: 0, extensionId: EXT_ID, token: TOKEN },
      appDir: fixtureApp(),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await post(base, `/reviews/${randomId("rvw")}/leave`, {})).status).toBe(404);
      expect((await post(base, `/reviews/${w.reviewId}/leave`, {})).status).toBe(204);
      await w.advance(2 * PING_AFTER_MS);
      expect(w.pings()).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("stops when the learner leaves, and starts again with their next turn", async () => {
    const w = world();
    await w.open();
    w.keepAlive.leave(w.reviewId);
    await w.advance(2 * PING_AFTER_MS);
    expect(w.pings()).toHaveLength(0);
    w.say({ kind: "ask_followup", threadId: nextThreadId({ reviewId: w.reviewId, mainQuestions: 0 }) }, "Say more about that.");
    await w.turn(answer("rows are equations"));
    await w.advance(PING_AFTER_MS);
    expect(w.pings()).toHaveLength(1);
  });

  test("the stop switch holds a keep-alive: nothing is sent, nothing is recorded, and it does not try again", async () => {
    const w = world();
    await w.open();
    w.stop(true);
    await w.advance(PING_AFTER_MS);
    w.stop(false);
    await w.advance(IDLE_LIMIT_MS);
    expect(w.pings()).toHaveLength(0);
    expect(w.keepAliveEvents()).toEqual([]);
    expect(w.keepAliveHolds()).toBe(0);
    expect(w.errors).toEqual([]);
  });

  test("a cap holds it the same way: a keep-alive is not exempt", async () => {
    const w = world();
    await w.open();
    // The first turn cost about $0.18; this brings the month within $0.02, the keep-alive's estimate, of the $5 cap.
    const spend = fakeTask<{ n: number }, string>({ purpose: "claim_revision", provider: "claude", answer: () => ok("x", { usage: usage({ kind: "measured", usd: 4.82 }) }) });
    expect((await w.memo.run(spend, { n: 1 })).kind).toBe("hit");
    await w.advance(2 * PING_AFTER_MS);
    expect(w.pings()).toHaveLength(0);
    expect(w.keepAliveEvents()).toEqual([]);
  });

  test("each keep-alive records a usage event and settles its hold at the cache read price", async () => {
    const w = world();
    await w.open();
    await w.advance(2 * PING_AFTER_MS);
    const events = w.keepAliveEvents();
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e).toMatchObject({ outcome: "ok", model: "claude-sonnet-5-5", cost_kind: "estimated", cache_read_tokens: CONTEXT });
      // 69,251 tokens read at $0.10 per million, plus 3 fresh input tokens at $2.
      expect(e.cost_usd!).toBeCloseTo((CONTEXT * 0.1 + 3 * 2) / 1_000_000, 9);
    }
    expect(w.keepAliveHolds()).toBe(2);
  });

  test("on Opus the keep-alive uses the Opus prefix", async () => {
    const w = world({ model: "opus" });
    await w.open();
    await w.advance(PING_AFTER_MS);
    expect(w.pings()[0]!.params.model).toBe("claude-opus-5-5");
  });
});

describe("where no keep-alive runs", () => {
  test("the claude -p backend cannot keep a cache warm, so it gets none", () => {
    const cli = createClaudeCli({ bin: "claude", cwd: "/nonexistent", maxConcurrent: 1, env: {} });
    const memo = createMemo(rig().db, "live");
    expect(keepAliveFor(cli, "opus", { memo, ended: () => false })).toBeNull();
  });
});

describe("migration 006-keepalive-purpose", () => {
  test("keeps every memo and usage row and constraint, and accepts cache_keepalive", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/afterclass-migration-${crypto.randomUUID()}.sqlite`;
    const insertInput = (key: string, purpose: string) =>
      `INSERT INTO memo_inputs (user_id, key, provider, purpose, version, model, input_json, first_seen_ms) VALUES ('${LOCAL_USER}','${key}','claude','${purpose}','v','m','{}',1)`;
    const insertEvent = (id: string, key: string, purpose: string) =>
      `INSERT INTO usage_events (id, user_id, memo_key, capture_id, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens, cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
       VALUES ('${id}','${LOCAL_USER}','${key}','cap_x',1,'claude','m','${purpose}','ok',1,2,3,'estimated',0.5,'list',NULL,7,8)`;
    const old = { ...MIGRATIONS, providers: MIGRATIONS.providers.filter((m) => m.id !== "006-keepalive-purpose") };
    let db = openDb(path, old);
    ensureLocalUser(db);
    db.sql.run(insertInput("k1", "tutor_turn"));
    db.sql.run(`INSERT INTO memo (user_id, key, output_json, seq, stored_ms) VALUES ('${LOCAL_USER}','k1','{}',1,1)`);
    db.sql.run(`INSERT INTO memo_failures (user_id, key, attempts, last_error, seq, terminal) VALUES ('${LOCAL_USER}','k1',1,'e',2,0)`);
    db.sql.run(insertEvent("u1", "k1", "tutor_turn"));
    expect(() => db.sql.run(insertInput("k0", "cache_keepalive"))).toThrow(/CHECK/);
    const before = db.sql.query("SELECT * FROM usage_events").all();
    db.close();

    db = openDb(path);
    expect(db.sql.query("SELECT * FROM usage_events").all()).toEqual(before);
    for (const table of ["memo_inputs", "memo", "memo_failures"]) expect(db.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 1 });
    expect(db.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.sql.run(insertInput("k2", "cache_keepalive"));
    db.sql.run(insertEvent("u2", "k2", "cache_keepalive"));
    expect(() => db.sql.run("UPDATE usage_events SET model = 'y'")).toThrow(/R17/);
    expect(() => db.sql.run("DELETE FROM usage_events")).toThrow(/R17/);
    expect(() => db.sql.run(insertEvent("u3", "missing-key", "tutor_turn"))).toThrow(/FOREIGN KEY/);
    expect(() => db.sql.run(insertInput("k3", "nonsense"))).toThrow(/CHECK/);
    expect(() => db.sql.run(insertInput("k1", "tutor_turn"))).toThrow(/UNIQUE|PRIMARY/);
    db.close();
  });
});
