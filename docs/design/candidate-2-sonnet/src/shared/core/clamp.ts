// core/clamp.ts -- observation status clamping (flow D, R12, R13, R14). Pure and exhaustively testable.
//
// The model PROPOSES a status; code computes the ceiling from the turn log, which code wrote:
// learner turn kinds come from UI events, tutor move kinds from the validated TutorGate. The model's
// opinion of what counted as "help" is never consulted.
import type {
  DisputeState, Observation, ObservationProposal, ObservationStatus, ReviewTurn, ClampReason,
} from "../domain/review";

/** strongest -> weakest. A clamp only ever moves DOWN this list. */
export const STATUS_ORDER = ["independent", "partial", "after_help", "unresolved", "not_assessed"] as const satisfies readonly ObservationStatus[];

/** tutor 'hint' | 'explain' | 'correction_disclosure' are help. A learner's REQUEST for help is not help until the tutor gives it. */
export function isHelp(t: ReviewTurn): boolean {
  throw new Error("not implemented");
}

export interface Clamped {
  readonly status: ObservationStatus;
  readonly clampedBy: ClampReason | null;
}

/**
 * pseudocode:
 *   turns = log.filter(t => t.questionId === proposal.questionId)         // main question + its follow-ups
 *   answers = turns.filter(t => t.actor=='learner' && t.kind=='answer' && t.text.trim() != '')
 *   cited   = proposal.citedLearnerTurns.map(find in answers)             // must be real answers of THIS question
 *
 *   if answers.length == 0:                           return not_assessed, 'no_learner_answer'     // R13: skip, don't-know, silence
 *   if proposal.status == 'not_assessed':             return not_assessed, null
 *   if cited has any missing:                         return cap(proposal.status, 'unresolved'), 'citation_invalid'
 *   assessed = last(cited by seq)
 *   helpBefore = turns.some(t => isHelp(t) && t.seq < assessed.seq)       // R12: help BEFORE the answer being assessed
 *   if helpBefore:                                    return cap(proposal.status, 'after_help'), 'help_before_assessed_answer'
 *   return proposal.status, null
 *
 * cap(s, ceiling) = the weaker of s and ceiling in STATUS_ORDER (so 'unresolved' stays 'unresolved').
 * Properties to test: (1) clamp is idempotent, (2) result is never stronger than the proposal,
 * (3) any log where isHelp precedes the cited answer never yields 'independent'/'partial',
 * (4) any question with no learner 'answer' turn yields 'not_assessed' for every proposal.
 */
export function clampObservation(proposal: ObservationProposal, log: readonly ReviewTurn[]): Clamped {
  throw new Error("not implemented");
}

/**
 * R14: what counts as a learning gap. Excludes any observation under open/unsettled dispute unless the
 * learner resolved it as a gap. Only `by: 'learner'` resolutions exist in the type, so code cannot resolve it for them.
 *   gap iff status in {unresolved, after_help}  AND  dispute is none | resolved(as: learner_gap)
 *   (resolved as not_a_gap / source_corrected => not a gap)
 */
export function countsAsGap(o: Pick<Observation, "status" | "dispute">): boolean {
  throw new Error("not implemented");
}

export function disputeAfterRecheck(settled: boolean, d: DisputeState): DisputeState {
  throw new Error("not implemented"); // open -> unsettled unless the LEARNER's later turn resolves it
}
