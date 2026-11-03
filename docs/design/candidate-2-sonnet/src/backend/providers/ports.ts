// providers/ports.ts -- what the rest of the app may know about Jev and Claude. Domain types in, domain types out.
// No HTTP shapes, no CLI envelopes, no raw usage. Everything a port returns has ALREADY been recorded in the
// usage ledger (R17) by providers/metered.ts, including calls that failed.
import type { ClaimVersion } from "../../shared/domain/claim";
import type { EvidenceId, ReviewId, CaptureId, JobId, ConceptId } from "../../shared/domain/ids";
import type { Answer, JudgmentStamp } from "../../shared/domain/judgment";
import type { ObservationProposal, ReviewTurn, TutorProposal } from "../../shared/domain/review";
import type { UsageStage } from "../../shared/domain/usage";
import type { GraphLink } from "../../shared/domain/record";

export interface CallCtx {
  readonly stage: UsageStage;
  readonly captureId?: CaptureId;
  readonly reviewId?: ReviewId;
  readonly jobId?: JobId;
  readonly attempt: number;
  /** abort => the transport kills the HTTP request / `claude` child; the ledger records outcome 'cancelled' */
  readonly signal?: AbortSignal;
  /** which of the five approved live experiments this call belongs to, or undefined for ordinary use */
  readonly liveScope?: string;
}

/** Content, not IDs: the pipeline loads evidence and hands the model-facing text/images here. */
export interface TextPassage { readonly id: EvidenceId; readonly startMs: number; readonly endMs: number; readonly text: string }
export interface FrameImage { readonly id: EvidenceId; readonly atMs: number; readonly bytes: Uint8Array; readonly width: number; readonly height: number; readonly mime: "image/png" | "image/jpeg" }

export interface BoundaryInput {
  readonly context: readonly TextPassage[];
  readonly passage: readonly TextPassage[];
  readonly frames: readonly FrameImage[];
  readonly gapsBefore: readonly number[];
}
export interface BoundaryAnswers { readonly newConcept: Answer; readonly stoppingPoint: Answer; readonly stamp: JudgmentStamp }

export interface FrameChangeInput { readonly before: FrameImage; readonly after: FrameImage; readonly nearby: readonly TextPassage[] }
export interface ClaimCheckInput {
  readonly claimText: string;
  readonly assumptions: readonly string[];
  readonly passages: readonly TextPassage[];
  readonly frames: readonly FrameImage[];
}

/**
 * Jev: narrow judgments only. Never throws for provider failure: failure is Answer{verdict:'uncertain', probability:null}
 * (flow B/C: "Jev error/uncertain -> continue / one revision"), after the failed call has been ledgered.
 * It DOES throw AbortError on cancellation so the job runner can mark the job cancelled.
 */
export interface JevPort {
  judgeBoundary(i: BoundaryInput, ctx: CallCtx): Promise<BoundaryAnswers>;
  judgeFrameChange(i: FrameChangeInput, ctx: CallCtx): Promise<{ readonly addsTeachingContent: Answer; readonly stamp: JudgmentStamp }>;
  checkClaim(i: ClaimCheckInput, ctx: CallCtx): Promise<{ readonly supported: Answer; readonly stamp: JudgmentStamp }>;
}

export interface InterpretInput { readonly passages: readonly TextPassage[]; readonly frames: readonly FrameImage[]; readonly priorClaimsHint?: readonly string[] }
export interface ReviseInput extends InterpretInput { readonly claim: ClaimVersion; readonly checkVerdict: Answer }
export interface TutorInput {
  readonly mode: "open_recall" | "next_main" | "follow_up" | "diagnose_mismatch" | "hint" | "explain" | "recheck_dispute" | "propose_detour" | "disclose_correction";
  readonly claims: readonly { readonly id: string; readonly text: string; readonly evidence: readonly TextPassage[] }[];
  readonly turns: readonly ReviewTurn[];
  readonly mainRemaining: number;
}
/**
 * The tutor schema orders fields header-first (move, claimId, cites, detourTopic) and `say` LAST, so the gate
 * (core/review.acceptTutorMove) can run on the header BEFORE any word is shown or spoken:
 *   header -> (gate: ok => continue, reject => caller aborts the signal and re-asks silently) -> say_delta* -> done
 */
export type TutorEvent =
  | { readonly tag: "header"; readonly proposal: Omit<TutorProposal, "say"> }
  | { readonly tag: "say_delta"; readonly text: string }
  | { readonly tag: "done"; readonly proposal: TutorProposal };
export interface ObservationInput { readonly turns: readonly ReviewTurn[]; readonly questions: readonly { readonly questionId: string; readonly claimText: string }[] }
export interface RecordDraftInput { readonly turns: readonly ReviewTurn[]; readonly observationsSummary: string }
export interface RecordSuggestions {
  readonly noteBodies: readonly { readonly subject: string; readonly text: string; readonly cites: readonly EvidenceId[] }[];
  readonly links: readonly (Pick<GraphLink, "relation" | "evidence"> & { readonly from: ConceptId; readonly to: ConceptId })[];
}

/** Claude via `claude -p`. Structured outputs are zod-parsed inside the adapter; callers never see JSON strings. */
export interface ClaudePort {
  interpret(i: InterpretInput, ctx: CallCtx): Promise<readonly ClaimVersion[]>;
  revise(i: ReviseInput, ctx: CallCtx): Promise<ClaimVersion>;
  tutorTurn(i: TutorInput, ctx: CallCtx): AsyncIterable<TutorEvent>;
  proposeObservations(i: ObservationInput, ctx: CallCtx): Promise<readonly ObservationProposal[]>;
  draftRecord(i: RecordDraftInput, ctx: CallCtx): Promise<RecordSuggestions>;
  searchResources(i: { readonly concept: string; readonly claimText: string }, ctx: CallCtx): Promise<readonly { readonly url: string; readonly title: string; readonly relevance: string }[]>;
}

export interface Providers {
  readonly jev: JevPort;
  readonly claude: ClaudePort;
}
