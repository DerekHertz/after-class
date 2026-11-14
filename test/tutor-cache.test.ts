import { describe, expect, test } from "bun:test";
import { createReviews } from "../src/backend/review";
import { LONG_PAUSE_MS, tutorTask } from "../src/backend/review/tutor";
import type { TutorInput } from "../src/backend/review/tutor";
import type { ClaudeCli, ClaudeRequest } from "../src/backend/providers/claude";
import { createMemo } from "../src/backend/providers/memo";
import type { UserDb } from "../src/backend/db";
import type { ReviewId } from "../src/shared/ids";
import { randomId } from "../src/shared/ids";
import { THREAD, answer, askMain, collect, kit, reply, started, startedRig, tutorHarness } from "./review-fixtures";
import type { World } from "./review-fixtures";

const MINUTE = 60_000;

/**
 * The cache lifetime each tutor request of a review would be sent with: the real tutor task's request, built from the TutorInput
 * the review module assembled from its stored turns. `fresh` stands in for a restarted process: a new tutor task and review module
 * over the same db.
 */
function backend(db: UserDb, world: World, clock: { advance: (ms: number) => number }) {
  const sent: ClaudeRequest[] = [];
  const claude: ClaudeCli = {
    async streamText(req) {
      sent.push(req);
      throw new Error("the cache lifetime is read from the request, so this call never answers");
    },
    structured: () => Promise.reject(new Error("no structured call in this test")),
  };
  const lifetimes: Record<ReviewId, string[]> = {};
  const fresh = () => {
    const tutor = tutorTask(claude, "sonnet", () => clock.advance(0));
    const harness = tutorHarness(db, async (input: TutorInput) => {
      await createMemo(db, "live", { retryDelayMs: () => 0 }).run(tutor, input).catch(() => {});
      (lifetimes[input.state.reviewId] ??= []).push(sent.at(-1)!.cacheTtl ?? "absent");
      const first = !input.turns.some((t) => t.actor === "tutor");
      return first ? reply(askMain(...input.claims.map((c) => c.id)), "Question.") : reply({ kind: "ask_followup", threadId: THREAD }, "Say more.");
    });
    const reviews = createReviews(db, { ...world.deps, runTutor: harness.runTutor, clearFailures: harness.clearFailures }, { tutor: kit, now: () => clock.advance(0) });
    return { say: (reviewId: ReviewId) => collect(reviews.turn(reviewId, randomId("turn"), answer())), reviews };
  };
  return { fresh, lifetimes };
}

describe("the tutor prompt's cache lifetime", () => {
  test("a review's first request is written for 5 minutes, even when it starts long after the review", async () => {
    const r = startedRig();
    const b = backend(r.db, r.world, r.clock);
    r.clock.advance(30 * MINUTE);
    await b.fresh().say(r.reviewId);
    expect(b.lifetimes[r.reviewId]).toEqual(["5m"]);
  });

  test("turns closer together than the long pause stay on 5 minutes", async () => {
    const r = startedRig();
    const b = backend(r.db, r.world, r.clock);
    const s = b.fresh();
    await s.say(r.reviewId);
    r.clock.advance(LONG_PAUSE_MS);
    await s.say(r.reviewId);
    r.clock.advance(MINUTE);
    await s.say(r.reviewId);
    expect(b.lifetimes[r.reviewId]).toEqual(["5m", "5m", "5m"]);
  });

  test("the request after a long pause is written for 1 hour, and so is every later one in the review", async () => {
    const r = startedRig();
    const b = backend(r.db, r.world, r.clock);
    const s = b.fresh();
    await s.say(r.reviewId);
    r.clock.advance(LONG_PAUSE_MS + 1);
    await s.say(r.reviewId);
    r.clock.advance(MINUTE);
    await s.say(r.reviewId);
    r.clock.advance(10_000);
    await s.say(r.reviewId);
    expect(b.lifetimes[r.reviewId]).toEqual(["5m", "1h", "1h", "1h"]);
  });

  test("a restarted backend reads the long pause from the stored turns and stays on 1 hour", async () => {
    const r = startedRig();
    const b = backend(r.db, r.world, r.clock);
    await b.fresh().say(r.reviewId);
    r.clock.advance(20 * MINUTE);
    await b.fresh().say(r.reviewId);
    r.clock.advance(MINUTE);
    await b.fresh().say(r.reviewId);
    expect(b.lifetimes[r.reviewId]).toEqual(["5m", "1h", "1h"]);
  });

  test("one review's long pause does not move another review to 1 hour", async () => {
    const r = startedRig();
    const b = backend(r.db, r.world, r.clock);
    const s = b.fresh();
    r.world.close(1, 300, 600);
    r.world.claim(2, 310, 320);
    const other = randomId("rvw");
    started(s.reviews.start(r.capture, "prepared_only", other));
    await s.say(r.reviewId);
    r.clock.advance(20 * MINUTE);
    await s.say(r.reviewId);
    await s.say(other);
    r.clock.advance(MINUTE);
    await s.say(other);
    expect(b.lifetimes[r.reviewId]).toEqual(["5m", "1h"]);
    expect(b.lifetimes[other]).toEqual(["5m", "5m"]);
  });
});
