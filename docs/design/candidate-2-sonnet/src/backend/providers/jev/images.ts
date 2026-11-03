// providers/jev/images.ts -- pre-flight for Jev's image limits (docs/research/jev-api.md). Jev REJECTS out-of-bounds images
// and one bad image fails the whole request, and Bun has no image resizer: so the extension downsizes at capture time and
// this file decides eligibility instead of letting a request fail.
//   PNG/JPEG only; 280..1568 px per side; 78_400..2_458_624 total px; <= 16 MiB each; <= 32 MiB per request.
import type { FrameImage } from "../ports";

export interface Eligibility { readonly ok: boolean; readonly why?: "format" | "side_bounds" | "total_pixels" | "bytes" }
export function jevImageEligible(width: number, height: number, byteLength: number, mime: string): Eligibility {
  throw new Error("not implemented");
}

/**
 * Per-request packing: drop ineligible frames (judge proceeds on text + remaining frames; the omission is logged on the judgment),
 * and keep total base64 under 32 MiB (each reference of an image is another copy, so budget by uses x size).
 */
export function packFrames(frames: readonly FrameImage[], usesPerFrame: number): { readonly sendable: readonly FrameImage[]; readonly omitted: readonly { readonly id: string; readonly why: string }[] } {
  throw new Error("not implemented");
}
