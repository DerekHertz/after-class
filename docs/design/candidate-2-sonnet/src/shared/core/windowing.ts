// core/windowing.ts -- cut judgment windows out of watched evidence (flow B, first two lines).
//
// Windows are cut over VIEWING ORDER (evidence.viewSeq), not media time, because a chunk
// may span several videos and rewatch must not generate new windows:
//   - rewatching an interval creates no new evidence (EvidenceId is natural => materialize is a no-op)
//     => no new window => the cached judgment stands ("already-judged windows reuse cached judgment").
//   - a seek-forward leaves a hole; `gapsBefore` marks it so Jev is never told two distant
//     passages were adjacent.
import type { TranscriptEvidence, FrameEvidence } from "../domain/evidence";
import type { WindowSpec } from "../domain/chunk";
import type { CaptureId } from "../domain/ids";

export interface WindowPolicy {
  readonly stepMs: number;     // ~30_000 newly watched caption time that triggers a window
  readonly contextMs: number;  // ~120_000 preceding context
  readonly maxFrames: number;  // frames attached when visual-dependent
}
export const DEFAULT_WINDOW_POLICY: WindowPolicy = { stepMs: 30_000, contextMs: 120_000, maxFrames: 3 };

/**
 * Pure: given everything watched in viewing order and the cursor, return the next window or null.
 *
 * pseudocode:
 *   fresh   = transcript.filter(e => e.viewSeq > judgedThrough)
 *   if watchedMs(fresh) < policy.stepMs and !flush: return null          // flush = session stop / source end
 *   passage = fresh                                                       // everything new since the cursor
 *   context = take transcript before passage[0], walking backwards until contextMs of watched time
 *   frames  = needsFrames(passage, keptFrames, policy) ? nearest keptFrames in [context.start, passage.end] : []
 *   windowId = natural hash(captureId, passage ids, context ids)         // same inputs => same id => cache hit
 */
export function nextWindow(
  captureId: CaptureId,
  transcript: readonly TranscriptEvidence[],
  keptFrames: readonly FrameEvidence[],
  judgedThrough: number,
  policy: WindowPolicy,
  flush: boolean,
): WindowSpec | null {
  throw new Error("not implemented");
}

/**
 * "(+ frames if visual-dependent)". Code heuristic (proposal; tune on held-out clips):
 *   true if any KEPT frame was captured inside the passage's media span, OR the passage text
 *   contains deixis cues ("this", "here", "as you can see", "on the board") with no kept frame
 *   yet (then also flags the window `visualAmbiguous` for the evaluation log).
 */
export function needsFrames(passage: readonly TranscriptEvidence[], keptFrames: readonly FrameEvidence[]): boolean {
  throw new Error("not implemented");
}
