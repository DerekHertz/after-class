// core/review.ts -- review lifecycle (flow D). Pure. The tutor MODEL proposes; this file disposes.
//
// R3  tutor claims come from `ReviewState.claims: SupportedClaim[]`; acceptTutorMove rejects any other claimId.
// R7  scope is frozen; `askableClaims` filters to claim.evidence ⊆ scope.evidence; there is no function that grows a scope.
// R9  this module imports nothing from capture; capture events cannot reach it.
// R10 `startReview` can only return `started` with a NonEmpty<SupportedClaim>.
// R11 `consentFrom` is the sole minting site of DetourConsent and takes a LEARNER turn.
import type { ChunkId, ContentKey, EvidenceId, ReviewId } from "../domain/ids";
import type { SupportedClaim } from "../domain/claim";
import type {
  DetourConsent, LearnerTurn, ReviewStart, ReviewState, TutorProposal, TutorTurn,
} from "../domain/review";
import type { Readiness } from "./prep";
import type { Transition } from "./transition";

export interface ReviewConfig {
  readonly softTargetMs: number; // default 10 min, configurable
  readonly maxMain: 3;
}

/**
 * Freeze the scope from what is prepared RIGHT NOW. New viewing never enters it.
 * pseudocode:
 *   if readiness.tag != 'ready': return nothing_to_review (caller maps 'processing' to the Processing screen first)
 *   evidence = union over ready chunks of chunk.evidenceIds
 *   scope = { reviewId, chunks: ready chunks (pinned contentKey), evidence, partial: readiness.partial }
 *   return started(scope, claims = readiness.supported)
 */
export function startReview(
  reviewId: ReviewId,
  readiness: Readiness,
  chunkEvidence: ReadonlyMap<ChunkId, { readonly contentKey: ContentKey; readonly evidenceIds: readonly EvidenceId[] }>,
  cfg: ReviewConfig,
  nowWall: number,
): { readonly start: ReviewStart; readonly state: ReviewState | null } {
  throw new Error("not implemented");
}

/** R7 ceiling: claims whose evidence is not a subset of scope.evidence are never offered to the tutor. */
export function askableClaims(state: ReviewState): readonly SupportedClaim[] {
  throw new Error("not implemented");
}

export type TutorGate =
  | { readonly ok: true; readonly turn: Omit<TutorTurn, "id" | "seq"> }
  | { readonly ok: false; readonly reason: "claim_not_askable" | "budget_exhausted" | "evidence_outside_scope" | "move_not_allowed_in_phase" | "detour_without_consent" };

/**
 * The gate every tutor output passes before it is stored or spoken.
 *   main_question  requires mainAsked < 3, claimId ∈ askable (mints SupportedClaimId from the state's own list, not from the model's string)
 *   follow_up/hint/explain/diagnostic require openQuestion != null
 *   detour_proposal requires detour.tag == 'none'; creates DetourState.proposed. It can NEVER start a detour.
 *   cites ⊆ scope.evidence (R7: evidence shown beside the conversation stays inside scope)
 *   correction_disclosure only after a CorrectionNotice
 */
export function acceptTutorMove(state: ReviewState, p: TutorProposal): TutorGate {
  throw new Error("not implemented");
}

export type ReviewCommand =
  | { readonly tag: "need_tutor_move"; readonly intent: "open_recall" | "next_main" | "follow_up" | "diagnose_mismatch" | "hint" | "explain" | "recheck_dispute" | "propose_detour" | "disclose_correction" }
  | { readonly tag: "offer_wrap" }
  | { readonly tag: "start_detour"; readonly consent: DetourConsent }
  | { readonly tag: "finalize_record" };

/**
 * pseudocode, by learner turn kind:
 *   answer          -> need_tutor_move(follow_up | diagnose_mismatch | next_main) (tutor decides which; gate checks it)
 *   skip|dont_know  -> question stays unanswered (observation will be not_assessed, R13); next_main
 *   request_hint    -> need_tutor_move(hint); explain likewise
 *   dispute         -> observation.dispute = open; need_tutor_move(recheck_dispute); unsettled stays 'unsettled'
 *   accept_detour   -> only if detour.tag == 'proposed': detour = accepted(consentFrom(turn)); start_detour(consent)   (R11)
 *   decline_detour  -> detour = declined
 *   pause           -> no command
 *   continue        -> clears wrap_offered
 *   wrap_up | end   -> phase = ended; finalize_record  (capture is not touched, R9)
 *   after any turn: if elapsed >= softTargetMs and at a natural pause (no open question, no detour proposal pending) -> offer_wrap
 *   a skip of the 3rd main question or any end -> never "forced cutoff": wrap is an offer, not a transition
 */
export function onLearnerTurn(state: ReviewState, t: LearnerTurn, nowWall: number): Transition<ReviewState, ReviewCommand> {
  throw new Error("not implemented");
}

export function consentFrom(t: LearnerTurn): DetourConsent | null {
  throw new Error("not implemented"); // t.kind === 'accept_detour' ? brand({turnId: t.id}) : null
}

/** Pipeline tells the review that a chunk it pinned was revised. */
export interface CorrectionNotice {
  readonly chunkId: ChunkId;
  readonly oldKey: ContentKey;
  readonly newKey: ContentKey;
  /** claims for the new key, already prepared; may be empty if prep is still running */
  readonly newClaims: readonly SupportedClaim[];
  readonly evidenceIdsOfNew: readonly EvidenceId[];
}

/**
 * "Reprocess affected claims only" without growing scope (R7):
 *   claims' = (state.claims minus those with contentKey == oldKey) ++ newClaims.filter(c => c.evidence ⊆ scope.evidence)
 *   scope itself is returned unchanged (same object): evidence beyond the ceiling stays in its chunk for a LATER review
 *   emit need_tutor_move('disclose_correction') iff any asked claim was affected; observations of affected claims get recomputed, others untouched
 *   if claims' is empty: phase -> wrap_offered with a notice (never silently continue on nothing)
 */
export function applyCorrection(state: ReviewState, n: CorrectionNotice): Transition<ReviewState, ReviewCommand> {
  throw new Error("not implemented");
}
