// extension/content/player.ts -- DOM glue: finds the page's <video> and #movie_player, normalizes events into PlaybackSample.
// Kept free of policy: every decision lives in spanTracker/adGuard/frameGaps. YouTube is a SPA: the video element is reused across
// videos, so this re-binds on `yt-navigate-finish`, and reads videoId from location (v=), title from the page, duration from the element
// once `loadedmetadata` fires (duration for SourceDescriptor; contentLikely compares against it).
import type { SourceDescriptor } from "../../shared/domain/capture";
import type { PlaybackSample } from "./spanTracker";

export interface PlayerHandle {
  /** current source, or null off /watch pages */
  source(): SourceDescriptor | null;
  video(): HTMLVideoElement | null;
  dispose(): void;
}
export function bindPlayer(doc: Document, onSample: (s: PlaybackSample) => void, onSource: (s: SourceDescriptor | null) => void): PlayerHandle {
  throw new Error("not implemented");
}
