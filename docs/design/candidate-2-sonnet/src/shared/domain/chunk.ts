// domain/chunk.ts -- chunk lifecycle types.
//
// A chunk SLOT (ChunkId) is a position in the capture's viewing order. Closing it, or
// moving its boundary later, produces an immutable ChunkRevision with a ContentKey =
// hash(evidence ids, text hashes, processing version). Everything downstream (claims,
// jobs, review scope) hangs off the ContentKey, not off the slot. Consequences:
//   * "outdated job" (R8) is derived: job.contentKey != slot's current ContentKey.
//   * cache reuse on rewatch is automatic: same content => same key => claims already there.
//   * nothing is ever mutated in place; a boundary correction adds a revision.
import { z } from "zod";
import { CaptureId, ChunkId, ContentKey, EvidenceId, SourceId, WindowId } from "./ids";
import { Interval } from "./time";

export const CloseProvenance = z.enum(["boundary", "time", "session_end", "boundary_revised"]);
export type CloseProvenance = z.infer<typeof CloseProvenance>;

export interface ChunkPiece {
  readonly sourceId: SourceId;
  readonly interval: Interval;
}

export interface ChunkRevision {
  readonly chunkId: ChunkId;
  readonly captureId: CaptureId;
  readonly revision: number; // 1-based; > 1 only after a boundary revision
  readonly contentKey: ContentKey;
  /** viewing order; a chunk may span several videos (flow B: video end never closes a chunk) */
  readonly pieces: readonly ChunkPiece[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly provenance: CloseProvenance;
  readonly closedAtWall: number;
  /** viewSeq range covered, [from, to] inclusive */
  readonly viewSeqRange: readonly [number, number];
}

/**
 * The open chunk. Owned by the boundary stage and by nobody else (single writer,
 * serialized per capture). Persisted as one JSON row with a version for crash recovery.
 */
export interface OpenChunk {
  readonly chunkId: ChunkId;
  readonly firstViewSeq: number;
  readonly lastViewSeq: number;
  /** watched media ms accumulated; drives the ~8 min time cap */
  readonly watchedMs: number;
  /**
   * (no, yes) windows: "soft pause inside topic" -- preferred cut if the time cap hits.
   * Stored as the viewSeq AFTER which a cut is allowed.
   */
  readonly softPauses: readonly number[];
  /**
   * (yes, no) window: the new concept began at this viewSeq but the old explanation
   * was unfinished. Don't close; if the NEXT window says stopping=yes, cut HERE
   * (where the new concept began), not at the window end. Dropped on a later (no, no).
   */
  readonly pendingBoundary: number | null;
  /**
   * One entry per judged window, in order. Lets a time-cap cut at an earlier soft pause
   * recompute how much watched time carries over into the next open chunk.
   */
  readonly ledger: readonly {
    readonly windowId: WindowId;
    readonly startViewSeq: number;
    readonly endViewSeq: number;
    readonly watchedMs: number;
  }[];
}

/** Everything the boundary stage knows about one capture. */
export interface ChunkTimeline {
  readonly captureId: CaptureId;
  readonly open: OpenChunk | null;
  readonly nextOrdinal: number;
  /** viewSeq up to which windows have been judged; the window scheduler resumes from here. */
  readonly judgedThrough: number;
}

/** The 2x2 table of flow B, plus the coercion of 'uncertain'. Exhaustive by type. */
export type BoundaryRow =
  | "close_at_boundary"   // yes, yes
  | "soft_pause"          // no,  yes
  | "flag_recheck"        // yes, no
  | "continue";           // no,  no   (and any uncertain/error)

export interface WindowSpec {
  readonly windowId: WindowId;
  readonly captureId: CaptureId;
  /** <= ~2 min of preceding watched evidence in viewing order */
  readonly context: readonly EvidenceId[];
  /** >= ~30 s of newly watched evidence */
  readonly passage: readonly EvidenceId[];
  /** included only when the policy says meaning depends on visuals */
  readonly frames: readonly EvidenceId[];
  /** media discontinuities inside context+passage (seek-forward skips), so Jev is not told two distant passages are adjacent */
  readonly gapsBefore: readonly number[]; // indices into the concatenated passage list
  readonly watchedMsInPassage: number;
}

export const InviteReason = z.enum(["boundary", "time_cap_15min"]);
export type InviteReason = z.infer<typeof InviteReason>;
