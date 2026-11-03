// extension/content/spanTracker.ts -- watched intervals in MEDIA time (flow A bullets 2-3 and 7). PURE reducer; no DOM, no clock.
// The glue (player.ts) turns <video>/player events into PlaybackSample; this decides what is a watched span.
//
// Why a reducer: pause/seek/speed/replay/ad edge cases are exactly where evidence would silently corrupt (R1, R2),
// so they are table-testable with fabricated sample sequences and no browser.
import type { CaptureEventBody } from "../../shared/domain/capture";
import type { SourceId, SpanId } from "../../shared/domain/ids";
import type { MediaMs, WallMs } from "../../shared/domain/time";
import type { Transition } from "../../shared/core/transition";

export type PlaybackSample =
  /** player glue emits ~4 Hz while playing (timeupdate); `contentLikely` is false when video.duration != source duration (ad media / wrong stream) */
  | { readonly tag: "tick"; readonly media: MediaMs; readonly wall: WallMs; readonly rate: number; readonly contentLikely: boolean }
  | { readonly tag: "pause" }
  | { readonly tag: "seeking" } // from the event, BEFORE currentTime is trusted
  | { readonly tag: "rate_change"; readonly rate: number }
  | { readonly tag: "ad"; readonly showing: boolean } // #movie_player.ad-showing, plus duration cross-check
  | { readonly tag: "capture"; readonly on: boolean } // user pause/resume/stop or auto-pause on leaving /watch
  | { readonly tag: "source"; readonly sourceId: SourceId | null; readonly duration: MediaMs | null }; // new video / left watch page

export interface TrackerState {
  readonly sourceId: SourceId | null;
  readonly duration: MediaMs | null;
  readonly captureOn: boolean;
  readonly adShowing: boolean;
  readonly seeking: boolean;
  /** last trusted content position (ad_break.at uses this) */
  readonly lastContent: MediaMs | null;
  readonly open: {
    readonly spanId: SpanId;
    readonly start: MediaMs;
    readonly end: MediaMs;
    readonly rate: number;
    readonly lastWall: WallMs;
    readonly lastHeartbeatWall: WallMs;
  } | null;
}

export interface TrackerPolicy {
  /** re-emit the open span at most this often (wall) so the backend sees growth */
  readonly heartbeatMs: number;
  /** |observed - expected| beyond this + 25% of elapsed => unreported seek */
  readonly seekToleranceMs: number;
  /** injected: crypto.randomUUID in the page, a counter in tests */
  readonly newSpanId: () => SpanId;
}

/**
 * pseudocode:
 *   tick(m, w, rate, contentLikely):
 *     if !captureOn || adShowing || seeking || !contentLikely || !sourceId: ignore
 *         (and if a span is open and !contentLikely: close it at open.end)
 *     if open == null: open span {start: m, end: m, rate}          // emit watched_span open=true
 *     else:
 *        expected = open.end + (w - open.lastWall) * rate
 *        if |m - expected| > seekTolerance + 0.25 * (w - open.lastWall):   // unreported seek (belt and braces to 'seeking')
 *             close at open.end (NOT at m); open new span at m
 *        elif m < open.end:   replay/backward without a seek event -> same as seek
 *        else open.end = min(m, duration); heartbeat if w - lastHeartbeat >= heartbeatMs
 *   pause | seeking | rate_change: close at open.end (the last trusted tick); rate_change reopens on the next tick
 *   ad(showing=true):  close at open.end; adShowing = true; emit ad_break{at: lastContent, state:'started'}; ticks ignored until ad(false)
 *   ad(showing=false): emit ad_break{state:'ended'}; adShowing = false; the next trusted tick opens a NEW span (never extends the pre-ad one)
 *   capture(on=false): close at open.end
 *   source(...):       close at open.end; reset. Speed is metadata and never closes a span except via rate_change.
 * Invariant (test): every emitted span lies in [0, duration]; NO span is opened or extended while adShowing (R2);
 * a span's end only moves forward in media time.
 */
export function trackerStep(s: TrackerState, e: PlaybackSample, p: TrackerPolicy): Transition<TrackerState, CaptureEventBody> {
  throw new Error("not implemented");
}

export const initialTracker: TrackerState = {
  sourceId: null, duration: null, captureOn: false, adShowing: false, seeking: false, lastContent: null, open: null,
};
