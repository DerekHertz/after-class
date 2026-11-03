// store/timeline.ts -- owner: boundary workstream. Sole writer of: open_chunk, chunk_revisions,
// invite_log, judgments (Jev answers cache + audit).
//
//   open_chunk(capture_id PK, json, judged_through, version)               -- the one mutable row; single writer (boundary stage, serialized per capture)
//   chunk_revisions(chunk_id, revision, content_key, ...json..., PRIMARY KEY (chunk_id, revision))   -- immutable
//   invite_log(capture_id, n, entry_json)                                  -- append-only, two writers append, state is folded on read
//   judgments(id PK, kind, input_hash, stamp_json, answer_json, created_at) UNIQUE(kind, input_hash, stamp)   -- cache + inspection
import type { CaptureId, ChunkId, ContentKey, JudgmentId } from "../../shared/domain/ids";
import type { ChunkRevision, ChunkTimeline, WindowSpec } from "../../shared/domain/chunk";
import type { BoundaryJudgment, ClaimCheckJudgment, FrameChangeJudgment, JudgmentStamp } from "../../shared/domain/judgment";
import type { InviteEntry } from "../../shared/core/invite";
import type { EnqueueSpec } from "./jobs";
import type { Db } from "./db";

export interface TimelineCommit {
  readonly next: ChunkTimeline;
  /** optimistic check: refuse if the stored judged_through != this (a second boundary runner would be a bug) */
  readonly expectedJudgedThrough: number;
  readonly judgment: BoundaryJudgment;
  readonly closes: readonly ChunkRevision[];
  readonly invite: readonly InviteEntry[];
  /** interpretation jobs for each close whose ContentKey has no prepared claims yet (cache miss) */
  readonly enqueue: readonly EnqueueSpec[];
}

export interface TimelineRepo {
  load(captureId: CaptureId): ChunkTimeline;
  /**
   * ONE transaction: judgment + timeline + chunk revisions + invite entries + job enqueue (INSERT OR IGNORE).
   * Crash anywhere => none of it happened and the window is simply re-cut and re-judged (cache makes that free).
   */
  commit(c: TimelineCommit): void;

  currentRevision(chunkId: ChunkId): ChunkRevision | null;
  revisions(captureId: CaptureId): readonly ChunkRevision[];
  /** boundary revision: appends revision n+1 (bounded to 1 revision) and returns it, or null if already revised */
  reviseBoundary(rev: ChunkRevision): ChunkRevision | null;

  inviteLog(captureId: CaptureId): readonly InviteEntry[];
  appendInvite(captureId: CaptureId, e: InviteEntry): void;

  cachedBoundary(w: WindowSpec, stamp: JudgmentStamp): BoundaryJudgment | null;
  cachedFrameChange(inputHash: string, stamp: JudgmentStamp): FrameChangeJudgment | null;
  saveFrameChange(j: FrameChangeJudgment, inputHash: string): void;
  judgment(id: JudgmentId): BoundaryJudgment | FrameChangeJudgment | ClaimCheckJudgment | null;
  byContentKey(k: ContentKey): ChunkRevision | null;
}

export function createTimelineRepo(db: Db): TimelineRepo {
  throw new Error("not implemented");
}
