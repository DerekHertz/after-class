/**
 * Pure view logic for topic diagrams (flow D: "show me the diagram"): which topic a question is about, how a
 * frame links back to its moment, when to keep polling, and the illustrated page the record shows per topic.
 */
import type { ClaimId, EvidenceId, ThreadId } from "../shared/ids";
import type { DiagramFrame, Observation, ReviewView, TopicDiagram, Turn } from "../shared/domain";
import { learnerActText, STATUS_LABEL, observationRow, watchUrl } from "./core";

/** The link that reopens the lecture at the frame's moment, or null when the source's video is unknown. */
export function frameLink(frame: DiagramFrame): string | null {
  return frame.videoId === null ? null : watchUrl(frame.videoId, frame.mediaS);
}

export const isQuestion = (t: Turn): t is Extract<Turn, { actor: "tutor" }> & { move: { kind: "ask_main" | "quick_check" } } =>
  t.actor === "tutor" && (t.move.kind === "ask_main" || t.move.kind === "quick_check");

/** The topic whose claims the current question asks about: the open thread's question, else the latest one asked. */
export function currentQuestionTopic(view: Pick<ReviewView, "turns" | "state">, topics: readonly TopicDiagram[]): TopicDiagram | null {
  const questions = view.turns.filter(isQuestion);
  const open = view.state.openThread;
  const asked = (open === null ? undefined : questions.find((t) => t.move.threadId === open)) ?? questions.at(-1);
  if (asked === undefined) return null;
  const claims = new Set<ClaimId>(asked.move.claimIds);
  return topics.find((t) => t.claimIds.some((id) => claims.has(id))) ?? null;
}

/** A summary being written is checked again until it settles. */
export const shouldPollDiagrams = (topics: readonly TopicDiagram[] | null): boolean => topics?.some((t) => t.summary.state === "preparing") === true;

export const SUMMARY_NOTE = {
  no_claims: "No claim about this topic is usable right now, so there is nothing cited to summarize.",
  not_requested: "The state-change summary has not been written yet.",
  preparing: "Writing the summary… this usually takes 20–30 seconds.",
} as const;

export const NO_FRAME_NOTE = "No frame was captured for this topic, so only the summary is shown.";

export type IllustratedQuestion = {
  readonly threadId: ThreadId;
  readonly kind: "Question" | "Quick check";
  readonly question: string;
  /** What the learner did on the thread: their answers, or that they skipped or did not know. */
  readonly answers: readonly string[];
  readonly status: string;
  readonly note: string | null;
};

export type IllustratedPage = { readonly topic: TopicDiagram; readonly questions: readonly IllustratedQuestion[] };

const ANSWER_ACTS = new Set(["answer", "skip", "dont_know"]);

function questionOf(o: Observation, turns: readonly Turn[]): IllustratedQuestion | null {
  const asked = turns.find((t) => isQuestion(t) && t.move.threadId === o.threadId);
  if (asked === undefined || asked.actor !== "tutor") return null;
  const learner = new Map(turns.flatMap((t) => (t.actor === "learner" ? [[t.id, t] as const] : [])));
  const answers = o.facts.learnerTurns.flatMap((id) => {
    const turn = learner.get(id);
    return turn !== undefined && ANSWER_ACTS.has(turn.act.kind) ? [learnerActText(turn.act)] : [];
  });
  const row = observationRow(o);
  return { threadId: o.threadId, kind: asked.move.kind === "quick_check" ? "Quick check" : "Question", question: asked.say, answers, status: STATUS_LABEL[o.status], note: row.note };
}

/**
 * One page per topic the review covered, in scope order: the topics an observation (a main question or a quick
 * check) was recorded for. A topic nobody was asked about has no page.
 */
export function illustratedPages(view: Pick<ReviewView, "turns" | "observations">, topics: readonly TopicDiagram[]): IllustratedPage[] {
  return topics.flatMap((topic) => {
    const mine = view.observations.filter((o) => o.conceptIds.includes(topic.topicId) || o.claimIds.some((id) => topic.claimIds.includes(id)));
    const questions = mine.flatMap((o) => questionOf(o, view.turns) ?? []);
    return questions.length === 0 ? [] : [{ topic, questions }];
  });
}

/** Topics a page needs a summary for and does not have yet. */
export const needsSummary = (topic: TopicDiagram): boolean => topic.summary.state === "not_requested";

export type LineSources = { readonly ids: readonly EvidenceId[]; readonly label: string; readonly aria: string };

/** The one compact "Sources (n)" button of a summary line; it opens all of that line's evidence in the evidence pane. */
export function lineSources(line: { readonly evidence: readonly EvidenceId[] }, lineNo: number): LineSources {
  const n = line.evidence.length;
  return { ids: line.evidence, label: `Sources (${n})`, aria: `Open the ${n} ${n === 1 ? "source" : "sources"} cited by line ${lineNo}` };
}
