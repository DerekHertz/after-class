// domain/claim.ts -- claim lifecycle, shaped so R3 and R4 cannot be violated by construction.
//
// R4 (at most one revision): a claim holds one or two ClaimVersions (tuple type), and the state
//   machine has exactly one edge into 'revising'. There is no second revise state to reach.
// R3 (only checked claims judge answers): the tutor/review API accepts SupportedClaim only.
//   A SupportedClaim is minted by exactly one function (core/claimMachine.asSupported).
import { z } from "zod";
import { ClaimId, ContentKey, EvidenceId, JudgmentId, type SupportedClaimId } from "./ids";
import type { Verdict } from "./judgment";

/** Source statements, interpretation, assumptions: kept distinguishable (PRD). */
export const LabeledText = z.object({
  label: z.enum(["source_says", "interpretation", "assumption", "possible_confusion"]),
  text: z.string().min(1),
});
export type LabeledText = z.infer<typeof LabeledText>;

export interface CheckOutcome {
  readonly verdict: Verdict;
  readonly probability: number | null;
  readonly judgmentId: JudgmentId;
}

export interface ClaimVersion {
  readonly text: string;
  readonly evidence: readonly [EvidenceId, ...EvidenceId[]];
  readonly details: readonly LabeledText[];
  /** visually dependent claims MUST cite a frame; enforced by core/claimMachine.validateDraft */
  readonly visualDependent: boolean;
  /** null until the check for THIS version has run */
  readonly check: CheckOutcome | null;
}

/**
 * Mirrors the TLA+ Preparation model: queued/checking -> supported | revising -> rechecking -> supported | unverified.
 * 'dropped' = cancelled by Stop early before it finished (never applied afterwards, R8).
 */
export type ClaimStatus =
  | "awaiting_check"      // version 1 written, check 1 pending (TLA "checking")
  | "revising"            // check 1 was no/uncertain (TLA "revising")
  | "awaiting_recheck"    // version 2 written, check 2 pending (TLA "rechecking")
  | "supported_by_check"  // passed a model check; NOT proof of truth (spec)
  | "unverified"          // failed after the one revision; excluded from assessment
  | "dropped";

export type ClaimVersions =
  | readonly [ClaimVersion]
  | readonly [ClaimVersion, ClaimVersion]; // R4: no third element is representable

export interface Claim {
  readonly id: ClaimId;
  readonly contentKey: ContentKey;
  readonly ordinal: number;
  readonly status: ClaimStatus;
  readonly versions: ClaimVersions;
}

/** The only type the tutor and review scope accept (R3). */
export type SupportedClaim = Claim & {
  readonly id: SupportedClaimId;
  readonly status: "supported_by_check";
};
