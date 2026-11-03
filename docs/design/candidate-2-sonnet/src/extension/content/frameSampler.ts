// extension/content/frameSampler.ts -- cheap pixel-diff candidate selection (flow B: "Code proposes frame candidates by cheap pixel diff").
// Jev later decides whether a candidate is teaching content; this only decides what is worth SENDING. Over-sending is cheap, losing a
// step is not: thresholds err toward sending. Pure; the DOM part (captureThumb/encodeFrame) is separate.
import type { MediaMs } from "../../shared/domain/time";

export const THUMB_W = 64, THUMB_H = 36; // grayscale thumbnail, 2304 bytes

export interface SamplerPolicy {
  /** ~1000 media ms while playing */
  readonly sampleEveryMs: number;
  /** min tile-change fraction vs last SENT frame to be a candidate (~0.015) */
  readonly changeFloor: number;
  /** change vs previous sample under this => the picture has stopped changing (~0.004) */
  readonly settledBelow: number;
  /** consecutive settled samples required (~2): avoids sending half-drawn equations */
  readonly settledSamples: number;
  /** continuous change this long => send anyway (continuous handwriting) (~10_000) */
  readonly maxWaitMs: number;
  /** nothing sent this long => send one (periodic capture) (~90_000) */
  readonly floorEveryMs: number;
}

export interface SamplerState {
  readonly lastSent: Uint8Array | null;
  readonly prev: Uint8Array | null;
  readonly settledRun: number;
  readonly changingSince: MediaMs | null;
  readonly lastSentAt: MediaMs | null;
}

export type SamplerDecision =
  | { readonly send: false; readonly state: SamplerState }
  | { readonly send: true; readonly diff: number; readonly state: SamplerState };

/** fraction in [0,1] of 8x8-px tiles whose mean abs difference exceeds a tile threshold; robust to compression noise and cursor motion (one tile) */
export function diffScore(a: Uint8Array, b: Uint8Array): number {
  throw new Error("not implemented");
}

/**
 * pseudocode:
 *   d_sent = lastSent ? diffScore(thumb, lastSent) : 1;  d_prev = prev ? diffScore(thumb, prev) : 1
 *   settledRun = d_prev < settledBelow ? run + 1 : 0;     changingSince = d_prev >= settledBelow ? (changingSince ?? at) : null
 *   candidate  = d_sent >= changeFloor && (settledRun >= settledSamples || at - changingSince >= maxWaitMs)
 *   floor      = lastSentAt != null && at - lastSentAt >= floorEveryMs
 *   first      = lastSent == null
 *   send if first || candidate || floor; on send: lastSent = thumb, lastSentAt = at
 */
export function samplerStep(s: SamplerState, thumb: Uint8Array, at: MediaMs, p: SamplerPolicy): SamplerDecision {
  throw new Error("not implemented");
}

/** DOM: draw video to a THUMB_W x THUMB_H canvas, convert to luma. Throws on tainted/blocked canvas => frame_attempt{ok:false}. */
export function captureThumb(video: HTMLVideoElement): Uint8Array {
  throw new Error("not implemented");
}

/**
 * DOM: draw at native size scaled so the longest side <= 1280 (Jev bounds: 280..1568 per side, <= 2_458_624 px), JPEG q~0.85.
 * Returns bytes + sha256 hex (crypto.subtle). Frames are content-addressed: re-sending the same frame is a no-op on the backend.
 */
export async function encodeFrame(video: HTMLVideoElement): Promise<{ readonly sha: string; readonly bytes: Uint8Array; readonly width: number; readonly height: number }> {
  throw new Error("not implemented");
}
