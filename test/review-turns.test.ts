import { describe, expect, test } from "bun:test";
import { asSeq } from "../src/backend/db";
import type { Reviews, TutorKit } from "../src/backend/review";
import { MAX_MOVES_PER_TURN, createReviews } from "../src/backend/review";
import type { TutorOutput } from "../src/backend/review/tutor";
import { nextThreadId, tutorOwesMove, waitsForLearner } from "../src/backend/review/tutor";
import type { LearnerAct, Turn, TurnEvent, TutorMove, TutorMoveKind } from "../src/shared/domain";
import type { ReviewId } from "../src/shared/ids";
import { randomId, stableId } from "../src/shared/ids";
import { Material } from "../src/shared/time";
import type { FakeStep } from "./fakes";
import { fail } from "./fakes";
import type { Script } from "./review-fixtures";
import { SECOND_THREAD, THREAD, answer, askMain, collect, kit, reply, rig, started, startedRig, turnRows, tutorHarness, types } from "./review-fixtures";

// ───────────────────────────── turns ─────────────────────────────

describe("turn", () => {
  test("streams learner_turn_stored, the prose by delta and sentence, the move once stored, then turn_complete", async () => {
    const r = startedRig();
    const move = askMain(r.claim);
    const t = tutorHarness(r.db, () => reply(move, "What is the main idea? Say it in your own words."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit, now: () => 1 });
    const turnId = randomId("turn");
    const events: TurnEvent[] = [];
    let storedWhenMoveSent: readonly Turn[] = [];
    for await (const e of reviews.turn(r.reviewId, turnId, answer())) {
      if (e.type === "move") storedWhenMoveSent = reviews.view(r.reviewId).turns;
      events.push(e);
    }

    expect(types(events)[0]).toBe("learner_turn_stored");
    expect(types(events)[1]).toBe("say_delta");
    expect(types(events).slice(-2)).toEqual(["move", "turn_complete"]);
    expect(storedWhenMoveSent.filter((x) => x.actor === "tutor")).toMatchObject([{ move }]);
    expect(events.filter((e) => e.type === "move")).toEqual([{ type: "move", turnId: stableId("turn", r.reviewId, turnId, "tutor"), move }]);
    expect(events.filter((e) => e.type === "say_delta").map((e) => e.type === "say_delta" && e.text).join("")).toBe("What is the main idea? Say it in your own words.");
    expect(events.filter((e) => e.type === "sentence").map((e) => e.type === "sentence" && e.text)).toEqual(["What is the main idea?", "Say it in your own words."]);
    const stored = reviews.view(r.reviewId).turns;
    expect(stored.map((x) => x.actor)).toEqual(["learner", "tutor"]);
    expect(stored[1]).toMatchObject({ actor: "tutor", threadId: THREAD, say: "What is the main idea? Say it in your own words." });
  });

  test("every learner turn carries the thread open when it was said", async () => {
    const r = startedRig();
    let call = 0;
    const t = tutorHarness(r.db, () => {
      call++;
      if (call === 1) return reply(askMain(r.claim), "Question.");
      if (call === 2) return reply({ kind: "ask_followup", threadId: THREAD }, "Say more.");
      if (call === 3) return reply({ kind: "close_thread", threadId: THREAD }, "Good.");
      return reply({ kind: "ask_main", threadId: SECOND_THREAD, claimIds: [r.claim] }, "Next question.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    for (let i = 0; i < 4; i++) await collect(reviews.turn(r.reviewId, randomId("turn"), answer(String(i))));
    const learners = reviews.view(r.reviewId).turns.filter((x) => x.actor === "learner");
    expect(learners.map((x) => x.threadId)).toEqual([null, THREAD, THREAD, SECOND_THREAD]);
  });

  test("the learner turn is committed before the model is called", async () => {
    const r = rig();
    r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20);
    const reviewId = randomId("rvw");
    let seenDuringCall: readonly Turn[] = [];
    const t = tutorHarness(r.db, () => {
      seenDuringCall = r.reviews.view(reviewId).turns;
      return reply({ kind: "wrap_up" }, "Done.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    started(reviews.start(r.capture, "prepared_only", reviewId));
    await collect(reviews.turn(reviewId, randomId("turn"), answer("my answer")));
    expect(seenDuringCall.map((x) => x.actor)).toEqual(["learner"]);
  });

  test("idempotent on turnId: a resend appends nothing, replays the reply, and pays for no second call", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply(askMain(r.claim), "First question. Second part."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const turnId = randomId("turn");
    const first = await collect(reviews.turn(r.reviewId, turnId, answer()));
    const again = await collect(reviews.turn(r.reviewId, turnId, answer()));

    expect(t.calls).toHaveLength(1);
    expect(turnRows(r.db, "learner")).toBe(1);
    expect(turnRows(r.db, "tutor")).toBe(1);
    expect(again.filter((e) => e.type === "move")).toEqual(first.filter((e) => e.type === "move"));
    expect(again.filter((e) => e.type === "sentence")).toEqual(first.filter((e) => e.type === "sentence"));
    expect(types(again).at(-1)).toBe("turn_complete");
  });

  test("a failed model call keeps the learner turn; resending the same turnId calls the model once more and completes it", async () => {
    let healthy = false;
    const r = startedRig();
    const t = tutorHarness(r.db, (): FakeStep<TutorOutput> => (healthy ? reply(askMain(r.claim), "Try this.") : fail("boom")));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const turnId = randomId("turn");
    const failed = await collect(reviews.turn(r.reviewId, turnId, answer("kept")));
    expect(failed.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    expect(t.calls).toHaveLength(1);
    expect(turnRows(r.db, "learner")).toBe(1);
    expect(turnRows(r.db, "tutor")).toBe(0);

    healthy = true;
    const retried = await collect(reviews.turn(r.reviewId, turnId, answer("kept")));
    expect(types(retried).at(-1)).toBe("turn_complete");
    expect(t.calls).toHaveLength(2);
    expect(turnRows(r.db, "learner")).toBe(1);
    expect(turnRows(r.db, "tutor")).toBe(1);
  });

  test("a resend that fails again is retryable again, one model call per send", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => fail("still down"));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const turnId = randomId("turn");
    for (let send = 1; send <= 3; send++) {
      const events = await collect(reviews.turn(r.reviewId, turnId, answer()));
      expect(events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
      expect(t.calls).toHaveLength(send);
    }
  });

  test("an invalid header is aborted before anything is spoken, then repaired once", async () => {
    const r = startedRig();
    const notAssessable = stableId("clm", "k", 999);
    const t = tutorHarness(r.db, (input) =>
      input.repairNote === null ? reply(askMain(notAssessable), "SPOKEN-WITHOUT-LEAVE. More words.") : reply(askMain(r.claim), "A valid question."),
    );
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));

    expect(t.calls.map((c) => c.repairNote)).toEqual([null, "claim is not assessable"]);
    expect(JSON.stringify(events)).not.toContain("SPOKEN-WITHOUT-LEAVE");
    expect(events.filter((e) => e.type === "move")).toHaveLength(1);
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { claimIds: [r.claim] } });
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("R3: a claim that loses its check while the model talks is neither stored nor sent as the move; the repair sees the change", async () => {
    const r = startedRig(undefined, {}, true);
    const t = tutorHarness(r.db, (input) => {
      if (input.state.corrections.length > 0 && input.state.corrections.every((c) => c.disclosed)) return reply(askMain(r.claim2!), "Tell me about claim two.");
      if (input.repairNote === null) {
        r.world.check(r.claim, "unverified");
        return reply(askMain(r.claim), "Tell me about claim one.");
      }
      return reply({ kind: "disclose_correction", correctionId: input.state.corrections[0]!.id, threadIds: [], evidence: [] }, "That claim did not hold up.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));

    const namesClaim = (move: TutorMove) => move.kind === "ask_main" && move.claimIds.includes(r.claim);
    expect(events.filter((e) => e.type === "move" && namesClaim(e.move))).toEqual([]);
    expect(reviews.view(r.reviewId).turns.filter((x) => x.actor === "tutor" && namesClaim(x.move))).toEqual([]);
    expect(t.calls).toHaveLength(3);
    expect(t.calls[1]!.repairNote).not.toBeNull();
    expect(t.calls[1]!.claims.map((c) => c.id)).not.toContain(r.claim);
    expect(t.calls[1]!.allowed).toEqual(["disclose_correction"]);
    expect(events.filter((e) => e.type === "move")).toMatchObject([{ move: { kind: "disclose_correction" } }, { move: { kind: "ask_main" } }]);
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("an invalid header that never repairs falls back to a code-authored move, never a stuck review", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply({ kind: "propose_detour", topic: "x", reason: "y", needsResource: null }, "Let us detour."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));

    expect(t.calls).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("detour");
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "wrap_up" } });
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(reviews.view(r.reviewId).turns.at(-1)).toMatchObject({ actor: "tutor", move: { kind: "wrap_up" } });
  });

  test("an ended review takes no new learner turn, so a saved record stays final (R15)", async () => {
    const r = startedRig(() => reply({ kind: "wrap_up" }, "Done."));
    await collect(r.reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(r.reviews.view(r.reviewId).state.phase).toBe("ended");
    const before = r.reviews.view(r.reviewId).turns.length;

    const late = await collect(r.reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(late).toEqual([{ type: "turn_failed", error: "this review has ended", retryable: false }]);
    expect(r.reviews.view(r.reviewId).turns).toHaveLength(before);
  });

  test("with a thread open the fallback closes the thread", async () => {
    const r = startedRig();
    let call = 0;
    const t = tutorHarness(r.db, () => (++call === 1 ? reply(askMain(r.claim), "Question one.") : reply({ kind: "detour_step" }, "Nope.")));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    await collect(reviews.turn(r.reviewId, randomId("turn"), answer("first")));
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer("second")));
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "close_thread", threadId: THREAD } });
  });

  test("with no fallback move and both invalid outputs stored, turn_failed says a resend will not help", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply({ kind: "wrap_up" }, "Bye."));
    const onlyAskMain: TutorKit = { ...kit, allowedMoves: () => new Set<TutorMoveKind>(["ask_main"]) };
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: onlyAskMain });
    const turnId = randomId("turn");
    expect((await collect(reviews.turn(r.reviewId, turnId, answer()))).at(-1)).toMatchObject({ type: "turn_failed", retryable: false });
    await collect(reviews.turn(r.reviewId, turnId, answer()));
    expect(t.calls).toHaveLength(2);
  });

  test("a paused review stores the learner's act and calls no model", async () => {
    const r = startedRig();
    const events = await collect(r.reviews.turn(r.reviewId, randomId("turn"), { kind: "pause" }));
    expect(types(events)).toEqual(["learner_turn_stored", "turn_complete"]);
    expect(r.tutor.calls).toHaveLength(0);
    expect(r.reviews.view(r.reviewId).state.phase).toBe("paused");
  });

  test("an unknown review fails the turn without retry", async () => {
    const r = rig();
    const events = await collect(r.reviews.turn(randomId("rvw"), randomId("turn"), answer()));
    expect(events).toEqual([{ type: "turn_failed", error: expect.stringContaining("unknown review"), retryable: false }]);
  });
});

describe("soft time target", () => {
  async function runToClose(softTargetS: number, elapsedMs: number) {
    let call = 0;
    const r = startedRig(undefined, { softTargetS });
    const t = tutorHarness(r.db, () => (++call === 1 ? reply(askMain(r.claim), "Question.") : reply({ kind: "close_thread", threadId: THREAD }, "Good enough.")));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit, softTargetS, now: () => r.clock.advance(0) });
    await collect(reviews.turn(r.reviewId, randomId("turn"), answer("a")));
    r.clock.advance(elapsedMs);
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer("b")));
    return { events, notices: reviews.view(r.reviewId).turns.filter((x) => x.actor === "code") };
  }

  test("is offered once, at the natural pause after a thread closes, never as a cutoff", async () => {
    const { events, notices } = await runToClose(600, 700_000);
    expect(notices).toMatchObject([{ notice: { kind: "soft_target_reached", elapsedS: 700 } }]);
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("is not offered before the target", async () => {
    const { notices } = await runToClose(600, 100_000);
    expect(notices).toEqual([]);
  });
});

// ───────────────────────────── R9 ─────────────────────────────

describe("R9 review and capture are independent", () => {
  test("start() leaves capture alone, and stopping capture neither ends nor pauses the review", async () => {
    const r = rig(() => reply(askMain(), "Question."));
    r.world.close(0, 0, 300);
    const claim = r.world.claim(1, 10, 20);
    const t = tutorHarness(r.db, () => reply(askMain(claim), "Question."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });

    expect(r.world.captureState).toBe("capturing");
    const reviewId = randomId("rvw");
    started(reviews.start(r.capture, "prepared_only", reviewId));
    expect(r.world.captureState).toBe("capturing");

    r.world.captureState = "stopped";
    expect(reviews.view(reviewId).state.phase).toBe("active");
    const events = await collect(reviews.turn(reviewId, randomId("turn"), answer()));
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(reviews.view(reviewId).state.phase).toBe("active");
  });

  test("a review keeps working while new chunks close and are invited about", async () => {
    const r = startedRig(() => reply({ kind: "wrap_up" }, "Done."));
    r.world.close(1, 300, 600);
    r.world.claim(2, 310, 320);
    expect(r.reviews.invite(r.capture)).toMatchObject({ state: "invited" });
    expect(r.reviews.view(r.reviewId).scope).toEqual(r.scope);
  });
});

// ───────────────────────────── begin: the tutor opens the review ─────────────────────────────

describe("begin (flow D: the tutor opens with a recall question)", () => {
  const begin: LearnerAct = { kind: "begin" };
  /** The real W8 rules, so ask_main must carry the thread id code minted. */
  function opening() {
    const r = startedRig();
    const t = tutorHarness(r.db, (input) => reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "What is the main idea?"));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 });
    return { ...r, t, reviews };
  }

  test("accepted as the very first turn: the allowed move is ask_main and the stored tutor turn is a main question", async () => {
    const x = opening();
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    expect(x.t.calls[0]!.allowed).toEqual(["ask_main"]);
    expect(types(events)).toContain("learner_turn_stored");
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "ask_main" } });
    expect(types(events).at(-1)).toBe("turn_complete");
    const turns = x.reviews.view(x.reviewId).turns;
    expect(turns.map((t) => t.actor)).toEqual(["learner", "tutor"]);
    expect(turns[0]).toMatchObject({ act: { kind: "begin" } });
    expect(x.reviews.view(x.reviewId).state.mainQuestions).toBe(1);
  });

  test("a resend of the same begin turn id stores nothing twice", async () => {
    const x = opening();
    const id = randomId("turn");
    await collect(x.reviews.turn(x.reviewId, id, begin));
    await collect(x.reviews.turn(x.reviewId, id, begin));
    expect(x.reviews.view(x.reviewId).turns).toHaveLength(2);
  });

  test("refused, and stored nowhere, when any turn already exists", async () => {
    const x = opening();
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    const before = x.reviews.view(x.reviewId).turns.length;
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    expect(events).toEqual([{ type: "turn_failed", error: "this review has already begun", retryable: false }]);
    expect(x.reviews.view(x.reviewId).turns).toHaveLength(before);
  });
});

// ───────────────────────────── material used up by earlier reviews ─────────────────────────────

describe("which earlier reviews use up material", () => {
  const endingScript: Script = () => reply({ kind: "wrap_up" }, "Done.");
  const end = (r: ReturnType<typeof startedRig>) => collect(r.reviews.turn(r.reviewId, randomId("turn"), { kind: "end" }));

  test("an ended review with no answer, skip or don't-know frees its material for a new review", async () => {
    const r = startedRig(endingScript);
    expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
    await end(r);
    expect(r.reviews.view(r.reviewId).state.phase).toBe("ended");
    expect(r.reviews.view(r.reviewId).turns.some((t) => t.actor === "learner" && ["answer", "skip", "dont_know"].includes(t.act.kind))).toBe(false);

    expect(r.reviews.options(r.capture)).toMatchObject({ kind: "ready", scope: { chunkRevisions: r.scope.chunkRevisions } });
    const again = started(r.reviews.start(r.capture, "prepared_only", randomId("rvw")));
    expect(again.scope.chunkRevisions).toEqual(r.scope.chunkRevisions);
    // R7: the ended review's own frozen scope is unchanged.
    expect(Material.canonical(r.reviews.view(r.reviewId).scope.material)).toEqual(Material.canonical(r.scope.material));
  });

  for (const act of [answer(), { kind: "skip" }, { kind: "dont_know" }] as LearnerAct[]) {
    test(`an ended review where the learner gave a ${act.kind} still uses its material up`, async () => {
      const r = startedRig(endingScript);
      await collect(r.reviews.turn(r.reviewId, randomId("turn"), act));
      expect(r.reviews.view(r.reviewId).state.phase).toBe("ended");
      expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
    });
  }

  test("a review that is active or paused with no response still holds its material, so two cannot run at once", async () => {
    const r = startedRig(endingScript);
    expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
    await collect(r.reviews.turn(r.reviewId, randomId("turn"), { kind: "pause" }));
    expect(r.reviews.view(r.reviewId).state.phase).toBe("paused");
    expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
  });

  test("freed material is offered together with new material, and list() names the reviews newest first", async () => {
    const r = startedRig(endingScript);
    await end(r);
    r.world.close(1, 300, 600);
    r.world.claim(2, 310, 320);
    const opts = r.reviews.options(r.capture);
    expect(opts.kind === "ready" && opts.scope.chunkRevisions.length).toBe(2);
    r.clock.advance(1000);
    const second = started(r.reviews.start(r.capture, "prepared_only", randomId("rvw")));
    expect(r.reviews.list(r.capture).map((x) => x.reviewId)).toEqual([second.reviewId, r.reviewId]);
  });
});

// ───────────────────────────── a turn never ends with nothing to answer ─────────────────────────────

describe("a request goes on until a move waits for the learner", () => {
  const moveKinds = (events: readonly TurnEvent[]) => events.flatMap((e) => (e.type === "move" ? [e.move.kind] : []));
  const begin: LearnerAct = { kind: "begin" };

  /** Pending corrections are disclosed one per call; once none is pending the tutor asks. */
  function chaining() {
    const r = startedRig(undefined, {}, true);
    const t = tutorHarness(r.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      if (pending) return reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.");
      return reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]?.id ?? r.claim] }, "A question.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    return { ...r, t, reviews };
  }

  test("begin with pending corrections: every correction is disclosed, then a question, in the one request", async () => {
    const x = chaining();
    x.world.check(x.claim, "unverified");
    x.world.claims.get(x.claim2!)!.text = "claim 2, reworded";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    expect(moveKinds(events)).toEqual(["disclose_correction", "disclose_correction", "ask_main"]);
    expect(types(events).filter((t) => t === "turn_complete")).toHaveLength(1);
    expect(types(events).at(-1)).toBe("turn_complete");
    const tutors = x.reviews.view(x.reviewId).turns.filter((t) => t.actor === "tutor");
    expect(tutors.map((t) => t.actor === "tutor" && t.move.kind)).toEqual(["disclose_correction", "disclose_correction", "ask_main"]);
    expect(x.reviews.view(x.reviewId).state.openThread).not.toBeNull();
  });

  test("a correction on a claim already asked about is disclosed, then the next move follows", async () => {
    const x = chaining();
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    x.world.claims.get(x.claim)!.text = "claim 1, reworded";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    expect(moveKinds(events)[0]).toBe("disclose_correction");
    expect(moveKinds(events).length).toBeGreaterThan(1);
  });

  test("a thread that is closed goes on to the next move", async () => {
    const r = startedRig();
    let call = 0;
    const t = tutorHarness(r.db, () => {
      call++;
      if (call === 1) return reply(askMain(r.claim), "Question.");
      if (call === 2) return reply({ kind: "close_thread", threadId: THREAD }, "Moving on.");
      return reply({ kind: "wrap_up" }, "Bye.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(moveKinds(events)).toEqual(["close_thread", "wrap_up"]);
  });

  test("a move that waits for the learner ends the request", async () => {
    const x = chaining();
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    expect(moveKinds(events)).toEqual(["ask_main"]);
    expect(x.t.calls).toHaveLength(1);
  });

  test("the cap: a tutor that only ever discloses stops at the maximum, never loops", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply({ kind: "disclose_correction", correctionId: "c", threadIds: [], evidence: [] }, "Again."));
    const always: TutorKit = { ...kit, allowedMoves: () => new Set<TutorMoveKind>(["disclose_correction"]) };
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: always });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(moveKinds(events)).toHaveLength(MAX_MOVES_PER_TURN);
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(reviews.view(r.reviewId).turns.filter((x) => x.actor === "tutor")).toHaveLength(MAX_MOVES_PER_TURN);
  });

  test("a retried request replays every stored move", async () => {
    const x = chaining();
    x.world.check(x.claim, "unverified");
    const turnId = randomId("turn");
    const first = await collect(x.reviews.turn(x.reviewId, turnId, begin));
    const again = await collect(x.reviews.turn(x.reviewId, turnId, begin));
    expect(moveKinds(again)).toEqual(moveKinds(first));
    expect(x.t.calls).toHaveLength(2);
  });

  test("waitsForLearner: only a disclosure or a closed thread lets the turn go on", () => {
    expect(waitsForLearner({ kind: "disclose_correction", correctionId: "c", threadIds: [], evidence: [] })).toBe(false);
    expect(waitsForLearner({ kind: "close_thread", threadId: THREAD })).toBe(false);
    for (const move of [askMain(), { kind: "ask_followup", threadId: THREAD }, { kind: "wrap_up" }, { kind: "hint", threadId: THREAD }] as TutorMove[]) {
      expect(waitsForLearner(move)).toBe(true);
    }
  });
});

describe("an interrupted chain is resumable, and a review with no usable claim ends honestly", () => {
  const moveKinds = (events: readonly TurnEvent[]) => events.flatMap((e) => (e.type === "move" ? [e.move.kind] : []));
  const tutorRows = (reviews: Reviews, reviewId: ReviewId) => reviews.view(reviewId).turns.filter((t) => t.actor === "tutor");

  function crashing() {
    const r = startedRig(undefined, {}, true);
    let down = false;
    const t = tutorHarness(r.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      if (pending) return reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.");
      return down ? fail("boom") : reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "Which claim holds?");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 });
    return { ...r, t, reviews, setDown: (v: boolean) => void (down = v) };
  }

  test("a chain that stops after a disclosure: the view says the tutor owes a move; a resend continues once and ends with a question", async () => {
    const x = crashing();
    x.world.check(x.claim2!, "unverified");
    x.setDown(true);
    const turnId = randomId("turn");
    const failed = await collect(x.reviews.turn(x.reviewId, turnId, { kind: "begin" }));
    expect(moveKinds(failed)).toEqual(["disclose_correction"]);
    expect(failed.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    const view = x.reviews.view(x.reviewId);
    expect(view.owesMove).toBe(true);
    expect(view.state.phase).toBe("active");

    x.setDown(false);
    const again = await collect(x.reviews.turn(x.reviewId, turnId, { kind: "begin" }));
    expect(moveKinds(again)).toEqual(["disclose_correction", "ask_main"]);
    expect(types(again).at(-1)).toBe("turn_complete");
    expect(tutorRows(x.reviews, x.reviewId)).toHaveLength(2);
    expect(x.reviews.view(x.reviewId).turns.filter((t) => t.actor === "learner")).toHaveLength(1);
    expect(x.reviews.view(x.reviewId).owesMove).toBe(false);
  });

  test("owesMove: not for a waiting move, the soft-target prompt, a paused or an ended review", () => {
    const rvw: ReviewId = stableId("rvw", 1);
    const base = (n: number) => ({ id: stableId("turn", n), reviewId: rvw, seq: asSeq(n), atMs: n, threadId: null });
    const tutor = (n: number, move: TutorMove): Turn => ({ ...base(n), actor: "tutor", move, say: "" });
    const note = (n: number): Turn => ({ ...base(n), actor: "code", notice: { kind: "soft_target_reached", elapsedS: 1 } });
    const learner = (n: number): Turn => ({ ...base(n), actor: "learner", act: answer() });
    const close: TutorMove = { kind: "close_thread", threadId: THREAD };
    expect(tutorOwesMove([learner(1), tutor(2, close)], "active")).toBe(true);
    expect(tutorOwesMove([learner(1), tutor(2, askMain())], "active")).toBe(false);
    expect(tutorOwesMove([learner(1), tutor(2, close), note(3)], "active")).toBe(false);
    expect(tutorOwesMove([tutor(2, close), learner(3)], "active")).toBe(false);
    expect(tutorOwesMove([learner(1), tutor(2, close)], "paused")).toBe(false);
    expect(tutorOwesMove([learner(1), tutor(2, close)], "ended")).toBe(false);
    expect(tutorOwesMove([], "active")).toBe(false);
  });

  test("every claim withdrawn: the disclosure, then an honest wrap_up, never turn_failed", async () => {
    const base = startedRig();
    const t = tutorHarness(base.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      if (pending) return reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.");
      return reply(askMain(stableId("clm", "gone")), "A question.");
    });
    const r = { ...base, tutor: t, reviews: createReviews(base.db, { ...base.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 }) };
    r.world.check(r.claim, "unverified");
    const events = await collect(r.reviews.turn(r.reviewId, randomId("turn"), { kind: "begin" }));
    expect(events.find((e) => e.type === "turn_failed")).toBeUndefined();
    expect(moveKinds(events)).toEqual(["disclose_correction", "wrap_up"]);
    expect(events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("")).toContain("nothing left I can fairly ask you about");
    expect(r.tutor.calls.at(-1)!.allowed).toEqual(["wrap_up"]);
    expect(r.reviews.view(r.reviewId).state.phase).toBe("ended");
    expect(r.reviews.view(r.reviewId).owesMove).toBe(false);
  });
});

describe("claims only out for a recheck do not end the review; the move cap does not strand a chain", () => {
  const moveKinds = (events: readonly TurnEvent[]) => events.flatMap((e) => (e.type === "move" ? [e.move.kind] : []));

  /** The real rules (allowedMoves, validateMove); a valid question whenever one is allowed. */
  function realRig() {
    const base = startedRig();
    const t = tutorHarness(base.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      if (pending) return reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.");
      return input.allowed.includes("ask_main")
        ? reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "A question.")
        : reply({ kind: "wrap_up" }, "Bye.");
    });
    const reviews = createReviews(base.db, { ...base.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 });
    return { ...base, tutor: t, reviews };
  }

  for (const status of ["awaiting_check", "awaiting_revision", "awaiting_recheck"] as const) {
    test(`every claim ${status}: the review stays open, the turn fails retryably, and a resend after the check continues`, async () => {
      const x = realRig();
      x.world.check(x.claim, status);
      const turnId = randomId("turn");
      const first = await collect(x.reviews.turn(x.reviewId, turnId, { kind: "begin" }));
      expect(moveKinds(first)).not.toContain("wrap_up");
      expect(first.at(-1)).toMatchObject({ type: "turn_failed", retryable: true, error: expect.stringContaining("rechecked") });
      expect(x.reviews.view(x.reviewId).state.phase).toBe("active");

      x.world.check(x.claim, "supported_by_check");
      const again = await collect(x.reviews.turn(x.reviewId, turnId, { kind: "begin" }));
      expect(again.find((e) => e.type === "turn_failed")).toBeUndefined();
      expect(moveKinds(again).at(-1)).toBe("ask_main");
      expect(types(again).at(-1)).toBe("turn_complete");
      expect(x.reviews.view(x.reviewId).state.phase).toBe("active");
      expect(x.reviews.view(x.reviewId).turns.filter((t) => t.actor === "learner")).toHaveLength(1);
    });
  }

  test("a withdrawn claim is final: the review wraps up with the honest line", async () => {
    const x = realRig();
    x.world.check(x.claim, "unverified");
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), { kind: "begin" }));
    expect(moveKinds(events).at(-1)).toBe("wrap_up");
    expect(events.find((e) => e.type === "turn_failed")).toBeUndefined();
  });

  test("a chain cut off by the move cap on a disclosure still owes a move, and a resend carries on", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, (input) =>
      input.allowed.includes("disclose_correction")
        ? reply({ kind: "disclose_correction", correctionId: "c", threadIds: [], evidence: [] }, "Again.")
        : reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [r.claim] }, "A question."),
    );
    const tutorTurns = (turns: readonly Turn[]) => turns.filter((x) => x.actor === "tutor").length;
    const capped: TutorKit = {
      ...kit,
      allowedMoves: (_state, ctx) => new Set<TutorMoveKind>(tutorTurns(ctx.turns) < MAX_MOVES_PER_TURN ? ["disclose_correction"] : ["ask_main"]),
    };
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: capped });
    const turnId = randomId("turn");
    const first = await collect(reviews.turn(r.reviewId, turnId, { kind: "begin" }));
    expect(moveKinds(first)).toHaveLength(MAX_MOVES_PER_TURN);
    expect(reviews.view(r.reviewId).owesMove).toBe(true);

    const again = await collect(reviews.turn(r.reviewId, turnId, { kind: "begin" }));
    expect(moveKinds(again)).toEqual([...moveKinds(first), "ask_main"]);
    expect(reviews.view(r.reviewId).turns.filter((x) => x.actor === "tutor")).toHaveLength(MAX_MOVES_PER_TURN + 1);
    expect(reviews.view(r.reviewId).owesMove).toBe(false);
  });
});
