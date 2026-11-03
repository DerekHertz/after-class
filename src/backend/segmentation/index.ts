/**
 * Boundary windows and chunks, flow B (W4). Owns: chunk_revisions.
 *
 * The chunk plan is a pure function (core.ts) of watch-ordered passages, frame
 * candidates, boundary judgments looked up in the memo, and the stop fact. It
 * is recomputed on every pump (~16 windows per 8 minutes). `sync` appends a
 * ChunkRevision only when a chunk's derived material differs from its latest
 * revision, under a content-derived ID, so running sync twice is a no-op.
 *
 *   const { closed, demand } = segmentation.sync(captureId);   // in scheduler.pump
 *   segmentation.current(captureId)                              // latest revision per chunk
 */
import type { CaptureId, ChunkId } from "../../shared/ids";
import type { BoundaryJudgment, BoundaryWindow, ChunkRevision, Route, Seq } from "../../shared/domain";
import type { WatchOrder } from "../evidence";
import type { BoundaryInput } from "../providers/jev-tasks";
import type { Lookup } from "../providers/memo";
import type { Db } from "../db";

/** Starting values (flow B: tune on held-out clips). */
export type SegmentationConfig = {
  readonly windowNewS: number; // 30
  readonly contextS: number; // 120
  readonly timeCapS: number; // 480
  readonly maxFramesPerWindow: number; // 2
};

export const SEGMENTATION_DEFAULTS: SegmentationConfig = { windowNewS: 30, contextS: 120, timeCapS: 480, maxFramesPerWindow: 2 };

export type WindowTrace = { readonly window: BoundaryWindow; readonly judgment: BoundaryJudgment | "pending" | "failed"; readonly route: Route | null; readonly note: string };

export type Segmentation = {
  /**
   * Derive the plan, append changed chunk revisions, return:
   *  - closed: revisions newly appended this call (invites and preparation react to these)
   *  - demand: windows needing a Jev judgment (memo missing), in watch order
   */
  sync(captureId: CaptureId): { readonly closed: readonly ChunkRevision[]; readonly demand: readonly BoundaryInput[] };
  current(captureId: CaptureId): readonly ChunkRevision[];
  revision(id: ChunkRevision["id"]): ChunkRevision | null;
  /** All revisions of a chunk, oldest first (correction disclosure needs the diff). */
  history(chunkId: ChunkId): readonly ChunkRevision[];
  /** Inspectability: window inputs, judgments, route per window (PRD acceptance 2). */
  trace(captureId: CaptureId): readonly WindowTrace[];
};

export function createSegmentation(db: Db, deps: {
  watchOrder(captureId: CaptureId): WatchOrder;
  lookupBoundary(input: BoundaryInput): Lookup<BoundaryJudgment>;
  boundaryInput(w: BoundaryWindow): BoundaryInput;
  nextSeq(): Seq;
}, cfg: SegmentationConfig): Segmentation {
  throw new Error("not implemented");
}
