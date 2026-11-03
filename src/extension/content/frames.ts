/**
 * Frame candidates by cheap pixel diff (W1; flow B: "Code proposes frame candidates by cheap pixel diff").
 * Jev decides teaching value later, in the backend. This module only decides
 * "something on screen changed and has settled" or "it's been a while".
 *
 * Pixels come from `drawImage(video)` into an OffscreenCanvas. YouTube plays
 * MSE blob media, so the canvas should not be tainted (probe on Windows Chrome
 * first; fallback is chrome.tabs.captureVisibleTab from the SW, cropped).
 *
 * Hidden tab: Chrome stops decoding background video, so sampling stops. We do
 * NOT synthesize frames; the backend derives a frame gap from span.tabVisible=false.
 */
import { FRAME_BOUNDS } from "../../shared/domain";
import type { Emit } from "./capture";

export type FrameSamplerConfig = {
  readonly sampleEveryMediaS: number; // 1.0
  readonly changeThreshold: number; // mean abs gray diff vs LAST KEPT thumb (catches slow handwriting cumulatively)
  readonly settleThreshold: number; // diff vs previous sample below this ⇒ the change has settled
  readonly maxSettleWaitMediaS: number; // 4.0: keep anyway if the board never settles (animation)
  readonly keyframeEveryMediaS: number; // 30.0
  readonly thumb: { readonly w: number; readonly h: number }; // 64 × 36
  readonly jpegQuality: number; // 0.85; PNG is a one-line switch if equations soften
};

export type FrameSampler = { setObserving(on: boolean): void; dispose(): void };

/**
 * TODO pseudocode (requestVideoFrameCallback, gated on media-time progress):
 *   on frame callback with mediaTime t:
 *     if !observing || ad showing || t - lastSampleT < cfg.sampleEveryMediaS: return
 *     thumb = grayThumb(video)              // 64×36 Uint8Array
 *     dKept = meanAbsDiff(thumb, lastKeptThumb); dPrev = meanAbsDiff(thumb, prevThumb)
 *     if lastKeptThumb == null                         → keep("first")
 *     elif pending && (dPrev < settle || t - pendingT > maxSettleWait) → keep("change_settled")
 *     elif !pending && dKept > change                  → pending = true; pendingT = t
 *     elif t - lastKeptT > keyframeEvery               → keep("keyframe")
 *     prevThumb = thumb; lastSampleT = t
 *   keep(trigger): size = normalizedSize(video.videoWidth, video.videoHeight); if null → channel "failed"
 *     emit({ kind: "frame", videoId, frameId: crypto.randomUUID(), mediaS: t, width, height, trigger, diff: dKept, jpegBase64 })
 *   stall: currentTime advances ≥ 3 s with the tab visible and no frame callback
 *     → emit({ kind: "channel", channel: "frames", health: "stalled", … })
 */
export function createFrameSampler(video: HTMLVideoElement, emit: Emit, videoId: () => string, cfg: FrameSamplerConfig): FrameSampler {
  throw new Error("not implemented");
}

/**
 * Pure: scale so the long side ≤ FRAME_BOUNDS.maxLongSide (1280) and the short
 * side ≥ FRAME_BOUNDS.minShortSide (280), or null if the aspect ratio makes both impossible.
 */
export function normalizedSize(w: number, h: number): { readonly w: number; readonly h: number } | null {
  void FRAME_BOUNDS;
  throw new Error("not implemented");
}

/** Pure: mean absolute difference of two equal-length grayscale buffers, 0..255. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  throw new Error("not implemented");
}
