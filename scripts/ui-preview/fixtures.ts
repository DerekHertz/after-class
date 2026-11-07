import type { AppApi } from "../../src/app/api";
import { ApiError } from "../../src/app/api";
import { parseId } from "../../src/shared/ids";
import type { IdKind, Id } from "../../src/shared/ids";
import type { LearnerAct, Turn, ReviewView } from "../../src/shared/domain";
import type { SpeechInput } from "../../src/app/speech";
import { captureResponsez, evidenceBundlez, recordViewz, reviewOptionsz, reviewViewz, usageSummaryz } from "../../src/app/decode";

const names = new Map<string, string>();
function id<K extends IdKind>(kind: K, name: string): Id<K> {
  const key = `${kind}:${name}`;
  if (!names.has(key)) names.set(key, (names.size + 1).toString(32).replaceAll('0', 'z').replaceAll('1', 'y').replaceAll('8', 'x').replaceAll('9', 'w').padEnd(26, 'a'));
  const parsed = parseId(kind, `${kind}_${names.get(key)}`);
  if (!parsed) throw new Error(`Invalid fixture id ${key}`);
  return parsed;
}
export const ids = { capture: id("cap", "capture"), review: id("rvw", "review"), source: id("src", "lecture"), thread: id("thr", "main"), claim: id("clm", "main"), passage: id("ev", "passage"), frame: id("ev", "frame"), chunk: id("crv", "chunk"), concept: id("cpt", "circular-wait") };
export const scenarios = ["review", "long-history", "streaming", "failed-turn", "unfinished-reply", "save-failure", "saving", "paused", "detour", "resource-wait", "correction", "soft-target", "missing-evidence", "evidence-error", "capture-ready", "capture-processing", "capture-empty", "record", "record-disputes", "record-empty", "record-error", "usage"] as const;
export type Scenario = typeof scenarios[number];
export const scenario = scenarios.find(s => s === new URLSearchParams(location.search).get("scenario")) ?? "review";
const material = [[ids.source, [[0, 760]]]];
const gap = { sourceId: ids.source, interval: { start: 600, end: 640 }, channel: "frames", reason: "hidden_tab" };
const turn = (actor: string, n: number, rest: object) => ({ id: id("turn", `${actor}-${n}`), reviewId: ids.review, seq: n, atMs: n * 1000, actor, threadId: actor === "code" ? null : ids.thread, ...rest });
const ask = (n: number, text: string) => turn("tutor", n, { move: { kind: "ask_main", threadId: ids.thread, claimIds: [ids.claim] }, say: text });
const answer = (n: number, text: string) => turn("learner", n, { act: { kind: "answer", text, modality: "text" } });
const turns: unknown[] = [];
if (scenario === "long-history") for (let n = 0; n < 12; n++) {
  turns.push(ask(turns.length + 1, `Earlier question ${n + 1}. How could a thread make progress?`));
  turns.push(answer(turns.length + 1, "One resource must become available before the waiting thread can proceed."));
}
turns.push(ask(turns.length + 1, "Two threads are waiting on each other. How could that happen?"));
turns.push(answer(turns.length + 1, "One holds lock A and wants B. The other holds B and wants A."));
turns.push(turn("tutor", turns.length + 1, { move: { kind: "explain", threadId: ids.thread, evidence: [ids.frame, ids.passage] }, say: "The lecture calls this circular wait. Each thread is holding a resource while waiting for the other." }));
turns.push(turn("tutor", turns.length + 1, { move: { kind: "ask_followup", threadId: ids.thread }, say: "What would have to change for either thread to continue?" }));
if (scenario === "soft-target") turns.push(turn("code", turns.length + 1, { notice: { kind: "soft_target_reached", elapsedS: 600 } }));
// Two disputed topics on two threads, so each notebook row has to say which assessment it changes (#112).
const ordering = { concept: id("cpt", "ordering"), claim: id("clm", "ordering"), thread: id("thr", "ordering") };
const disputes = scenario === "record-disputes";
const orderingLearnerTurns: string[] = [];
if (disputes) {
  turns.push(turn("learner", turns.length + 1, { act: { kind: "dispute", text: "I did describe the cycle: each thread waits on the other." } }));
  turns.push(turn("tutor", turns.length + 1, { move: { kind: "answer_dispute", threadId: ids.thread, evidence: [ids.passage], settled: false }, say: "The lecture treats holding one lock while waiting for another as the condition; your answer named the waiting but not the holding." }));
  const onOrdering = (actor: string, rest: object) => ({ ...turn(actor, turns.length + 1, rest), threadId: ordering.thread });
  turns.push(onOrdering("tutor", { move: { kind: "ask_main", threadId: ordering.thread, claimIds: [ordering.claim] }, say: "Why does acquiring locks in one global order prevent deadlock?" }));
  const orderingAnswer = onOrdering("learner", { act: { kind: "answer", text: "Nobody can wait on a lock that comes earlier in the order, so no cycle can form.", modality: "text" } });
  orderingLearnerTurns.push(orderingAnswer.id);
  turns.push(orderingAnswer);
  turns.push(onOrdering("tutor", { move: { kind: "diagnose", threadId: ordering.thread, hypothesis: "The answer skips that every thread must follow the same order.", evidence: [id("ev", "later-passage")] }, say: "Nearly." }));
  turns.push(onOrdering("learner", { act: { kind: "dispute", text: "One global order already means every thread follows it." } }));
}
if (scenario === "correction") turns.push(turn("code", turns.length + 1, { notice: { kind: "correction_pending", correctionId: "fixture-correction", affectedClaims: [ids.claim] } }));
let view: ReviewView = reviewViewz.parse({
  reviewId: ids.review, captureId: ids.capture,
  ...(disputes ? { topics: [{ id: ids.concept, label: "Circular wait", summary: "" }, { id: ordering.concept, label: "Lock ordering", summary: "" }] } : {}),
  scope: { chunkRevisions: [ids.chunk], material, claimsAtStart: [ids.claim], partial: [{ kind: "capture_gap", gap }], frozenAtSeq: 7 },
  state: { reviewId: ids.review, phase: scenario === "paused" ? "paused" : scenario === "save-failure" || scenario === "saving" ? "ended" : "active", mainQuestions: 1, openThread: ids.thread, lastLearnerAct: null,
    detour: scenario === "detour" ? { kind: "proposed", turnId: id("turn", "detour"), topic: "Resource ordering", needsResource: null } : scenario === "resource-wait" ? { kind: "awaiting_resource", resourceId: id("res", "resource"), topic: "Resource ordering" } : { kind: "none" },
    openDispute: null, corrections: [], activeSeconds: 30, softTargetS: 600, softTargetOffered: false, wrapUpRequested: false },
  turns, observations: [], saved: scenario === "save-failure" || scenario === "saving" ? "save_pending" : "unsaved",
});
const capture = captureResponsez.parse({ capture: { captureId: ids.capture, status: { state: "stopped" }, sources: [{ id: ids.source, videoId: "fixture", title: "Locks & deadlocks", url: "", channelName: "Deterministic preview", durationS: 1200 }], currentSourceId: ids.source, transcript: "available", health: [], watchedSeconds: 760 }, invite: { state: "invited", atChunk: ids.chunk } });
const laterPassage = id("ev", "later-passage");
const evidence = evidenceBundlez.parse({ material, passages: [{ kind: "passage", id: ids.passage, sourceId: ids.source, transcriptRevId: id("trv", "captions"), interval: { start: 402, end: 423 }, text: "Each thread holds a lock while waiting for the other.", origin: "panel" }, { kind: "passage", id: laterPassage, sourceId: ids.source, transcriptRevId: id("trv", "captions"), interval: { start: 480, end: 505 }, text: "Acquiring resources in the same order removes this circular wait.", origin: "panel" }], frames: [{ kind: "frame", id: ids.frame, sourceId: ids.source, mediaS: 402, width: 800, height: 450, teaching: "kept" }], gaps: [gap], ads: [] });
const observation = { id: id("obs", "disputed"), reviewId: ids.review, threadId: ids.thread, claimIds: [ids.claim], conceptIds: [ids.concept], proposed: "partial", status: "disputed", clampedFrom: null, dispute: { kind: "open", turnId: id("turn", "dispute") }, corrections: [], facts: { threadId: ids.thread, firstSubstantiveAnswerSeq: 2, firstHelpSeq: 3, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [id("turn", "learner-2")], helpTurns: [id("turn", "tutor-3")] } };
const orderingObservation = { ...observation, id: id("obs", "ordering"), threadId: ordering.thread, claimIds: [ordering.claim], conceptIds: [ordering.concept], dispute: { kind: "open", turnId: id("turn", "ordering-dispute") }, facts: { ...observation.facts, threadId: ordering.thread, firstHelpSeq: null, learnerTurns: orderingLearnerTurns, helpTurns: [] } };
let record = recordViewz.parse({ notes: scenario === "record-empty" ? [] : [{ id: id("note", "note"), reviewId: ids.review, conceptId: ids.concept, generated: [{ author: "learner", text: "Each thread holds something the other needs.", turnId: null, evidence: [] }, { author: "tutor", text: "Look at the order in which resources are acquired.", turnId: null, evidence: [ids.passage] }, { author: "source", text: "Circular wait is one condition for deadlock.", turnId: null, evidence: [ids.frame] }], userEdit: null, evidence: [ids.passage, ids.frame] }], observations: scenario === "record-empty" ? [] : disputes ? [observation, orderingObservation] : [observation], links: scenario === "record-empty" ? [] : [{id:id("lnk","link"),from:ids.concept,to:id("cpt","ordering"),type:"related_to",evidence:[ids.passage],rationale:"Resource ordering changes the circular-wait condition.",decision:"suggested"}], unavailableEvidence: [] });
const ledger: string[] = [];
const listeners = new Set<() => void>();
function log(call: string) { ledger.push(call); for (const listener of listeners) listener(); }
export const requestLedger = { subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot: () => ledger.join("\n") };
let release: (() => void) | undefined;
export function continueFixture() { release?.(); release = undefined; }
const gate = () => new Promise<void>(resolve => { release = resolve; });
let speechCallbacks: Parameters<SpeechInput["start"]>[0] | null = null;
export const speech: SpeechInput = {
  supported: true,
  start(callbacks) { speechCallbacks = callbacks; log("speech.start"); callbacks.onSpeechStart(); },
  stop() { speechCallbacks?.onEnd(); speechCallbacks = null; log("speech.stop"); },
};
export function dictateFixture() { speechCallbacks?.onTranscript("Maybe one thread could release its lock before waiting.", true); }
let attempts = 0;
let evidenceAttempts = 0;
const illustration = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450" fill="#fbf2db"/><g fill="none" stroke="#264c92" stroke-width="6"><path d="M230 190Q400 40 570 190"/><path d="m550 160 20 30-35 5"/><path d="M570 260Q400 410 230 260"/><path d="m250 290-20-30 35-5"/></g><g font-family="Georgia" fill="#302b22" text-anchor="middle"><text x="400" y="48" font-size="24">Illustrative fixture frame · circular wait</text><text x="215" y="230" font-size="34">Thread 1</text><text x="585" y="230" font-size="34">Thread 2</text><text x="215" y="275" font-size="24">holds A</text><text x="585" y="275" font-size="24">holds B</text><text x="400" y="422" font-size="18">Preview data, not a captured lecture</text></g></svg>`;
export const api: AppApi = {
  async review() { log("review.read"); return view; },
  async captureView() { log("capture.read"); return capture; },
  async lectures() { log("lectures.read"); return { lectures: [] }; },
  async reviewOptions() {
    log("review.options");
    const scope = { chunkRevisions: [ids.chunk], supportedClaims: 3, partial: [{ kind: "capture_gap", gap }] };
    return reviewOptionsz.parse(scenario === "capture-empty" ? { kind: "nothing_to_review", gaps: [gap], unverified: [], rewatch: [{ sourceId: ids.source, interval: { start: 600, end: 640 } }] } : scenario === "capture-processing" ? { kind: "processing", readyNow: scope, pendingChunks: 2, estimateS: null } : { kind: "ready", scope });
  },
  async startReview(_capture, _choice, reviewId) { log("review.start"); return { kind: "started", reviewId, scope: view.scope }; },
  async answerInvite(_id, answer) { log(`invite.${answer}`); },
  async retryPreparation() { log("preparation.retry"); },
  async diagrams() { return []; },
  async requestDiagram() { throw new ApiError("The preview has no diagrams.", 503); },
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
    const learner = reviewViewz.parse({ ...view, scope: { ...view.scope, material }, turns: [ { id: turnId, reviewId: ids.review, actor: "learner", seq: view.turns.length + 1, atMs: 5000, threadId: ids.thread, act } ] }).turns[0]!;
    view = { ...view, turns: [...view.turns.filter(t => t.id !== turnId), learner] };
    yield { type: "learner_turn_stored", turnId };
    const move = scenario === "streaming" ? { kind: "explain" as const, threadId: ids.thread, evidence: [laterPassage] } : { kind: "ask_followup" as const, threadId: ids.thread };
    yield { type: "move", turnId, move };
    yield { type: "say_delta", text: "What might change " };
    if (scenario === "streaming") await gate();
    if (scenario === "unfinished-reply" && attempts++ === 0) { yield { type: "turn_failed", error: "Fixture reply interrupted after delivery.", retryable: true }; return; }
    const say = "What might change if the threads acquired resources in a consistent order?";
    yield { type: "say_delta", text: "if the threads acquired resources in a consistent order?" };
    yield { type: "sentence", text: say };
    const next: Turn = { id: id("turn", `reply-${turnId}`), reviewId: ids.review, seq: learner.seq, atMs: 6000, actor: "tutor", threadId: ids.thread, move, say };
    const phase = act.kind === "pause" ? "paused" : act.kind === "resume" ? "active" : act.kind === "end" || act.kind === "wrap_up" ? "ended" : view.state.phase;
    view = { ...view, state: { ...view.state, phase }, turns: [...view.turns, next] };
    yield { type: "turn_complete", turnId };
  },
  async save() {
    log("review.save");
    if (scenario === "saving") await gate();
    if (scenario === "save-failure" && attempts++ === 0) return { kind: "save_failed", error: "Fixture disk write failed. Your review is still here.", retryable: true };
    view = { ...view, saved: "saved" }; return { kind: "saved", notes: 1, observations: 0, links: 0 };
  },
  async record() { log("record.read"); if (scenario === "record-error" && attempts++ === 0) throw new ApiError("Fixture notebook could not load. Retry is available.", 503); return record; },
  async editNote(noteId, text) { log("note.edit"); record = { ...record, notes: record.notes.map(note => note.id === noteId ? { ...note, userEdit: text } : note) }; },
  async deleteNote(noteId) { log("note.delete"); record = { ...record, notes: record.notes.filter(note => note.id !== noteId) }; },
  async decideLink(linkId, decision) { log("link.decide"); record = {...record, links:record.links.map(link=>link.id===linkId?{...link,decision}:link)}; }, async resolveDispute(obsId, outcome) { log("dispute.resolve"); record = {...record,observations:record.observations.map(obs=>obs.id===obsId?{...obs,status:outcome==="it_was_my_gap"&&!["partial","unresolved"].includes(obs.proposed)?"unresolved":obs.proposed,dispute:{kind:"resolved_by_learner",outcome}}:obs)}; }, async overrideObservation(obsId,status) { log("observation.override"); record={...record,observations:record.observations.map(obs=>obs.id===obsId?{...obs,status}:obs)}; },
  async deleteEvidence(evidenceIds) { log("evidence.delete"); record = { ...record, unavailableEvidence: evidenceIds.map(id => ({ kind: "deleted", id, deletedAtMs: 1000 })) }; },
  async usage() { return usageSummaryz.parse({ byKind: {}, byPurpose: {} }); },
};
