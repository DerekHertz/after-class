/**
 * Content script entry (isolated world, every youtube.com page; YouTube is an SPA).
 *
 * The content script is an OBSERVER. It owns no capture state: the service
 * worker owns control (start/pause/stop) and sequencing, and tells us whether
 * to observe. We emit unsequenced fact bodies over one long-lived port.
 *
 *   SW ──{observe: true|false, captureId}──▶ content
 *   content ──{fact body}──▶ SW (stamps clientSeq, persists, uploads)
 *
 * Usage (this file's own wiring):
 *   const port = chrome.runtime.connect({ name: "capture" });
 *   const tracker = createPlaybackTracker(findVideo(), findPlayer(), (f) => port.postMessage(f));
 *   watchNavigation({ onWatchPage: …, onLeftWatchPage: () => port.postMessage({ type: "left_watch_page" }) });
 */
import type { CaptureFactBody } from "../../shared/domain";

export type Emit = (fact: CaptureFactBody) => void;

/** Messages SW → content. */
export type ControlMessage = { type: "observe"; on: boolean } | { type: "read_transcript" };
/** Messages content → SW, besides fact bodies. */
export type ContentSignal = { type: "left_watch_page" } | { type: "returned_to_watch_page"; videoId: string };

export type PlaybackTracker = {
  setObserving(on: boolean): void;
  /** Close the open span and stop listening (navigation away / teardown). */
  dispose(): void;
};

/**
 * Turns <video> playback into media-time `span` facts and `ad` facts.
 *
 * Invariants:
 *  - A span covers only content media time actually played while observing (R1).
 *  - No span ever contains ad playback; ads become separate `ad` facts (R2).
 *  - Span ends use the LAST OBSERVED currentTime, never extrapolation, so we
 *    under-count rather than invent watched time.
 *  - Wall clock is used only to detect un-signalled jumps, never as evidence.
 */
export function createPlaybackTracker(video: HTMLVideoElement, player: HTMLElement, emit: Emit, videoId: () => string): PlaybackTracker {
  // TODO pseudocode:
  //   open: { start, last, lastWall, rate, visible } | null
  //   adStartedWall: number | null; contentPosAtAd: number
  //
  //   tick() — on 'timeupdate' and a 1s interval (timeupdate throttles in hidden tabs):
  //     if !observing || isAd() || video.paused || video.seeking || video.ended: closeSpan(); return
  //     t = video.currentTime; wall = performance.now()
  //     if open:
  //       expected = (wall - open.lastWall)/1000 * video.playbackRate
  //       if t < open.last - 0.05 || t - open.last > expected + 1.5: closeSpan()   // un-signalled seek/jump
  //       else if video.playbackRate != open.rate || !document.hidden != open.visible: closeSpan()
  //     if !open: open = { start: t, last: t, lastWall: wall, rate: video.playbackRate, visible: !document.hidden }
  //     else { open.last = t; open.lastWall = wall }
  //     if open.last - open.start >= 5: closeSpan()   // flush every 5s of media: bounds loss on crash
  //
  //   closeSpan(): if open && open.last - open.start >= 0.25:
  //       emit({ kind:"span", videoId: videoId(), start, end: last, rate, tabVisible: visible })
  //     open = null
  //
  //   listeners: pause, seeking, ratechange, ended, emptied, loadstart → closeSpan()
  //              visibilitychange → closeSpan() (next tick reopens with new visibility)
  //   ad: MutationObserver on player.classList ('ad-showing' | 'ad-interrupting'):
  //       on → closeSpan(); adStartedWall = now; contentPosAtAd = lastContentT
  //       off → emit({ kind:"ad", videoId, atContentS: contentPosAtAd, wallDurationMs })
  throw new Error("not implemented");
}

/** `#movie_player` carries ad state classes; `video.html5-main-video` is the element. */
export function findPlayer(): { video: HTMLVideoElement; player: HTMLElement } | null {
  throw new Error("not implemented");
}

/**
 * SPA navigation: 'yt-navigate-finish' + URL check. Watch→watch is a new source in
 * the same capture (flow A). Watch→non-watch auto-pauses (SW decides; we signal).
 */
export function watchNavigation(handlers: {
  onWatchPage(videoId: string): void;
  onLeftWatchPage(): void;
}): () => void {
  throw new Error("not implemented");
}

/** Read title/channel/duration for the `source` fact once the player has metadata. */
export function readSourceMetadata(videoId: string): Promise<Extract<CaptureFactBody, { kind: "source" }>> {
  throw new Error("not implemented");
}
