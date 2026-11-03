// core/claimMachine.ts -- per-claim lifecycle (flow C). The TLA+ Preparation model's claim states, as a reducer.
//
//   awaiting_check --yes--> supported_by_check
//   awaiting_check --no/uncertain/error--> revising --revised--> awaiting_recheck --yes--> supported_by_check
//                                                                                  --no/uncertain/error--> unverified
//   any non-final --cancelled--> dropped
//
// R4: 'revising' has exactly one inbound edge (from awaiting_check) and 'awaiting_recheck' has no
//     edge to 'revising'. ClaimVersions is a 1-or-2 tuple. A third revision is unrepresentable.
// R3: asSupported is the ONLY function that returns SupportedClaim.
import type { Claim, CheckOutcome, ClaimVersion, SupportedClaim } from "../domain/claim";
import type { EvidenceId } from "../domain/ids";
import type { Ignored, Transition } from "./transition";

export type ClaimEvent =
  | { readonly tag: "checked"; readonly check: CheckOutcome }
  | { readonly tag: "revised"; readonly version: ClaimVersion }
  | { readonly tag: "cancelled" };

export type ClaimCommand =
  | { readonly tag: "enqueue_check"; readonly version: 1 | 2 }
  | { readonly tag: "enqueue_revise" };

/**
 * pseudocode:
 *   checked, status=awaiting_check:
 *       verdict yes     -> supported_by_check
 *       otherwise       -> revising + enqueue_revise
 *   revised, status=revising:
 *       versions = [v1, v2]; status = awaiting_recheck + enqueue_check(2)
 *   checked, status=awaiting_recheck:
 *       verdict yes     -> supported_by_check
 *       otherwise       -> unverified       // excluded from assessment; kept visible with evidence
 *   cancelled, status not final -> dropped
 *   anything else     -> Ignored('illegal in <status>')     // never throws; logs/replays stay safe
 */
export function claimStep(c: Claim, e: ClaimEvent): Transition<Claim, ClaimCommand> | Ignored<Claim> {
  throw new Error("not implemented");
}

/** returns the claim typed as SupportedClaim iff status === 'supported_by_check'; the only minting site (R3). */
export function asSupported(c: Claim): SupportedClaim | null {
  throw new Error("not implemented");
}

/**
 * Checks a freshly written draft BEFORE it is stored (agent output is untrusted):
 *   - every cited EvidenceId exists in the chunk revision's evidence set (cannot cite outside the chunk)
 *   - visualDependent => at least one cited evidence is a kept frame
 *   - at most N claims per chunk; text non-empty
 * A draft failing validation is stored with status 'unverified' + reason, not silently repaired.
 */
export function validateDraft(
  v: ClaimVersion,
  chunkEvidence: ReadonlySet<EvidenceId>,
  frameIds: ReadonlySet<EvidenceId>,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  throw new Error("not implemented");
}
