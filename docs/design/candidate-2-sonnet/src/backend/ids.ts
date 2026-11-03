// backend/ids.ts -- natural-ID minting (backend only; uses node:crypto, so never imported by the extension bundle).
//
// One rule: an ID derived from content is `${prefix}_${base32(sha256(len-prefixed parts)).slice(0, 26)}`.
// Parts are length-prefixed before hashing so ("ab","c") and ("a","bc") differ.
// Changing any derivation here is a data migration; they are versioned by PROCESSING_VERSION where relevant.
import type {
  ChunkId, ClaimId, ContentKey, EvidenceId, JobKey, NoteId, ObservationId, QuestionId, ReviewId, SourceId, LinkId, ConceptId,
} from "../shared/domain/ids";
import type { Evidence } from "../shared/domain/evidence";
import type { JobKind, JobTarget } from "../shared/domain/job";
import type { MediaMs } from "../shared/domain/time";

export const PROCESSING_VERSION = "p1"; // bump when interpretation prompts/schemas change: invalidates prep cache

export function evidenceIdForTranscript(source: SourceId, trackRevision: string, start: MediaMs, end: MediaMs): EvidenceId {
  throw new Error("not implemented");
}
export function evidenceIdForFrame(source: SourceId, sha: string): EvidenceId {
  throw new Error("not implemented");
}

/**
 * Content-addressed preparation identity (spec "cache identity"):
 *   hash(PROCESSING_VERSION, per piece: sourceId, trackRevision, evidence ids in viewing order, frame shas of KEPT frames)
 * Same watched content + same processing => same key => cached claims reused on rewatch.
 * A boundary revision changes the evidence list => new key => old jobs are structurally outdated (R8).
 */
export function contentKeyFor(evidence: readonly Evidence[]): ContentKey {
  throw new Error("not implemented");
}

export function chunkIdFor(captureIdOrdinal: string): ChunkId {
  throw new Error("not implemented");
}
export function claimIdFor(key: ContentKey, ordinal: number): ClaimId {
  throw new Error("not implemented");
}
export function jobKeyFor(kind: JobKind, target: JobTarget, inputs: string): JobKey {
  throw new Error("not implemented"); // + PROCESSING_VERSION
}
export function questionIdFor(review: ReviewId, mainOrdinal: number): QuestionId {
  throw new Error("not implemented");
}
/** R15: same (review, question) always yields the same observation row. */
export function observationIdFor(review: ReviewId, question: QuestionId): ObservationId {
  throw new Error("not implemented");
}
/** R15: notes are addressed by (review, subject) where subject is e.g. "summary", "gap:<questionId>", "learner-explanation:<questionId>". */
export function noteIdFor(review: ReviewId, subject: string): NoteId {
  throw new Error("not implemented");
}
export function linkIdFor(from: ConceptId, to: ConceptId, relation: string): LinkId {
  throw new Error("not implemented");
}
