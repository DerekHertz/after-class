/**
 * Pure segmentation (W4). Importable only by segmentation/ and test/.
 */
import type { CaptureId, WindowId } from "../../shared/ids";
import type { BoundaryJudgment, BoundaryWindow, ChunkProvenance, ChunkRevision, Route, Seq, Verdict } from "../../shared/domain";
import type { Material } from "../../shared/time";
import type { WatchOrder } from "../evidence";
import type { SegmentationConfig } from ".";

/** Flow B table. The ONLY place the four rows exist. */
export function route(newConcept: Verdict, stoppingPoint: Verdict): Route {
  if (newConcept === "yes" && stoppingPoint === "yes") return "close";
  if (newConcept === "no" && stoppingPoint === "yes") return "soft_pause";
  if (newConcept === "yes" && stoppingPoint === "no") return "flag_recheck";
  return "continue"; // no/no, and every uncertain combination (flow B: "Jev error/uncertain → treat as \"continue\"")
}

/**
 * Cut watch-ordered passages into windows of ~30 s NEW material.
 * Context = the preceding ≤120 s of watched passages in watch order (may cross
 * sources: "Video ends → do NOT close; the next clip's first window decides").
 * Frames = ≤2 frame candidates inside the window's new material, latest first.
 * A trailing partial window is emitted only once capture is stopped.
 * Window ID = stableId("win", newPassageIds, contextPassageIds, frameIds), no
 * captureId, so identical material in another session reuses the judgment.
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
 * whose judgment is "pending" (blockedOn). A "failed" lookup is uncertain/uncertain.
 *
 * TODO pseudocode:
 *   chunks = []; open = { windows: [], softPauseAfter: null, flaggedAt: null, newS: 0 }
 *   lastClose = null   // { chunkIdx, reconsidered: bool }
 *   for w in windows:
 *     j = judgment(w); if j == "pending": blockedOn = w; break
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
 *         cutAt = open.flaggedAt ?? open.windows.length    // flagged earlier (yes/no): the new concept began there
 *         closeChunk(open.windows[0:cutAt], "boundary"); open = rest + [w]; lastClose = {…}
 *     elif r == "flag_recheck": open.flaggedAt ??= open.windows.length; open.push(w)
 *     elif r == "soft_pause":   open.push(w); open.softPauseAfter = open.windows.length
 *     else:                     open.push(w); if j.newConcept == "no": open.flaggedAt = null
 *
 *     if watchedSeconds(open) >= timeCapS:
 *         cut = open.softPauseAfter ?? open.windows.length     // preferred time-fallback cut point
 *         closeChunk(open.windows[0:cut], "time"); open = rest; lastClose = null
 *   if stopped && blockedOn == null && open nonempty: closeChunk(open, "session_end")
 */
export function planChunks(
  windows: readonly BoundaryWindow[],
  judgment: (w: BoundaryWindow) => BoundaryJudgment | "pending" | "failed",
  stopped: boolean,
  cfg: SegmentationConfig,
): ChunkPlan {
  throw new Error("not implemented");
}

/**
 * Compare plan to stored revisions; return rows to append.
 * New revision iff no revision for that ordinal, or Material differs. Never
 * deletes or updates (chunk_revisions rejects UPDATE); the new row names the
 * revision it supersedes.
 */
export function reconcile(captureId: CaptureId, plan: ChunkPlan, stored: readonly ChunkRevision[], seq: () => Seq): ChunkRevision[] {
  throw new Error("not implemented");
}
