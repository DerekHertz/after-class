/**
 * Content script entry (isolated world). Wiring only: the observers live in
 * capture.ts and frames.ts (W1), transcripts in transcript.ts (W2). It owns no
 * capture state; the service worker says whether to observe.
 */
import type { CaptureFactBody } from "../../shared/domain";
import { createPlaybackTracker, findPlayer, readSourceMetadata, watchNavigation } from "./capture";
import type { ContentSignal, ControlMessage, PlaybackTracker } from "./capture";
import { createFrameSampler } from "./frames";
import type { FrameSampler, FrameSamplerConfig } from "./frames";
import { acquireTranscript, startCaptionListener } from "./transcript";

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

function currentVideoId(): string {
  return new URL(location.href).searchParams.get("v") ?? "";
}

function main(): void {
  startCaptionListener();

  let port: chrome.runtime.Port | null = null;
  let observing = false;
  let tracker: PlaybackTracker | null = null;
  let sampler: FrameSampler | null = null;
  const transcribed = new Set<string>();

  function connect(): chrome.runtime.Port {
    const p = chrome.runtime.connect({ name: "capture" });
    p.onMessage.addListener(onControl);
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      setTimeout(() => (port ??= connect()), 1000);
    });
    return p;
  }

  function send(message: CaptureFactBody | ContentSignal): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        (port ??= connect()).postMessage(message);
        return;
      } catch {
        port = null;
      }
    }
  }

  async function readTranscript(force: boolean): Promise<void> {
    const videoId = currentVideoId();
    if (videoId === "" || (!force && transcribed.has(videoId))) return;
    transcribed.add(videoId);
    send(await acquireTranscript(videoId, findPlayer()?.video.duration || null));
  }

  async function beginVideo(): Promise<void> {
    const videoId = currentVideoId();
    if (videoId === "") return;
    send(await readSourceMetadata(videoId));
    await readTranscript(false);
  }

  function ensureObservers(): boolean {
    if (tracker) return true;
    const found = findPlayer();
    if (!found) return false;
    tracker = createPlaybackTracker(found.video, found.player, send, currentVideoId, () => found.video.duration || null);
    sampler = createFrameSampler(found.video, send, currentVideoId, FRAME_CONFIG);
    return true;
  }

  function onControl(m: ControlMessage): void {
    if (m.type === "read_transcript") {
      void readTranscript(true);
      return;
    }
    const wasObserving = observing;
    observing = m.on;
    if (observing && !ensureObservers()) {
      const poll = setInterval(() => {
        if (observing && ensureObservers()) {
          clearInterval(poll);
          tracker?.setObserving(true);
          sampler?.setObserving(true);
          void beginVideo();
        }
      }, 500);
      setTimeout(() => clearInterval(poll), 15_000);
      return;
    }
    tracker?.setObserving(observing);
    sampler?.setObserving(observing);
    if (observing && !wasObserving) void beginVideo();
  }

  watchNavigation({
    onWatchPage(videoId) {
      send({ type: "returned_to_watch_page", videoId });
      if (observing) void beginVideo();
    },
    onLeftWatchPage() {
      send({ type: "left_watch_page" });
    },
  });

  port = connect();
}

if (!window.__afterclassContent) {
  window.__afterclassContent = true;
  main();
}
