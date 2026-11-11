import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Api } from "../src/app/api";
import { ApiError } from "../src/app/api";
import type { SessionState } from "../src/app/controller";
import { createReviewController, needsChecklist, needsResume, resumeOnce } from "../src/app/controller";
import { conversationLines, owedLearnerTurn, startLive, stepStartHandoff } from "../src/app/core";
import { reviewViewz } from "../src/app/decode";
import { Composer, SaveBanner, TopicChecklist, UndeliveredNote } from "../src/app/review";
import type { Speaker } from "../src/app/speech";
import { createSynthSpeaker } from "../src/app/speech";
import { createMemoryUnsent } from "../src/app/unsent";
import { gateSpeaker } from "../src/app/voice";
import type { LearnerAct, ReviewView } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import { learnerAct } from "../src/shared/wire";
import { answer, clm, cpt, events, findElements, learnerAnswer, parsedReview, reviewId, reviewJson, sentence, setup, thr, turnJson, tutorAsk } from "./app-fixtures";

describe("save banner", () => {
  const session = (o: Partial<SessionState>): SessionState => ({
    view: parsedReview(), loadError: null, live: null, unsent: [], sendError: null, saving: false, saveError: null, savedSummary: null, storageDegraded: false, ...o,
  });
  const banner = (o: Partial<SessionState>) => renderToStaticMarkup(createElement(SaveBanner, { state: session(o), onRetry: () => {}, reviewId }));

  test("it says Saved only when the backend reports the review saved", () => {
    expect(banner({ view: parsedReview({ saved: "saved" }) })).toContain("Review saved");
    expect(banner({ view: parsedReview({ saved: "unsaved" }) })).not.toContain("saved<");
    expect(banner({ view: parsedReview({ saved: "save_pending" }) })).not.toContain("Review saved");
    expect(banner({ view: parsedReview({ saved: "unsaved" }), saving: true })).toContain("Saving this review to your notebook...");
    expect(banner({ view: parsedReview({ saved: "unsaved" }), saving: true })).not.toContain("Review saved");
    expect(banner({ saveError: "offline" })).toContain("not saved yet: offline");
  });

  test("degraded local storage is stated, with the consequence, whatever the save state; healthy storage claims nothing about it", () => {
    for (const saved of ["unsaved", "saved", "save_pending"] as const) {
      const out = banner({ storageDegraded: true, view: parsedReview({ saved }) });
      expect(out).toContain("not keeping your unsent messages");
      expect(out).toContain("reload");
    }
    expect(banner({ storageDegraded: true, saveError: "offline" })).not.toContain("kept on this computer");
    expect(banner({ saveError: "offline" })).not.toContain("not keeping your unsent messages");
  });
});

describe("review session controller", () => {
  test("a sent turn is kept until the backend stores it, its sentences are spoken, and the view is refreshed", async () => {
    let keptWhileStreaming = -1;
    const h = setup({
      sendTurn: async function* ({ turnId }) {
        keptWhileStreaming = (await h.unsent.forReview(reviewId)).length;
        yield { type: "learner_turn_stored", turnId };
        yield { type: "move", turnId, move: { kind: "wrap_up" } };
        yield { type: "say_delta", text: "Good. Next." };
        yield sentence("Good.");
        yield sentence("Next.");
        yield { type: "turn_complete", turnId };
      },
    });
    await h.controller.send(answer);
    expect(keptWhileStreaming).toBe(1);
    expect(await h.unsent.forReview(reviewId)).toEqual([]);
    expect(h.spoken).toEqual(["Good.", "Next."]);
    expect(h.reviews()).toBe(1);
    expect(h.controller.getState()).toMatchObject({ live: null, view: { reviewId } });
  });

  test("R15: a turn lost before it was stored is resent under the same id", async () => {
    const h = setup({
      sendTurn: ({ turnId }, n) =>
        n === 0
          ? events({ type: "turn_failed", error: "connection reset", retryable: true })
          : events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }),
    });
    await h.controller.send(answer);
    expect(h.controller.getState().live).toMatchObject({ status: "failed", retryable: true });
    expect(h.controller.getState().unsent).toHaveLength(1);
    await h.controller.retryTurn();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toEqual(h.sends[0]!);
    expect(h.controller.getState().unsent).toEqual([]);
  });

  test("a turn kept from a previous page load is resent with its original id", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    const original = { turnId: randomId("turn"), reviewId, act: answer, createdAtMs: 5 };
    await h.unsent.put(original);
    await h.controller.load();
    expect(h.controller.getState().unsent).toEqual([original]);
    await h.controller.retryTurn();
    expect(h.sends).toEqual([{ turnId: original.turnId, act: answer }]);
  });

  test("a stored turn the tutor never answered is resent from the view, again under its own id", async () => {
    const h = setup({
      review: () => parsedReview({ turns: [tutorAsk, learnerAnswer()] }),
      sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }),
    });
    await h.controller.load();
    await h.controller.retryTurn();
    expect(h.sends).toEqual([{ turnId: stableId("turn", "l2"), act: { kind: "answer", text: "An ordering of events.", modality: "speech" } }]);
  });

  test("an HTTP failure before the stream starts leaves the turn unsent and marks it retryable by status", async () => {
    const h = setup({
      // A failed async iterator rejects on next(), before yielding any event.
      // eslint-disable-next-line require-yield
      sendTurn: async function* () {
        throw new ApiError("backend restarting", 503);
      },
    });
    await h.controller.send(answer);
    expect(h.controller.getState().live).toMatchObject({ status: "failed", error: "backend restarting", retryable: true });
    expect(h.controller.getState().unsent).toHaveLength(1);
  });

  test("chat-first: a gated-off speaker never delays a send, and the sentences still stream to the screen", async () => {
    const calls: string[] = [];
    const speaker = gateSpeaker(() => false, () => (calls.push("made"), { beginTurn: () => void calls.push("begin"), speak: () => void calls.push("speak"), stop: () => void calls.push("stop") }));
    const api: Api = {
      reviewOptions: async () => { throw new Error("unused"); },
      startReview: async () => { throw new Error("unused"); },
      sendTurn: async function* (_r, turnId) {
        yield { type: "learner_turn_stored", turnId };
        yield sentence("One.");
        yield sentence("Two.");
        yield { type: "turn_complete", turnId };
      },
      review: async () => parsedReview(),
      save: async () => ({ kind: "saved", notes: 0, observations: 0, links: 0 }),
      record: async () => { throw new Error("unused"); },
      usage: async () => { throw new Error("unused"); },
    };
    const controller = createReviewController({ api, reviewId, speaker, unsent: createMemoryUnsent() });
    await controller.send(answer);
    expect(controller.getState().unsent).toHaveLength(0);
    expect(controller.getState().sendError).toBeNull();
    expect(calls).toEqual([]);
  });

  test("the tutor stops mid-turn when the learner starts speaking, and speaks again on the next turn", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const spoken: string[] = [];
    let beginCount = 0;
    const real = createSynthSpeaker({ speak: (u) => void spoken.push(u.text), cancel: () => {} }, (text) => ({ text }) as SpeechSynthesisUtterance);
    const speaker: Speaker = { ...real, beginTurn: () => (beginCount++, real.beginTurn()) };
    const api: Api = {
      reviewOptions: async () => { throw new Error("unused"); },
      startReview: async () => { throw new Error("unused"); },
      sendTurn: async function* (_r, turnId) {
        yield { type: "learner_turn_stored", turnId };
        yield sentence("One.");
        await gate;
        yield sentence("Two.");
        yield { type: "turn_complete", turnId };
      },
      review: async () => parsedReview(),
      save: async () => ({ kind: "saved", notes: 0, observations: 0, links: 0 }),
      record: async () => { throw new Error("unused"); },
      usage: async () => { throw new Error("unused"); },
    };
    const controller = createReviewController({ api, reviewId, speaker, unsent: createMemoryUnsent() });
    const first = controller.send(answer);
    while (spoken.length < 1) await Promise.resolve();
    controller.learnerSpeaking();
    release();
    await first;
    expect(spoken).toEqual(["One."]);
    await controller.send({ kind: "skip" });
    expect(beginCount).toBe(2);
    expect(spoken).toEqual(["One.", "One.", "Two."]);
  });

  test("a second send while a turn is streaming is ignored", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = setup({
      sendTurn: async function* ({ turnId }) {
        yield { type: "learner_turn_stored", turnId };
        await gate;
        yield { type: "turn_complete", turnId };
      },
    });
    const first = h.controller.send(answer);
    await h.controller.send({ kind: "skip" });
    release();
    await first;
    expect(h.sends).toHaveLength(1);
  });

  test("a pending save waits for Retry, and Retry calls the same save until it succeeds", async () => {
    const results: Awaited<ReturnType<Api["save"]>>[] = [
      { kind: "save_failed", error: "disk full", retryable: true },
      { kind: "saved", notes: 2, observations: 1, links: 1 },
    ];
    const h = setup({
      review: () => parsedReview({ phase: "ended", saved: "save_pending", turns: [tutorAsk] }),
      sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }),
      save: async () => results.shift()!,
    });
    await h.controller.load();
    expect(h.saves()).toBe(0);
    await h.controller.save();
    expect(h.controller.getState()).toMatchObject({ saving: false, saveError: "disk full" });
    await h.controller.save();
    expect(h.saves()).toBe(2);
    expect(h.controller.getState()).toMatchObject({ saveError: null, savedSummary: { notes: 2, observations: 1, links: 1 } });
  });

  test("#138: a turn that wraps up saves automatically although the backend already marks the save pending", async () => {
    const h = setup({
      review: () => parsedReview({ phase: "ended", saved: "save_pending", turns: [tutorAsk] }),
      sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "move", turnId, move: { kind: "wrap_up" } }, { type: "turn_complete", turnId }),
      save: async () => ({ kind: "saved", notes: 1, observations: 1, links: 0 }),
    });
    await h.controller.send({ kind: "end" });
    expect(h.saves()).toBe(1);
  });

  test("#138: a pending save shows Saving, not the not-saved alert, while a save runs", () => {
    const banner = renderToStaticMarkup(createElement(SaveBanner, {
      state: { view: parsedReview({ saved: "save_pending" }), loadError: null, live: null, unsent: [], sendError: null, saving: true, saveError: null, savedSummary: null, storageDegraded: false },
      onRetry: () => {}, reviewId,
    }));
    expect(banner).toContain("Saving this review to your notebook...");
    expect(banner).not.toContain("not saved yet");
  });

  test("a review that ends unsaved is saved automatically, and a failure does not loop", async () => {
    const h = setup({
      review: () => parsedReview({ phase: "ended", saved: "unsaved", turns: [tutorAsk] }),
      sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }),
      save: async () => ({ kind: "save_failed", error: "locked", retryable: true }),
    });
    await h.controller.send({ kind: "end" });
    expect(h.saves()).toBe(1);
    expect(h.controller.getState().saveError).toBe("locked");
    await h.controller.send({ kind: "end" });
    expect(h.saves()).toBe(1);
    expect(h.stops()).toBe(2);
  });

  test("a save that throws is a pending save with the error shown", async () => {
    const h = setup({
      review: () => parsedReview({ saved: "unsaved" }),
      sendTurn: () => events(),
      save: async () => { throw new ApiError("offline", 0); },
    });
    await h.controller.save();
    expect(h.controller.getState().saveError).toBe("offline");
  });
  test("after a reload with an unsent turn, a new send is refused with a message and nothing is sent or stored", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    const original = { turnId: randomId("turn"), reviewId, act: answer, createdAtMs: 5 };
    await h.unsent.put(original);
    await h.controller.load();
    const accepted = await h.controller.send({ kind: "answer", text: "A newer answer.", modality: "text" });
    expect(accepted).toBe(false);
    expect(h.sends).toEqual([]);
    expect(await h.unsent.forReview(reviewId)).toEqual([original]);
    expect(h.controller.getState().sendError).toContain("not delivered");
    await h.controller.retryTurn();
    expect(h.sends).toEqual([{ turnId: original.turnId, act: answer }]);
    expect(await h.controller.send({ kind: "answer", text: "A newer answer.", modality: "text" })).toBe(true);
    expect(h.sends.map((c) => c.act.kind === "answer" && c.act.text)).toEqual(["An ordering of events.", "A newer answer."]);
    expect(h.controller.getState().sendError).toBeNull();
  });

  test("a turn the backend rejects for good can be discarded, and the review can then be ended", async () => {
    const h = setup({
      sendTurn: ({ turnId, act }) => {
        if (act.kind === "answer") {
          // Reproduce a stream that fails before its first event.
          // eslint-disable-next-line require-yield
          return (async function* () {
            throw new ApiError("another turn on this review is still running", 409);
          })();
        }
        return events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId });
      },
    });
    await h.controller.send(answer);
    expect(h.controller.getState().live).toMatchObject({ status: "failed", retryable: false });
    expect(h.controller.getState().unsent).toHaveLength(1);
    expect(await h.controller.send({ kind: "end" })).toBe(false);

    await h.controller.discardUnsent();
    const after = h.controller.getState();
    expect(after.unsent).toEqual([]);
    expect(after.live).toBeNull();
    expect(after.sendError).toBeNull();
    expect(await h.unsent.forReview(reviewId)).toEqual([]);

    expect(await h.controller.send({ kind: "end" })).toBe(true);
    expect(h.sends.map((c) => c.act.kind)).toEqual(["answer", "end"]);
  });

  test("an undelivered message offers Retry and Discard; a tutor reply that stalled offers Retry only", () => {
    const buttons = (props: Parameters<typeof UndeliveredNote>[0]) =>
      findElements(UndeliveredNote(props), (e) => e.type === "button").map((b) => (b.props as { children?: unknown }).children);
    const base = { unsent: 1, failed: true, onRetry: () => {}, onDiscard: () => {} };
    expect(buttons(base)).toEqual(["Retry", "Discard message"]);
    expect(buttons({ ...base, unsent: 0 })).toEqual(["Retry"]);
    let discarded = 0;
    const [, discard] = findElements(UndeliveredNote({ ...base, onDiscard: () => discarded++ }), (e) => e.type === "button");
    (discard!.props as { onClick: () => void }).onClick();
    expect(discarded).toBe(1);
  });

  test("the session says when local storage is degraded, and not before", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    await h.controller.load();
    expect(h.controller.getState().storageDegraded).toBe(false);

    const degraded = { ...createMemoryUnsent(), degraded: true };
    const api = { review: async () => parsedReview() } as unknown as Api;
    const speaker: Speaker = { beginTurn() {}, speak() {}, stop() {} };
    const controller = createReviewController({ api, reviewId, speaker, unsent: degraded });
    await controller.load();
    expect(controller.getState().storageDegraded).toBe(true);
  });

  test("discarding with nothing unsent does nothing, and never touches a turn that is streaming", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    await h.controller.discardUnsent();
    expect(h.controller.getState().unsent).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  test("an over-length answer is rejected up front with a message and never reaches the unsent store", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    const accepted = await h.controller.send({ kind: "answer", text: "x".repeat(8001), modality: "text" });
    expect(accepted).toBe(false);
    expect(h.sends).toEqual([]);
    expect(await h.unsent.forReview(reviewId)).toEqual([]);
    expect(h.controller.getState().unsent).toEqual([]);
    expect(h.controller.getState().sendError).toContain("8000");
  });
});

describe("review composer", () => {
  const composer = (actions: Parameters<typeof Composer>[0]["actions"], disabled = false) => renderToStaticMarkup(createElement(Composer, {
    actions, disabled, sendError: null,
    speech: { supported: false, start() {}, stop() {} },
    onSpeaking() {}, send: async () => true,
  }));

  test("the answer field has a visible label and empty answers cannot be sent", () => {
    const out = composer(["answer", "hint", "end"]);
    const label = out.match(/<label for="([^"]+)">Your thinking<\/label>/);
    expect(label).not.toBeNull();
    expect(out).toContain(`id="${label![1]}"`);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Share my thinking<\/button>/);
    expect(out).toContain("Speech input is not available in this browser.");
    expect(out).toContain(">Finish &amp; save</button>");
  });

  test("a pending turn disables every action and a phase without answering has no answer field", () => {
    const pending = composer(["answer", "hint", "end"], true);
    const buttons = pending.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    const paused = composer(["resume", "end"]);
    expect(paused).not.toContain("<textarea");
    expect(paused).toContain(">Resume</button>");
    expect(paused).toContain(">Finish &amp; save</button>");
  });
});

describe("opening the review (flow D: topic checklist, then the learner starts it)", () => {
  const state = (o: Partial<SessionState> = {}): SessionState => ({
    view: parsedReview(), loadError: null, live: null, unsent: [], sendError: null, saving: false, saveError: null, savedSummary: null, storageDegraded: false, ...o,
  });
  const cpt2 = stableId("cpt", "concept-2");
  const topics = [{ id: cpt, label: "Logical clocks", summary: "Order events without a shared clock." }, { id: cpt2, label: "Vector clocks", summary: "" }];

  test("the wire schema round-trips begin with fuzzy and note, with or without them, and rejects other spellings", () => {
    expect(learnerAct.parse({ kind: "begin" })).toEqual({ kind: "begin" });
    expect(learnerAct.parse({ kind: "begin", fuzzy: [], note: "  the ordering part " })).toEqual({ kind: "begin", fuzzy: [], note: "the ordering part" });
    expect(learnerAct.parse({ kind: "begin", fuzzy: [cpt, cpt2] })).toEqual({ kind: "begin", fuzzy: [cpt, cpt2] });
    expect(learnerAct.safeParse({ kind: "begin", fuzzy: ["nope"] }).success).toBe(false);
    expect(learnerAct.safeParse({ kind: "begins" }).success).toBe(false);
  });

  test("the review view carries its topics in scope order", () => {
    expect(parsedReview().topics.map((t) => t.label)).toEqual(["Logical clocks", "Vector clocks"]);
  });

  test("an empty active review shows the checklist; a review with turns, paused, ended, unsent or streaming does not", () => {
    expect(needsChecklist(state())).toBe(true);
    expect(needsChecklist(state({ view: parsedReview({ turns: [tutorAsk] }) }))).toBe(false);
    expect(needsChecklist(state({ view: parsedReview({ phase: "paused" }) }))).toBe(false);
    expect(needsChecklist(state({ view: parsedReview({ phase: "ended" }) }))).toBe(false);
    expect(needsChecklist(state({ unsent: [{ turnId: stableId("turn", "u"), reviewId, act: { kind: "begin" } as LearnerAct, createdAtMs: 1 }] }))).toBe(false);
    expect(needsChecklist(state({ live: startLive(stableId("turn", "x")) }))).toBe(false);
    expect(needsChecklist(state({ view: null }))).toBe(false);
  });

  test("nothing begins by itself on load: the controller sends no turn until the learner acts", async () => {
    const h = setup({ sendTurn: async function* () {} });
    await h.controller.load();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sends).toEqual([]);
    expect("beginOnce" in (await import("../src/app/controller"))).toBe(false);
    expect(await Bun.file(new URL("../src/app/review.tsx", import.meta.url)).text()).not.toContain("beginOnce");
  });

  test("starting sends one begin carrying the marked topics and the note; a failed begin is resent with the same turn id", async () => {
    const h = setup({
      sendTurn: async function* ({ turnId }, n) {
        if (n === 0) throw new ApiError("down", 0);
        yield { type: "learner_turn_stored", turnId };
        yield { type: "turn_complete", turnId };
      },
    });
    await h.controller.load();
    await h.controller.send({ kind: "begin", fuzzy: [cpt], note: "ordering" });
    expect(h.sends.map((s) => s.act)).toEqual([{ kind: "begin", fuzzy: [cpt], note: "ordering" }]);
    await h.controller.retryTurn();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]!.turnId).toBe(h.sends[0]!.turnId);
    expect(h.sends[1]!.act).toEqual({ kind: "begin", fuzzy: [cpt], note: "ordering" });
  });

  test("the checklist is a starting-point choice: every topic with its summary, an optional note box, and one start that works with nothing marked", () => {
    const html = renderToStaticMarkup(createElement(TopicChecklist, { topics, disabled: false, onStart: () => {} }));
    expect(html).toContain('<h2 id="starting-point-heading">Choose a starting point</h2>');
    expect(html).toContain("Mark none and the tutor starts with open recall questions.");
    expect(html).toContain("Logical clocks");
    expect(html).toContain("Order events without a shared clock.");
    expect(html).toContain("Vector clocks");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("<textarea");
    // The start is the default path: enabled with nothing marked, and it sends the None path.
    expect(html).toMatch(/<button type="submit" class="primary-action">Start review<\/button>/);
    expect(html).not.toContain("None, just quiz me");
    expect(html).not.toContain("Question");
  });

  test("the begin act is a system line naming the learner's picks and note, never a learner line", () => {
    const begin = (act: unknown) => parsedReview({ turns: [turnJson(1, "learner", { act }), tutorAsk] });
    const plain = conversationLines(begin({ kind: "begin" }).turns);
    expect(plain.map((l) => l.speaker)).toEqual(["system", "tutor"]);
    expect(plain[0]!.text).toBe("Review started");
    const picked = begin({ kind: "begin", fuzzy: [cpt, cpt2], note: "the ordering" });
    expect(conversationLines(picked.turns, picked.topics)[0]!).toMatchObject({ speaker: "system", text: "You marked: Logical clocks, Vector clocks. Your note: the ordering" });
    const none = begin({ kind: "begin", fuzzy: [] });
    expect(conversationLines(none.turns, none.topics)[0]!.text).toBe("Review started");
  });

  test("a quick check is labelled Quick check", () => {
    const qc = turnJson(2, "tutor", { move: { kind: "quick_check", threadId: stableId("thr", "thread-2"), claimIds: [clm] }, say: "In a sentence, what is a vector clock?" });
    expect(conversationLines(parsedReview({ turns: [tutorAsk, qc] }).turns).map((l) => l.label)).toEqual(["Question", "Quick check"]);
  });
});

describe("focus after the starting-point form (stepStartHandoff)", () => {
  const at = (checklist: boolean, question: boolean, focusFree = true) => ({ checklist, question, focusFree });

  test("without the learner's own start, a later reply never moves focus", () => {
    expect(stepStartHandoff("none", at(false, true))).toEqual({ step: "none", focus: null });
    expect(stepStartHandoff("none", at(false, false))).toEqual({ step: "none", focus: null });
  });

  test("while the form is still shown nothing moves", () => {
    expect(stepStartHandoff("submitted", at(true, false))).toEqual({ step: "submitted", focus: null });
  });

  test("the form gives way before the reply: focus goes to the start status, then to the question while it still rests there", () => {
    const sent = stepStartHandoff("submitted", at(false, false));
    expect(sent).toEqual({ step: "waiting", focus: "status" });
    expect(stepStartHandoff(sent.step, at(false, false))).toEqual({ step: "waiting", focus: null });
    expect(stepStartHandoff(sent.step, at(false, true))).toEqual({ step: "none", focus: "question" });
  });

  test("a question already there when the form goes takes focus directly", () => {
    expect(stepStartHandoff("submitted", at(false, true))).toEqual({ step: "none", focus: "question" });
  });

  test("if the learner moved focus while waiting, the question does not take it and the handoff ends", () => {
    expect(stepStartHandoff("waiting", at(false, true, false))).toEqual({ step: "none", focus: null });
  });

  test("the form coming back (the unsent start was discarded) ends the handoff", () => {
    expect(stepStartHandoff("waiting", at(true, false))).toEqual({ step: "none", focus: null });
  });
});

describe("a chain that stopped part-way resumes after reload", () => {
  const closeThread = turnJson(3, "tutor", { move: { kind: "close_thread", threadId: thr }, say: "Let's leave that question there and move on." });
  const owing = (o: Parameters<typeof reviewJson>[0] = {}) => parsedReview({ turns: [tutorAsk, learnerAnswer(2), closeThread], owesMove: true, ...o });
  const state = (view: ReviewView | null, o: Partial<SessionState> = {}): SessionState => ({
    view, loadError: null, live: null, unsent: [], sendError: null, saving: false, saveError: null, savedSummary: null, storageDegraded: false, ...o,
  });
  const run = (states: SessionState[]) => {
    let n = 0;
    const offer = resumeOnce({ retryTurn: async () => void n++ });
    for (const s of states) offer(s);
    return n;
  };

  test("the wire schema carries owesMove", () => {
    expect(owing().owesMove).toBe(true);
    expect(parsedReview().owesMove).toBe(false);
    expect(reviewViewz.safeParse({ ...reviewJson(), owesMove: undefined }).success).toBe(false);
  });

  test("the owed turn is the last learner turn, only for an active review", () => {
    expect(owedLearnerTurn(owing())?.id).toBe(learnerAnswer(2).id);
    expect(owedLearnerTurn(parsedReview({ turns: [tutorAsk, learnerAnswer(2)] }))).toBeNull();
    expect(owedLearnerTurn(owing({ phase: "paused" }))).toBeNull();
    expect(owedLearnerTurn(owing({ phase: "ended" }))).toBeNull();
  });

  test("it fires once however often the state is offered, and never for paused, ended, unsent or streaming", () => {
    expect(run([state(owing()), state(owing()), state(owing())])).toBe(1);
    expect(run([state(null), state(owing())])).toBe(1);
    expect(run([state(owing({ phase: "paused" }))])).toBe(0);
    expect(run([state(owing({ phase: "ended" }))])).toBe(0);
    expect(run([state(parsedReview({ turns: [tutorAsk] }))])).toBe(0);
    expect(run([state(owing(), { live: startLive(stableId("turn", "x")) })])).toBe(0);
    expect(run([state(owing(), { unsent: [{ turnId: stableId("turn", "u"), reviewId, act: answer, createdAtMs: 1 }] })])).toBe(0);
    expect(needsResume(state(owing()))).toBe(true);
  });

  test("through the controller: the retry resends the last learner turn id, once", async () => {
    const h = setup({
      review: () => owing(),
      sendTurn: async function* ({ turnId }) {
        yield { type: "learner_turn_stored", turnId };
        yield { type: "turn_complete", turnId };
      },
    });
    await h.controller.load();
    const offer = resumeOnce(h.controller);
    offer(h.controller.getState());
    offer(h.controller.getState());
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sends).toEqual([{ turnId: learnerAnswer(2).id, act: { kind: "answer", text: "An ordering of events.", modality: "speech" } }]);
  });

  test("a failed automatic continue leaves the Retry button, which resends the same id", async () => {
    const h = setup({
      review: () => owing(),
      sendTurn: async function* ({ turnId }, n) {
        if (n === 0) throw new ApiError("down", 0);
        yield { type: "turn_complete", turnId };
      },
    });
    await h.controller.load();
    resumeOnce(h.controller)(h.controller.getState());
    await new Promise((r) => setTimeout(r, 10));
    expect(h.controller.getState().live?.status).toBe("failed");
    expect(needsResume(h.controller.getState())).toBe(false);
    await h.controller.retryTurn();
    expect(h.sends.map((s) => s.turnId)).toEqual([learnerAnswer(2).id, learnerAnswer(2).id]);
  });
});
