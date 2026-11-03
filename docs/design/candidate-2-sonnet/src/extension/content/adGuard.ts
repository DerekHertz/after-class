// extension/content/adGuard.ts -- is an ad playing? Two independent signals; EITHER means "ad" (fail closed: R2 beats completeness).
//   1. DOM: #movie_player has class `ad-showing` (and/or `.ytp-ad-player-overlay`, ad badge present)
//   2. Media: video.duration differs from the content source's duration by more than 1.5 s (an ad swaps the stream; the <video>
//      element is reused and currentTime then counts AD time, which must never be mistaken for content time).
// Why both: the class flips a tick late on some transitions; the duration check catches that tick.
export interface AdSignals {
  readonly domAdShowing: boolean;
  readonly videoDurationMs: number;
  readonly sourceDurationMs: number | null;
}

export function isAdShowing(s: AdSignals): boolean {
  throw new Error("not implemented");
}

/** reads the DOM; the only DOM-touching function here (kept apart so isAdShowing stays pure and testable) */
export function readAdSignals(player: Element | null, video: HTMLVideoElement | null, sourceDurationMs: number | null): AdSignals {
  throw new Error("not implemented");
}
