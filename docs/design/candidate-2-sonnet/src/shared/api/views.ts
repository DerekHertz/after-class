// api/views.ts -- read models the review app and extension render. Built by the engine from domain state;
// these are the only shapes that cross to the UI. (Domain types appear inside them where the UI needs them.)
import type { CaptureId, ChunkId, ClaimId, EvidenceId, ReviewId, TurnId, NoteId } from "../domain/ids";
import type { CoverageReport, EvidenceRef } from "../domain/evidence";
import type { InviteState } from "../core/invite";
import type { PrepStatus } from "../core/prep";
import type { ClaimStatus } from "../domain/claim";
import type { BoundaryRow, CloseProvenance } from "../domain/chunk";
import type { Answer } from "../domain/judgment";
import type { ReviewPhase, ReviewScope, ReviewTurn, Observation, PartialReason, DetourState } from "../domain/review";
import type { Note, GraphLink, SaveState } from "../domain/record";
import type { CostTotal, UsageStage } from "../domain/usage";

export interface ChunkView {
  readonly chunkId: ChunkId;
  readonly revision: number;
  readonly provenance: CloseProvenance;
  readonly prep: PrepStatus;
  readonly coverage: readonly CoverageReport[];
  readonly claims: readonly { readonly id: ClaimId; readonly status: ClaimStatus; readonly text: string; readonly unverifiedReason: string | null }[];
}
export interface PrepView {
  readonly captureId: CaptureId;
  readonly invite: InviteState;
  readonly readiness: "ready" | "processing" | "nothing_to_review";
  readonly processing: { readonly pending: readonly ChunkId[]; readonly estimateMs: number | null } | null;
  readonly chunks: readonly ChunkView[];
}
/** "Inspectable Jev preprocessing inputs, judgments, routing and uncertain outcomes" (PRD acceptance #2). */
export interface ChunkInspectView {
  readonly chunk: ChunkView;
  readonly evidence: readonly EvidenceRef[];
  readonly windows: readonly { readonly passage: readonly EvidenceId[]; readonly context: readonly EvidenceId[]; readonly newConcept: Answer; readonly stopping: Answer; readonly routed: BoundaryRow; readonly cached: boolean }[];
}

export type ReviewStartView =
  | { readonly kind: "started"; readonly reviewId: ReviewId; readonly scope: ReviewScope }
  | { readonly kind: "processing"; readonly pending: readonly ChunkId[]; readonly estimateMs: number | null }
  | { readonly kind: "nothing_to_review"; readonly gaps: readonly PartialReason[]; readonly unverified: readonly { readonly id: ClaimId; readonly text: string; readonly evidence: readonly EvidenceId[] }[]; readonly canRetry: boolean };

export interface ReviewView {
  readonly reviewId: ReviewId;
  readonly phase: ReviewPhase;
  readonly scope: ReviewScope;
  readonly turns: readonly ReviewTurn[];
  readonly mainAsked: number;
  readonly detour: DetourState;
  readonly save: SaveState;
  readonly shownEvidence: readonly EvidenceRef[];
}

/** One streamed tutor turn. `speakable` deltas are sentence-complete so TTS can start early; `interrupted` is the learner barging in. */
export type TutorStreamEvent =
  | { readonly tag: "learner_turn_stored"; readonly turnId: TurnId }
  | { readonly tag: "say_delta"; readonly text: string }
  | { readonly tag: "tutor_turn"; readonly turn: ReviewTurn }
  | { readonly tag: "phase"; readonly phase: ReviewPhase }
  | { readonly tag: "save"; readonly state: SaveState }
  | { readonly tag: "error"; readonly message: string };

export interface RecordView {
  readonly notes: readonly Note[];
  readonly observations: readonly Observation[];
  readonly links: readonly GraphLink[];
  readonly gaps: readonly ClaimId[]; // countsAsGap(...) applied: disputed ones excluded (R14)
  readonly noteIdsWithDeletedEvidence: readonly NoteId[];
}

export interface UsageView {
  readonly total: CostTotal;
  readonly byStage: Readonly<Record<UsageStage, CostTotal>>;
}
