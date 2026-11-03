/**
 * Pure preparation (W6). Importable only by preparation/ and test/.
 */
import type { AssessableClaim, ChunkPrep, Claim, ClaimDraft, ClaimStatus, EvidenceBundle, Seq, Verdict } from "../../shared/domain";
import type { Lookup } from "../providers/memo";

/** Code-side validity before any Jev call: refs exist, lie in the chunk, visual ⇒ cites a frame. */
export function validateDraft(draft: ClaimDraft, chunk: EvidenceBundle): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  throw new Error("not implemented");
}

type Check = { readonly verdict: Verdict; readonly p: number | null };

export type CheckLookups = {
  readonly originalCheck: Lookup<Check> | { readonly kind: "invalid_refs" };
  readonly revision: Lookup<ClaimDraft> | null; // null until originalCheck is terminal-and-not-yes
  readonly revisionCheck: Lookup<Check> | { readonly kind: "invalid_refs" } | null;
};

/**
 * R3: "A claim can be used to judge my answers only if it passed the evidence check."
 * R4: "A claim gets at most one revision; after that it's unverified."
 * R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes."
 *
 * `cutoff` = Seq of the latest stop-early covering this claim's chunk that is
 * not followed by a covering retry (null if none). A result counts only if
 * memo.appliesBefore(result, cutoff).
 *
 *   pending(next) = cutoff ? "dropped" : next
 *   c1 = originalCheck            (invalid_refs counts as verdict "no", no Jev call made)
 *   !counts(c1)                    → pending("awaiting_check")
 *   c1 yes                         → "supported_by_check"
 *   rv = revision                  (input is ALWAYS the original draft + c1)
 *   !counts(rv)                    → pending("awaiting_revision")
 *   rv failed                      → "unverified"   (no second revision attempt)
 *   c2 = revisionCheck(rv.value)
 *   !counts(c2)                    → pending("awaiting_recheck")
 *   c2 yes ? "supported_by_check" : "unverified"   (no / uncertain / failed ⇒ unverified)
 */
export function deriveClaimStatus(lookups: CheckLookups, cutoff: Seq | null): ClaimStatus {
  throw new Error("not implemented");
}

/**
 * R3: "A claim can be used to judge my answers only if it passed the evidence check."
 * The AssessableClaim constructor. Returns null unless status is supported_by_check.
 */
export function assessable(claim: Claim): AssessableClaim | null {
  throw new Error("not implemented");
}

/** Interpretation terminal ∧ every member claim terminal (supported | unverified | dropped). */
export function isFinished(prep: Omit<ChunkPrep, "finished">): boolean {
  throw new Error("not implemented");
}
