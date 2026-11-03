/**
 * Evidence store (W3). Owns: capture_facts, frames (bytes on disk at
 * <dataDir>/frames/<sourceId>/<frameId>.jpg), evidence_snapshots, evidence_deletions.
 *
 * Facts in, evidence out. The capture projection (watched material, gaps,
 * health, status) is a fold over this capture's facts (core.ts), rebuilt from
 * capture_facts on boot.
 *
 *   const ack = evidence.ingest(parsed);                 // POST /ingest
 *   const view = evidence.captureView(captureId);        // popup + app
 *   const order = evidence.watchOrder(captureId);         // segmentation input
 *   const bundle = evidence.bundle(chunk.material);       // interpretation input, evidence panel
 */
import type { CaptureId, EvidenceId, MemoKey } from "../../shared/ids";
import type {
  CaptureFact, CaptureStatus, CaptureView, DeletedEvidence, Evidence, EvidenceBundle, Frame, Passage, Seq, Verdict,
} from "../../shared/domain";
import type { Material } from "../../shared/time";
import type { Db } from "../db";
import type { WorkItem } from "../scheduler";
import type { Lookup } from "../providers/memo";
import type { FrameChangeInput } from "../providers/jev-tasks";

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
   * Idempotent on (captureId, clientSeq). Frame bytes go to disk via
   * temp+rename BEFORE the row commits; a crash leaves an orphan file (swept),
   * never a row without bytes. Returns the highest contiguous clientSeq stored.
   */
  ingest(batch: { readonly captureId: CaptureId; readonly facts: readonly CaptureFact[] }): { readonly ackedThroughSeq: number };
  captureView(captureId: CaptureId): CaptureView;
  activeCaptures(): readonly CaptureId[];
  watchOrder(captureId: CaptureId): WatchOrder;
  /** Watched passages + kept/uncertain frames + gaps + ads inside `material`. User-deleted evidence is left out. */
  bundle(material: Material): EvidenceBundle;
  get(ids: readonly EvidenceId[]): ReadonlyMap<EvidenceId, Evidence | DeletedEvidence>;
  frameBytes(id: EvidenceId): Uint8Array | null;
  /** Frame-change judgments still needed (frames with teaching "unjudged"). */
  frameDemand(captureId: CaptureId): readonly WorkItem[];
  /**
   * Called by record.save inside the save transaction: copy cited evidence
   * (passage text + interval, frame file hard-link) into evidence_snapshots.
   * Insert-only and content-addressed, so a retried save is a no-op.
   */
  snapshotInTx(ids: readonly EvidenceId[]): void;
  /**
   * User command. One tx: tombstone in evidence_deletions, then delete the
   * snapshot and frame rows, then unlink files. Citing notes then show
   * "evidence deleted by you". The tombstone is what lets the R16 triggers pass.
   */
  deleteByUser(ids: readonly EvidenceId[], requestId: string): void;
  /**
   * R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry."
   * Daily sweep: raw capture facts and frame files older than retentionDays (30).
   * The SQL says NOT EXISTS for live citations and for unsaved reviews of the
   * capture (pending saves count as citing); the db.ts triggers abort the
   * delete if this SQL is ever wrong. No route exposes it.
   */
  sweepExpired(nowMs: number, retentionDays: number): { readonly framesDeleted: number; readonly factsDeleted: number; readonly snapshotsDeleted: number };
};

export function createEvidence(db: Db, dataDir: string, deps: {
  /** Frame.teaching derives from this lookup: yes→kept, no→dropped, uncertain/failed→uncertain (kept). */
  lookupFrameChange(input: FrameChangeInput): Lookup<Verdict>;
  runFrameChange(input: FrameChangeInput, signal: AbortSignal): Promise<unknown>;
  frameChangeKey(input: FrameChangeInput): MemoKey;
  onChange(): void;
}): EvidenceStore {
  throw new Error("not implemented");
}
