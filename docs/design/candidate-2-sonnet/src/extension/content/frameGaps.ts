// extension/content/frameGaps.ts -- hidden/minimized tab and stalled decode => log a FRAME GAP, never invent frames (flow A).
// Captions keep flowing while hidden (transcript comes from the panel/track, not from rendering); frames may stall because Chrome
// stops rendering/decoding hidden video and throttles timers.
import type { CaptureEventBody } from "../../shared/domain/capture";
import type { GapId, SourceId } from "../../shared/domain/ids";
import type { MediaMs } from "../../shared/domain/time";
import type { Transition } from "../../shared/core/transition";

export type FrameHealthSample =
  | { readonly tag: "visibility"; readonly visible: boolean }
  /** drawImage threw / video.readyState < 2 / all-black frame */
  | { readonly tag: "frame_attempt"; readonly ok: boolean }
  /** latest trusted media position while a span is open (from spanTracker) */
  | { readonly tag: "playing_at"; readonly media: MediaMs }
  | { readonly tag: "span_closed"; readonly media: MediaMs };

export interface FrameHealthState {
  readonly sourceId: SourceId | null;
  readonly visible: boolean;
  readonly latest: MediaMs | null;
  readonly failedAttempts: number;
  readonly gap: { readonly gapId: GapId; readonly start: MediaMs; readonly reason: "tab_hidden" | "decode_stalled" } | null;
}

/**
 * pseudocode:
 *   visibility(false) while playing -> open gap{reason tab_hidden, start = latest}
 *   visibility(true)                -> close gap at latest -> emit gap{channel:'frames', start, end, reason}
 *   frame_attempt(ok=false) x3 in a row while visible -> open gap decode_stalled; first ok=true closes it
 *   span_closed                     -> close any open gap at that media position (a gap never outlives its span)
 * Gaps are media-time intervals on the SAME clock as spans; the backend intersects them with watched coverage.
 */
export function frameHealthStep(s: FrameHealthState, e: FrameHealthSample, newGapId: () => GapId): Transition<FrameHealthState, CaptureEventBody> {
  throw new Error("not implemented");
}
