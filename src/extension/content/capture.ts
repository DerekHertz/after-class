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
import { media } from "../../shared/time";

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

const AD_DURATION_TOLERANCE_S = 1.5;
const SPAN_MIN_S = 0.25;
const SPAN_FLUSH_S = 5;
const JUMP_SLACK_S = 1.5;
const BACKWARD_SLACK_S = 0.05;
const NEW_STREAM_NEAR_START_S = 2;

/**
 * R2: "Ad time never becomes evidence."
 * Fails closed: EITHER signal means an ad. The DOM class flips a tick late on
 * some transitions; an ad swaps the stream in the same <video>, so a duration
 * differing from the content's by more than 1.5 s catches that tick.
 * Returns the signals that fired, or null when no ad is playing.
 */
export function isAdShowing(s: AdSignals): NonEmpty<AdSignal> | null {
  const fired: AdSignal[] = [];
  if (s.domAdShowing) fired.push("dom_class");
  // NaN (no metadata yet) and Infinity (live) carry no duration signal.
  if (s.sourceDurationS !== null && Number.isFinite(s.videoDurationS) && Math.abs(s.videoDurationS - s.sourceDurationS) > AD_DURATION_TOLERANCE_S) {
    fired.push("duration_mismatch");
  }
  const [first, ...rest] = fired;
  return first === undefined ? null : [first, ...rest];
}

const AD_PLAYER_CLASSES = ["ad-showing", "ad-interrupting"];
const AD_OVERLAY_SELECTOR = ".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-preview-container";

/** The only DOM-touching ad function, kept apart so isAdShowing stays pure. */
export function readAdSignals(player: Element | null, video: HTMLVideoElement | null, sourceDurationS: number | null): AdSignals {
  const domAdShowing = player !== null && (AD_PLAYER_CLASSES.some((c) => player.classList.contains(c)) || player.querySelector(AD_OVERLAY_SELECTOR) !== null);
  return { domAdShowing, videoDurationS: video?.duration ?? Number.NaN, sourceDurationS };
}

/** One shared predicate for the tracker and the frame sampler, so both fail closed identically. */
export function createAdProbe(player: Element | null, video: HTMLVideoElement | null, sourceDurationS: () => number | null): () => boolean {
  return () => isAdShowing(readAdSignals(player, video, sourceDurationS())) !== null;
}

type SpanBody = Extract<CaptureFactBody, { kind: "span" }>;
type AdBody = Extract<CaptureFactBody, { kind: "ad" }>;

type OpenSpan = {
  readonly videoId: string; // fixed at open: a SPA navigation must not re-label a span
  readonly start: number;
  readonly last: number; // last OBSERVED currentTime, never extrapolated
  readonly openedWall: number;
  readonly lastWall: number;
  readonly rate: number;
  readonly visible: boolean;
};

type AdRun = { readonly videoId: string; readonly startedWall: number; readonly atContentS: number; readonly signals: NonEmpty<AdSignal> };

export type PlaybackState = {
  readonly observing: boolean;
  readonly open: OpenSpan | null;
  readonly ad: AdRun | null;
  /** Last content time seen outside an ad; where an ad interrupted. */
  readonly content: { readonly videoId: string; readonly t: number } | null;
  /**
   * The id the <video> is believed to be playing. `staleT` is set when the id
   * changed with no sign the stream did: YouTube flips the id before the element
   * swaps streams, so until a reset the element still plays the OLD video.
   * It holds that old stream's last time (Infinity when unknown).
   */
  readonly stream: { readonly videoId: string; readonly staleT: number | null } | null;
};

/** What the <video> and its player said at one instant. Everything the step needs, nothing it must fetch. */
export type PlaybackSample = {
  readonly wallMs: number; // performance.now(): monotonic, only for jump detection and wallDurationMs
  readonly videoId: string;
  readonly t: number;
  readonly rate: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly ended: boolean;
  readonly ready: boolean; // finite currentTime and metadata loaded
  readonly visible: boolean;
  readonly ad: NonEmpty<AdSignal> | null;
};

export type PlaybackEvent =
  | { readonly type: "tick"; readonly s: PlaybackSample }
  /** emptied / loadstart: the element is loading another stream, so currentTime carries no continuity. */
  | { readonly type: "reset" }
  | { readonly type: "observing"; readonly on: boolean; readonly wallMs: number };

export const initialPlayback: PlaybackState = { observing: false, open: null, ad: null, content: null, stream: null };

function spanFact(o: OpenSpan): SpanBody | null {
  if (o.last - o.start < SPAN_MIN_S) return null;
  return {
    kind: "span",
    videoId: o.videoId,
    start: media(o.start),
    end: media(o.last),
    rate: o.rate,
    tabVisible: o.visible,
    wallDurationMs: Math.max(0, Math.round(o.lastWall - o.openedWall)),
  };
}

function unionSignals(a: NonEmpty<AdSignal>, b: NonEmpty<AdSignal>): NonEmpty<AdSignal> {
  return [a[0], ...a.slice(1), ...b].filter((x, i, all) => all.indexOf(x) === i) as unknown as NonEmpty<AdSignal>;
}

function adFact(a: AdRun, wallMs: number): AdBody {
  return { kind: "ad", videoId: a.videoId, atContentS: media(a.atContentS), wallDurationMs: Math.max(0, Math.round(wallMs - a.startedWall)), signals: a.signals };
}

/**
 * Passages must lie wholly inside watched time (strict R1), so an uninterrupted
 * flush reopens AT the previous end; otherwise every 5 s boundary is a hole.
 */
function reopen(o: OpenSpan, s: PlaybackSample): OpenSpan {
  return { ...o, start: o.last, openedWall: o.lastWall, rate: s.rate, visible: s.visible };
}

/**
 * R1: "Evidence only comes from intervals I actually watched while capture was on."
 * R2: "Ad time never becomes evidence."
 * Pure reducer behind createPlaybackTracker. Invariants:
 *  - A span covers only content media time actually played while observing.
 *  - No span ever contains ad playback; ads become separate `ad` facts.
 *  - Span ends use the LAST OBSERVED currentTime, never extrapolation.
 *  - Wall clock only detects un-signalled jumps and fills wallDurationMs, never evidence.
 */
export function stepPlayback(st: PlaybackState, ev: PlaybackEvent): { readonly state: PlaybackState; readonly facts: readonly CaptureFactBody[] } {
  const facts: CaptureFactBody[] = [];
  let { observing, open, ad, content, stream } = st;

  const closeOpen = () => {
    const f = open === null ? null : spanFact(open);
    if (f !== null) facts.push(f);
    open = null;
  };
  const done = () => ({ state: { observing, open, ad, content, stream }, facts });

  if (ev.type === "observing") {
    if (ev.on === observing) return done();
    closeOpen();
    if (ad !== null) facts.push(adFact(ad, ev.wallMs));
    observing = ev.on;
    ad = null;
    content = null;
    stream = null;
    return done();
  }
  if (!observing) return done();
  if (ev.type === "reset") {
    closeOpen();
    stream = null; // the next tick's id belongs to the stream that just loaded
    return done();
  }

  const s = ev.s;

  if (s.ad !== null) {
    closeOpen();
    if (ad === null) {
      ad = { videoId: s.videoId, startedWall: s.wallMs, atContentS: content !== null && content.videoId === s.videoId ? content.t : 0, signals: s.ad };
    } else {
      ad = { ...ad, signals: unionSignals(ad.signals, s.ad) };
    }
    return done();
  }
  if (ad !== null) {
    facts.push(adFact(ad, s.wallMs));
    ad = null;
  }

  if (s.videoId !== "") {
    if (stream === null) stream = { videoId: s.videoId, staleT: null };
    else if (stream.videoId !== s.videoId) {
      const prev = stream.videoId;
      const old = [content, open === null ? null : { videoId: open.videoId, t: open.last }].find((c) => c !== null && c.videoId === prev);
      stream = { videoId: s.videoId, staleT: old?.t ?? Number.POSITIVE_INFINITY };
    }
    if (stream.staleT !== null && (s.seeking || (s.t <= NEW_STREAM_NEAR_START_S && s.t < stream.staleT))) stream = { videoId: s.videoId, staleT: null };
  }

  if (open !== null && open.videoId !== s.videoId) closeOpen();
  if (content !== null && content.videoId !== s.videoId) content = null;
  if (s.videoId === "" || !s.ready || s.seeking || (stream !== null && stream.staleT !== null)) {
    closeOpen();
    return done();
  }

  if (open !== null) {
    const expected = ((s.wallMs - open.lastWall) / 1000) * Math.max(s.rate, open.rate);
    if (s.t < open.last - BACKWARD_SLACK_S || s.t - open.last > expected + JUMP_SLACK_S) {
      closeOpen(); // un-signalled seek or jump
    } else {
      open = { ...open, last: Math.max(open.last, s.t), lastWall: s.wallMs };
      if (s.rate !== open.rate || s.visible !== open.visible) {
        const f = spanFact(open);
        if (f !== null) {
          facts.push(f);
          open = reopen(open, s);
        } else {
          open = { ...open, rate: s.rate, visible: s.visible };
        }
      }
    }
  }
  content = { videoId: s.videoId, t: s.t };

  if (s.paused || s.ended) {
    closeOpen();
    return done();
  }
  if (open === null) open = { videoId: s.videoId, start: s.t, last: s.t, openedWall: s.wallMs, lastWall: s.wallMs, rate: s.rate, visible: s.visible };
  if (open.last - open.start >= SPAN_FLUSH_S) {
    const f = spanFact(open);
    if (f !== null) facts.push(f);
    open = reopen(open, s);
  }
  return done();
}

/** Everything the tracker takes from the page, so tests can run it with a fake clock. */
export type PlaybackEnv = {
  now(): number;
  isHidden(): boolean;
  /** Repeat `fn` every `ms`; returns a stopper. */
  every(ms: number, fn: () => void): () => void;
  onVisibilityChange(fn: () => void): () => void;
};

export const browserPlaybackEnv: PlaybackEnv = {
  now: () => performance.now(),
  isHidden: () => document.hidden,
  every: (ms, fn) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
  onVisibilityChange: (fn) => {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
};

const TICK_EVENTS = ["timeupdate", "play", "playing", "pause", "seeking", "seeked", "ratechange", "ended"] as const;
const RESET_EVENTS = ["emptied", "loadstart"] as const;

/**
 * Turns <video> playback into media-time `span` facts and `ad` facts. The
 * 1 s interval backs up `timeupdate`, which hidden tabs throttle.
 */
export function createPlaybackTracker(
  video: HTMLVideoElement,
  player: HTMLElement,
  emit: Emit,
  videoId: () => string,
  sourceDurationS: () => number | null,
  env: PlaybackEnv = browserPlaybackEnv,
): PlaybackTracker {
  let st = initialPlayback;
  const run = (ev: PlaybackEvent) => {
    const r = stepPlayback(st, ev);
    st = r.state;
    for (const f of r.facts) emit(f);
  };
  const sample = (): PlaybackSample => ({
    wallMs: env.now(),
    videoId: videoId(),
    t: video.currentTime,
    rate: video.playbackRate,
    paused: video.paused,
    seeking: video.seeking,
    ended: video.ended,
    ready: video.readyState >= 1 && Number.isFinite(video.currentTime),
    visible: !env.isHidden(),
    ad: isAdShowing(readAdSignals(player, video, sourceDurationS())),
  });
  const tick = () => {
    if (st.observing) run({ type: "tick", s: sample() });
  };
  const reset = () => run({ type: "reset" });

  const off: (() => void)[] = [];
  for (const e of TICK_EVENTS) {
    video.addEventListener(e, tick);
    off.push(() => video.removeEventListener(e, tick));
  }
  for (const e of RESET_EVENTS) {
    video.addEventListener(e, reset);
    off.push(() => video.removeEventListener(e, reset));
  }
  off.push(env.onVisibilityChange(tick));
  let stopInterval: (() => void) | null = null;

  const setObserving = (on: boolean) => {
    if (on === st.observing) return;
    if (on) {
      run({ type: "observing", on: true, wallMs: env.now() });
      stopInterval = env.every(1000, tick);
      tick();
    } else {
      tick(); // fold in the final observed time before closing; the end is observed, not extrapolated
      stopInterval?.();
      stopInterval = null;
      run({ type: "observing", on: false, wallMs: env.now() });
    }
  };

  return {
    setObserving,
    dispose() {
      setObserving(false);
      for (const f of off) f();
      off.length = 0;
    },
  };
}

/** `#movie_player` carries ad state classes; `video.html5-main-video` is the element. */
export function findPlayer(): { readonly video: HTMLVideoElement; readonly player: HTMLElement } | null {
  const player = document.querySelector<HTMLElement>("#movie_player");
  if (player === null) return null;
  const video = player.querySelector<HTMLVideoElement>("video.html5-main-video") ?? player.querySelector<HTMLVideoElement>("video");
  return video === null ? null : { video, player };
}

/** Pure: the video id of a youtube.com watch URL, or null on any other page. */
export function parseWatchUrl(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.pathname !== "/watch") return null;
  const v = u.searchParams.get("v");
  return v !== null && /^[\w-]{11}$/.test(v) ? v : null;
}

/**
 * SPA navigation: 'yt-navigate-finish' + URL check. Watch→watch is a new source in
 * the same capture (flow A). Watch→non-watch auto-pauses (SW decides; we signal).
 */
export function watchNavigation(handlers: { onWatchPage(videoId: string): void; onLeftWatchPage(): void }): () => void {
  let current: string | null = null;
  const check = () => {
    const id = parseWatchUrl(location.href);
    if (id === current) return;
    const wasWatching = current !== null;
    current = id;
    if (id !== null) handlers.onWatchPage(id);
    else if (wasWatching) handlers.onLeftWatchPage();
  };
  // Capture phase on window: the event is dispatched on document and may not bubble.
  window.addEventListener("yt-navigate-finish", check, true);
  window.addEventListener("popstate", check);
  check();
  return () => {
    window.removeEventListener("yt-navigate-finish", check, true);
    window.removeEventListener("popstate", check);
  };
}

const METADATA_WAIT_MS = 60_000;
const METADATA_POLL_MS = 250;

function text(sel: string): string {
  return document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Read title/channel/duration for the `source` fact once the player has metadata.
 * Waits out a pre-roll: during an ad `video.duration` is the ad's, and recording
 * it as the source duration would make every content tick look like an ad.
 * An ad that never clears leaves durationS null, which disables the duration
 * signal but keeps the DOM one.
 */
export async function readSourceMetadata(videoId: string): Promise<Extract<CaptureFactBody, { kind: "source" }>> {
  const deadline = Date.now() + METADATA_WAIT_MS;
  let durationS: number | null = null;
  for (;;) {
    const found = findPlayer();
    const flexy = document.querySelector("ytd-watch-flexy")?.getAttribute("video-id");
    const current = flexy === null || flexy === undefined || flexy === videoId;
    const ad = found !== null && readAdSignals(found.player, found.video, null).domAdShowing;
    if (found !== null && current && !ad && found.video.readyState >= 1 && Number.isFinite(found.video.duration) && found.video.duration > 0) {
      durationS = found.video.duration;
      break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, METADATA_POLL_MS));
  }
  const title = text("h1.ytd-watch-metadata") || document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "").trim() || videoId;
  const channelName = text("ytd-watch-metadata ytd-channel-name a") || text("#owner #channel-name a");
  return { kind: "source", videoId, title: title.slice(0, 1000), channelName: channelName.slice(0, 1000), url: `https://www.youtube.com/watch?v=${videoId}`, durationS };
}
