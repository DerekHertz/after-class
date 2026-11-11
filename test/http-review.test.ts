import { describe, expect, test } from "bun:test";
import { nextThreadId } from "../src/backend/review/tutor";
import type { LearnerAct } from "../src/shared/domain";
import { randomId } from "../src/shared/ids";
import type { ReviewId } from "../src/shared/ids";
import { interval } from "../src/shared/time";
import { reviewOptionsResponse, reviewViewResponse, saveResponse, startReviewResponse, tutorStreamEvent } from "../src/shared/wire";
import { JSON_HEADERS, SRC, bearer, count, learnerRows, moveOf, pick, post, registerCleanup, reviewRig, reviewRows, said, startedIn, tutorRows, until } from "./http-fixtures";
import { raceAt } from "./interleave";

registerCleanup();

describe("GET /captures/:id/review-options", () => {
  test("answers nothing_to_review, processing and ready in the route's schema", async () => {
    const rig = reviewRig();
    const get = async () => reviewOptionsResponse.parse(await (await fetch(`${rig.base}/captures/${rig.capture}/review-options`, { headers: bearer })).json());
    expect(await get()).toMatchObject({ kind: "nothing_to_review", gaps: [] });

    const { rev } = rig.prepare();
    expect(await get()).toMatchObject({ kind: "ready", scope: { supportedClaims: 2 } });

    rig.world.pendingChunks.add(rev.id);
    expect(await get()).toMatchObject({ kind: "processing", pendingChunks: 1 });
    expect((await fetch(`${rig.base}/captures/${rig.capture}/review-options`)).status).toBe(401);
    expect((await fetch(`${rig.base}/captures/nope/review-options`, { headers: bearer })).status).toBe(400);
  });
});

describe("POST /captures/:id/reviews", () => {
  test("starts a review with the scope in the route's schema, Material as canonical rows", async () => {
    const rig = reviewRig();
    rig.prepare();
    const s = await rig.startReview();
    expect(s.status).toBe(200);
    expect(startReviewResponse.parse(s.body)).toMatchObject({ kind: "started", reviewId: s.reviewId });
    expect(s.body.scope.material).toEqual([[SRC, [[0, 300]]]]);
    expect(s.body.scope.claimsAtStart).toHaveLength(2);
    expect(reviewRows(rig.db)).toBe(1);
  });

  test('R15: "Retrying a save never creates a duplicate record." A resent start returns the stored scope and inserts nothing', async () => {
    const rig = reviewRig();
    rig.prepare();
    const first = await rig.startReview();
    rig.world.claim(3, 50, 60);
    const again = await rig.startReview(first.reviewId);
    expect(again.body).toEqual(first.body);
    expect(reviewRows(rig.db)).toBe(1);
    expect((await rig.startReview(first.reviewId, "prepared_only", randomId("cap"))).status).toBe(409);
    expect(reviewRows(rig.db)).toBe(1);
  });

  test('R10: "A review never starts with zero supported claims in scope." nothing_to_review carries gaps, unverified claims and rewatch, writes no review, and Retry reaches preparation', async () => {
    const rig = reviewRig();
    const rev = rig.world.close(0, 0, 300);
    const unverified = rig.world.claim(1, 10, 20, "unverified");
    rig.world.gaps.push({ sourceId: SRC, interval: interval(100, 130), channel: "transcript", reason: "no_transcript" });
    const s = await rig.startReview();
    expect(s.status).toBe(200);
    const body = startReviewResponse.parse(s.body);
    expect(body).toMatchObject({ kind: "nothing_to_review", gaps: [{ reason: "no_transcript" }], unverified: [{ id: unverified }] });
    if (body.kind === "nothing_to_review") expect(body.rewatch.length).toBeGreaterThan(0);
    expect(reviewRows(rig.db)).toBe(0);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM review_turns")).toBe(0);

    const retry = await post(rig.base, `/captures/${rig.capture}/retry-preparation`, {});
    expect(retry.status).toBe(204);
    expect(rig.retries).toEqual([{ captureId: rig.capture, ids: [rev.id] }]);
  });

  test("a stop-early start while a chunk is still preparing labels the review partial", async () => {
    const rig = reviewRig();
    rig.prepare();
    const slow = rig.world.close(1, 300, 600);
    rig.world.pendingChunks.add(slow.id);
    rig.world.claim(3, 400, 410, "awaiting_check");
    const s = await rig.startReview(randomId("rvw"), "stop_early");
    expect(startReviewResponse.parse(s.body)).toMatchObject({ kind: "started", scope: { partial: [{ kind: "stopped_early", droppedClaims: 1 }] } });
  });

  test("bad ids and bodies are 400 and a wrong token is 401; nothing is written", async () => {
    const rig = reviewRig();
    rig.prepare();
    const url = `/captures/${rig.capture}/reviews`;
    const good = { reviewId: randomId("rvw"), choice: "prepared_only" };
    expect((await post(rig.base, url, { ...good, reviewId: "rvw_nope" })).status).toBe(400);
    expect((await post(rig.base, url, { ...good, choice: "later" })).status).toBe(400);
    expect((await post(rig.base, url, { choice: "prepared_only" })).status).toBe(400);
    expect((await post(rig.base, url, "{")).status).toBe(400);
    expect((await post(rig.base, "/captures/nope/reviews", good)).status).toBe(400);
    expect((await post(rig.base, url, good, { "Content-Type": "application/json" })).status).toBe(401);
    expect((await post(rig.base, url, good, { Authorization: "Bearer nope" })).status).toBe(401);
    expect(reviewRows(rig.db)).toBe(0);
  });
});

describe("POST /reviews/:id/turns", () => {
  test("streams one JSON object per line: learner turn stored, prose, then the move, then turn_complete", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    const t = await rig.turn(reviewId, { kind: "resume" });
    expect(t.status).toBe(200);
    expect(t.type).toContain("application/x-ndjson");
    expect(t.body.endsWith("\n")).toBe(true);
    expect(t.lines.at(-1)).toBe("");
    for (const line of t.lines.slice(0, -1)) {
      expect(line).not.toBe("");
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const types = t.events.map((e) => e.type);
    expect(types[0]).toBe("learner_turn_stored");
    expect(types.at(-1)).toBe("turn_complete");
    expect(types.filter((x) => x === "turn_complete" || x === "turn_failed")).toHaveLength(1);
    expect(types.indexOf("sentence")).toBeGreaterThan(0);
    expect(types.indexOf("move")).toBeGreaterThan(types.lastIndexOf("sentence"));
    expect(moveOf(t.events)).toBe("ask_main");
    expect(t.events.filter((e) => e.type === "sentence").map((e) => (e as { text: string }).text)).toEqual([
      "In your own words, what is claim 1?",
      "Take your time.",
    ]);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test("a client that disconnects mid-stream does not corrupt the turn: it still commits once, and a resend replays it without the model", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rig = reviewRig(async (input) => {
      await gate;
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const turnId = randomId("turn");
    const ac = new AbortController();
    const res = await fetch(`${rig.base}/reviews/${reviewId}/turns`, {
      method: "POST", headers: JSON_HEADERS, signal: ac.signal, body: JSON.stringify({ turnId, act: { kind: "resume" } }),
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(tutorStreamEvent.parse(JSON.parse(new TextDecoder().decode(first.value).trim()))).toEqual({ type: "learner_turn_stored", turnId });
    ac.abort();
    await reader.read().catch(() => undefined);
    expect(tutorRows(rig.db)).toBe(0);

    release();
    await until(() => tutorRows(rig.db) === 1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(rig.model.calls).toHaveLength(1);

    const resent = await rig.turn(reviewId, { kind: "resume" }, turnId);
    expect(resent.events[0]).toEqual({ type: "learner_turn_stored", turnId });
    expect(resent.events.at(-1)?.type).toBe("turn_complete");
    expect(moveOf(resent.events)).toBe("ask_main");
    expect(rig.model.calls).toHaveLength(1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test('R15: a resent turn that already completed replays the stored reply and neither inserts nor calls the model', async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    const first = await rig.turn(reviewId, { kind: "resume" });
    const again = await rig.turn(reviewId, { kind: "resume" }, first.turnId);
    expect(again.events.at(-1)).toEqual(first.events.at(-1));
    expect(moveOf(again.events)).toBe(moveOf(first.events));
    expect(rig.model.calls).toHaveLength(1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test('R15: a resent turn racing its original asks the model once and stores one learner and one tutor turn', async () => {
    let hook: () => void = () => {};
    const rig = reviewRig((input) => {
      hook();
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const turnId = randomId("turn");
    const { first, second } = await raceAt(
      "model-called",
      (il) => {
        hook = () => il.at("model-called");
        return rig.turn(reviewId, { kind: "resume" }, turnId);
      },
      () => rig.turn(reviewId, { kind: "resume" }, turnId),
    );
    for (const t of [first, second]) {
      expect(t.events[0]).toEqual({ type: "learner_turn_stored", turnId });
      expect(t.events.at(-1)?.type).toBe("turn_complete");
      expect(moveOf(t.events)).toBe("ask_main");
    }
    expect(rig.model.calls).toHaveLength(1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test('R3: "A claim can be used to judge my answers only if it passed the evidence check." A claim that loses its check while the tutor talks is not the question that is stored', async () => {
    let hook: () => void = () => {};
    const rig = reviewRig((input) => {
      hook();
      return pick(input);
    });
    const { a } = rig.prepare();
    const started = await rig.startReview();
    const { first } = await raceAt(
      "model-called",
      (il) => {
        hook = () => il.at("model-called");
        return rig.turn(started.reviewId, { kind: "resume" });
      },
      () => rig.world.check(a, "unverified"),
    );
    expect(first.events.at(-1)?.type).toBe("turn_complete");
    expect(moveOf(first.events)).toBe("disclose_correction");
    expect(rig.model.calls).toHaveLength(3);

    const { body } = await rig.view(started.reviewId);
    const turns = body.turns as { actor: string; move?: { kind: string; claimIds?: string[] }; notice?: { kind: string } }[];
    const tutors = turns.filter((t) => t.actor === "tutor");
    expect(tutors.map((t) => t.move?.kind)).toEqual(["disclose_correction", "ask_main"]);
    expect(tutors.some((t) => t.move?.claimIds?.includes(a))).toBe(false);
    expect(turns.some((t) => t.actor === "code" && t.notice?.kind === "correction_pending")).toBe(true);
  });

  test("one turn at a time per review: a second turn post with a different turnId while one runs is 409 and stores nothing; the same turnId still replays", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rig = reviewRig(async (input, call) => {
      if (call === 1) await gate;
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const second = await rig.startReview(randomId("rvw"), "prepared_only", randomId("cap"));
    const other = second.reviewId;
    const turnId = randomId("turn");
    const running = await post(rig.base, `/reviews/${reviewId}/turns`, { turnId, act: { kind: "resume" } });
    await until(() => rig.model.calls.length === 1);

    const refused = await post(rig.base, `/reviews/${reviewId}/turns`, { turnId: randomId("turn"), act: said("too soon") });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: expect.any(String) });
    expect(learnerRows(rig.db)).toBe(1);
    expect(rig.model.calls).toHaveLength(1);

    // another review is not held up
    const elsewhere = await rig.turn(other, { kind: "resume" });

    expect(elsewhere.events.at(-1)?.type).toBe("turn_complete");

    const joined = post(rig.base, `/reviews/${reviewId}/turns`, { turnId, act: { kind: "resume" } });
    release();
    for (const r of [running, await joined]) {
      const events = (await r.text()).trim().split("\n").map((l) => tutorStreamEvent.parse(JSON.parse(l)));
      expect(events.at(-1)?.type).toBe("turn_complete");
    }
    expect(learnerRows(rig.db)).toBe(2);
    expect(rig.model.calls).toHaveLength(2);

    const next = await rig.turn(reviewId, said("lines meeting at a point"));
    expect(next.status).toBe(200);
    expect(next.events.at(-1)?.type).toBe("turn_complete");
  });

  test("a turn stream that outlives the server's deadline ends with turn_failed retryable; the turn goes on, holds the review until it ends, and a resend replays it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rig = reviewRig(async (input) => {
      await gate;
      return pick(input);
    }, { turnDeadlineMs: 60 });
    const reviewId = await startedIn(rig);
    const turnId = randomId("turn");
    const t0 = Date.now();
    const late = await rig.turn(reviewId, { kind: "resume" }, turnId);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    expect(late.events.map((e) => e.type)).toEqual(["learner_turn_stored", "turn_failed"]);
    expect(late.events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    expect(tutorRows(rig.db)).toBe(0);

    expect((await post(rig.base, `/reviews/${reviewId}/turns`, { turnId: randomId("turn"), act: said("meanwhile") })).status).toBe(409);

    release();
    await until(() => tutorRows(rig.db) === 1);
    let resent = await rig.turn(reviewId, { kind: "resume" }, turnId);
    for (let i = 0; i < 100 && resent.status === 409; i++) {
      await Bun.sleep(10);
      resent = await rig.turn(reviewId, { kind: "resume" }, turnId);
    }
    expect(resent.events.at(-1)?.type).toBe("turn_complete");
    expect(moveOf(resent.events)).toBe("ask_main");
    expect(rig.model.calls).toHaveLength(1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test("a turn that fails frees the review for the next post", async () => {
    let fail = true;
    const rig = reviewRig((input) => {
      if (fail) throw new Error("model down");
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const failed = await rig.turn(reviewId, { kind: "resume" });
    expect(failed.events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    fail = false;
    const next = await rig.turn(reviewId, { kind: "resume" });
    expect(next.status).toBe(200);
    expect(next.events.at(-1)?.type).toBe("turn_complete");
  });

  test("a failed model call reports turn_failed with retryable, keeps the learner's turn, and a resend finishes it", async () => {
    let down = true;
    const rig = reviewRig((input) => {
      if (down) throw new Error("model down");
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const failed = await rig.turn(reviewId, { kind: "resume" });
    expect(failed.events.map((e) => e.type)).toEqual(["learner_turn_stored", "turn_failed"]);
    expect(failed.events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(0);

    down = false;
    const resent = await rig.turn(reviewId, { kind: "resume" }, failed.turnId);
    expect(resent.events.at(-1)?.type).toBe("turn_complete");
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test("an unknown review is 404 and stores nothing; bad ids and bodies are 400; a wrong token is 401", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    const turnId = randomId("turn");
    const url = `/reviews/${reviewId}/turns`;
    expect((await post(rig.base, `/reviews/${randomId("rvw")}/turns`, { turnId, act: { kind: "resume" } })).status).toBe(404);
    expect((await post(rig.base, "/reviews/nope/turns", { turnId, act: { kind: "resume" } })).status).toBe(400);
    expect((await post(rig.base, url, { turnId: "turn_nope", act: { kind: "resume" } })).status).toBe(400);
    expect((await post(rig.base, url, { turnId, act: { kind: "juggle" } })).status).toBe(400);
    expect((await post(rig.base, url, { turnId, act: { kind: "answer", text: "   ", modality: "text" } })).status).toBe(400);
    expect((await post(rig.base, url, { act: { kind: "resume" } })).status).toBe(400);
    expect((await post(rig.base, url, "{")).status).toBe(400);
    expect((await post(rig.base, url, { turnId, act: { kind: "resume" } }, { "Content-Type": "application/json" })).status).toBe(401);
    expect(learnerRows(rig.db)).toBe(0);
    expect(rig.model.calls).toHaveLength(0);
  });
});

describe("GET /reviews/:id, POST /reviews/:id/save and the replay review", () => {
  test("a review through HTTP: start, five streamed turns, wrap up, save; the view carries turns, the ended state, saved and the observations", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    const acts: LearnerAct[] = [{ kind: "resume" }, said("lines meeting at a point"), said("because both equations hold there"), { kind: "skip" }, { kind: "wrap_up" }];
    const moves: (string | undefined)[] = [];
    for (const act of acts) {
      const t = await rig.turn(reviewId, act);
      expect(t.events.at(-1)?.type).toBe("turn_complete");
      moves.push(moveOf(t.events));
    }
    expect(moves).toEqual(["ask_main", "ask_followup", "close_thread", "ask_followup", "wrap_up"]);
    expect(rig.model.calls).toHaveLength(6);

    const before = await rig.view(reviewId);
    expect(before.status).toBe(200);
    reviewViewResponse.parse(before.body);
    expect(before.body).toMatchObject({ reviewId, captureId: rig.capture, saved: "unsaved", observations: [], state: { phase: "ended", mainQuestions: 2 } });
    expect(before.body.scope.material).toEqual([[SRC, [[0, 300]]]]);
    expect(before.body.turns.filter((t: { actor: string }) => t.actor === "learner")).toHaveLength(5);
    expect(before.body.turns.filter((t: { actor: string }) => t.actor === "tutor")).toHaveLength(6);

    const save = await post(rig.base, `/reviews/${reviewId}/save`, {});
    expect(save.status).toBe(200);
    expect(saveResponse.parse(await save.json())).toMatchObject({ kind: "saved", observations: 2 });

    const after = await rig.view(reviewId);
    reviewViewResponse.parse(after.body);
    expect(after.body.saved).toBe("saved");
    expect(after.body.observations).toHaveLength(2);
    const status = (thread: string) => after.body.observations.find((o: { threadId: string }) => o.threadId === thread).status;
    expect(status(nextThreadId({ reviewId, mainQuestions: 0 }))).toBe("independent");
    expect(status(nextThreadId({ reviewId, mainQuestions: 1 }))).not.toBe("independent");

    const resaved = await post(rig.base, `/reviews/${reviewId}/save`, {});
    expect(await resaved.json()).toEqual({ kind: "saved", notes: 1, observations: 2, links: 1 });
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM observations")).toBe(2);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM notes")).toBe(1);
  });

  /** What the app does after an end: the turn wraps up, the view reads ended, and the save (POST /save) records notes and observations. */
  const endsAndSaves = async (rig: ReturnType<typeof reviewRig>, reviewId: ReviewId, ending: { events: readonly { type: string }[] }) => {
    expect(ending.events.at(-1)?.type).toBe("turn_complete");
    expect(moveOf(ending.events)).toBe("wrap_up");
    expect((await rig.view(reviewId)).body.state.phase).toBe("ended");
    const save = await post(rig.base, `/reviews/${reviewId}/save`, {});
    expect(save.status).toBe(200);
    const saved = saveResponse.parse(await save.json());
    expect(saved).toMatchObject({ kind: "saved", notes: 1 });
    expect(saved.kind === "saved" && saved.observations).toBeGreaterThan(0);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM saved_reviews")).toBe(1);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM notes")).toBe(1);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM observations")).toBe(saved.kind === "saved" ? saved.observations : -1);
  };

  test("#136: ending a paused review wraps it up, and the save records its notes and observations", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    for (const act of [{ kind: "resume" }, said("lines meeting at a point"), { kind: "pause" }] as LearnerAct[]) await rig.turn(reviewId, act);
    expect((await rig.view(reviewId)).body.state.phase).toBe("paused");
    await endsAndSaves(rig, reviewId, await rig.turn(reviewId, { kind: "end" }));
  });

  test("#136: pause, resume, then end wraps up and saves", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    for (const act of [{ kind: "resume" }, said("lines meeting at a point"), { kind: "pause" }, { kind: "resume" }] as LearnerAct[]) await rig.turn(reviewId, act);
    await endsAndSaves(rig, reviewId, await rig.turn(reviewId, { kind: "end" }));
  });

  test("#136: a pause sent while a tutor turn is in flight is refused; pausing and ending once it lands still wraps up and saves", async () => {
    let release: (() => void) | null = null;
    const rig = reviewRig(async (input) => {
      if (release === null) await new Promise<void>((r) => (release = r));
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const opening = rig.turn(reviewId, { kind: "resume" });
    await until(() => release !== null);
    expect((await rig.turn(reviewId, { kind: "pause" })).status).toBe(409);
    release!();
    expect((await opening).events.at(-1)?.type).toBe("turn_complete");
    await rig.turn(reviewId, said("lines meeting at a point"));
    await rig.turn(reviewId, { kind: "pause" });
    expect((await rig.view(reviewId)).body.state.phase).toBe("paused");
    await endsAndSaves(rig, reviewId, await rig.turn(reviewId, { kind: "end" }));
  });

  test("GET /reviews/:id of an unknown review is 404, of a bad id 400, without the token 401", async () => {
    const rig = reviewRig();
    expect((await rig.view(randomId("rvw"))).status).toBe(404);
    expect((await fetch(`${rig.base}/reviews/nope`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${rig.base}/reviews/${randomId("rvw")}`)).status).toBe(401);
  });

  test("POST /reviews/:id/save: unknown review 404, wrong token 401, a failed save reads save_pending and a retry saves once", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    await rig.turn(reviewId, { kind: "resume" });
    await rig.turn(reviewId, { kind: "end" });
    expect((await post(rig.base, `/reviews/${randomId("rvw")}/save`, {})).status).toBe(404);
    expect((await post(rig.base, `/reviews/${reviewId}/save`, {}, { "Content-Type": "application/json" })).status).toBe(401);

    rig.flags.failSave = true;
    const failed = await post(rig.base, `/reviews/${reviewId}/save`, {});
    expect(failed.status).toBe(200);
    expect(saveResponse.parse(await failed.json())).toMatchObject({ kind: "save_failed", retryable: true });
    expect((await rig.view(reviewId)).body.saved).toBe("save_pending");
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM saved_reviews")).toBe(0);

    rig.flags.failSave = false;
    expect(saveResponse.parse(await (await post(rig.base, `/reviews/${reviewId}/save`, {})).json()).kind).toBe("saved");
    expect((await rig.view(reviewId)).body.saved).toBe("saved");
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM saved_reviews")).toBe(1);
  });
});
