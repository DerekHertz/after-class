/**
 * #236: a tutor turn reserves what its own request could cost, not one flat figure. Every request goes through the real tutor
 * task, memo, budget and Messages API adapter over a fake network, so the reservation is the one the backend would take. Nothing is paid.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { ensureLocalUser, scopeDb } from "../src/backend/db";
import type { Db, UserDb } from "../src/backend/db";
import { createBudget, periodOf } from "../src/backend/providers/budget";
import { REQUEST_OVERHEAD_TOKENS, createClaudeApi, priceUsage, streamWorstCaseUsd } from "../src/backend/providers/claude-api";
import type { ApiClient } from "../src/backend/providers/claude-api";
import { createMemo } from "../src/backend/providers/memo";
import { PEEK_MARGIN_MS, TUTOR_MAX_OUTPUT_TOKENS, allowedMoves, nextThreadId, reviewState, tutorCache, tutorRequest, tutorTask } from "../src/backend/review/tutor";
import type { TutorInput, TutorModel } from "../src/backend/review/tutor";
import type { AssessableClaim, EvidenceBundle, FrozenScope, Passage, Turn, TutorMove } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { ClaimId, ConceptId, EvidenceId, ReviewId, SourceId, ThreadId, TurnId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { testDb, testSeq } from "./fakes";

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
type Network = { usage: (system: string) => Usage; stop?: string; gate?: Promise<void> };

function reply(text: string, u: Usage, ttl: string, stop = "end_turn"): Message {
  return {
    id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: stop, stop_sequence: null, stop_details: null,
    content: [{ type: "text", text, citations: null }],
    usage: { input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.creation, cache_read_input_tokens: u.read, cache_creation: { ephemeral_5m_input_tokens: ttl === "5m" ? u.creation : 0, ephemeral_1h_input_tokens: ttl === "1h" ? u.creation : 0 } },
  } as unknown as Message;
}

function rig(limits: { userUsd: number | null; totalUsd: number | null } = { userUsd: 5, totalUsd: null }) {
  const root: Db = testDb();
  const me: UserDb = scopeDb(root, ensureLocalUser(root));
  let t = 1_000_000_000;
  const budget = createBudget(root, { limits, stopped: () => false, now: () => t });
  const sent: { max_tokens: number; system: string }[] = [];
  let net: Network = { usage: () => ({ input: 10, creation: 0, read: 0, output: 20 }) };

  const client: ApiClient = {
    messages: {
      stream(params) {
        const p = params as { max_tokens: number; system: { text: string; cache_control: { ttl: string } }[] };
        const system = p.system[0]!.text;
        const ttl = p.system[0]!.cache_control.ttl;
        sent.push({ max_tokens: p.max_tokens, system });
        const plan = net;
        const text = `${JSON.stringify({ kind: "ask_followup", threadId: nextThreadId({ reviewId: review(0), mainQuestions: 0 }) } satisfies TutorMove)}\nSay more.`;
        const stream = {
          on: () => stream,
          finalMessage: async () => {
            await plan.gate;
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
  const cache = tutorCache(me, () => t);
  const turn = (model: TutorModel, input: TutorInput) => memo.run(tutorTask(claude, cache, model), input, { review: input.state.reviewId });
  const holds = () => root.sql.query<{ purpose: string; reserved_micros: number; settled_micros: number | null }, []>(`SELECT purpose, reserved_micros, settled_micros FROM budget_holds ORDER BY reserved_ms, rowid`).all();
  const used = (usd: number) => root.sql.query("INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms, settled_micros, settled_ms) VALUES (?, ?, ?, 'claim_revision', ?, 1, 1, ?, 1)").run(`h${Math.random()}`, me.userId, periodOf(t), `k${Math.random()}`, Math.round(usd * 1e6));
  return { root, me, budget, turn, holds, used, sent, net: (n: Network) => (net = n), at: (min: number) => (t = 1_000_000_000 + min * MINUTE), cache, allowance: () => budget.allowance(me.userId) };
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

  test("the reservation is the request's worst case: its own bytes, its cache state and its output limit", () => {
    const input = turnInput(review(4), 1, AUDIT_PASSAGE_BYTES);
    const req = tutorRequest(input, "sonnet");
    const bytes = new TextEncoder().encode(req.system + req.prompt).length;
    const cold = streamWorstCaseUsd("claude-sonnet-5-5", req, { ttl: "5m", warm: false })!;
    expect(cold).toBeCloseTo(((bytes + REQUEST_OVERHEAD_TOKENS) * 2 * 1.25 + TUTOR_MAX_OUTPUT_TOKENS * 10) / 1e6, 12);
    expect(streamWorstCaseUsd("claude-sonnet-5-5", req, { ttl: "1h", warm: false })!).toBeGreaterThan(cold);
    expect(streamWorstCaseUsd("claude-sonnet-5-5", req, { ttl: "5m", warm: true })!).toBeLessThan(cold / 1.5);
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

  test("a warm turn whose cache was evicted settles above its reservation by at most the cache-read slack, and the 5 minute write is the dearest the first turn can be", async () => {
    const r = rig();
    const input = turnInput(review(7), 1, AUDIT_PASSAGE_BYTES);
    r.at(0);
    r.net({ usage: () => ({ input: 0, creation: 0, read: 12_000, output: 100 }) });
    await r.turn("sonnet", input);
    r.at(2);
    const second = turnInput(review(7), 2, AUDIT_PASSAGE_BYTES);
    const req = tutorRequest(second, "sonnet");
    const systemBytes = new TextEncoder().encode(req.system).length;
    const total = new TextEncoder().encode(req.system + req.prompt).length;
    r.net({ usage: () => ({ input: 0, creation: total + REQUEST_OVERHEAD_TOKENS, read: 0, output: TUTOR_MAX_OUTPUT_TOKENS }), stop: "max_tokens" });
    await r.turn("sonnet", second);
    const hold = r.holds()[1]!;
    const slack = micros((systemBytes * (2 * 1.25 - 0.1)) / 1e6) + 1;
    expect(hold.settled_micros!).toBeGreaterThan(hold.reserved_micros);
    expect(hold.settled_micros! - hold.reserved_micros).toBeLessThanOrEqual(slack);
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
  test("at $4.85 of $5 a normal turn of the audit's lecture is admitted on Sonnet, from the second turn on", async () => {
    const r = rig();
    r.at(0);
    await r.turn("sonnet", turnInput(review(20), 1, AUDIT_PASSAGE_BYTES));
    r.used(4.85);
    r.at(1);
    const second = await r.turn("sonnet", turnInput(review(20), 2, AUDIT_PASSAGE_BYTES));
    expect(second.kind).not.toBe("held");
    expect(r.sent).toHaveLength(2);
    const hold = r.holds().find((h) => h.purpose === "tutor_turn" && h.reserved_micros < micros(0.15) && h.reserved_micros > micros(0.05));
    expect(hold).toBeDefined();
  });

  test("a learner with less than the reservation left is held, and Opus needs more headroom than Sonnet", async () => {
    const r = rig();
    r.at(0);
    await r.turn("sonnet", turnInput(review(21), 1, AUDIT_PASSAGE_BYTES));
    r.used(4.85);
    r.at(1);
    const opus = await r.turn("opus", turnInput(review(21), 2, AUDIT_PASSAGE_BYTES));
    expect(opus.kind).toBe("held");
    const sonnet = await r.turn("sonnet", turnInput(review(21), 2, AUDIT_PASSAGE_BYTES));
    expect(sonnet.kind).not.toBe("held");
  });
});

describe("tutorCache.peek", () => {
  test("is cold with no earlier request, warm within 4.5 minutes, cold and 1 hour after, and records nothing", () => {
    const r = rig();
    const id = review(30);
    expect(r.cache.peek(id)).toEqual({ ttl: "5m", warm: false });
    r.at(0);
    r.cache.start(id);
    r.at(2);
    expect(r.cache.peek(id)).toEqual({ ttl: "5m", warm: true });
    r.at(4.5 - PEEK_MARGIN_MS / 2 / MINUTE);
    expect(r.cache.peek(id)).toEqual({ ttl: "1h", warm: false });
    r.at(6);
    expect(r.cache.peek(id)).toEqual({ ttl: "1h", warm: false });
    expect(r.cache.start(id)).toBe("1h");
    r.at(30);
    expect(r.cache.peek(id)).toEqual({ ttl: "1h", warm: true });
  });

  test("never answers 5 minutes where start answers 1 hour", () => {
    for (let ms = 0; ms <= 6 * MINUTE; ms += 5_000) {
      const fresh = rig();
      const other = review(32);
      fresh.at(0);
      fresh.cache.start(other);
      fresh.at(ms / MINUTE);
      const peek = fresh.cache.peek(other);
      const real = fresh.cache.start(other);
      if (real === "1h") expect(peek.ttl).toBe("1h");
    }
  });
});

describe("what the reservation does not change", () => {
  test("the unit price table still prices a settlement the way it did", () => {
    expect(priceUsage("claude-sonnet-5-5", { fresh: 0, creation5m: 1_000_000, creation1h: 0, read: 0, output: 0 })).toBeCloseTo(2.5, 9);
  });
});
