/**
 * Content script entry (W1; isolated world, every youtube.com page; YouTube is an SPA).
 *
 * The content script is an OBSERVER. It owns no capture state: the service
 * worker owns control (start/pause/stop) and sequencing, and tells us whether
 * to observe. We emit unsequenced fact bodies over one long-lived port.
 *
 *   SW ──{observe: true|false}──▶ content
 *   content ──{fact body}──▶ SW (stamps clientSeq, persists, uploads)
 */
import type { AdSignal, CaptureFactBody, NonEmpty } from "../../shared/domain";

export type Emit = (fact: CaptureFactBody) => void;

/** Messages SW → content. */
export type ControlMessage = { readonly type: "observe"; readonly on: boolean } | { readonly type: "read_transcript" };
/** Messages content → SW, besides fact bodies. */
export type ContentSignal = { readonly type: "left_watch_page" } | { readonly type: "returned_to_watch_page"; readonly videoId: string };

export type PlaybackTracker = {
  setObserving(on: boolean): void;
  /** Close the open span and stop listening (navigation away / teardown). */
  dispose(): void;
};

/** Two independent ad signals (SYNTHESIS graft 3). */
export type AdSignals = {
  readonly domAdShowing: boolean; // #movie_player has `ad-showing` / `ad-interrupting`, or the ad overlay is present
  readonly videoDurationS: number; // the <video> element's current duration
  readonly sourceDurationS: number | null; // the content video's duration from the source fact
};

/**
 * R2: "Ad time never becomes evidence."
 * Fails closed: EITHER signal means an ad. The DOM class flips a tick late on
 * some transitions; an ad swaps the stream in the same <video>, so a duration
 * differing from the content's by more than 1.5 s catches that tick.
 * Returns the signals that fired, or null when no ad is playing.
 */
export function isAdShowing(s: AdSignals): NonEmpty<AdSignal> | null {
  throw new Error("not implemented");
}

/** The only DOM-touching ad function, kept apart so isAdShowing stays pure. */
export function readAdSignals(player: Element | null, video: HTMLVideoElement | null, sourceDurationS: number | null): AdSignals {
  throw new Error("not implemented");
}

/**
 * Turns <video> playback into media-time `span` facts and `ad` facts.
 *
 * R1: "Evidence only comes from intervals I actually watched while capture was on."
 * R2: "Ad time never becomes evidence."
 * Invariants:
 *  - A span covers only content media time actually played while observing.
 *  - No span ever contains ad playback; ads become separate `ad` facts.
 *  - Span ends use the LAST OBSERVED currentTime, never extrapolation.
 *  - Wall clock only detects un-signalled jumps and fills wallDurationMs, never evidence.
 *
 * TODO pseudocode:
 *   open: { start, last, openedWall, lastWall, rate, visible } | null
 *   adStartedWall: number | null; adSignals; contentPosAtAd
 *
 *   tick() on 'timeupdate' and a 1 s interval (timeupdate throttles in hidden tabs):
 *     ad = isAdShowing(readAdSignals(player, video, sourceDurationS))
 *     if !observing || ad || video.paused || video.seeking || video.ended: closeSpan(); handleAd(ad); return
 *     t = video.currentTime; wall = performance.now()
 *     if open:
 *       expected = (wall - open.lastWall) / 1000 * video.playbackRate
 *       if t < open.last - 0.05 || t - open.last > expected + 1.5: closeSpan()   // un-signalled seek/jump
 *       else if video.playbackRate != open.rate || !document.hidden != open.visible: closeSpan(continuous = true)
 *     if !open: open = { start: t, last: t, openedWall: wall, lastWall: wall, rate, visible: !document.hidden }
 *     else { open.last = t; open.lastWall = wall }
 *     if open.last - open.start >= 5: closeSpan(continuous = true)   // flush every 5 s of media: bounds loss on crash
 *
 *   closeSpan(continuous = false):
 *     if open && open.last - open.start >= 0.25:
 *       emit({ kind: "span", videoId, start, end: last, rate, tabVisible: visible, wallDurationMs: round(lastWall - openedWall) })
 *     // Passages must lie wholly inside watched time (strict R1), so an uninterrupted
 *     // flush reopens AT the previous end; otherwise every 5 s boundary is a hole.
 *     open = continuous && open ? { start: open.last, last: open.last, openedWall: open.lastWall, … } : null
 *
 *   listeners: pause, seeking, ratechange, ended, emptied, loadstart → closeSpan()
 *              visibilitychange → closeSpan(continuous = true) (next tick carries the new visibility)
 *   handleAd(ad): on start → adStartedWall = now; adSignals = ad; contentPosAtAd = last content t
 *                 on end   → emit({ kind: "ad", videoId, atContentS: contentPosAtAd, wallDurationMs, signals: adSignals })
 */
export function createPlaybackTracker(video: HTMLVideoElement, player: HTMLElement, emit: Emit, videoId: () => string, sourceDurationS: () => number | null): PlaybackTracker {
  throw new Error("not implemented");
}

/** `#movie_player` carries ad state classes; `video.html5-main-video` is the element. */
export function findPlayer(): { readonly video: HTMLVideoElement; readonly player: HTMLElement } | null {
  throw new Error("not implemented");
}

/**
 * SPA navigation: 'yt-navigate-finish' + URL check. Watch→watch is a new source in
 * the same capture (flow A). Watch→non-watch auto-pauses (SW decides; we signal).
 */
export function watchNavigation(handlers: { onWatchPage(videoId: string): void; onLeftWatchPage(): void }): () => void {
  throw new Error("not implemented");
}

/** Read title/channel/duration for the `source` fact once the player has metadata. */
export function readSourceMetadata(videoId: string): Promise<Extract<CaptureFactBody, { kind: "source" }>> {
  throw new Error("not implemented");
}
