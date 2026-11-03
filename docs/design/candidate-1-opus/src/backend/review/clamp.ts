/**
 * Observation status clamping (flow D) and the learning-gap predicate.
 * Pure. Imported by review (live view) and record (save), nothing else decides status.
 *
 * Rank for capping: independent > partial > after_help > unresolved.
 * not_assessed is outside the rank: it means "no evidence about understanding".
 * Downgrades proposed by the tutor are always kept; code only ever caps.
 */
import type { DisputeState, Observation, ObservationStatus, ThreadFacts, Turn } from "../../shared/domain";
import type { ThreadId } from "../../shared/ids";
import { HELP_MOVES } from "../../shared/domain";

/**
 * Facts about one thread, derived from turns in seq order.
 *   substantive answer = learner `answer` act in the thread (skip / dont_know are not answers)
 *   help               = tutor turn in the thread whose move.kind ∈ HELP_MOVES (single list in domain.ts)
 */
export function threadFacts(threadId: ThreadId, turns: readonly Turn[]): ThreadFacts {
  // TODO: also count as help an `explain` in another thread that cites this thread's claims? (open question)
  void HELP_MOVES;
  throw new Error("not implemented");
}

/**
 * R12 + R13.
 *   no substantive answer:
 *     only dont_know         → "unresolved"     (engaged, said they don't know; open question: or not_assessed?)
 *     skipped / unanswered   → "not_assessed"   (R13: never counted as understood)
 *   help before the first substantive answer:
 *     proposed ∈ {independent, partial} → "after_help"   (R12)
 *   otherwise → proposed
 * Returns the clamped status and what it was clamped from (for the record's audit line).
 */
export function clampStatus(proposed: ObservationStatus, facts: ThreadFacts): { status: ObservationStatus; clampedFrom: ObservationStatus | null } {
  throw new Error("not implemented");
}

/**
 * R14: a disputed assessment counts as a learning gap only if the LEARNER
 * resolved it that way. Only record.resolveDispute (a user command) can produce
 * `resolved_by_learner`; the tutor's move set has no way to resolve a dispute.
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
