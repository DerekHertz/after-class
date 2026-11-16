/**
 * Content script entry (isolated world). Wiring only: the observers live in
 * capture.ts and frames.ts (W1), transcripts in transcript.ts (W2). It owns no
 * capture state; the service worker says whether to observe.
 *
 * `startContent` takes its page access as `ContentDeps`, so the wiring is tested
 * without a browser; `browserDeps` is the production set.
 */
import type { CaptureFactBody } from "../../shared/domain";
import type { CaptureId } from "../../shared/ids";
import { createAdProbe, createPlaybackTracker, findPlayer, readSourceMetadata, watchNavigation } from "./capture";
import type { Emit, PlaybackTracker, RestSignal } from "./capture";
import { createFrameSampler } from "./frames";
import { createPausedSign } from "./paused-sign";
import type { PausedSign } from "./paused-sign";
import type { FrameSampler, FrameSamplerConfig } from "./frames";
import { STREAM_ID_ATTR, pickVideoId } from "./stream-id";
import { acquireTranscript, startCaptionListener } from "./transcript";
import type { TranscriptResult } from "./transcript";
import type { FromContent, ToContent } from "../worker/control";

declare global {
  interface Window {
    __afterclassContent?: true;
  }
}

// Starting values from the design sketch. Thresholds are placeholders for W1 to tune on real clips.
const FRAME_CONFIG: FrameSamplerConfig = {
  sampleEveryMediaS: 1,
  changeThreshold: 8,
  settleThreshold: 2,
  maxSettleWaitMediaS: 4,
  keyframeEveryMediaS: 30,
  thumb: { w: 64, h: 36 },
  jpegQuality: 0.85,
};

export type ContentPort = {
  postMessage(message: FromContent): void;
  readonly onMessage: { addListener(fn: (m: ToContent) => void): void };
  readonly onDisconnect: { addListener(fn: () => void): void };
};

type Found = { readonly video: HTMLVideoElement; readonly player: HTMLElement };
type SourceFact = Extract<CaptureFactBody, { kind: "source" }>;

export type ContentDeps = {
  connect(): ContentPort;
  startCaptionListener(videoId: string, signal: AbortSignal): void;
  /** The id in the page URL. */
  urlVideoId(): string;
  /** The id the player has loaded, when it can be read. */
  streamVideoId(): string | null;
  findPlayer(): Found | null;
  readSourceMetadata(videoId: string): Promise<SourceFact>;
  acquireTranscript(videoId: string, durationS: number | null, signal: AbortSignal): Promise<TranscriptResult>;
  createTracker(found: Found, emit: Emit, videoId: () => string, sourceDurationS: () => number | null, signal: (s: RestSignal) => void): PlaybackTracker;
  createSampler(found: Found, emit: Emit, videoId: () => string, sourceDurationS: () => number | null): FrameSampler;
  watchNavigation: typeof watchNavigation;
  pausedSign: PausedSign;
};

/**
 * R2: "Ad time never becomes evidence." The sampler's own default probe sees only the DOM
 * signal; this one also knows the source duration, so an ad that swaps the stream before the
 * DOM class flips is caught by the duration mismatch, the same as in the tracker.
 */
export function createBrowserSampler(
  found: Found,
  emit: Emit,
  videoId: () => string,
  sourceDurationS: () => number | null,
  create: typeof createFrameSampler = createFrameSampler,
): FrameSampler {
  return create(found.video, emit, videoId, FRAME_CONFIG, { adShowing: createAdProbe(found.player, found.video, sourceDurationS) });
}

export const browserDeps: ContentDeps = {
  connect: () => chrome.runtime.connect({ name: "capture" }) as ContentPort,
  startCaptionListener,
  urlVideoId: () => new URL(location.href).searchParams.get("v") ?? "",
  streamVideoId: () => document.documentElement.getAttribute(STREAM_ID_ATTR),
  findPlayer,
  readSourceMetadata,
  acquireTranscript: (id, duration, signal) => acquireTranscript(id, duration, undefined, undefined, signal),
  createTracker: (found, emit, videoId, dur, signal) => createPlaybackTracker(found.video, found.player, emit, videoId, dur, undefined, signal),
  createSampler: createBrowserSampler,
  watchNavigation,
  pausedSign: createPausedSign(() => document, () => findPlayer()?.player ?? null),
};

export function startContent(deps: ContentDeps): void {
  let captions: { videoId: string; life: AbortController } | null = null;

  let port: ContentPort | null = null;
  let observing = false;
  let attached: { readonly video: HTMLVideoElement; readonly tracker: PlaybackTracker; readonly sampler: FrameSampler } | null = null;
  let captureId: CaptureId | null = null;
  let paused = false;
  let onWatch = false;
  const transcribed = new Set<string>();
  const durations = new Map<string, number>();

  const currentVideoId = () => pickVideoId(deps.streamVideoId(), deps.urlVideoId());

  function connect(): ContentPort {
    const p = deps.connect();
    p.onMessage.addListener(onControl);
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      setTimeout(() => (port ??= connect()), 1000);
    });
    return p;
  }

  function send(message: FromContent): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        (port ??= connect()).postMessage(message);
        return;
      } catch {
        port = null;
      }
    }
  }

  /** Stamps the rest with the capture this page is observing for; with none, there is nothing to pause or stop. */
  function sendRest(rest: RestSignal): void {
    if (captureId !== null) send({ ...rest, captureId });
  }

  function stopCaptions(): void {
    captions?.life.abort();
    captions = null;
  }

  function observeCaptions(videoId: string): void {
    if (captions?.videoId === videoId) return;
    stopCaptions();
    if (!observing || !videoId) return;
    captions = { videoId, life: new AbortController() };
    deps.startCaptionListener(videoId, captions.life.signal);
  }

  let pendingTranscript: AbortSignal | null = null;
  async function readTranscript(force: boolean): Promise<void> {
    if (!captions) return;
    const { videoId, life: { signal } } = captions;
    if (pendingTranscript === signal || (!force && transcribed.has(videoId))) return;
    pendingTranscript = signal;
    try {
      const result = await deps.acquireTranscript(videoId, deps.findPlayer()?.video.duration || null, signal);
      if (signal.aborted) return;
      transcribed.add(videoId);
      send(result);
    } finally {
      if (pendingTranscript === signal) pendingTranscript = null;
    }
  }

  async function beginVideo(videoId = currentVideoId()): Promise<void> {
    observeCaptions(videoId);
    if (!captions) return;
    const signal = captions.life.signal;
    const source = await deps.readSourceMetadata(videoId);
    if (signal.aborted) return;
    if (source.durationS !== null) durations.set(videoId, source.durationS);
    send(source);
    await readTranscript(false);
  }

  function ensureObservers(): boolean {
    const found = deps.findPlayer();
    if (!found) return attached !== null;
    if (attached?.video === found.video) return true;
    // YouTube can swap the <video>; observers on the old element would watch nothing.
    attached?.tracker.dispose();
    attached?.sampler.dispose();
    const dur = () => durations.get(currentVideoId()) ?? null;
    attached = { video: found.video, tracker: deps.createTracker(found, send, currentVideoId, dur, sendRest), sampler: deps.createSampler(found, send, currentVideoId, dur) };
    return true;
  }

  /**
   * The sign is on the page exactly while capture is paused and the tab is on a watch page. Leaving the page only
   * takes it down; a Hide the learner pressed lasts until this pause ends, so only a capture that is not paused clears it.
   */
  function updateSign(): void {
    if (!paused) deps.pausedSign.reset();
    else if (!onWatch || captureId === null) deps.pausedSign.remove();
    else {
      const shownFor = captureId;
      deps.pausedSign.show(() => send({ type: "resume", captureId: shownFor }));
    }
  }

  /** Closes the open span and stops observing; the worker re-sends observe if capture is still on. */
  function flushObservers(): void {
    observing = false;
    stopCaptions();
    attached?.tracker.setObserving(false);
    attached?.sampler.setObserving(false);
  }

  function onControl(m: ToContent): void {
    if (m.type === "read_transcript") {
      void readTranscript(true);
      return;
    }
    if (m.type === "flush") {
      flushObservers();
      send({ type: "flushed" });
      return;
    }
    const wasObserving = observing;
    observing = m.on;
    // A different capture is a different pause, whatever the Hide on the last one said.
    const changedCapture = m.captureId !== captureId;
    if (changedCapture) {
      deps.pausedSign.reset();
      stopCaptions();
      transcribed.clear();
      durations.clear();
    }
    if (observing) observeCaptions(currentVideoId());
    else stopCaptions();
    captureId = m.captureId;
    paused = m.paused === true;
    updateSign();
    if (observing && !ensureObservers()) {
      const poll = setInterval(() => {
        if (observing && ensureObservers()) {
          clearInterval(poll);
          attached?.tracker.setObserving(true);
          attached?.sampler.setObserving(true);
          void beginVideo();
        }
      }, 500);
      setTimeout(() => clearInterval(poll), 15_000);
      return;
    }
    attached?.tracker.setObserving(observing);
    attached?.sampler.setObserving(observing);
    if (observing && (!wasObserving || changedCapture)) void beginVideo();
  }

  deps.watchNavigation({
    onWatchPage(videoId) {
      onWatch = true;
      updateSign();
      send({ type: "returned_to_watch_page", videoId });
      if (observing) void beginVideo(videoId);
    },
    onLeftWatchPage() {
      onWatch = false;
      updateSign();
      flushObservers();
      send({ type: "left_watch_page" });
    },
  });

  port = connect();
}

if (typeof window !== "undefined" && !window.__afterclassContent) {
  window.__afterclassContent = true;
  startContent(browserDeps);
}
