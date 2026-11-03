// store/capture.ts -- owner: evidence-store workstream. Sole writer of: capture_events, watched_spans,
// quarantined_spans, sources, transcript_tracks, evidence, frame files, citations.
//
// Schema sketch (migrations live next to the code):
//   capture_events(capture_id, seq, wall, body_json, PRIMARY KEY (capture_id, seq))   -- append-only, the log
//   sources(source_id PK, video_id, url, title, duration_ms, ...)
//   watched_spans(span_id PK, capture_id, source_id, start_ms, end_ms, rate, first_seen, last_seen)   INDEX(source_id)
//   transcript_tracks(source_id, revision, provenance, segments_json, PRIMARY KEY (source_id, revision))
//   evidence(id PK, source_id, kind, start_ms, end_ms, text|sha, view_seq, capture_id, disposition, created_at, deleted_at)
//        INDEX(capture_id, view_seq)  INDEX(source_id, start_ms)
//   citations(note_id, evidence_id, state ('live'|'deleted'), interval snapshot)            -- R16
//   TRIGGER evidence_no_delete_if_cited: BEFORE DELETE ON evidence WHEN EXISTS
//        (SELECT 1 FROM citations WHERE evidence_id = OLD.id AND state = 'live') -> RAISE(ABORT,'R16')
//   frames on disk: <dataDir>/frames/<sha[0:2]>/<sha>.jpg  (content-addressed; write temp + fsync + rename)
import type { CaptureEvent, CaptureView } from "../../shared/domain/capture";
import type { CaptureId, EvidenceId, FrameSha, NoteId, SourceId } from "../../shared/domain/ids";
import type { EvidenceRef, CoverageReport, FrameDisposition, FrameEvidence, TranscriptEvidence } from "../../shared/domain/evidence";
import type { WallMs } from "../../shared/domain/time";
import type { Db } from "./db";

export interface IngestResult {
  /** highest contiguous seq persisted; the extension may drop its outbox through this (ack-by-high-water-mark) */
  readonly ackedThrough: number;
  readonly duplicates: number;
  readonly rejected: readonly { readonly seq: number; readonly reason: "implausible_span" | "unknown_source" | "frame_bytes_missing" | "schema" }[];
  /** what this batch made newly available; the pipeline wakes the boundary stage if > 0 */
  readonly newTranscriptEvidence: number;
  readonly newFrames: readonly FrameSha[];
  /** frames whose bytes the extension must (re)send before the event is accepted */
  readonly needBytes: readonly FrameSha[];
}

export interface CaptureRepo {
  /**
   * ONE transaction:
   *   1. INSERT OR IGNORE each event into capture_events by (capture_id, seq)   -> duplicates counted, not applied twice
   *   2. apply by type: sources / watched_spans (upsert, end = max(end)) / transcript_tracks / gaps / ad breaks / frame candidates
   *   3. spanPlausible() each span; implausible ones go to quarantined_spans, add no coverage (R2 defense in depth)
   *   4. materializeEvidence(sourceId) for every source touched   <- the ONLY code that INSERTs into `evidence` (R1, R2)
   *        coverage  = watchedCoverage(spans(source))
   *        covered   = selectCoveredSegments(track.segments, coverage)
   *        INSERT OR IGNORE evidence rows with natural ids; view_seq = next per-capture counter in segment-start order
   *        frames:  candidate rows whose `at` is covered; uncovered candidates wait (a later span can cover them)
   */
  append(batch: readonly CaptureEvent[]): IngestResult;

  /** Frame bytes arrive first (PUT /api/frames/:sha). Verifies sha256, parses PNG/JPEG header for dimensions, rejects out-of-bounds images. */
  putFrame(sha: FrameSha, bytes: Uint8Array): Promise<"stored" | "exists" | "hash_mismatch" | "unsupported_image">;
  readFrame(sha: FrameSha): Promise<Uint8Array | null>;

  view(captureId: CaptureId): CaptureView;
  coverage(sourceId: SourceId): CoverageReport;

  /** viewing-order reads for the pipeline (windows) and the review UI */
  transcriptAfter(captureId: CaptureId, viewSeq: number): readonly TranscriptEvidence[];
  keptFrames(captureId: CaptureId, fromViewSeq: number, toViewSeq: number): readonly FrameEvidence[];
  pendingFrameCandidates(captureId: CaptureId): readonly FrameEvidence[];
  /** deleted evidence comes back as a tombstone, never as readable content */
  get(ids: readonly EvidenceId[]): readonly EvidenceRef[];
  setDisposition(id: EvidenceId, d: FrameDisposition): void;
}

export interface RetentionRepo {
  /**
   * R16: pseudocode (single SQL statement, plus unlink of frame files afterwards):
   *   DELETE FROM evidence WHERE created_at < now - ttl AND NOT EXISTS (live citation) AND NOT EXISTS (claim_evidence of a claim pinned by an active review)
   * Cited evidence cannot be removed even if this SQL is wrong: the trigger aborts. Returns counts for display.
   */
  expireUncited(now: WallMs, ttlMs: number): { readonly removed: number; readonly keptCited: number };

  /**
   * The only deletion path for cited evidence, taking an explicit user-intent token from the HTTP layer.
   * One tx: citations.state='deleted' (keeps interval snapshot so the note shows "evidence deleted"), then DELETE evidence, then unlink frames.
   */
  deleteByUser(ids: readonly EvidenceId[], intent: UserDeleteIntent): void;

  /** called by ReviewRepo.commitRecord inside its transaction */
  cite(noteId: NoteId, evidence: readonly EvidenceId[]): void;
}
export type UserDeleteIntent = { readonly kind: "user_delete"; readonly requestId: string };

export function createCaptureRepo(db: Db, dataDir: string): CaptureRepo {
  throw new Error("not implemented");
}
export function createRetentionRepo(db: Db, dataDir: string): RetentionRepo {
  throw new Error("not implemented");
}
