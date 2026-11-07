/**
 * Pure view logic for topic diagrams (flow D: "show me the diagram"): which topic a question is about, how a
 * frame links back to its moment, and when to keep polling. The notebook shows each topic's frame and summary in its
 * Source part (record.tsx).
 */
import type { ClaimId, EvidenceId } from "../shared/ids";
import type { DiagramFrame, ReviewView, TopicDiagram, Turn } from "../shared/domain";
import { watchUrl } from "./core";

/** The link that reopens the lecture at the frame's moment, or null when the source's video is unknown. */
export function frameLink(frame: DiagramFrame): string | null {
  return frame.videoId === null ? null : watchUrl(frame.videoId, frame.mediaS);
}

const isQuestion = (t: Turn): t is Extract<Turn, { actor: "tutor" }> & { move: { kind: "ask_main" | "quick_check" } } =>
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

export type LineSources = { readonly ids: readonly EvidenceId[]; readonly label: string; readonly aria: string };

/** The one compact "Sources (n)" button of a summary line; it opens all of that line's evidence in the evidence pane. */
export function lineSources(line: { readonly evidence: readonly EvidenceId[] }, lineNo: number): LineSources {
  const n = line.evidence.length;
  return { ids: line.evidence, label: `Sources (${n})`, aria: `Open the ${n} ${n === 1 ? "source" : "sources"} cited by line ${lineNo}` };
}
