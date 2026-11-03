/**
 * Content script entry (isolated world). Wiring only: the observers live in
 * capture.ts and frames.ts (W1), transcripts in transcript.ts (W2). It owns no
 * capture state; the service worker says whether to observe.
 *
 * `startContent` takes its page access as `ContentDeps`, so the wiring is tested
 * without a browser; `browserDeps` is the production set.
 */
import type { CaptureFactBody } from "../../shared/domain";
import { createAdProbe, createPlaybackTracker, findPlayer, readSourceMetadata, watchNavigation } from "./capture";
import type { Emit, PlaybackTracker } from "./capture";
import { createFrameSampler } from "./frames";
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
  startCaptionListener(): void;
  /** The id in the page URL. */
  urlVideoId(): string;
  /** The id the player has loaded, when it can be read. */
  streamVideoId(): string | null;
  findPlayer(): Found | null;
  readSourceMetadata(videoId: string): Promise<SourceFact>;
  acquireTranscript(videoId: string, durationS: number | null): Promise<TranscriptResult>;
  createTracker(found: Found, emit: Emit, videoId: () => string, sourceDurationS: () => number | null): PlaybackTracker;
  createSampler(found: Found, emit: Emit, videoId: () => string, sourceDurationS: () => number | null): FrameSampler;
  watchNavigation: typeof watchNavigation;
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
  acquireTranscript,
  createTracker: (found, emit, videoId, dur) => createPlaybackTracker(found.video, found.player, emit, videoId, dur),
  createSampler: createBrowserSampler,
  watchNavigation,
};

export function startContent(deps: ContentDeps): void {
  deps.startCaptionListener();

  let port: ContentPort | null = null;
  let observing = false;
  let attached: { readonly video: HTMLVideoElement; readonly tracker: PlaybackTracker; readonly sampler: FrameSampler } | null = null;
  let captureId: string | null = null;
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

  async function readTranscript(force: boolean, videoId = currentVideoId()): Promise<void> {
    // Keyed by capture: a Stop then Start on the same video is a new capture and needs its own transcript fact.
    const key = `${captureId ?? ""}:${videoId}`;
    if (videoId === "" || (!force && transcribed.has(key))) return;
    transcribed.add(key);
    send(await deps.acquireTranscript(videoId, deps.findPlayer()?.video.duration || null));
  }

  async function beginVideo(videoId = currentVideoId()): Promise<void> {
    if (videoId === "") return;
    const source = await deps.readSourceMetadata(videoId);
    if (source.durationS !== null) durations.set(videoId, source.durationS);
    send(source);
    await readTranscript(false, videoId);
  }

  function ensureObservers(): boolean {
    const found = deps.findPlayer();
    if (!found) return attached !== null;
    if (attached?.video === found.video) return true;
    // YouTube can swap the <video>; observers on the old element would watch nothing.
    attached?.tracker.dispose();
    attached?.sampler.dispose();
    const dur = () => durations.get(currentVideoId()) ?? null;
    attached = { video: found.video, tracker: deps.createTracker(found, send, currentVideoId, dur), sampler: deps.createSampler(found, send, currentVideoId, dur) };
    return true;
  }

  /** Closes the open span and stops observing; the worker re-sends observe if capture is still on. */
  function flushObservers(): void {
    observing = false;
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
    captureId = m.captureId;
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
    if (observing && !wasObserving) void beginVideo();
  }

  deps.watchNavigation({
    onWatchPage(videoId) {
      send({ type: "returned_to_watch_page", videoId });
      if (observing) void beginVideo(videoId);
    },
    onLeftWatchPage() {
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
