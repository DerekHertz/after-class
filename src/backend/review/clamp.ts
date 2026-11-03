/**
 * Observation status clamping (flow D) and the learning-gap predicate (W8).
 * Pure. Imported by review (live view) and record (save); nothing else decides status.
 *
 * Rank for capping: independent > partial > after_help > unresolved.
 * not_assessed is outside the rank: it means "no evidence about understanding".
 * Downgrades the tutor proposed are kept; code only ever caps.
 */
import type { DisputeState, Observation, ObservationStatus, RecordedStatus, ThreadFacts, Turn } from "../../shared/domain";
import type { ThreadId } from "../../shared/ids";
import { HELP_MOVES } from "../../shared/domain";

/**
 * Facts about one thread, derived from turns in seq order.
 *   substantive answer = learner `answer` act in the thread (skip / dont_know are not answers)
 *   help               = tutor turn in the thread whose move.kind ∈ HELP_MOVES (single list in domain.ts)
 */
export function threadFacts(threadId: ThreadId, turns: readonly Turn[]): ThreadFacts {
  void HELP_MOVES;
  throw new Error("not implemented");
}

/**
 * R12: "If the tutor helped before my answer, it can't count as independent."
 * R13: "A skipped or unanswered question is never counted as understood."
 * R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
 *
 *   dispute open or unsettled                    → "disputed"      (R14, explicit clamp; the TLC fix)
 *   no substantive answer:
 *     only dont_know                             → "unresolved"    (SYNTHESIS open question 2)
 *     skipped / unanswered                       → "not_assessed"  (R13)
 *   help before the first substantive answer:
 *     proposed ∈ {independent, partial}          → "after_help"    (R12)
 *   otherwise                                    → proposed
 * The learner's override is clamped the same way. Returns what it was clamped from, for the audit line.
 */
export function clampStatus(proposed: ObservationStatus, facts: ThreadFacts, dispute: DisputeState): { readonly status: RecordedStatus; readonly clampedFrom: ObservationStatus | null } {
  throw new Error("not implemented");
}

/**
 * R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
 * Only record.resolveDispute (a user command) produces `resolved_by_learner`;
 * the tutor's move set has no way to resolve a dispute. after_help is not a
 * gap (SYNTHESIS open question 3).
 */
export function isLearningGap(o: Pick<Observation, "status" | "dispute">): boolean {
  const gapStatus = o.status === "unresolved" || o.status === "partial";
  return gapStatus && disputeAllowsGap(o.dispute);
}

function disputeAllowsGap(d: DisputeState): boolean {
  switch (d.kind) {
    case "none":
      return true;
    case "resolved_by_learner":
      return d.outcome === "it_was_my_gap";
    case "open":
    case "unsettled":
      return false;
  }
}
