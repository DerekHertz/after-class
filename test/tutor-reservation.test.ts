/**
 * #236: a tutor turn reserves what its own request could cost, not one flat figure. Every request goes through the real tutor
 * task, memo, budget and Messages API adapter over a fake network, so the reservation is the one the backend would take. Nothing is paid.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { ensureLocalUser, scopeDb } from "../src/backend/db";
import type { Db, UserDb } from "../src/backend/db";
import { createBudget, periodOf } from "../src/backend/providers/budget";
import Anthropic from "@anthropic-ai/sdk";
import { REQUEST_OVERHEAD_TOKENS, cliStreamEstimateUsd, createClaudeApi, priceUsage, streamEstimateUsd } from "../src/backend/providers/claude-api";
import type { ApiClient } from "../src/backend/providers/claude-api";
import { createClaudeCli } from "../src/backend/providers/claude";
import { createMemo } from "../src/backend/providers/memo";
import { LONG_PAUSE_MS, TUTOR_MAX_OUTPUT_TOKENS, allowedMoves, nextThreadId, reviewState, tutorCache, tutorRequest, tutorTask } from "../src/backend/review/tutor";
import type { TutorInput, TutorModel } from "../src/backend/review/tutor";
import type { AssessableClaim, EvidenceBundle, FrozenScope, Passage, Turn, TutorMove } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { ClaimId, ConceptId, EvidenceId, ReviewId, SourceId, ThreadId, TurnId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { testDb, testSeq } from "./fakes";
import { fakeSpawn } from "./providers-fixtures";

const MINUTE = 60_000;
const KEY = "sk-ant-api03-tutor-reservation-0123456789";
const SRC = stableId("src", "youtube", "abcdefghijk") as SourceId;
const EV = stableId("ev", "passage", 1) as EvidenceId;
const CLAIM = { id: stableId("clm", 1) as ClaimId, conceptId: stableId("cpt", 1) as ConceptId, text: "claim 1", evidence: [EV], assumptions: [] } as unknown as AssessableClaim;
const SCOPE: FrozenScope = { chunkRevisions: [stableId("crv", "c1")], material: Material.of([[SRC, [interval(0, 600)]]]), claimsAtStart: [CLAIM.id], partial: [], frozenAtSeq: testSeq(1) };
const passage = (bytes: number) => ({ kind: "passage", id: EV, sourceId: SRC, transcriptRevId: stableId("trv", "t"), interval: interval(10, 20), text: "x".repeat(bytes), origin: "panel" }) as unknown as Passage;

/** The audit's lecture: the system block of its 12 turns was 49,844 bytes, so a passage that makes this one about that long. */
const AUDIT_PASSAGE_BYTES = 49_000;

const review = (n: number) => stableId("rvw", `r${n}`) as ReviewId;

function turnInput(reviewId: ReviewId, n: number, passageBytes = 100): TutorInput {
  const thread = nextThreadId({ reviewId, mainQuestions: 0 }) as ThreadId;
  const turns: Turn[] = [];
  const push = (t: Omit<Turn, "id" | "reviewId" | "seq" | "atMs">) => {
    const k = turns.length + 1;
    turns.push({ ...t, id: stableId("turn", reviewId, k) as TurnId, reviewId, seq: testSeq(k), atMs: k } as Turn);
  };
  push({ actor: "tutor", threadId: thread, move: { kind: "ask_main", threadId: thread, claimIds: [CLAIM.id] }, say: "Question?" } as never);
  for (let i = 1; i <= n; i++) {
    if (i > 1) push({ actor: "tutor", threadId: thread, move: { kind: "ask_followup", threadId: thread }, say: "Say more." } as never);
    push({ actor: "learner", threadId: thread, act: { kind: "answer", text: `answer ${i}`, modality: "text" } } as never);
  }
  const state = reviewState(reviewId, turns, [], 600, 0);
  const evidence: EvidenceBundle = { material: SCOPE.material, passages: [passage(passageBytes)], frames: [], gaps: [], ads: [] };
  return { state, allowed: [...allowedMoves(state, { turns, claims: [CLAIM] })], scope: SCOPE, claims: [CLAIM], evidence, turns, priorObservations: [], repairNote: null };
}

type Usage = { input: number; creation: number; read: number; output: number };
type Network = { usage: (system: string) => Usage; stop?: string; gate?: Promise<void>; /** The first this many requests are rejected with a 429 before any inference. */ rejectFirst?: number };

function reply(text: string, u: Usage, ttl: string, stop = "end_turn"): Message {
  return {
    id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: stop, stop_sequence: null, stop_details: null,
    content: [{ type: "text", text, citations: null }],
    usage: { input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.creation, cache_read_input_tokens: u.read, cache_creation: { ephemeral_5m_input_tokens: ttl === "5m" ? u.creation : 0, ephemeral_1h_input_tokens: ttl === "1h" ? u.creation : 0 } },
  } as unknown as Message;
}

function rig(limits: { userUsd: number | null; totalUsd: number | null } = { userUsd: 5, totalUsd: null }, skewMs = 0) {
  const root: Db = testDb();
  const me: UserDb = scopeDb(root, ensureLocalUser(root));
  let t = 1_000_000_000;
  const budget = createBudget(root, { limits, stopped: () => false, now: () => t });
  const sent: { max_tokens: number; system: string; ttl: string }[] = [];
  let rejected = 0;
  let net: Network = { usage: () => ({ input: 10, creation: 0, read: 0, output: 20 }) };

  const client: ApiClient = {
    messages: {
      stream(params) {
        const p = params as { max_tokens: number; system: { text: string; cache_control: { ttl: string } }[] };
        const system = p.system[0]!.text;
        const ttl = p.system[0]!.cache_control.ttl;
        sent.push({ max_tokens: p.max_tokens, system, ttl });
        const plan = net;
        const text = `${JSON.stringify({ kind: "ask_followup", threadId: nextThreadId({ reviewId: review(0), mainQuestions: 0 }) } satisfies TutorMove)}\nSay more.`;
        const stream = {
          on: () => stream,
          finalMessage: async () => {
            await plan.gate;
            if (rejected < (plan.rejectFirst ?? 0)) {
              rejected++;
              throw new Anthropic.RateLimitError(429, {}, "slow down", new Headers());
            }
            return reply(text, plan.usage(system), ttl, plan.stop);
          },
          abort: () => {},
        };
        return stream;
      },
      create: () => Promise.reject(new Error("the tutor only streams")),
    },
  };
  const claude = createClaudeApi({ apiKey: KEY, maxConcurrent: 8, client });
  const memo = createMemo(me, "live", { budget, now: () => t, retryDelayMs: () => 0 });
  // A skew models the time a slow database write takes: every read of the cache's clock is later than the last.
  let reads = 0;
  const cache = tutorCache(me, () => t + reads++ * skewMs);
  const turn = (model: TutorModel, input: TutorInput) => memo.run(tutorTask(claude, cache, model), input, { review: input.state.reviewId });
  const holds = () => root.sql.query<{ purpose: string; reserved_micros: number; settled_micros: number | null }, []>(`SELECT purpose, reserved_micros, settled_micros FROM budget_holds ORDER BY reserved_ms, rowid`).all();
  const used = (usd: number) => root.sql.query("INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms, settled_micros, settled_ms) VALUES (?, ?, ?, 'claim_revision', ?, 1, 1, ?, 1)").run(`h${Math.random()}`, me.userId, periodOf(t), `k${Math.random()}`, Math.round(usd * 1e6));
  return { root, me, budget, turn, holds, used, sent, net: (n: Network) => (net = n), at: (min: number) => ((reads = 0), (t = 1_000_000_000 + min * MINUTE)), cache, allowance: () => budget.allowance(me.userId) };
}

const micros = (usd: number) => Math.round(usd * 1e6);

describe("the reservation follows the request", () => {
  test("a longer lecture reserves more, and Opus reserves more than Sonnet", async () => {
    const reserved = async (model: TutorModel, bytes: number, n: number) => {
      const r = rig({ userUsd: null, totalUsd: null });
      await r.turn(model, turnInput(review(n), 1, bytes));
      return r.holds()[0]!.reserved_micros;
    };
    const small = await reserved("sonnet", 1_000, 1);
    const large = await reserved("sonnet", AUDIT_PASSAGE_BYTES, 2);
    const opus = await reserved("opus", AUDIT_PASSAGE_BYTES, 3);
    expect(large).toBeGreaterThan(small + micros(0.1));
    expect(opus).toBeGreaterThan(large * 1.9);
    expect(opus).toBeLessThan(large * 2.1);
  });

  test("the reservation is the request's estimate: its own bytes written at the lifetime it sends, and its output limit", () => {
    const input = turnInput(review(4), 1, AUDIT_PASSAGE_BYTES);
    const req = tutorRequest(input, "sonnet");
    const bytes = new TextEncoder().encode(req.system + req.prompt).length;
    const cold = streamEstimateUsd("claude-sonnet-5-5", req, "5m")!;
    expect(cold).toBeCloseTo(((bytes + REQUEST_OVERHEAD_TOKENS) * 2 * 1.25 + TUTOR_MAX_OUTPUT_TOKENS * 10) / 1e6, 12);
    expect(streamEstimateUsd("claude-sonnet-5-5", req, "1h")!).toBeGreaterThan(cold);
    expect(streamEstimateUsd("claude-sonnet-5-5", req)!).toBeCloseTo(streamEstimateUsd("claude-sonnet-5-5", req, "1h")!, 12);
  });

  test("the request asks the API for at most TUTOR_MAX_OUTPUT_TOKENS", async () => {
    const r = rig();
    await r.turn("sonnet", turnInput(review(5), 1));
    expect(r.sent.map((s) => s.max_tokens)).toEqual([TUTOR_MAX_OUTPUT_TOKENS]);
    expect(TUTOR_MAX_OUTPUT_TOKENS).toBe(8_000);
  });
});

describe("a turn never settles above its reservation", () => {
  /** The adversarial response: every input byte a token written at the request's own rate, and the whole output limit spent. */
  const worst = (writeBytes: (system: string) => number, read = 0): Network => ({
    usage: (system) => ({ input: 0, creation: writeBytes(system) + REQUEST_OVERHEAD_TOKENS, read, output: TUTOR_MAX_OUTPUT_TOKENS }),
    stop: "max_tokens",
  });

  for (const model of ["sonnet", "opus"] as const) {
    test(`${model}: a first turn that writes every byte and spends all its output settles at or under what it reserved`, async () => {
      const r = rig();
      const input = turnInput(review(6), 1, AUDIT_PASSAGE_BYTES);
      const req = tutorRequest(input, model);
      const total = new TextEncoder().encode(req.system + req.prompt).length;
      r.net({ ...worst(() => total), usage: () => ({ input: 0, creation: total + REQUEST_OVERHEAD_TOKENS, read: 0, output: TUTOR_MAX_OUTPUT_TOKENS }) });
      const result = await r.turn(model, input);
      expect(result.kind).toBe("failed");
      const [hold] = r.holds();
      expect(hold!.settled_micros).toBeGreaterThan(micros(0.2));
      expect(hold!.settled_micros!).toBeLessThanOrEqual(hold!.reserved_micros);
    });
  }

  test("a second turn within 5 minutes whose cache is gone writes every byte again and still settles at or under its reservation", async () => {
    const r = rig();
    const input = turnInput(review(7), 1, AUDIT_PASSAGE_BYTES);
    r.at(0);
    r.net({ usage: () => ({ input: 0, creation: 0, read: 12_000, output: 100 }) });
    await r.turn("sonnet", input);
    r.at(2);
    const second = turnInput(review(7), 2, AUDIT_PASSAGE_BYTES);
    const req = tutorRequest(second, "sonnet");
    const total = new TextEncoder().encode(req.system + req.prompt).length;
    r.net({ usage: () => ({ input: 0, creation: total + REQUEST_OVERHEAD_TOKENS, read: 0, output: TUTOR_MAX_OUTPUT_TOKENS }), stop: "max_tokens" });
    await r.turn("sonnet", second);
    const hold = r.holds()[1]!;
    expect(hold.settled_micros!).toBeGreaterThan(micros(0.2));
    expect(hold.settled_micros!).toBeLessThanOrEqual(hold.reserved_micros);
  });

  test("a retry after a 429 rejected before inference reserves a cache write, not a read, and settles at or under it (round 2, finding 1)", async () => {
    const r = rig({ userUsd: null, totalUsd: null });
    const input = turnInput(review(9), 1, AUDIT_PASSAGE_BYTES);
    const req = tutorRequest(input, "sonnet");
    const total = new TextEncoder().encode(req.system + req.prompt).length;
    r.net({ usage: () => ({ input: 0, creation: total + REQUEST_OVERHEAD_TOKENS, read: 0, output: TUTOR_MAX_OUTPUT_TOKENS }), stop: "max_tokens", rejectFirst: 1 });
    r.at(0);
    await r.turn("sonnet", input);
    const holds = r.holds();
    expect(r.sent).toHaveLength(2);
    expect(holds).toHaveLength(2);
    const retry = holds[1]!;
    expect(retry.reserved_micros).toBeGreaterThan(micros(0.2));
    expect(retry.settled_micros!).toBeGreaterThan(micros(0.2));
    expect(retry.settled_micros!).toBeLessThanOrEqual(retry.reserved_micros);
  });

  test("a retry after a 429 cannot take a nearly spent cap past it", async () => {
    const r = rig({ userUsd: 5, totalUsd: null });
    r.used(4.8);
    const input = turnInput(review(11), 1, AUDIT_PASSAGE_BYTES);
    const req = tutorRequest(input, "sonnet");
    const total = new TextEncoder().encode(req.system + req.prompt).length;
    r.net({ usage: () => ({ input: 0, creation: total + REQUEST_OVERHEAD_TOKENS, read: 0, output: TUTOR_MAX_OUTPUT_TOKENS }), stop: "max_tokens", rejectFirst: 1 });
    await r.turn("sonnet", input);
    const spent = r.holds().filter((h) => h.purpose === "tutor_turn").reduce((s, h) => s + (h.settled_micros ?? h.reserved_micros), 0);
    expect(spent + micros(4.8)).toBeLessThanOrEqual(micros(5));
  });
});

describe("a turn after a long pause", () => {
  test("writes every byte at the 1 hour rate and still settles at or under what it reserved", async () => {
    const r = rig();
    r.at(0);
    await r.turn("sonnet", turnInput(review(8), 1, AUDIT_PASSAGE_BYTES));
    r.at(10);
    const second = turnInput(review(8), 2, AUDIT_PASSAGE_BYTES);
    const req = tutorRequest(second, "sonnet");
    const total = new TextEncoder().encode(req.system + req.prompt).length;
    r.net({ usage: () => ({ input: 0, creation: total + REQUEST_OVERHEAD_TOKENS, read: 0, output: TUTOR_MAX_OUTPUT_TOKENS }), stop: "max_tokens" });
    await r.turn("sonnet", second);
    const hold = r.holds()[1]!;
    expect(hold.reserved_micros).toBeGreaterThan(micros(0.3));
    expect(hold.settled_micros!).toBeLessThanOrEqual(hold.reserved_micros);
    expect(hold.settled_micros!).toBeGreaterThan(micros(0.3));
  });
});

describe("concurrent turns", () => {
  test("four admitted at once cannot take a user past their cap, because each holds its own worst case", async () => {
    const cap = 0.6;
    const r = rig({ userUsd: cap, totalUsd: null });
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    const inputs = [10, 11, 12, 13].map((n) => turnInput(review(n), 1, AUDIT_PASSAGE_BYTES));
    const req = tutorRequest(inputs[0]!, "sonnet");
    const total = new TextEncoder().encode(req.system + req.prompt).length;
    r.net({ usage: () => ({ input: 0, creation: total + REQUEST_OVERHEAD_TOKENS, read: 0, output: TUTOR_MAX_OUTPUT_TOKENS }), stop: "max_tokens", gate });
    const running = inputs.map((i) => r.turn("sonnet", i));
    await Bun.sleep(20);
    open();
    const results = await Promise.all(running);
    const sentCount = r.sent.length;
    const spent = r.holds().reduce((s, h) => s + (h.settled_micros ?? h.reserved_micros), 0);
    expect(sentCount).toBe(2);
    expect(results.filter((x) => x.kind === "held")).toHaveLength(4 - sentCount);
    expect(spent).toBeLessThanOrEqual(micros(cap));
  });
});

describe("a learner near the cap", () => {
  test("on Sonnet a later turn of the audit's lecture is admitted at $4.70 of $5, a first turn at $4.75, and both are held at $4.80", async () => {
    const r = rig();
    r.at(0);
    await r.turn("sonnet", turnInput(review(20), 1, AUDIT_PASSAGE_BYTES));
    r.used(4.7);
    r.at(1);
    expect((await r.turn("sonnet", turnInput(review(20), 2, AUDIT_PASSAGE_BYTES))).kind).not.toBe("held");
    const r2 = rig();
    r2.used(4.75);
    expect((await r2.turn("sonnet", turnInput(review(22), 1, AUDIT_PASSAGE_BYTES))).kind).not.toBe("held");
    const r3 = rig();
    r3.used(4.8);
    expect((await r3.turn("sonnet", turnInput(review(23), 1, AUDIT_PASSAGE_BYTES))).kind).toBe("held");
    expect(r3.sent).toHaveLength(0);
  });

  test("a learner with less than the reservation left is held, and Opus needs more headroom than Sonnet", async () => {
    const r = rig();
    r.at(0);
    await r.turn("sonnet", turnInput(review(21), 1, AUDIT_PASSAGE_BYTES));
    r.used(4.6);
    r.at(1);
    const opus = await r.turn("opus", turnInput(review(21), 2, AUDIT_PASSAGE_BYTES));
    expect(opus.kind).toBe("held");
    const sonnet = await r.turn("sonnet", turnInput(review(21), 2, AUDIT_PASSAGE_BYTES));
    expect(sonnet.kind).not.toBe("held");
  });
});

describe("tutorCache.decide", () => {
  test("is 5 minutes with no earlier start, 5 minutes within 4.5 minutes, 1 hour after, and stays 1 hour", () => {
    const r = rig();
    const id = review(30);
    expect(r.cache.decide(id).ttl).toBe("5m");
    r.at(0);
    r.cache.decide(id).record();
    r.at(4);
    expect(r.cache.decide(id).ttl).toBe("5m");
    r.at(4.6);
    const late = r.cache.decide(id);
    expect(late.ttl).toBe("1h");
    late.record();
    r.at(5);
    expect(r.cache.decide(id).ttl).toBe("1h");
    r.at(30);
    expect(r.cache.decide(id).ttl).toBe("1h");
  });

  test("a decision that is not recorded changes nothing", () => {
    const r = rig();
    const id = review(31);
    r.at(0);
    r.cache.decide(id).record();
    r.at(4);
    r.cache.decide(id);
    r.at(8);
    expect(r.cache.decide(id).ttl).toBe("1h");
    r.at(8.1);
    const row = r.me.sql.query<{ last_start_ms: number }, []>("SELECT last_start_ms FROM tutor_cache").get();
    expect(row!.last_start_ms).toBe(1_000_000_000);
  });
});

describe("one decision for the reservation and the request (round 2, finding 3)", () => {
  test("a slow admission, 1.85 seconds late, near the long-pause line still sends the lifetime it reserved for", async () => {
    // Each read of the cache's clock after the first is 1.85 seconds later, as a slow database write would make it between the decision and the send.
    const r = rig({ userUsd: null, totalUsd: null }, 1_850);
    const id = review(40);
    r.at(0);
    await r.turn("sonnet", turnInput(id, 1, AUDIT_PASSAGE_BYTES));
    // The first read of the clock is 1 second short of the long-pause line, so it decides 5 minutes and any later read decides 1 hour.
    r.at((LONG_PAUSE_MS - 1_000) / MINUTE);
    const second = turnInput(id, 2, AUDIT_PASSAGE_BYTES);
    await r.turn("sonnet", second);
    const hold = r.holds()[1]!;
    const sentTtl = r.sent[1]!.ttl;
    const req = tutorRequest(second, "sonnet");
    expect(sentTtl).toBe("5m");
    expect(hold.reserved_micros).toBe(Math.ceil(streamEstimateUsd("claude-sonnet-5-5", req, sentTtl as "5m" | "1h")! * 1e6));
  });
});

describe("the claude -p tutor turn (round 2, finding 2)", () => {
  const done = (text: string, usd: number) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: usd, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 } }) + "\n";
  function cliRig(limits: { userUsd: number | null; totalUsd: number | null }) {
    const root: Db = testDb();
    const me: UserDb = scopeDb(root, ensureLocalUser(root));
    const budget = createBudget(root, { limits, stopped: () => false, now: () => 1_000_000_000 });
    const text = `${JSON.stringify({ kind: "ask_followup", threadId: nextThreadId({ reviewId: review(0), mainQuestions: 0 }) } satisfies TutorMove)}\nSay more.`;
    const fake = fakeSpawn({ stdout: [done(text, 0.6)] });
    const claude = createClaudeCli({ bin: "claude", cwd: "/work", maxConcurrent: 2, spawn: fake.spawn, estimate: cliStreamEstimateUsd });
    const memo = createMemo(me, "live", { budget, now: () => 1_000_000_000, retryDelayMs: () => 0 });
    const turn = (input: TutorInput) => memo.run(tutorTask(claude, tutorCache(me, () => 1_000_000_000), "sonnet"), input, { review: input.state.reviewId });
    const holds = () => root.sql.query<{ reserved_micros: number }, []>("SELECT reserved_micros FROM budget_holds").all();
    const used = (usd: number) => root.sql.query("INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms, settled_micros, settled_ms) VALUES ('u', ?, ?, 'claim_revision', 'k', 1, 1, ?, 1)").run(me.userId, periodOf(1_000_000_000), Math.round(usd * 1e6));
    return { turn, holds, used, calls: fake.calls };
  }

  test("reserves the request's own estimate, not the flat $0.15", async () => {
    const r = cliRig({ userUsd: null, totalUsd: null });
    const input = turnInput(review(50), 1, AUDIT_PASSAGE_BYTES);
    await r.turn(input);
    expect(r.holds()[0]!.reserved_micros).toBeGreaterThan(micros(0.3));
  });

  test("is held at $4.85 of $5 instead of being admitted and settling at $0.60", async () => {
    const r = cliRig({ userUsd: 5, totalUsd: null });
    r.used(4.85);
    const result = await r.turn(turnInput(review(51), 1, AUDIT_PASSAGE_BYTES));
    expect(result.kind).toBe("held");
    expect(r.calls).toHaveLength(0);
  });
});

describe("what the reservation does not change", () => {
  test("the unit price table still prices a settlement the way it did", () => {
    expect(priceUsage("claude-sonnet-5-5", { fresh: 0, creation5m: 1_000_000, creation1h: 0, read: 0, output: 0 })).toBeCloseTo(2.5, 9);
  });
});
