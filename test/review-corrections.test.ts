import { describe, expect, test } from "bun:test";
import type { Reviews, TutorKit } from "../src/backend/review";
import { createReviews } from "../src/backend/review";
import { nextThreadId } from "../src/backend/review/tutor";
import type { TutorMoveKind } from "../src/shared/domain";
import type { ClaimId, ReviewId } from "../src/shared/ids";
import { randomId, stableId } from "../src/shared/ids";
import { Material } from "../src/shared/time";
import type { Script } from "./review-fixtures";
import { THREAD, answer, askMain, collect, kit, reply, rig, started, startedRig, tutorHarness, types } from "./review-fixtures";

// ───────────────────────────── R7: scope never grows ─────────────────────────────

describe("a recurring correction is disclosed each time", () => {
  /** Each turn the tutor discloses the first pending correction, or wraps up when none is pending. */
  function disclosingRig(text = "v0") {
    const r = rig();
    r.world.close(0, 0, 300);
    const claim = r.world.claim(1, 10, 20, "supported_by_check", text);
    const reviewId = randomId("rvw");
    started(r.reviews.start(r.capture, "prepared_only", reviewId));
    const t = tutorHarness(r.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      return pending
        ? reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.")
        : reply({ kind: "ask_main", threadId: THREAD, claimIds: [input.claims[0]!.id] }, "A question.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const pending = () => reviews.view(reviewId).state.corrections.filter((c) => !c.disclosed);
    const turn = () => collect(reviews.turn(reviewId, randomId("turn"), answer()));
    return { ...r, claim, reviewId, reviews, pending, turn };
  }

  test("a second text change after the first was disclosed must be disclosed too", async () => {
    const x = disclosingRig("v0");
    x.world.claims.get(x.claim)!.text = "v1";
    await x.turn();
    expect(x.pending()).toEqual([]);
    x.world.claims.get(x.claim)!.text = "v2";
    expect(x.pending()).toMatchObject([{ claimId: x.claim, change: "text_changed" }]);
  });

  test("withdrawn, disclosed, reinstated by a new check, then withdrawn again must be disclosed again", async () => {
    const x = disclosingRig();
    x.world.check(x.claim, "unverified");
    await x.turn();
    expect(x.pending()).toEqual([]);
    x.world.check(x.claim, "supported_by_check");
    expect(x.pending()).toEqual([]);
    x.world.check(x.claim, "unverified");
    expect(x.pending()).toMatchObject([{ claimId: x.claim, change: "withdrawn" }]);
  });

  test("a withdrawal that persists is disclosed once", async () => {
    const x = disclosingRig();
    x.world.check(x.claim, "unverified");
    await x.turn();
    await x.turn();
    expect(x.pending()).toEqual([]);
  });
});

describe("R7 scope never grows (the TLC counterexample)", () => {
  /** Review starts on [0, 60); a later window moves the boundary so the chunk now reaches [0, 120) with a new claim in the new half. */
  function counterexample() {
    const r = rig((input) => reply(askMain(...input.claims.map((c) => c.id) as [ClaimId, ...ClaimId[]]), "What does the first claim say?"));
    const rev = r.world.close(0, 0, 60);
    const old = r.world.claim(1, 10, 20);
    const reviewId = randomId("rvw");
    const scope = started(r.reviews.start(r.capture, "prepared_only", reviewId)).scope;
    const moved = r.world.close(0, 0, 120, "boundary_revised");
    const added = r.world.claim(2, 70, 80);
    return { ...r, rev, moved, old, added, reviewId, scope };
  }

  test("the open review keeps its frozen material and claims", () => {
    const x = counterexample();
    const view = x.reviews.view(x.reviewId);
    expect(view.scope).toEqual(x.scope);
    expect(Material.duration(view.scope.material)).toBe(60);
    expect(view.scope.claimsAtStart).toEqual([x.old]);
  });

  test("the tutor is only ever given claims and evidence inside the frozen material", async () => {
    const x = counterexample();
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    const input = x.tutor.calls[0]!;
    expect(input.claims.map((c) => c.id)).toEqual([x.old]);
    expect(input.evidence.passages.map((p) => p.id)).toEqual([stableId("ev", "w", 1)]);
    expect(x.reviews.view(x.reviewId).state.corrections).toEqual([]);
  });

  test("a dependency that ignores the material it was given still cannot add material", async () => {
    const x = counterexample();
    const leaky = createReviews(x.db, { ...x.world.deps, assessableIn: () => x.world.deps.assessableIn(x.capture, x.moved.material), runTutor: x.tutor.runTutor, clearFailures: x.tutor.clearFailures }, { tutor: kit });
    await collect(leaky.turn(x.reviewId, randomId("turn"), answer()));
    expect(x.tutor.calls[0]!.claims.map((c) => c.id)).toEqual([x.old]);
    expect(leaky.view(x.reviewId).state.corrections).toEqual([]);
  });

  test("the moved boundary becomes separate, later material instead", () => {
    const x = counterexample();
    expect(x.reviews.options(x.capture)).toMatchObject({ kind: "ready", scope: { chunkRevisions: [x.moved.id] } });
  });

  test("a claim inside the scope that was asked about and is withdrawn is disclosed as a correction, and the tutor must disclose it first", async () => {
    const x = counterexample();
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    x.world.claims.get(x.old)!.status = "unverified";
    const t = tutorHarness(x.db, (input) =>
      reply({ kind: "disclose_correction", correctionId: input.state.corrections[0]!.id, threadIds: [], evidence: [] }, "I need to correct something."),
    );
    const reviews = createReviews(x.db, { ...x.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const events = await collect(reviews.turn(x.reviewId, randomId("turn"), answer()));
    expect(t.calls[0]!.allowed).toEqual(["disclose_correction"]);
    expect(events.find((e) => e.type === "turn_failed")).toBeUndefined();
    const turns = reviews.view(x.reviewId).turns;
    expect(turns.filter((t) => t.actor === "code" && t.notice.kind.startsWith("correction"))).toMatchObject([{ notice: { kind: "correction_pending", affectedClaims: [x.old] } }]);
    expect(reviews.view(x.reviewId).state.corrections).toMatchObject([{ claimId: x.old, change: "withdrawn", disclosed: true }]);
  });
});

// ───────────────────────────── #137: the first tutor turn is a question ─────────────────────────────

describe("a correction to a claim not yet asked about in this review is applied silently and logged", () => {
  /** The real W8 rules; the model discloses whenever disclosure is allowed, otherwise asks about the first usable claim. */
  function pendingAtStart() {
    const r = startedRig(undefined, {}, true);
    const t = tutorHarness(r.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      if (input.allowed.includes("disclose_correction") && pending) return reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.");
      if (input.allowed.includes("ask_main")) return reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "A question.");
      return input.allowed.includes("ask_followup") ? reply({ kind: "ask_followup", threadId: input.state.openThread! }, "Say more.") : reply({ kind: "wrap_up" }, "Bye.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 });
    r.world.claims.get(r.claim)!.text = "claim 1, reworded";
    r.world.claims.get(r.claim2!)!.status = "unverified";
    return { ...r, t, reviews };
  }
  const moves = (events: readonly { type: string }[]) => events.flatMap((e) => (e.type === "move" ? [(e as unknown as { move: { kind: string } }).move.kind] : []));

  test("with corrections pending at the start, the first tutor turn of a new review is a question", async () => {
    const x = pendingAtStart();
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), { kind: "begin" }));
    expect(x.t.calls[0]!.allowed).not.toContain("disclose_correction");
    expect(moves(events)).toEqual(["ask_main"]);
    const view = x.reviews.view(x.reviewId);
    expect(view.turns.filter((t) => t.actor === "code")).toMatchObject([
      { notice: { kind: "correction_applied", affectedClaims: [x.claim] } },
      { notice: { kind: "correction_applied", affectedClaims: [x.claim2] } },
    ]);
    expect(view.state.corrections.filter((c) => !c.disclosed)).toEqual([]);
    expect(x.t.calls[0]!.claims.map((c) => c.text)).toEqual(["claim 1, reworded"]);
  });

  test("a silently applied correction is not announced later, when its claim is asked about", async () => {
    const x = pendingAtStart();
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), { kind: "begin" }));
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    expect(moves(events)).not.toContain("disclose_correction");
    expect(x.reviews.view(x.reviewId).turns.filter((t) => t.actor === "tutor" && t.move.kind === "disclose_correction")).toEqual([]);
  });
});

// ───────────────────────────── a pending correction never sticks the review ─────────────────────────────

describe("code-written disclose_correction when the model fails", () => {
  /** The real W8 rules (allowedMoves, validateMove), so the code move passes the same check a model move would. */
  function stuck(script: Script) {
    const r = startedRig(undefined, {}, true);
    const t = tutorHarness(r.db, script);
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 });
    return { ...r, t, reviews };
  }
  /** Invalid while a correction is pending (so code writes the disclosure); a valid question once it is not. */
  const useless: Script = (input) =>
    input.allowed.includes("ask_main")
      ? reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "A question.")
      : reply({ kind: "wrap_up" }, "Bye.");
  const disclosures = (reviews: Reviews, reviewId: ReviewId) =>
    reviews.view(reviewId).turns.filter((t) => t.actor === "tutor" && t.move.kind === "disclose_correction");
  /** One turn that asks about the first claim, so a later correction to it is disclosed (#137). Returns the calls made so far. */
  const askFirst = async (x: ReturnType<typeof stuck>) => {
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    return x.t.calls.length;
  };
  const open = (reviewId: ReviewId) => nextThreadId({ reviewId, mainQuestions: 0 });

  test("a withdrawn claim: after two failed model calls code discloses it, names the claim and cites no evidence", async () => {
    const x = stuck(useless);
    const before = await askFirst(x);
    x.world.claims.get(x.claim)!.status = "unverified";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));

    // Two failed calls before code discloses, two before code closes the paused thread (R3), one valid question.
    expect(x.t.calls.slice(before)).toHaveLength(5);
    expect(x.t.calls[before]!.allowed).toEqual(["disclose_correction"]);
    const move = events.find((e) => e.type === "move");
    expect(move).toMatchObject({ move: { kind: "disclose_correction", threadIds: [open(x.reviewId)], evidence: [] } });
    const said = events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("");
    expect(said).toContain("claim 1");
    expect(said).toMatch(/no longer/);
    expect(events.filter((e) => e.type === "move").map((e) => e.type === "move" && e.move.kind)).toEqual(["disclose_correction", "close_thread", "ask_main"]);
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(x.reviews.view(x.reviewId).state.corrections).toMatchObject([{ claimId: x.claim, change: "withdrawn", disclosed: true }]);
  });

  test("a reworded claim on an open thread: the disclosure names the new text, the thread, and only the claim's own evidence", async () => {
    let call = 0;
    const x = stuck((input) => {
      call++;
      if (call === 1) return reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "Question one.");
      return input.allowed.includes("ask_followup") ? reply({ kind: "ask_followup", threadId: input.state.openThread! }, "Say more.") : reply({ kind: "wrap_up" }, "Bye.");
    });
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer("first")));
    x.world.claims.get(x.claim)!.text = "claim 1, reworded";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer("second")));

    expect(events.find((e) => e.type === "move")).toMatchObject({
      move: { kind: "disclose_correction", threadIds: [open(x.reviewId)], evidence: [stableId("ev", "w", 1)] },
    });
    const said = events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("");
    expect(said).toContain("claim 1, reworded");
    expect(x.reviews.view(x.reviewId).state.corrections).toMatchObject([{ change: "text_changed", disclosed: true }]);
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("a retried turn replays the same code move and writes nothing twice", async () => {
    const x = stuck(useless);
    await askFirst(x);
    x.world.claims.get(x.claim)!.status = "unverified";
    const turnId = randomId("turn");
    const first = await collect(x.reviews.turn(x.reviewId, turnId, answer()));
    const turnsBefore = x.reviews.view(x.reviewId).turns;
    const calls = x.t.calls.length;
    const again = await collect(x.reviews.turn(x.reviewId, turnId, answer()));

    expect(x.t.calls).toHaveLength(calls);
    expect(x.reviews.view(x.reviewId).turns).toEqual(turnsBefore);
    expect(disclosures(x.reviews, x.reviewId)).toHaveLength(1);
    expect(again.filter((e) => e.type === "move")).toEqual(first.filter((e) => e.type === "move"));
    expect(again.filter((e) => e.type === "sentence")).toEqual(first.filter((e) => e.type === "sentence"));
  });

  test("when the disclosure and a closing move are both allowed, the disclosure comes first", async () => {
    const r = startedRig((input) => reply(askMain(input.claims[0]!.id), "A question."));
    await collect(r.reviews.turn(r.reviewId, randomId("turn"), answer()));
    r.world.claims.get(r.claim)!.status = "unverified";
    const t = tutorHarness(r.db, () => reply({ kind: "propose_detour", topic: "x", reason: "y", needsResource: null }, "Detour."));
    const both: TutorKit = { ...kit, allowedMoves: () => new Set<TutorMoveKind>(["wrap_up", "disclose_correction"]) };
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: both });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "disclose_correction" } });
  });

  test("when the model succeeds its own disclosure is used and code writes nothing", async () => {
    const x = stuck((input) =>
      input.allowed.includes("disclose_correction")
        ? reply({ kind: "disclose_correction", correctionId: input.state.corrections.find((c) => !c.disclosed)!.id, threadIds: [], evidence: [] }, "Model words.")
        : input.allowed.includes("close_thread")
          ? reply({ kind: "close_thread", threadId: input.state.openThread! }, "Moving on.")
          : reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "Then a question."),
    );
    const before = await askFirst(x);
    x.world.claims.get(x.claim)!.status = "unverified";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    expect(x.t.calls.slice(before)).toHaveLength(3);
    expect(events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("")).toBe("Model words.Moving on.Then a question.");
    expect(disclosures(x.reviews, x.reviewId)).toMatchObject([{ say: "Model words." }]);
  });
});
