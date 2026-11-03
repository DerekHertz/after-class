/**
 * Evidence store. Owns: capture_facts, sources, transcript_revisions, frames
 * (metadata; bytes on disk at <dataDir>/frames/<sourceId>/<frameId>.jpg),
 * pinned_evidence. Nothing else writes these.
 *
 * Facts in, evidence out. The capture projection (watched material, gaps,
 * health, status) is a fold over this capture's facts; the in-memory instance is
 * just that fold's accumulator, rebuilt from capture_facts on boot.
 *
 * Usage:
 *   const ack = evidence.ingest(parsed);                 // POST /ingest
 *   const view = evidence.captureView(captureId);        // popup + app
 *   const stream = evidence.watchOrder(captureId);        // segmentation input
 *   const bundle = evidence.bundle(chunk.material);       // interpretation input, evidence panel
 */
import type { CaptureId, EvidenceId, SourceId } from "../../shared/ids";
import type {
  AdRecord, CaptureFact, CaptureStatus, CaptureView, Evidence, EvidenceBundle, Frame, Gap,
  Passage, Seq, TranscriptSegment,
} from "../../shared/domain";
import type { Interval, Material } from "../../shared/time";
import type { Db, ModuleSchema } from "../db";
import type { WorkItem } from "../scheduler";
import type { Lookup } from "../providers/memo";
import type { FrameChangeInput } from "../providers/jev-tasks";
import type { MemoKey } from "../../shared/ids";
import type { Verdict } from "../../shared/domain";

export const evidenceSchema: ModuleSchema = { module: "evidence", version: 1, ddl: [/* TODO */] };

/** Newly watched material in WATCH order (not media order): what segmentation windows over. */
export type WatchedPassage = { readonly passage: Passage; readonly firstWatchedAtSeq: Seq; readonly sourceIndex: number };

export type WatchOrder = {
  readonly passages: readonly WatchedPassage[];
  readonly frameCandidates: readonly Frame[]; // watched, visible-tab, in watch order
  readonly status: CaptureStatus;
  readonly stoppedAtSeq: Seq | null;
  readonly watchedSeconds: number;
};

export type EvidenceStore = {
  /**
   * Idempotent on (captureId, clientSeq). Frames: write bytes to disk via
   * temp+rename BEFORE the row commits; a crash leaves an orphan file (swept), never a row without bytes.
   * Returns highest contiguous clientSeq stored. Triggers scheduler.pump().
   */
  ingest(batch: { captureId: CaptureId; facts: readonly CaptureFact[] }): { ackedThroughSeq: number };
  captureView(captureId: CaptureId): CaptureView;
  activeCaptures(): readonly CaptureId[];
  watchOrder(captureId: CaptureId): WatchOrder;
  /** Watched passages + kept/uncertain frames + gaps + ads inside `material`. */
  bundle(material: Material): EvidenceBundle;
  get(ids: readonly EvidenceId[]): ReadonlyMap<EvidenceId, Evidence>;
  frameBytes(id: EvidenceId): Uint8Array | null;
  /** Frame-change judgments still needed (frames with teaching "unjudged"). */
  frameDemand(captureId: CaptureId): readonly WorkItem[];
  /**
   * Called by record.save inside the save transaction: copy cited evidence
   * (passage text+interval, frame file hard-link) into evidence_snapshots.
   * Insert-only and content-addressed (evidence IDs are content hashes), so a
   * snapshot can never diverge from the original and a retried save is a no-op.
   */
  snapshotInTx(ids: readonly EvidenceId[]): void;
  /** User command: delete evidence; citing notes then render "evidence deleted by you" (never a dangling working link). */
  deleteByUser(ids: readonly EvidenceId[]): void;
  /**
   * Daily sweep. Raw capture facts and frame files older than retentionDays (30)
   * are deleted. Snapshots are deleted only when NO note cites them — read live
   * from record's note_evidence table, not from a synced pin list — so cited
   * evidence goes away only after the user deletes the citing note (R16).
   */
  sweepExpired(nowMs: number, retentionDays: number): { framesDeleted: number; factsDeleted: number; snapshotsDeleted: number };
};

export function createEvidence(db: Db, dataDir: string, deps: {
  /** Frame.teaching is derived from this lookup (yes→kept, no→dropped, uncertain/failed→uncertain). */
  lookupFrameChange(input: FrameChangeInput): Lookup<Verdict>;
  runFrameChange(input: FrameChangeInput, signal: AbortSignal): Promise<unknown>;
  frameChangeKey(input: FrameChangeInput): MemoKey;
  onChange(): void;
}): EvidenceStore {
  throw new Error("not implemented");
}

// ───── pure core. Lives in evidence/core.ts in the real tree; importable only by this module and test/ ─────

/**
 * Fold control + span facts into watched material.
 * R1: a span counts only if it lies in an active control period of this capture
 * (double gate: the extension also stops emitting when paused).
 * R2: reads only `span` facts; `ad` facts are a different kind and can't reach here.
 */
export function watchedMaterial(facts: readonly CaptureFact[]): Material {
  throw new Error("not implemented");
}

/**
 * The ONLY constructor of Passage (R1).
 * A segment becomes a passage iff overlapFraction(segment, watched) ≥ minOverlap (0.5);
 * its interval is clipped to watched; `partiallyWatched` when < 1.
 */
export function clipToWatched(
  sourceId: SourceId, transcriptRevId: Passage["transcriptRevId"], origin: Passage["origin"],
  segments: readonly TranscriptSegment[], watched: Material, minOverlap: number,
): Passage[] {
  throw new Error("not implemented");
}

/**
 * Gaps for a source: watched intervals with no transcript (no_transcript /
 * transcript_declined), with tabVisible=false (hidden_tab, frames channel),
 * with no frame sample for > 3 s while visible (frame_stall), channel failures.
 */
export function deriveGaps(facts: readonly CaptureFact[], watched: Material): Gap[] {
  throw new Error("not implemented");
}

export function deriveAds(facts: readonly CaptureFact[]): AdRecord[] {
  throw new Error("not implemented");
}

export type { Interval };
