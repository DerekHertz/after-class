import { describe, expect, test } from "bun:test";
import { createBudget, ESTIMATE_USD, UNCAPPED_REQUESTS_PER_REVIEW } from "../src/backend/providers/budget";
import { createMemo } from "../src/backend/providers/memo";
import { ReviewLimitError, UNANSWERED_REVIEWS_PER_DAY, wrapUpRun } from "../src/backend/review";
import type { Turn } from "../src/shared/domain";
import { Material } from "../src/shared/time";
import { randomId } from "../src/shared/ids";
import type { ReviewId } from "../src/shared/ids";
import { fakeTask, ok, testUserDb, usage } from "./fakes";
import { answer, rig, started } from "./review-fixtures";

// #244: the wrap-up that saves a review passes both caps ("i think it should be allowed to finish"), so it must be bounded by the review.

const NOV_10 = Date.UTC(2026, 10, 10, 12);
const UNKNOWN = { kind: "unknown", reason: "test" } as const;
type In = { readonly n: number };

/** A budget already used up: the one tutor turn it allows has been spent. */
async function spentWorld() {
  const db = testUserDb();
  const budget = createBudget(db, { limits: { userUsd: ESTIMATE_USD.tutor_turn, totalUsd: 50 }, stopped: () => false, now: () => NOV_10 });
  const memo = createMemo(db, "live", { retryDelayMs: () => 0, now: () => NOV_10, budget });
  const spend = fakeTask<In, string>({ purpose: "tutor_turn", provider: "claude", answer: () => ok("x", { usage: usage(UNKNOWN) }) });
  await memo.run(spend, { n: 0 });
  expect(budget.allowance(db.userId).held).toMatchObject({ reason: "user_budget" });
  const wrapUp = fakeTask<In, string>({ purpose: "wrap_up", provider: "claude", answer: () => ok("saved", { usage: usage(UNKNOWN) }) });
  return { db, memo, wrapUp };
}

const learner = (reviewId: ReviewId, act: Extract<Turn, { actor: "learner" }>["act"]): Turn =>
  ({ id: randomId("turn"), reviewId, seq: 1, atMs: 1, actor: "learner", threadId: null, act }) as Turn;
const reviewIdOf = () => randomId("rvw");

describe("the wrap-up passes the caps only for a review the learner responded to", () => {
  test("a loop of reviews with no response makes no uncapped call", async () => {
    const w = await spentWorld();
    for (let i = 0; i < 10; i++) {
      const id = reviewIdOf();
      const turns: Turn[] = [learner(id, { kind: "begin" } as never), learner(id, { kind: "end" } as never)];
      expect(wrapUpRun(id, turns)).toEqual({});
      expect(await w.memo.run(w.wrapUp, { n: i }, wrapUpRun(id, turns))).toMatchObject({ kind: "held", hold: { reason: "user_budget" } });
    }
    expect(w.wrapUp.calls).toEqual([]);
  });

  test("a real review past the cap still finishes and saves, and the call still counts", async () => {
    const w = await spentWorld();
    const id = reviewIdOf();
    const turns = [learner(id, answer())];
    expect(wrapUpRun(id, turns)).toEqual({ finishes: id });
    expect((await w.memo.run(w.wrapUp, { n: 1 }, wrapUpRun(id, turns))).kind).toBe("hit");
    expect(w.wrapUp.calls).toEqual([{ n: 1 }]);
    expect(w.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events WHERE purpose = 'wrap_up'").get()!.n).toBe(1);
  });

  test("a skip and an I don't know are responses too", () => {
    const id = reviewIdOf();
    for (const kind of ["skip", "dont_know"]) expect(wrapUpRun(id, [learner(id, { kind } as never)])).toEqual({ finishes: id });
  });

  test("a second save of the same review makes no second call, and a review cannot pass the caps without bound", async () => {
    const w = await spentWorld();
    const id = reviewIdOf();
    const run = wrapUpRun(id, [learner(id, answer())]);
    await w.memo.run(w.wrapUp, { n: 1 }, run);
    await w.memo.run(w.wrapUp, { n: 1 }, run);
    expect(w.wrapUp.calls).toHaveLength(1);
    // Inputs that differ for the same review, as a replay of changed claims would: each is a new request, and only so many pass.
    const results = [];
    for (let n = 2; n < UNCAPPED_REQUESTS_PER_REVIEW + 4; n++) results.push((await w.memo.run(w.wrapUp, { n }, run)).kind);
    expect(w.wrapUp.calls).toHaveLength(UNCAPPED_REQUESTS_PER_REVIEW);
    expect(results.at(-1)).toBe("held");
    // Another review is unaffected.
    const other = reviewIdOf();
    expect((await w.memo.run(w.wrapUp, { n: 99 }, wrapUpRun(other, [learner(other, answer())]))).kind).toBe("hit");
  });

  test("the stop switch still holds a real review's wrap-up", async () => {
    const db = testUserDb();
    const budget = createBudget(db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => true, now: () => NOV_10 });
    const memo = createMemo(db, "live", { retryDelayMs: () => 0, now: () => NOV_10, budget });
    const t = fakeTask<In, string>({ purpose: "wrap_up", provider: "claude", answer: () => ok("x", { usage: usage(UNKNOWN) }) });
    const id = reviewIdOf();
    expect(await memo.run(t, { n: 1 }, wrapUpRun(id, [learner(id, answer())]))).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
  });
});

describe("starting reviews without responding to one is limited", () => {
  let seeded = 0;
  // A review over no material, so it blocks nothing: what a review ended by a mis-click leaves once its material is offered again.
  const EMPTY_SCOPE = JSON.stringify({ scope: { material: Material.canonical(Material.empty) }, claimTexts: {} });
  /** Reviews started `agoMs` before now with no turn, as an ended-by-mis-click review leaves. */
  function seedUnanswered(r: ReturnType<typeof rig>, n: number, startedMs: number): void {
    for (let i = 0; i < n; i++) {
      r.db.sql.query("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, ?, 'prepared_only', ?, ?, ?)")
        .run(randomId("rvw"), r.db.userId, r.capture, EMPTY_SCOPE, 10_000 + seeded++, startedMs);
    }
  }
  const prepared = () => {
    const r = rig();
    r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20);
    return r;
  };

  test("the next start is refused with a plain error once a day's worth have no response", () => {
    const r = prepared();
    seedUnanswered(r, UNANSWERED_REVIEWS_PER_DAY, r.clock.advance(0));
    expect(() => r.reviews.start(r.capture, "prepared_only", randomId("rvw"))).toThrow(ReviewLimitError);
    expect(() => r.reviews.start(r.capture, "prepared_only", randomId("rvw"))).toThrow("You have started a lot of reviews today without answering a question in them.");
  });

  test("a learner under the limit, one whose reviews are old, and a retry of a started review are unaffected", () => {
    const r = prepared();
    seedUnanswered(r, UNANSWERED_REVIEWS_PER_DAY - 1, r.clock.advance(0));
    const id = randomId("rvw");
    const first = started(r.reviews.start(r.capture, "prepared_only", id));
    seedUnanswered(r, 5, r.clock.advance(0));
    expect(started(r.reviews.start(r.capture, "prepared_only", id)).reviewId).toBe(first.reviewId);

    const old = prepared();
    seedUnanswered(old, UNANSWERED_REVIEWS_PER_DAY, old.clock.advance(0) - 86_400_001);
    expect(started(old.reviews.start(old.capture, "prepared_only", randomId("rvw"))).kind).toBe("started");
  });

  test("a review the learner responded to does not count", () => {
    const r = prepared();
    seedUnanswered(r, UNANSWERED_REVIEWS_PER_DAY, r.clock.advance(0));
    const ids = r.db.sql.query<{ id: string }, []>("SELECT id FROM reviews").all().map((x) => x.id);
    ids.slice(0, 3).forEach((rid, i) =>
      r.db.sql.query("INSERT INTO review_turns (user_id, id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES (?, ?, ?, ?, 'learner', NULL, ?, 1)")
        .run(r.db.userId, randomId("turn"), rid, 500 + i, JSON.stringify({ act: { kind: "answer", text: "a", modality: "text" } })));
    expect(started(r.reviews.start(r.capture, "prepared_only", randomId("rvw"))).kind).toBe("started");
  });
});
