/**
 * Deterministic UI preview fixtures. Every response is built from raw JSON and parsed through the same wire schemas
 * the backend's `ROUTES` table uses, so a schema change fails `createFixture` (and test/ui-preview.test.ts) instead of
 * leaving a blank page in the browser. No live lecture, provider or model calls.
 */
import type { AppApi } from "../../src/app/api";
import { ApiError } from "../../src/app/api";
import { parseId } from "../../src/shared/ids";
import type { IdKind, Id, ReviewId } from "../../src/shared/ids";
import type { LearnerAct, ObservationStatus, Seq,Turn, ReviewView, TopicDiagram } from "../../src/shared/domain";
import type { SpeechInput } from "../../src/app/speech";
import { captureResponsez, evidenceBundlez, recordViewz, reviewOptionsz, reviewViewz, saveResultz, usageSummaryz } from "../../src/app/decode";
import { diagramsResponse, lecturesResponse, topicDiagramResponse } from "../../src/shared/wire";

const names = new Map<string, string>();
function id<K extends IdKind>(kind: K, name: string): Id<K> {
  const key = `${kind}:${name}`;
  if (!names.has(key)) names.set(key, (names.size + 1).toString(32).replaceAll('0', 'z').replaceAll('1', 'y').replaceAll('8', 'x').replaceAll('9', 'w').padEnd(26, 'a'));
  const parsed = parseId(kind, `${kind}_${names.get(key)}`);
  if (!parsed) throw new Error(`Invalid fixture id ${key}`);
  return parsed;
}
export const ids = {
  capture: id("cap", "capture"), review: id("rvw", "review"), earlierReview: id("rvw", "earlier-review"), source: id("src", "lecture"), thread: id("thr", "main"), quickThread: id("thr", "quick-check"),
  claim: id("clm", "main"), orderingClaim: id("clm", "ordering"), passage: id("ev", "passage"), laterPassage: id("ev", "later-passage"), frame: id("ev", "frame"),
  chunk: id("crv", "chunk"), concept: id("cpt", "circular-wait"), ordering: id("cpt", "ordering"), earlierCapture: id("cap", "earlier-capture"),
  otherCapture: id("cap", "other-capture"), pendingReview: id("rvw", "pending-review"), unsavedReview: id("rvw", "unsaved-review"),
};
export const scenarios = ["review", "long-history", "long-reply", "streaming", "failed-turn", "unfinished-reply", "save-failure", "saving", "paused", "detour", "resource-wait", "correction", "soft-target", "missing-evidence", "evidence-error", "fuzzy-checklist", "diagram", "held-turn", "held-turn-used-up", "capture-ready", "capture-processing", "capture-held", "capture-empty", "record", "record-illustrated", "record-empty", "record-error", "record-disputes", "record-context-error", "record-lectures", "usage", "usage-held", "home", "home-paused", "home-setup", "home-topic-error", "home-empty", "home-error"] as const;
export type Scenario = typeof scenarios[number];
export const scenarioFrom = (search: string): Scenario => scenarios.find(s => s === new URLSearchParams(search).get("scenario")) ?? "review";

/** When the fixture month's AI allowance resets: December 1, UTC. */
const MONTH_END = Date.UTC(2026, 11, 1);

export type Fixture = {
  readonly api: AppApi;
  readonly speech: SpeechInput;
  /** The review the record page is filtered to, or null for all notes. */
  readonly recordReviewId: ReviewId | null;
  readonly requestLedger: { subscribe(listener: () => void): () => void; snapshot(): string };
  /** Releases the pending streaming, saving or diagram-summary gate. */
  continueFixture(): void;
  dictateFixture(): void;
};

const illustration = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450" fill="#fbf2db"/><g fill="none" stroke="#264c92" stroke-width="6"><path d="M230 190Q400 40 570 190"/><path d="m550 160 20 30-35 5"/><path d="M570 260Q400 410 230 260"/><path d="m250 290-20-30 35-5"/></g><g font-family="Georgia" fill="#302b22" text-anchor="middle"><text x="400" y="48" font-size="24">Illustrative fixture frame · circular wait</text><text x="215" y="230" font-size="34">Thread 1</text><text x="585" y="230" font-size="34">Thread 2</text><text x="215" y="275" font-size="24">holds A</text><text x="585" y="275" font-size="24">holds B</text><text x="400" y="422" font-size="18">Preview data, not a captured lecture</text></g></svg>`;

/** Builds one scenario's fake API. Throws (a ZodError) when a fixture no longer matches the wire schemas. */
export function createFixture(scenario: Scenario): Fixture {
  const material = [[ids.source, [[0, 760]]]];
  const gap = { sourceId: ids.source, interval: { start: 600, end: 640 }, channel: "frames", reason: "hidden_tab" };
  const topics = [
    { id: ids.concept, label: "Circular wait", summary: "Each thread holds a resource while waiting for one another thread holds." },
    { id: ids.ordering, label: "Resource ordering", summary: "Acquiring resources in one global order removes the circular wait." },
  ];
  /** A reply long enough that its question, the last sentence, starts below the bottom of the board. */
  const longReplyQuestion = "What would have to change for either thread to continue?";
  const longReply = `${Array.from({ length: 14 }, (_, n) => `Step ${n + 1}. Thread 1 holds lock A and waits for lock B, while thread 2 holds lock B and waits for lock A, so neither can release what the other needs.`).join(" ")} ${longReplyQuestion}`;
  const firstQuestion = "Two threads are waiting on each other. How could that happen?";
  /**
   * A review view as the backend sends it. A saved review also has a quick check on a second topic and the observations
   * for both threads, so each illustrated page has its question, answer and status. In "record-disputes" the second topic
   * is a main question too, and the learner disputed both assessments, so two disputed rows need telling apart.
   */
  function reviewJson(reviewId: ReviewId, s: Scenario) {
    const saved = s.startsWith("record");
    const disputes = s === "record-disputes";
    const turn = (actor: string, n: number, rest: object) => ({ id: id("turn", `${reviewId}-${actor}-${n}`), reviewId, seq: n, atMs: n * 1000, actor, threadId: actor === "code" ? null : ids.thread, ...rest });
    const ask = (n: number, text: string) => turn("tutor", n, { move: { kind: "ask_main", threadId: ids.thread, claimIds: [ids.claim] }, say: text });
    const answer = (n: number, text: string, threadId = ids.thread) => turn("learner", n, { threadId, act: { kind: "answer", text, modality: "text" } });
    const turns: ReturnType<typeof turn>[] = [];
    if (s === "long-history") for (let n = 0; n < 12; n++) {
      turns.push(ask(turns.length + 1, `Earlier question ${n + 1}. How could a thread make progress?`));
      turns.push(answer(turns.length + 1, "One resource must become available before the waiting thread can proceed."));
    }
    // The fuzzy-topic checklist shows only before the first turn (flow D), so that scenario starts with none.
    let observations: object[] = [];
    if (s !== "fuzzy-checklist" && s !== "home-setup") {
      turns.push(ask(turns.length + 1, firstQuestion));
      const mainAnswer = answer(turns.length + 1, "One holds lock A and wants B. The other holds B and wants A.");
      turns.push(mainAnswer);
      const help = turn("tutor", turns.length + 1, { move: { kind: "explain", threadId: ids.thread, evidence: [ids.frame, ids.passage] }, say: "The lecture calls this circular wait. Each thread is holding a resource while waiting for the other." });
      turns.push(help);
      turns.push(turn("tutor", turns.length + 1, { move: { kind: "ask_followup", threadId: ids.thread }, say: s === "long-reply" ? longReply : longReplyQuestion }));
      if (disputes) {
        turns.push(turn("learner", turns.length + 1, { act: { kind: "dispute", text: "I did name circular wait: each thread holds one lock and waits for the other." } }));
        turns.push(turn("tutor", turns.length + 1, { move: { kind: "answer_dispute", threadId: ids.thread, evidence: [ids.passage], settled: false }, say: "Your answer described the waiting but not why neither thread can release its lock, which the lecture names as the condition." }));
        turns.push(turn("tutor", turns.length + 1, { threadId: ids.quickThread, move: { kind: "ask_main", threadId: ids.quickThread, claimIds: [ids.orderingClaim] }, say: "How does taking locks in one global order prevent a deadlock?" }));
        const orderingAnswer = answer(turns.length + 1, "If every thread takes A before B, nobody holds B while waiting for A.", ids.quickThread);
        turns.push(orderingAnswer);
        turns.push(turn("learner", turns.length + 1, { threadId: ids.quickThread, act: { kind: "dispute", text: "That is the global order the lecture gave." } }));
        turns.push(turn("tutor", turns.length + 1, { threadId: ids.quickThread, move: { kind: "answer_dispute", threadId: ids.quickThread, evidence: [ids.laterPassage], settled: false }, say: "The order is right, but the answer did not say that it removes the circular wait." }));
        observations = [
          { id: id("obs", `${reviewId}-disputed`), reviewId, threadId: ids.thread, claimIds: [ids.claim], conceptIds: [ids.concept], proposed: "partial", status: "disputed", clampedFrom: null, dispute: { kind: "unsettled" }, corrections: [], facts: { threadId: ids.thread, firstSubstantiveAnswerSeq: mainAnswer.seq, firstHelpSeq: help.seq, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [mainAnswer.id], helpTurns: [help.id] } },
          { id: id("obs", `${reviewId}-ordering-disputed`), reviewId, threadId: ids.quickThread, claimIds: [ids.orderingClaim], conceptIds: [ids.ordering], proposed: "unresolved", status: "disputed", clampedFrom: null, dispute: { kind: "unsettled" }, corrections: [], facts: { threadId: ids.quickThread, firstSubstantiveAnswerSeq: orderingAnswer.seq, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [orderingAnswer.id], helpTurns: [] } },
        ];
      } else if (saved) {
        turns.push(turn("tutor", turns.length + 1, { threadId: ids.quickThread, move: { kind: "quick_check", threadId: ids.quickThread, claimIds: [ids.orderingClaim] }, say: "Quick check: what does taking locks in one global order prevent?" }));
        const quickAnswer = answer(turns.length + 1, "It prevents a circular wait.", ids.quickThread);
        turns.push(quickAnswer);
        observations = [
          { id: id("obs", `${reviewId}-disputed`), reviewId, threadId: ids.thread, claimIds: [ids.claim], conceptIds: [ids.concept], proposed: "partial", status: "disputed", clampedFrom: null, dispute: { kind: "open", turnId: id("turn", `${reviewId}-dispute`) }, corrections: [], facts: { threadId: ids.thread, firstSubstantiveAnswerSeq: mainAnswer.seq, firstHelpSeq: help.seq, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [mainAnswer.id], helpTurns: [help.id] } },
          { id: id("obs", `${reviewId}-quick-check`), reviewId, threadId: ids.quickThread, claimIds: [ids.orderingClaim], conceptIds: [ids.ordering], proposed: "independent", status: "independent", clampedFrom: null, dispute: { kind: "none" }, corrections: [], facts: { threadId: ids.quickThread, firstSubstantiveAnswerSeq: quickAnswer.seq, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [quickAnswer.id], helpTurns: [] } },
        ];
      }
    }
    if (s === "soft-target") turns.push(turn("code", turns.length + 1, { notice: { kind: "soft_target_reached", elapsedS: 600 } }));
    if (s === "correction") turns.push(turn("code", turns.length + 1, { notice: { kind: "correction_pending", correctionId: "fixture-correction", affectedClaims: [ids.claim] } }));
    const checklist = s === "fuzzy-checklist" || s === "home-setup";
    return {
      reviewId, captureId: reviewId === ids.earlierReview ? ids.earlierCapture : ids.capture,
      topics,
      scope: { chunkRevisions: [ids.chunk], material, claimsAtStart: [ids.claim, ids.orderingClaim], partial: [{ kind: "capture_gap", gap }], frozenAtSeq: 7 },
      state: { reviewId, phase: s === "paused" || s === "home-paused" ? "paused" : s === "save-failure" || s === "saving" || saved ? "ended" : "active", mainQuestions: checklist ? 0 : disputes ? 2 : 1, quickChecks: saved && !disputes ? 1 : 0, fuzzy: saved ? [ids.concept] : [], openThread: checklist || saved ? null : ids.thread, lastLearnerAct: null,
        detour: s === "detour" ? { kind: "proposed", turnId: id("turn", "detour"), topic: "Resource ordering", needsResource: null } : s === "resource-wait" ? { kind: "awaiting_resource", resourceId: id("res", "resource"), topic: "Resource ordering" } : { kind: "none" },
        openDispute: null, corrections: [], activeSeconds: 30, softTargetS: 600, softTargetOffered: false, wrapUpRequested: false },
      turns, owesMove: false, observations, saved: saved ? "saved" : s === "save-failure" || s === "saving" ? "save_pending" : "unsaved",
    };
  }
  let view: ReviewView = reviewViewz.parse(reviewJson(ids.review, scenario));
  // The notebook holds a saved review: this one in record scenarios, otherwise an earlier one, so its illustrated pages are complete.
  const savedView = view.saved === "saved" ? view : reviewViewz.parse(reviewJson(ids.earlierReview, "record"));
  // "record-context-error" and "record-lectures": the notebook also holds an earlier lecture's review with two disputes. In "record-context-error" its first lookup fails while this review's loads.
  const earlierView = scenario === "record-context-error" || scenario === "record-lectures" ? reviewViewz.parse(reviewJson(ids.earlierReview, "record-disputes")) : null;
  const capture = captureResponsez.parse({ capture: { captureId: ids.capture, status: { state: "stopped" }, sources: [{ id: ids.source, videoId: "fixture", title: "Locks & deadlocks", url: "", channelName: "Deterministic preview", durationS: 1200 }], currentSourceId: ids.source, transcript: "available", health: [], watchedSeconds: 760 }, invite: { state: "invited", atChunk: ids.chunk } });
  const evidence = evidenceBundlez.parse({ material, passages: [{ kind: "passage", id: ids.passage, sourceId: ids.source, transcriptRevId: id("trv", "captions"), interval: { start: 402, end: 423 }, text: "Each thread holds a lock while waiting for the other.", origin: "panel" }, { kind: "passage", id: ids.laterPassage, sourceId: ids.source, transcriptRevId: id("trv", "captions"), interval: { start: 480, end: 505 }, text: "Acquiring resources in the same order removes this circular wait.", origin: "panel" }], frames: [{ kind: "frame", id: ids.frame, sourceId: ids.source, mediaS: 402, width: 800, height: 450, teaching: "kept" }], gaps: [gap], ads: [] });
  // With no lectures captured ("home-empty"), the notebook has nothing in it either.
  const empty = scenario === "record-empty" || scenario === "home-empty";
  const lectures = scenario === "record-lectures";
  // "record-lectures": the earlier lecture's note cites a passage the learner has since deleted.
  const earlierNote = { id: id("note", "earlier-note"), reviewId: ids.earlierReview, conceptId: ids.ordering, generated: [{ author: "learner", text: "Taking locks in one order means nobody waits in a circle.", turnId: null, evidence: [] }, { author: "source", text: "Acquiring resources in the same order removes this circular wait.", turnId: null, evidence: [ids.laterPassage] }], userEdit: null, evidence: [ids.laterPassage] };
  let record = recordViewz.parse({ notes: empty ? [] : [{ id: id("note", "note"), reviewId: savedView.reviewId, conceptId: ids.concept, generated: [{ author: "learner", text: "Each thread holds something the other needs.", turnId: null, evidence: [] }, { author: "tutor", text: "Look at the order in which resources are acquired.", turnId: null, evidence: [ids.passage] }, { author: "source", text: "Circular wait is one condition for deadlock.", turnId: null, evidence: [ids.frame] }], userEdit: null, evidence: [ids.passage, ids.frame] }, ...(lectures ? [earlierNote] : [])], observations: empty ? [] : [...(earlierView?.observations ?? []), ...savedView.observations], links: scenario === "record-empty" ? [] : [{ id: id("lnk", "link"), from: ids.concept, to: ids.ordering, type: "related_to", evidence: [ids.passage], rationale: "Resource ordering changes the circular-wait condition.", decision: "suggested" }], unavailableEvidence: lectures ? [{ kind: "deleted", id: ids.laterPassage, deletedAtMs: 1000 }] : [] });
  // One topic has a ready summary and a frame; the other has neither yet, so asking for it shows preparing until the gate is released.
  let diagrams: readonly TopicDiagram[] = diagramsResponse.parse({ topics: [
    { topicId: ids.concept, label: "Circular wait", claimIds: [ids.claim], frame: { id: ids.frame, mediaS: 402, sourceId: ids.source, videoId: null, title: "Locks & deadlocks" }, summary: { state: "ready", title: "How does a circular wait form?", lines: [{ text: "Thread 1 holds A and waits for B.", evidence: [ids.passage] }, { text: "Thread 2 holds B and waits for A.", evidence: [ids.passage, ids.frame] }, { text: "Neither can continue: a circular wait.", evidence: [ids.frame] }] } },
    { topicId: ids.ordering, label: "Resource ordering", claimIds: [ids.orderingClaim], frame: null, summary: { state: "not_requested" } },
  ] }).topics;
  const orderingReady = topicDiagramResponse.parse({ topicId: ids.ordering, label: "Resource ordering", claimIds: [ids.orderingClaim], frame: null, summary: { state: "ready", title: "Why does one lock order prevent the wait?", lines: [{ text: "Every thread takes locks in the same global order.", evidence: [ids.laterPassage] }, { text: "No thread holds a later lock while waiting for an earlier one.", evidence: [ids.laterPassage] }] } });
  const setDiagram = (next: TopicDiagram) => { diagrams = diagrams.map(t => t.topicId === next.topicId ? next : t); return next; };

  const ledger: string[] = [];
  const listeners = new Set<() => void>();
  function log(call: string) { ledger.push(call); for (const listener of listeners) listener(); }
  let release: (() => void) | undefined;
  const gate = () => new Promise<void>(resolve => { release = resolve; });
  let speechCallbacks: Parameters<SpeechInput["start"]>[0] | null = null;
  const speech: SpeechInput = {
    supported: true,
    start(callbacks) { speechCallbacks = callbacks; log("speech.start"); callbacks.onSpeechStart(); },
    stop() { speechCallbacks?.onEnd(); speechCallbacks = null; log("speech.stop"); },
  };
  // Home lists this lecture's open review with two ended ones (save not finished, ended without notes), a lecture still
  // capturing, and the earlier lecture whose saved review the notebook holds. Notebook and Home read this one list.
  const at = (hour: number) => Date.UTC(2026, 10, 6, hour, 4);
  const lectureList = lecturesResponse.parse({ lectures: scenario === "home-empty" ? [] : [
    { captureId: ids.capture, sourceTitles: ["Locks & deadlocks"], videos: 1, watchedSeconds: 760, status: { state: "stopped" }, reviews: [
      { reviewId: ids.review, startedMs: at(15), phase: view.state.phase, saved: view.saved, mainQuestions: view.state.mainQuestions },
      { reviewId: ids.pendingReview, startedMs: at(13), phase: "ended", saved: "save_pending", mainQuestions: 2 },
      { reviewId: ids.unsavedReview, startedMs: at(10), phase: "ended", saved: "unsaved", mainQuestions: 0 },
    ] },
    { captureId: ids.otherCapture, sourceTitles: ["Semaphores - Operating Systems"], videos: 1, watchedSeconds: 240, status: { state: "capturing" }, reviews: [] },
    { captureId: ids.earlierCapture, sourceTitles: ["Deadlock prevention"], videos: 1, watchedSeconds: 900, status: { state: "stopped" }, reviews: [
      { reviewId: ids.earlierReview, startedMs: at(11), phase: "ended", saved: "saved", mainQuestions: earlierView?.state.mainQuestions ?? 1 },
    ] },
  ] });
  let attempts = 0;
  let evidenceAttempts = 0;
  let diagramAttempts = 0;
  let reviewAttempts = 0;
  let topicReads = 0;
  const api: AppApi = {
    async review(reviewId) {
      log("review.read");
      if (earlierView !== null && reviewId === earlierView.reviewId) {
        if (scenario === "record-context-error" && reviewAttempts++ === 0) throw new ApiError("Fixture review lookup failed. Retry is available.", 503);
        return earlierView;
      }
      return reviewId === view.reviewId ? view : savedView;
    },
    async captureView() { log("capture.read"); return capture; },
    async lectures() {
      log("lectures.read");
      if (scenario === "home-error" && attempts++ === 0) throw new ApiError("Fixture lecture list could not load. Retry is available.", 503);
      return lectureList;
    },
    async reviewOptions() {
      log("review.options");
      const scope = { chunkRevisions: [ids.chunk], supportedClaims: 3, topics, material, partial: [{ kind: "capture_gap", gap }] };
      return reviewOptionsz.parse(scenario === "capture-empty" ? { kind: "nothing_to_review", gaps: [gap], unverified: [], rewatch: [{ sourceId: ids.source, interval: { start: 600, end: 640 } }] } : scenario === "capture-processing" || scenario === "capture-held" ? { kind: "processing", readyNow: scope, pendingChunks: 2, estimateS: null } : { kind: "ready", scope });
    },
    async startReview(_capture, _choice, reviewId) { log("review.start"); return { kind: "started", reviewId, scope: view.scope }; },
    async answerInvite(_id, answer) { log(`invite.${answer}`); },
    async retryPreparation() { log("preparation.retry"); },
    async diagrams() {
      log("diagrams.read");
      if (scenario === "home-topic-error" && topicReads++ === 0) throw new ApiError("Fixture topic list could not load. Retry is available.", 503);
      return diagrams;
    },
    async requestDiagram(_review, topicId) {
      log(`diagram.request ${topicId}`);
      const topic = diagrams.find(t => t.topicId === topicId);
      if (topic === undefined) throw new ApiError("The preview has no such topic.", 404);
      if (topic.summary.state === "ready") return topic;
      if (scenario === "diagram" && diagramAttempts++ === 0) return setDiagram({ ...topic, summary: { state: "failed", error: "Fixture summary call failed. Retry is available." } });
      void gate().then(() => setDiagram(orderingReady));
      return setDiagram({ ...topic, summary: { state: "preparing" } });
    },
    async voiceAvailable() { return false; },
    async speech() { throw new Error("the preview has no voice"); },
    async evidence(query) {
      log("evidence.read");
      if (scenario === "evidence-error" && evidenceAttempts++ === 0) throw new ApiError("Fixture evidence request failed. Retry is available.", 503);
      if (scenario === "missing-evidence") return { ...evidence, frames: [], passages: [] };
      if ("ids" in query) return { ...evidence, frames: evidence.frames.filter(f => query.ids.includes(f.id)), passages: evidence.passages.filter(p => query.ids.includes(p.id)) };
      return evidence;
    },
    async frameImage() { return new Blob([illustration], { type: "image/svg+xml" }); },
    async *sendTurn(_review, turnId, act: LearnerAct) {
      log(`turn.send ${turnId} ${act.kind}`);
      if (scenario === "failed-turn" && attempts++ === 0) throw new ApiError("Fixture connection interrupted before delivery.", 503);
      const begin = act.kind === "begin";
      const learner = reviewViewz.parse({ ...view, scope: { ...view.scope, material }, turns: [{ id: turnId, reviewId: ids.review, actor: "learner", seq: view.turns.length + 1, atMs: 5000, threadId: begin ? null : ids.thread, act }] }).turns[0]!;
      view = { ...view, turns: [...view.turns.filter(t => t.id !== turnId), learner] };
      yield { type: "learner_turn_stored", turnId };
      if ((scenario === "held-turn" || scenario === "held-turn-used-up") && !begin) { yield { type: "turn_held", hold: { reason: "user_budget", resetsAtMs: MONTH_END, usedUp: scenario === "held-turn-used-up" } }; return; }
      const move = begin ? { kind: "ask_main" as const, threadId: ids.thread, claimIds: [ids.claim] as const } : scenario === "streaming" ? { kind: "explain" as const, threadId: ids.thread, evidence: [ids.laterPassage] } : { kind: "ask_followup" as const, threadId: ids.thread };
      yield { type: "move", turnId, move };
      const say = begin ? firstQuestion : "What might change if the threads acquired resources in a consistent order?";
      const cut = say.indexOf(" ", 16) + 1;
      yield { type: "say_delta", text: say.slice(0, cut) };
      if (scenario === "streaming") await gate();
      if (scenario === "unfinished-reply" && attempts++ === 0) { yield { type: "turn_failed", error: "Fixture reply interrupted after delivery.", retryable: true }; return; }
      yield { type: "say_delta", text: say.slice(cut) };
      yield { type: "sentence", text: say };
      const next: Turn = { id: id("turn", `reply-${turnId}`), reviewId: ids.review, seq: (learner.seq + 1) as Seq, atMs: 6000, actor: "tutor", threadId: ids.thread, move, say };
      const phase = act.kind === "pause" ? "paused" : act.kind === "resume" ? "active" : act.kind === "end" || act.kind === "wrap_up" ? "ended" : view.state.phase;
      const state = begin ? { ...view.state, phase, fuzzy: act.fuzzy ?? [], mainQuestions: view.state.mainQuestions + 1, openThread: ids.thread } : { ...view.state, phase };
      view = { ...view, state, turns: [...view.turns, next] };
      yield { type: "turn_complete", turnId };
    },
    async save() {
      log("review.save");
      if (scenario === "saving") await gate();
      if (scenario === "save-failure" && attempts++ === 0) return saveResultz.parse({ kind: "save_failed", error: "Fixture disk write failed. Your review is still here.", retryable: true });
      // As the backend does, the saved review carries its persisted observations: the main question, disputed. Resource ordering was never asked, so it has none.
      const observations = reviewViewz.parse(reviewJson(ids.review, "record")).observations.filter(o => o.threadId === ids.thread);
      view = { ...view, saved: "saved", observations }; return saveResultz.parse({ kind: "saved", notes: 1, observations: observations.length, links: 0 });
    },
    async record() { log("record.read"); if (scenario === "record-error" && attempts++ === 0) throw new ApiError("Fixture notebook could not load. Retry is available.", 503); return record; },
    async editNote(noteId, text) { log("note.edit"); record = { ...record, notes: record.notes.map(note => note.id === noteId ? { ...note, userEdit: text } : note) }; },
    async deleteNote(noteId) { log("note.delete"); record = { ...record, notes: record.notes.filter(note => note.id !== noteId) }; },
    async decideLink(linkId, decision) { log("link.decide"); record = {...record, links:record.links.map(link=>link.id===linkId?{...link,decision}:link)}; }, async resolveDispute(obsId, outcome) {
      log(`dispute.resolve ${obsId} ${outcome}`);
      // As clampStatus saves these fixture threads (answered before any help): a gap outcome keeps a gap status or becomes unresolved; otherwise the proposal stands.
      const resolved = (proposed: ObservationStatus): ObservationStatus => outcome === "it_was_my_gap" && proposed !== "partial" && proposed !== "unresolved" ? "unresolved" : proposed;
      record = { ...record, observations: record.observations.map(obs => obs.id === obsId ? { ...obs, status: resolved(obs.proposed), dispute: { kind: "resolved_by_learner", outcome } } : obs) };
    },
    async overrideObservation(obsId,status) { log(`observation.override ${obsId} ${status}`); record={...record,observations:record.observations.map(obs=>obs.id===obsId?{...obs,status}:obs)}; },
    async deleteEvidence(evidenceIds) { log("evidence.delete"); record = { ...record, unavailableEvidence: evidenceIds.map(id => ({ kind: "deleted", id, deletedAtMs: 1000 })) }; },
    async usage() {
      const held = scenario === "usage-held" || scenario === "capture-held" || scenario === "held-turn";
      if (scenario === "held-turn-used-up") return usageSummaryz.parse({ byKind: {}, byPurpose: {}, allowance: { usedUsd: 5, limitUsd: 5, resetsAtMs: MONTH_END, held: { reason: "user_budget", resetsAtMs: MONTH_END, usedUp: true } } });
      return usageSummaryz.parse(held
        ? { byKind: { estimated: { calls: 14, usd: 4.31 }, unknown: { calls: 3, usd: null } }, byPurpose: { interpretation: { calls: 3, errors: 0, unknownCost: 0 }, tutor_turn: { calls: 11, errors: 0, unknownCost: 0 }, boundary: { calls: 3, errors: 0, unknownCost: 3 } }, allowance: { usedUsd: 4.79, limitUsd: 5, resetsAtMs: MONTH_END, held: { reason: "user_budget", resetsAtMs: MONTH_END, usedUp: false } } }
        : { byKind: {}, byPurpose: {}, allowance: { usedUsd: 1.37, limitUsd: 5, resetsAtMs: MONTH_END, held: null } });
    },
  };
  return {
    api, speech,
    recordReviewId: scenario === "record-illustrated" ? ids.review : null,
    requestLedger: { subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot: () => ledger.join("\n") },
    continueFixture() { release?.(); release = undefined; },
    dictateFixture() { speechCallbacks?.onTranscript("Maybe one thread could release its lock before waiting.", true); },
  };
}
