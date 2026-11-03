/**
 * Boundary windows and chunks (flow B). Owns: chunk_revisions.
 *
 * The chunk plan is a PURE function of (watch-ordered passages, frame
 * candidates, boundary judgments looked up in the memo, stop fact). It is
 * recomputed from scratch on every pump; ~16 windows per 8 minutes, so this
 * is cheap and keeps one source of truth. `sync` appends a ChunkRevision row
 * only when a chunk's derived material differs from its latest revision, with
 * a content-derived ID, so running sync twice (or after a crash) is a no-op.
 *
 * Usage:
 *   const { closed, demand } = segmentation.sync(captureId);   // in scheduler.pump
 *   for (const w of demand) await memo.run(boundaryTask, w);
 *   segmentation.current(captureId)                              // latest revision per chunk
 */
import type { CaptureId, ChunkId, WindowId } from "../../shared/ids";
import type {
  BoundaryJudgment, BoundaryWindow, ChunkProvenance, ChunkRevision, Route, Seq, Verdict,
} from "../../shared/domain";
import type { Material } from "../../shared/time";
import type { WatchOrder } from "../evidence";
import type { BoundaryInput } from "../providers/jev-tasks";
import type { Lookup } from "../providers/memo";
import type { Db, ModuleSchema } from "../db";

export const segmentationSchema: ModuleSchema = { module: "segmentation", version: 1, ddl: [/* chunk_revisions */] };

/** Starting values (flow B: tune on held-out clips). */
export type SegmentationConfig = {
  readonly windowNewS: 30;
  readonly contextS: 120;
  readonly timeCapS: 480;
  readonly maxFramesPerWindow: 2;
};

export type Segmentation = {
  /**
   * Derive the plan, append changed chunk revisions, return:
   *  - closed: revisions newly appended this call (invites + preparation react to these)
   *  - demand: windows needing a Jev judgment (memo missing), in watch order
   */
  sync(captureId: CaptureId): { closed: readonly ChunkRevision[]; demand: readonly BoundaryInput[] };
  current(captureId: CaptureId): readonly ChunkRevision[];
  revision(id: ChunkRevision["id"]): ChunkRevision | null;
  /** All revisions of a chunk, oldest first (correction disclosure needs the diff). */
  history(chunkId: ChunkId): readonly ChunkRevision[];
  /** Inspectability: window inputs, judgments, route per window (PRD acceptance 2). */
  trace(captureId: CaptureId): readonly WindowTrace[];
};

export type WindowTrace = { readonly window: BoundaryWindow; readonly judgment: BoundaryJudgment | "pending"; readonly route: Route | null; readonly note: string };

export function createSegmentation(db: Db, deps: {
  watchOrder(captureId: CaptureId): WatchOrder;
  lookupBoundary(input: BoundaryInput): Lookup<BoundaryJudgment>;
  boundaryInput(w: BoundaryWindow): BoundaryInput;
  nextSeq(): Seq;
}, cfg: SegmentationConfig): Segmentation {
  throw new Error("not implemented");
}

// ─────────────── pure core (segmentation/core.ts in the real tree) ──────────

/** Flow B table. The ONLY place the four rows exist. */
export function route(newConcept: Verdict, stoppingPoint: Verdict): Route {
  if (newConcept === "yes" && stoppingPoint === "yes") return "close";
  if (newConcept === "no" && stoppingPoint === "yes") return "soft_pause";
  if (newConcept === "yes" && stoppingPoint === "no") return "flag_recheck";
  return "continue"; // no/no, and every uncertain combination (flow B: "error/uncertain → continue")
}

/**
 * Cut watch-ordered passages into windows of ~30 s NEW material.
 * Context = the preceding ≤120 s of watched passages in watch order (may cross
 * sources: "Video ends → do NOT close; the next clip's first window decides").
 * Frames = ≤2 frame candidates inside the window's new material, latest first.
 * A trailing partial window is emitted only once capture is stopped.
 * Window ID = stableId("win", newPassageIds, contextPassageIds, frameIds) — no captureId,
 * so identical material in another session is the same window (rewatch reuse).
 */
export function buildWindows(order: WatchOrder, cfg: SegmentationConfig): BoundaryWindow[] {
  throw new Error("not implemented");
}

export type PlannedChunk = {
  readonly ordinal: number;
  readonly windows: readonly WindowId[];
  readonly material: Material;
  readonly provenance: ChunkProvenance;
};
export type ChunkPlan = { readonly closed: readonly PlannedChunk[]; readonly open: PlannedChunk | null; readonly blockedOn: WindowId | null };

/**
 * The fold. Processes windows in watch order and stops at the first window
 * whose judgment is "inflight"/"missing" (blockedOn). A "failed" lookup is
 * treated as uncertain/uncertain.
 *
 * TODO pseudocode:
 *   chunks = []; open = { windows: [], softPauseAfter: null, flaggedAt: null, newS: 0 }
 *   lastClose = null   // { chunkIdx, reconsidered: bool }
 *   for w in windows:
 *     j = judgment(w) ?? break(blockedOn = w)
 *     r = route(j.newConcept, j.stoppingPoint)
 *
 *     // Boundary revision (flow D "later evidence revises a boundary"; TLA ALaterWindowMovesABoundary):
 *     // the FIRST window after a boundary close says "continues, unfinished" (no/no)
 *     // ⇒ the previous explanation wasn't done: move that boundary forward by this window,
 *     // at most once per boundary (no oscillation). Provenance "boundary_revised".
 *     if lastClose && !lastClose.reconsidered && open.windows.length == 0 && j is (no, no):
 *         chunks[lastClose.chunkIdx].windows.push(w); provenance = "boundary_revised"
 *         lastClose.reconsidered = true; continue
 *     lastClose?.reconsidered = true
 *
 *     if r == "close" && open.windows nonempty:
 *         // flagged earlier (yes/no) ⇒ the new concept started at the flagged window: cut before it
 *         cutAt = open.flaggedAt ?? open.windows.length
 *         closeChunk(open.windows[0:cutAt], "boundary"); open = rest + [w]; lastClose = {…}
 *     elif r == "flag_recheck": open.flaggedAt ??= open.windows.length; open.push(w)
 *     elif r == "soft_pause":   open.push(w); open.softPauseAfter = open.windows.length
 *     else:                     open.push(w); if r == "continue" && j.newConcept == "no": open.flaggedAt = null
 *
 *     if watchedSeconds(open) >= timeCapS:
 *         cut = open.softPauseAfter ?? open.windows.length     // preferred time-fallback cut point
 *         closeChunk(open.windows[0:cut], "time"); open = rest; lastClose = null (time closes aren't reconsidered)
 *   if stopped && blockedOn == null && open nonempty: closeChunk(open, "session_end")
 */
export function planChunks(
  windows: readonly BoundaryWindow[],
  judgment: (w: BoundaryWindow) => BoundaryJudgment | "pending",
  stopped: boolean,
  cfg: SegmentationConfig,
): ChunkPlan {
  throw new Error("not implemented");
}

/**
 * Compare plan to stored revisions; return rows to append.
 * New revision iff no revision for that ordinal, or Material differs. Never deletes.
 * The previous revision is marked superseded by ID reference only (no UPDATE).
 */
export function reconcile(
  captureId: CaptureId, plan: ChunkPlan, stored: readonly ChunkRevision[], seq: () => Seq,
): ChunkRevision[] {
  throw new Error("not implemented");
}
