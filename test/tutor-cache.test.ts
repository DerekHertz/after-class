/**
 * The cache lifetime each tutor request is sent with, read from the request the real Messages API adapter hands a fake network.
 * Every request goes through the real tutor task, memo and budget, so a held request, a failed one and a slow reply behave as
 * they do in the backend. A restart is a new adapter, memo and tutor task over the same database.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { ensureLocalUser, scopeDb } from "../src/backend/db";
import type { Db, UserDb } from "../src/backend/db";
import { createBudget } from "../src/backend/providers/budget";
import { createClaudeApi } from "../src/backend/providers/claude-api";
import type { ApiClient } from "../src/backend/providers/claude-api";
import { createMemo } from "../src/backend/providers/memo";
import { allowedMoves, nextThreadId, reviewState, tutorCache, tutorTask } from "../src/backend/review/tutor";
import type { TutorInput } from "../src/backend/review/tutor";
import type { AssessableClaim, EvidenceBundle, FrozenScope, Passage, Turn, TutorMove } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { ClaimId, ConceptId, EvidenceId, ReviewId, SourceId, ThreadId, TurnId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { otherUserDb, testDb, testSeq } from "./fakes";

const MINUTE = 60_000;
const KEY = "sk-ant-api03-tutor-cache-0123456789";
const SRC = stableId("src", "youtube", "abcdefghijk") as SourceId;
const EV = stableId("ev", "passage", 1) as EvidenceId;
const CLAIM = { id: stableId("clm", 1) as ClaimId, conceptId: stableId("cpt", 1) as ConceptId, text: "claim 1", evidence: [EV], assumptions: [] } as unknown as AssessableClaim;
const SCOPE: FrozenScope = { chunkRevisions: [stableId("crv", "c1")], material: Material.of([[SRC, [interval(0, 600)]]]), claimsAtStart: [CLAIM.id], partial: [], frozenAtSeq: testSeq(1) };
const PASSAGE = { kind: "passage", id: EV, sourceId: SRC, transcriptRevId: stableId("trv", "t"), interval: interval(10, 20), text: "passage 1", origin: "panel" } as unknown as Passage;
const BUNDLE: EvidenceBundle = { material: SCOPE.material, passages: [PASSAGE], frames: [], gaps: [], ads: [] };

const REVIEW_A = stableId("rvw", "a") as ReviewId;
const REVIEW_B = stableId("rvw", "b") as ReviewId;

const threadOf = (reviewId: ReviewId): ThreadId => nextThreadId({ reviewId, mainQuestions: 0 });

/** The input of the review's turn `n`: a main question on one thread, then n learner answers with a follow-up between each. */
function turnInput(reviewId: ReviewId, n: number): TutorInput {
  const thread = threadOf(reviewId);
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
  return { state, allowed: [...allowedMoves(state, { turns, claims: [CLAIM] })], scope: SCOPE, claims: [CLAIM], evidence: BUNDLE, turns, priorObservations: [], repairNote: null };
}

function reply(text: string): Message {
  return {
    id: "msg_x", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    content: [{ type: "text", text, citations: null }],
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Message;
}

type Answer = { readonly generationMs?: number; readonly fail?: boolean };

/** One database, a clock in minutes, the stop switch, and backend processes that run the tutor over them. */
function rig() {
  const root: Db = testDb();
  const me = scopeDb(root, ensureLocalUser(root));
  const base = 1_000_000_000;
  let t = base;
  let stopped = false;
  let answer: Answer = {};
  let replyText = "";
  const budget = createBudget(root, { limits: { userUsd: null, totalUsd: null }, stopped: () => stopped, now: () => t });

  /** The network: records each request's cache lifetime, lets the clock run while the reply is generated, and may fail mid-reply. */
  const client: ApiClient = {
    messages: {
      stream(params, options) {
        const sent = params as { system: { cache_control: { ttl: string } }[] };
        sentTtls.push(sent.system[0]!.cache_control.ttl);
        const plan = answer;
        const text = replyText;
        let listener: (d: string) => void = () => {};
        const stream = {
          on: (_event: "text", l: (d: string) => void) => {
            listener = l;
            return stream;
          },
          finalMessage: async () => {
            options.signal.throwIfAborted();
            listener(text.slice(0, 10));
            t += plan.generationMs ?? 0;
            if (plan.fail) throw new Error("connection reset after the reply began");
            return reply(text);
          },
          abort: () => {},
        };
        return stream;
      },
      create: () => Promise.reject(new Error("the tutor only streams")),
    },
  };
  const sentTtls: string[] = [];

  /** A backend process: what main.ts builds for a user. */
  function process(db: UserDb = me) {
    const claude = createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client });
    const memo = createMemo(db, "live", { budget, now: () => t, retryDelayMs: () => 0 });
    const tutor = tutorTask(claude, tutorCache(db, () => t), "sonnet");
    /** Runs the review's turn `n`: the cache lifetime its request was sent with, or "not sent", followed by the outcome unless it is a stored reply. */
    return async (reviewId: ReviewId, n: number, plan: Answer = {}): Promise<string> => {
      answer = plan;
      const move: TutorMove = { kind: "ask_followup", threadId: threadOf(reviewId) };
      replyText = `${JSON.stringify(move)}\nSay more.`;
      const before = sentTtls.length;
      const result = await memo.run(tutor, turnInput(reviewId, n));
      const sent = sentTtls.slice(before).join(",") || "not sent";
      return result.kind === "hit" ? sent : `${sent} ${result.kind}`;
    };
  }

  return {
    root,
    process,
    at: (minutes: number) => (t = base + minutes * MINUTE),
    stop: (on: boolean) => (stopped = on),
  };
}

describe("the tutor prompt's cache lifetime", () => {
  test("0 min sent, 4 min held, 5 min resent, restart, 6 min: 5m, not sent, 1h, 1h", async () => {
    const r = rig();
    let backend = r.process();
    r.at(0);
    const first = await backend(REVIEW_A, 1);
    r.at(4);
    r.stop(true);
    const held = await backend(REVIEW_A, 2);
    r.at(5);
    r.stop(false);
    const resent = await backend(REVIEW_A, 2);
    backend = r.process();
    r.at(6);
    const afterRestart = await backend(REVIEW_A, 3);
    expect([first, held, resent, afterRestart]).toEqual(["5m", "not sent held", "1h", "1h"]);
  });

  test("requests starting at 0, 4 and 5 min, no gap over 4.5 min: 5m, 5m, 5m", async () => {
    const r = rig();
    const backend = r.process();
    const ttls: string[] = [];
    for (const [minute, n] of [[0, 1], [4, 2], [5, 3]] as const) {
      r.at(minute);
      ttls.push(await backend(REVIEW_A, n));
    }
    expect(ttls).toEqual(["5m", "5m", "5m"]);
  });

  test("a reply generated from 0 to 3 min, then a request at 5 min: the gap is start to start, so 5m, 1h", async () => {
    const r = rig();
    const backend = r.process();
    r.at(0);
    const slow = await backend(REVIEW_A, 1, { generationMs: 3 * MINUTE });
    r.at(5);
    const next = await backend(REVIEW_A, 2);
    expect([slow, next]).toEqual(["5m", "1h"]);
  });

  test("0 min sent, 4 min sent and failed, 8 min: the failed request is a start, so 5m, 5m, 5m", async () => {
    const r = rig();
    const backend = r.process();
    r.at(0);
    const first = await backend(REVIEW_A, 1);
    r.at(4);
    const failed = await backend(REVIEW_A, 2, { fail: true });
    r.at(8);
    const next = await backend(REVIEW_A, 3);
    expect([first, failed, next]).toEqual(["5m", "5m failed", "5m"]);
  });

  test("0 min sent, 4 min held, 8 min: the held request is not a start, so 5m, not sent, 1h", async () => {
    const r = rig();
    const backend = r.process();
    r.at(0);
    const first = await backend(REVIEW_A, 1);
    r.at(4);
    r.stop(true);
    const held = await backend(REVIEW_A, 2);
    r.at(8);
    r.stop(false);
    const next = await backend(REVIEW_A, 3);
    expect([first, held, next]).toEqual(["5m", "not sent held", "1h"]);
  });

  test("0 min, 20 min, restart, 21 min, 22 min: the 1 hour choice survives the restart, so 5m, 1h, 1h, 1h", async () => {
    const r = rig();
    let backend = r.process();
    const ttls: string[] = [];
    r.at(0);
    ttls.push(await backend(REVIEW_A, 1));
    r.at(20);
    ttls.push(await backend(REVIEW_A, 2));
    backend = r.process();
    r.at(21);
    ttls.push(await backend(REVIEW_A, 3));
    r.at(22);
    ttls.push(await backend(REVIEW_A, 4));
    expect(ttls).toEqual(["5m", "1h", "1h", "1h"]);
  });

  test("another review and another user's review with the same id neither move a review's starts nor share its 1 hour choice", async () => {
    const r = rig();
    const mine = r.process();
    const theirs = r.process(otherUserDb(r.root));
    r.at(0);
    const a0 = await mine(REVIEW_A, 1);
    r.at(3);
    const b3 = await mine(REVIEW_B, 1);
    const theirA3 = await theirs(REVIEW_A, 1);
    r.at(6);
    const a6 = await mine(REVIEW_A, 2);
    r.at(7);
    const b7 = await mine(REVIEW_B, 2);
    const theirA7 = await theirs(REVIEW_A, 2);
    expect({ a0, b3, theirA3, a6, b7, theirA7 }).toEqual({ a0: "5m", b3: "5m", theirA3: "5m", a6: "1h", b7: "5m", theirA7: "5m" });
  });
});
