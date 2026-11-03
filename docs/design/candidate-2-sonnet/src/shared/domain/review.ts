// domain/review.ts -- review lifecycle, turns, observations. Encodes R3, R7, R10-R14.
import { z } from "zod";
import {
  CaptureId, ChunkId, ClaimId, ContentKey, EvidenceId, type NonEmpty, ObservationId, QuestionId,
  ReviewId, TurnId, type SupportedClaimId,
} from "./ids";
import type { SupportedClaim } from "./claim";

/**
 * R7: frozen at start. `evidence` is the ceiling: a correction may swap claims for a chunk,
 * but `askableClaims` (core/review.ts) only returns claims whose evidence is a subset of it.
 * There is deliberately no `withChunk`/`extend` function on a scope.
 */
export interface ReviewScope {
  readonly reviewId: ReviewId;
  readonly captureId: CaptureId;
  readonly chunks: NonEmpty<{ readonly chunkId: ChunkId; readonly contentKey: ContentKey }>;
  readonly evidence: readonly EvidenceId[];
  readonly partial: readonly PartialReason[];
}
export type PartialReason =
  | { readonly kind: "stopped_early"; readonly unfinishedChunks: readonly ChunkId[] }
  | { readonly kind: "capture_gap"; readonly chunkId: ChunkId }
  | { readonly kind: "unverified_claims_excluded"; readonly count: number };

/** R10: the only way to get a started review is a non-empty supported set. */
export type ReviewStart =
  | { readonly kind: "started"; readonly scope: ReviewScope; readonly claims: NonEmpty<SupportedClaim> }
  | { readonly kind: "nothing_to_review"; readonly gaps: readonly PartialReason[]; readonly unverified: readonly ClaimId[]; readonly canRetry: boolean };

// ---- turns -----------------------------------------------------------------

export const LearnerTurnKind = z.enum([
  "answer", "skip", "dont_know", "request_hint", "request_explain",
  "dispute", "accept_detour", "decline_detour", "pause", "continue", "wrap_up", "end",
]);
export type LearnerTurnKind = z.infer<typeof LearnerTurnKind>;

export const TutorMove = z.enum([
  "main_question", "follow_up", "hint", "explain", "diagnostic",
  "detour_proposal", "recheck", "correction_disclosure", "wrap_offer", "closing",
]);
export type TutorMove = z.infer<typeof TutorMove>;

interface TurnBase {
  readonly id: TurnId;
  readonly reviewId: ReviewId;
  /** order in the log; assigned by the store on append */
  readonly seq: number;
  readonly questionId: QuestionId | null;
  readonly text: string;
  readonly evidenceShown: readonly EvidenceId[];
}
export interface LearnerTurn extends TurnBase { readonly actor: "learner"; readonly kind: LearnerTurnKind; readonly viaSpeech: boolean }
export interface TutorTurn extends TurnBase {
  readonly actor: "tutor";
  readonly kind: TutorMove;
  /** set by code from the validated tutor output; only SupportedClaimId can appear here (R3) */
  readonly claimId: SupportedClaimId | null;
}
export type ReviewTurn = LearnerTurn | TutorTurn;

// ---- detours (R11) ------------------------------------------------------------

/** Minted only by core/review.consentFrom(turn) from a LEARNER turn of kind 'accept_detour'. Model output cannot produce one. */
export type DetourConsent = { readonly turnId: TurnId } & z.$brand<"DetourConsent">;
export type DetourState =
  | { readonly tag: "none" }
  | { readonly tag: "proposed"; readonly topic: string; readonly needsPendingResource: boolean }
  | { readonly tag: "accepted"; readonly topic: string; readonly consent: DetourConsent }
  | { readonly tag: "declined"; readonly topic: string };

// ---- lifecycle ------------------------------------------------------------------

export type ReviewPhase =
  | "asking"            // tutor owes a move
  | "awaiting_learner"
  | "wrap_offered"      // soft target reached at a natural pause: continue / wrap up (never forced)
  | "ended";
export type EndedBy = "learner" | "wrapped_up" | "plan_complete";

export interface ReviewState {
  readonly scope: ReviewScope;
  /** current askable claims; may shrink after a correction, can never contain a claim outside scope.evidence */
  readonly claims: readonly SupportedClaim[];
  readonly phase: ReviewPhase;
  readonly endedBy: EndedBy | null;
  /** up to 3 main questions; follow-ups unbounded. Type forbids a fourth. */
  readonly mainAsked: 0 | 1 | 2 | 3;
  readonly openQuestion: QuestionId | null;
  readonly detour: DetourState;
  readonly softTargetMs: number;
  readonly startedAtWall: number;
}

// ---- observations (R12-R14) ------------------------------------------------------

export const ObservationStatus = z.enum(["independent", "partial", "after_help", "unresolved", "not_assessed"]);
export type ObservationStatus = z.infer<typeof ObservationStatus>;

export type ClampReason =
  | "no_learner_answer"            // R13
  | "help_before_assessed_answer"  // R12
  | "citation_invalid";            // proposal cited no real learner answer turn of this question

/** What the model proposes. Never stored as the status. */
export interface ObservationProposal {
  readonly questionId: QuestionId;
  readonly status: ObservationStatus;
  /** learner turns the model says justify the status; validated by clampObservation */
  readonly citedLearnerTurns: readonly TurnId[];
  readonly rationale: string;
}

export type DisputeState =
  | { readonly tag: "none" }
  | { readonly tag: "open"; readonly turnId: TurnId }
  | { readonly tag: "unsettled" }  // recheck did not settle it: stays disputed
  | { readonly tag: "resolved"; readonly as: "learner_gap" | "not_a_gap" | "source_corrected"; readonly by: "learner" };

export interface Observation {
  readonly id: ObservationId;
  readonly reviewId: ReviewId;
  readonly questionId: QuestionId;
  readonly claimId: SupportedClaimId;
  /** after clamping */
  readonly status: ObservationStatus;
  readonly proposed: ObservationStatus;
  readonly clampedBy: ClampReason | null;
  readonly turns: readonly TurnId[];
  readonly dispute: DisputeState;
  readonly sourceRefs: readonly EvidenceId[];
}

// ---- tutor proposals (model output, parsed; code disposes) --------------------------

/**
 * What the tutor model may ask for. Every field is a PROPOSAL: core/review.acceptTutorMove
 * checks it against ReviewState (claim askable? budget left? evidence inside scope? detour
 * allowed?) and either turns it into a TutorTurn or rejects it with a reason.
 * Note what is absent: no way to set a status, a consent, or a scope change.
 */
export interface TutorProposal {
  readonly move: TutorMove;
  readonly say: string;
  readonly claimId: ClaimId | null;
  readonly cites: readonly EvidenceId[];
  readonly detourTopic: string | null;
}
