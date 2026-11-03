/**
 * Frame candidates by cheap pixel diff (flow B: "Code proposes frame candidates").
 * Jev decides teaching value later, in the backend. This module only decides
 * "something on screen changed and has settled" or "it's been a while".
 *
 * Pixels come from `drawImage(video)` into an OffscreenCanvas. YouTube plays
 * MSE blob media, so the canvas is not tainted. (Probe on Windows Chrome before
 * relying on it; fallback is chrome.tabs.captureVisibleTab from the SW cropped
 * to the video rect, which captures overlays and only works for the visible tab.)
 *
 * Hidden tab: Chrome stops decoding background video, so sampling stops. We do
 * NOT synthesize frames; the backend derives a frame gap from `span.tabVisible=false`.
 */
import type { Emit } from "./capture";

export type FrameSamplerConfig = {
  readonly sampleEveryMediaS: number; // 1.0
  readonly changeThreshold: number; // mean abs gray diff vs LAST KEPT thumb (catches slow handwriting cumulatively)
  readonly settleThreshold: number; // diff vs previous sample below this ⇒ the change has settled
  readonly maxSettleWaitMediaS: number; // 4.0: keep anyway if the board never settles (animation)
  readonly keyframeEveryMediaS: number; // 30.0
  readonly thumb: { w: 64; h: 36 };
  readonly maxLongSide: 1568; // Jev image bounds: 280–1568 px per side, 78,400–2,458,624 px total
  readonly minShortSide: 280;
};

export type FrameSampler = { setObserving(on: boolean): void; dispose(): void };

/**
 * TODO pseudocode (driven by requestVideoFrameCallback, gated on media-time progress):
 *   on frame callback with mediaTime t:
 *     if !observing || isAd() || t - lastSampleT < cfg.sampleEveryMediaS: return
 *     thumb = grayThumb(video)              // 64×36 Uint8Array
 *     dKept = meanAbsDiff(thumb, lastKeptThumb); dPrev = meanAbsDiff(thumb, prevThumb)
 *     if lastKeptThumb == null                         → keep("first")
 *     elif pending && (dPrev < settle || t - pendingT > maxSettleWait) → keep("change_settled")
 *     elif !pending && dKept > change                  → pending = true; pendingT = t
 *     elif t - lastKeptT > keyframeEvery               → keep("keyframe")
 *     prevThumb = thumb; lastSampleT = t
 *   keep(trigger): jpeg = encodeJpeg(video, normalizedSize(video.videoWidth, video.videoHeight), 0.85)
 *     emit({ kind:"frame", videoId, frameId: crypto.randomUUID(), mediaS: t, width, height, trigger, diff: dKept, jpegBase64 })
 *   stall detection: if currentTime advances ≥ 3s with tab visible and no frame callback fired
 *     → emit({ kind:"channel", channel:"frames", health:"stalled", … })
 */
export function createFrameSampler(video: HTMLVideoElement, emit: Emit, videoId: () => string, cfg: FrameSamplerConfig): FrameSampler {
  throw new Error("not implemented");
}

/** Pure: scale so long side ≤ 1568 and short side ≥ 280 (or null if impossible). */
export function normalizedSize(w: number, h: number): { w: number; h: number } | null {
  throw new Error("not implemented");
}

/** Pure: mean absolute difference of two equal-length grayscale buffers, 0..255. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  throw new Error("not implemented");
}
