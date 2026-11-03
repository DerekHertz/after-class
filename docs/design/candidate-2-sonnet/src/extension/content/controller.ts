// extension/content/controller.ts -- the in-page capture shell. Owns DOM listeners and the three pure reducers; everything it
// emits is a CaptureEventBody sent to the service worker (which wraps it in an envelope with seq and persists it).
//
// Lifecycle (flow A), all driven by messages from the SW/popup plus YouTube SPA navigation events:
//   start   -> source_attached (+ transcript acquisition), tracker.capture(on)
//   pause / resume / stop (user) and auto-pause when the tab leaves /watch (yt-navigate-finish to a non-watch URL, or pagehide)
//   next video in the same tab (yt-navigate-finish with new v=) -> source_attached for the new SourceId, SAME captureId
//   ad start/end  -> tracker.ad(...)  (adGuard.isAdShowing evaluated on every tick AND on class mutation of #movie_player)
//   visibilitychange -> frameHealth.visibility(...)
import type { CaptureEventBody } from "../../shared/domain/capture";
import type { CaptureId } from "../../shared/domain/ids";

export interface Controller {
  start(captureId: CaptureId): Promise<void>;
  pause(cause: "user" | "left_watch_page"): void;
  resume(): void;
  stop(cause: "user" | "tab_closed"): void;
}

/** sink = SW message port: `emit(bodies)` for events, `sendFrame(sha, bytes, event)` for frames (bytes first, then the event; base64 over runtime messaging, which is JSON-only) */
export interface Sink {
  emit(captureId: CaptureId, bodies: readonly CaptureEventBody[]): void;
  sendFrame(captureId: CaptureId, sha: string, bytes: Uint8Array, event: Extract<CaptureEventBody, { type: "frame_candidate" }>): void;
}

/**
 * pseudocode of the hot loop (one place that connects reducers to the DOM):
 *   video.timeupdate (+ rAF-free; setInterval is throttled when hidden, timeupdate is not reliable to the ms but is enough):
 *      ad = isAdShowing(readAdSignals(...)); tracker.step(ad changed ? {ad} : nothing)
 *      tracker.step({tick, media: video.currentTime*1000, wall: now, rate: video.playbackRate, contentLikely: durationMatches})
 *      every sampleEveryMs of MEDIA time while a span is open AND !ad:
 *          try { thumb = captureThumb(video); frameHealth.step(frame_attempt ok) } catch { frameHealth.step(frame_attempt !ok); continue }
 *          d = samplerStep(...); if d.send: { f = await encodeFrame(video); sink.sendFrame(...) }       // never during an ad
 *   video events: pause, seeking, ratechange -> tracker.step(...)       (seeked is informational; trust returns on the next tick)
 *   MutationObserver on #movie_player class -> ad edge immediately (do not wait for the next tick)
 *   document.visibilitychange -> frameHealth.step({visibility})
 *   every emitted body goes through sink.emit in order; the SW preserves order and persists before acking
 */
export function createController(sink: Sink, doc: Document): Controller {
  throw new Error("not implemented");
}
