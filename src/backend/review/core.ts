/**
 * Pure invite policy, scope freezing and corrections (W7). Importable only by review/ and test/.
 */
import type { ChunkRevisionId, ReviewId } from "../../shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkProvenance, ChunkRevision, Correction, EvidenceBundle, FrozenScope, InviteAnswer, InviteState, Seq,
} from "../../shared/domain";
import type { Material } from "../../shared/time";

export type InviteEvent =
  | { readonly kind: "chunk_closed"; readonly seq: Seq; readonly provenance: ChunkProvenance; readonly chunk: ChunkRevisionId; readonly watchedS: number }
  | { readonly kind: "answer"; readonly seq: Seq; readonly answer: InviteAnswer; readonly watchedS: number }
  | { readonly kind: "review_started"; readonly seq: Seq };

/**
 * Flow C invite policy as a fold.
 *   boundary close                          → invited; mark = watchedS
 *   time close, watchedS − mark ≥ 900       → invited; mark = watchedS
 *   boundary_revised / session_end          → unchanged (SYNTHESIS open question 5: no invite on session end)
 *   later                                   → "later"; mark = watchedS (next invite at next boundary close)
 *   wait                                    → "waiting"
 *   review_now / stop_early / review_started → "none"
 */
export function foldInvites(events: readonly InviteEvent[], timeInviteGapS: number): InviteState {
  throw new Error("not implemented");
}

/**
 * Flow C: "Freeze review scope = prepared chunks now".
 * unreviewed = current closed revisions whose material is not contained in the
 * union of earlier reviews' scope material.
 * R10: "A review never starts with zero supported claims in scope."
 * Returns null when no supported claim exists; FrozenScope.claimsAtStart is NonEmpty.
 */
export function freezeScope(
  unreviewed: readonly { readonly rev: ChunkRevision; readonly prep: ChunkPrep }[],
  assessable: (m: Material) => readonly AssessableClaim[],
  gaps: (m: Material) => EvidenceBundle["gaps"],
  seq: Seq,
): FrozenScope | null {
  throw new Error("not implemented");
}

/**
 * R7: "Once a review starts, its scope never grows; corrections can change claims inside it but can't add material."
 * Corrections inside a frozen scope: claims usable at start that no longer are,
 * claims whose text changed, new usable claims whose evidence is inside scope.material.
 * Never anything outside scope.material.
 */
export function corrections(reviewId: ReviewId, scope: FrozenScope, usableNow: readonly AssessableClaim[], disclosedIds: ReadonlySet<string>): Correction[] {
  throw new Error("not implemented");
}
