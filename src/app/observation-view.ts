/**
 * Pure view logic for one tutor observation in the notebook: which topic it assesses, the question and the learner's
 * answer, the tutor's judgment and the evidence behind it. A row may be changed only once that context has loaded, so
 * the learner never corrects an assessment they cannot identify.
 */
import type { EvidenceId, ReviewId } from "../shared/ids";
import type { Observation, ReviewView, Turn } from "../shared/domain";
import type { AppApi } from "./api";
import { learnerActText, moveEvidence, STATUS_LABEL } from "./core";

/** One saved review's view, loaded for its observations' context. Each review loads and fails on its own. */
export type ReviewContext =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "ready"; readonly view: ReviewView };

/** Never rejects: a failed review becomes a failed context, so one bad request leaves the other reviews' context intact. */
export async function loadReviewContext(api: Pick<AppApi, "review">, reviewId: ReviewId): Promise<ReviewContext> {
  try {
    return { state: "ready", view: await api.review(reviewId) };
  } catch (e) {
    return { state: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

export type ObservationDetails = {
  readonly topic: string;
  readonly kind: "Question" | "Quick check";
  readonly question: string;
  /** What the learner did on the thread: their answers, or that they skipped or did not know. */
  readonly answers: readonly string[];
  /** The learner's latest dispute on the thread, in their words. */
  readonly dispute: string | null;
  /** What the tutor proposed, before the record rules or a dispute changed it. */
  readonly proposed: string;
  /**
   * The tutor's latest answer to a dispute on the thread, else its latest diagnosis hypothesis. A help explanation is
   * teaching, not the assessment's reason, and a diagnosis's spoken text can be as short as "Nearly.".
   */
  readonly reasoning: string | null;
  /** Lecture evidence the tutor cited on the thread, in the order cited. */
  readonly evidence: readonly EvidenceId[];
};

export type ObservationContext =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly error: string }
  /** The review loaded but does not name this observation's topic or question. */
  | { readonly kind: "incomplete"; readonly missing: readonly ("topic" | "question")[] }
  | { readonly kind: "ready"; readonly details: ObservationDetails };

const ANSWER_ACTS = new Set(["answer", "skip", "dont_know"]);

export function observationContext(o: Observation, review: ReviewContext | undefined): ObservationContext {
  if (review === undefined || review.state === "loading") return { kind: "loading" };
  if (review.state === "failed") return { kind: "failed", error: review.error };
  const { topics, turns } = review.view;
  const topic = topics.filter((t) => o.conceptIds.includes(t.id)).map((t) => t.label).join(" & ");
  const thread = turns.filter((t) => t.threadId === o.threadId);
  const asked = thread.find((t): t is Extract<Turn, { actor: "tutor" }> => t.actor === "tutor" && (t.move.kind === "ask_main" || t.move.kind === "quick_check"));
  const missing = [...(topic === "" ? ["topic" as const] : []), ...(asked === undefined ? ["question" as const] : [])];
  if (asked === undefined || missing.length > 0) return { kind: "incomplete", missing };
  const learner = new Map(turns.flatMap((t) => (t.actor === "learner" ? [[t.id, t] as const] : [])));
  const answers = o.facts.learnerTurns.flatMap((id) => {
    const turn = learner.get(id);
    return turn !== undefined && ANSWER_ACTS.has(turn.act.kind) ? [learnerActText(turn.act)] : [];
  });
  const dispute = thread.findLast((t) => t.actor === "learner" && t.act.kind === "dispute");
  const tutor = thread.filter((t): t is Extract<Turn, { actor: "tutor" }> => t.actor === "tutor");
  const disputeAnswer = tutor.findLast((t) => t.move.kind === "answer_dispute");
  const diagnosis = tutor.map((t) => t.move).findLast((m) => m.kind === "diagnose");
  return {
    kind: "ready",
    details: {
      topic,
      kind: asked.move.kind === "quick_check" ? "Quick check" : "Question",
      question: asked.say,
      answers,
      dispute: dispute?.actor === "learner" && dispute.act.kind === "dispute" ? dispute.act.text : null,
      proposed: STATUS_LABEL[o.proposed],
      reasoning: disputeAnswer?.say ?? diagnosis?.hypothesis ?? null,
      evidence: [...new Set(tutor.flatMap((t) => moveEvidence(t.move)))],
    },
  };
}

/** Status corrections and dispute decisions are sent only for a row whose topic and question the learner can see. */
export const canChangeObservation = (context: ObservationContext): context is Extract<ObservationContext, { kind: "ready" }> => context.kind === "ready";

/** Every row change goes through here; the disabled controls only show the rule. Returns whether the change was sent. */
export async function changeObservation(context: ObservationContext, run: (action: () => Promise<void>) => Promise<void>, action: () => Promise<void>): Promise<boolean> {
  if (!canChangeObservation(context)) return false;
  await run(action);
  return true;
}

/**
 * The learner's choices for an open dispute, mapped to the record's outcomes. "keep" sends nothing: the observation
 * stays disputed, which R14 never counts as a learning gap.
 */
export const DISPUTE_CHOICES = [
  { value: "keep", label: "Keep unresolved", meaning: "Stays disputed. It is not counted as a learning gap or as understood." },
  { value: "learner_was_right", label: "My explanation was supported", meaning: "Closes the dispute. It is not counted as a learning gap." },
  { value: "it_was_my_gap", label: "I want to revisit this", meaning: "Closes the dispute and counts this topic as a learning gap to revisit." },
] as const;
export type DisputeChoice = (typeof DISPUTE_CHOICES)[number]["value"];
