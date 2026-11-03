/** The content script's wiring, driven through ContentDeps with W1's real playback tracker on a fake clock. */
import { describe, expect, test } from "bun:test";
import type { CaptureFactBody } from "../src/shared/domain";
import { createPlaybackTracker } from "../src/extension/content/capture";
import type { PlaybackEnv, PlaybackTracker } from "../src/extension/content/capture";
import { createBrowserSampler, startContent } from "../src/extension/content/content-entry";
import type { ContentDeps, ContentPort } from "../src/extension/content/content-entry";
import { installStreamIdMirror } from "../src/extension/content/main-world";
import { STREAM_ID_ATTR, pickVideoId } from "../src/extension/content/stream-id";
import type { FromContent, ToContent } from "../src/extension/worker/control";

const VID = "aaaaaaaaaaa";
const VID2 = "bbbbbbbbbbb";
const CAP_A = "cap_a";
const CAP_B = "cap_b";
const wait = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

type SimVideo = EventTarget & { currentTime: number; playbackRate: number; paused: boolean; seeking: boolean; ended: boolean; readyState: number; duration: number };
const newVideo = (): SimVideo => Object.assign(new EventTarget(), { currentTime: 100, playbackRate: 1, paused: false, seeking: false, ended: false, readyState: 4, duration: 600 }) as SimVideo;
const newPlayer = (classes: string[] = []) => ({ classList: { contains: (c: string) => classes.includes(c) }, querySelector: () => null }) as unknown as HTMLElement;

function rig(over: Partial<ContentDeps> = {}) {
  let wall = 1000;
  let urlId = VID;
  let streamId: string | null = VID;
  const posted: FromContent[] = [];
  const listeners: ((m: ToContent) => void)[] = [];
  const port: ContentPort = { postMessage: (m) => void posted.push(m), onMessage: { addListener: (f) => void listeners.push(f) }, onDisconnect: { addListener: () => {} } };
  let video = newVideo();
  const player = newPlayer();
  const intervals = new Set<() => void>();
  const env: PlaybackEnv = {
    now: () => wall,
    isHidden: () => false,
    every: (_ms, fn) => (intervals.add(fn), () => intervals.delete(fn)),
    onVisibilityChange: () => () => {},
  };
  const transcriptCalls: string[] = [];
  let nav: Parameters<ContentDeps["watchNavigation"]>[0] | null = null;
  const trackers: { tracker: PlaybackTracker; disposed: boolean }[] = [];

  const deps: ContentDeps = {
    connect: () => port,
    startCaptionListener: () => {},
    urlVideoId: () => urlId,
    streamVideoId: () => streamId,
    findPlayer: () => ({ video: video as unknown as HTMLVideoElement, player }),
    readSourceMetadata: async (id) => ({ kind: "source", videoId: id, title: "t", channelName: "c", url: `https://www.youtube.com/watch?v=${id}`, durationS: 600 }),
    acquireTranscript: async (id) => {
      transcriptCalls.push(id);
      return { kind: "transcript_unavailable", videoId: id, reason: "no_captions" };
    },
    createTracker: (found, emit, id, dur) => {
      const tracker = createPlaybackTracker(found.video, found.player, emit, id, dur, env);
      const entry = { tracker, disposed: false };
      trackers.push(entry);
      return { setObserving: (on) => tracker.setObserving(on), dispose: () => ((entry.disposed = true), tracker.dispose()) };
    },
    createSampler: () => ({ setObserving() {}, dispose() {} }),
    watchNavigation: (h) => ((nav = h), () => {}),
    ...over,
  };
  startContent(deps);

  return {
    posted,
    transcriptCalls,
    trackers,
    deliver: (m: ToContent) => listeners.forEach((f) => f(m)),
    get video() {
      return video;
    },
    swapVideo: () => (video = newVideo()),
    setUrlId: (id: string) => (urlId = id),
    setStreamId: (id: string | null) => (streamId = id),
    nav: () => nav!,
    /** Advance the clock by `dt` seconds and report `t` as the playhead. */
    tick: (dt: number, t: number) => {
      wall += dt * 1000;
      video.currentTime = t;
      video.dispatchEvent(new Event("timeupdate"));
    },
    fire: (name: string) => video.dispatchEvent(new Event(name)),
    spans: () => posted.filter((m): m is Extract<CaptureFactBody, { kind: "span" }> => "kind" in m && m.kind === "span"),
  };
}

const observe = (on: boolean, captureId: string | null) => ({ type: "observe", on, captureId }) as unknown as ToContent;

describe("the transcript is read once per capture and video", () => {
  test("Stop then Start on the same video reads it again for the new capture", async () => {
    const r = rig();
    r.deliver(observe(true, CAP_A));
    await wait();
    expect(r.transcriptCalls).toEqual([VID]);
    r.deliver(observe(false, CAP_A));
    r.deliver(observe(true, CAP_B));
    await wait();
    expect(r.transcriptCalls).toEqual([VID, VID]);
    expect(r.posted.filter((m) => "kind" in m && m.kind === "transcript_unavailable")).toHaveLength(2);
  });

  test("Pause then Resume inside one capture does not read it again", async () => {
    const r = rig();
    r.deliver(observe(true, CAP_A));
    await wait();
    r.deliver(observe(false, CAP_A));
    r.deliver(observe(true, CAP_A));
    await wait();
    expect(r.transcriptCalls).toEqual([VID]);
  });

  test("returning to the same video within a capture does not read it again; a different video does", async () => {
    const r = rig();
    r.deliver(observe(true, CAP_A));
    await wait();
    r.nav().onWatchPage(VID);
    await wait();
    expect(r.transcriptCalls).toEqual([VID]);
    r.setUrlId(VID2);
    r.setStreamId(VID2);
    r.nav().onWatchPage(VID2);
    await wait();
    expect(r.transcriptCalls).toEqual([VID, VID2]);
  });
});

describe("flushing the open span", () => {
  test("a flush request sends the closing span and only then says flushed", async () => {
    const r = rig();
    r.deliver(observe(true, CAP_A));
    await wait();
    r.tick(1, 100);
    r.tick(1, 101);
    r.tick(1, 102);
    expect(r.spans()).toHaveLength(0);
    r.deliver({ type: "flush" });
    const tail = r.posted.slice(-2);
    expect(tail[0]).toMatchObject({ kind: "span", videoId: VID, start: 100, end: 102 });
    expect(tail[1]).toEqual({ type: "flushed" });
    r.tick(1, 103);
    expect(r.spans()).toHaveLength(1);
  });

  test("a flush with nothing open still answers, so the worker is never left waiting", async () => {
    const r = rig();
    r.deliver({ type: "flush" });
    expect(r.posted.at(-1)).toEqual({ type: "flushed" });
  });

  test("leaving the watch page closes the span before the signal goes out", async () => {
    const r = rig();
    r.deliver(observe(true, CAP_A));
    await wait();
    r.tick(1, 100);
    r.tick(1, 102);
    r.nav().onLeftWatchPage();
    const tail = r.posted.slice(-2);
    expect(tail[0]).toMatchObject({ kind: "span", start: 100, end: 102 });
    expect(tail[1]).toEqual({ type: "left_watch_page" });
  });
});

describe("which video a span belongs to (R1)", () => {
  test("the stream resets to the next video before the URL flips: no new-stream time is credited to the old video", async () => {
    const r = rig();
    r.deliver(observe(true, CAP_A));
    await wait();
    r.tick(1, 108);
    r.tick(1, 109);
    r.tick(1, 110);
    // The player loads the next video: its id is readable and the element resets while the URL still names the old one.
    r.setStreamId(VID2);
    r.fire("emptied");
    r.fire("loadstart");
    r.tick(0.5, 0.5);
    r.tick(1, 1.5);
    r.tick(1, 2.5);
    r.tick(1, 3.5);
    r.setUrlId(VID2);
    r.nav().onWatchPage(VID2);
    r.tick(1, 4.5);
    r.tick(1, 5.5);
    r.deliver({ type: "flush" });

    const spans = r.spans();
    const old = spans.filter((s) => s.videoId === VID);
    const next = spans.filter((s) => s.videoId === VID2);
    expect(old.length).toBeGreaterThan(0);
    for (const s of old) expect(s.end).toBeLessThanOrEqual(110);
    expect(next.length).toBeGreaterThan(0);
    expect(Math.min(...next.map((s) => s.start))).toBeLessThanOrEqual(1.5);
    expect(Math.max(...next.map((s) => s.end))).toBeGreaterThanOrEqual(5.5);
  });

  test("the player's stream id wins over the URL; the URL is the fallback when it cannot be read", () => {
    expect(pickVideoId(VID2, VID)).toBe(VID2);
    expect(pickVideoId(null, VID)).toBe(VID);
    expect(pickVideoId("not-an-id", VID)).toBe(VID);
    expect(pickVideoId("", VID)).toBe(VID);
  });

  test("the main-world mirror republishes the player's loaded id on media events and clears it when the player has none", () => {
    const doc = new EventTarget() as unknown as Document & { _root: Map<string, string>; _id: string | null };
    const attrs = new Map<string, string>();
    Object.assign(doc, {
      documentElement: { setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) },
      getElementById: () => ({ getVideoData: () => ({ video_id: doc._id }) }),
      _id: VID,
    });
    installStreamIdMirror(doc);
    expect(attrs.get(STREAM_ID_ATTR)).toBe(VID);
    doc._id = VID2;
    doc.dispatchEvent(new Event("loadstart"));
    expect(attrs.get(STREAM_ID_ATTR)).toBe(VID2);
    doc._id = null;
    doc.dispatchEvent(new Event("emptied"));
    expect(attrs.has(STREAM_ID_ATTR)).toBe(false);
  });
});

describe("observers", () => {
  test("a replaced <video> gets fresh observers, and the old ones are disposed", async () => {
    const r = rig();
    r.deliver(observe(true, CAP_A));
    await wait();
    expect(r.trackers).toHaveLength(1);
    r.swapVideo();
    r.deliver(observe(true, CAP_A));
    await wait();
    expect(r.trackers).toHaveLength(2);
    expect(r.trackers[0]!.disposed).toBe(true);
    expect(r.trackers[1]!.disposed).toBe(false);
  });

  test("the frame sampler gets the same ad probe as the tracker: DOM class or a duration that is not the source's", () => {
    let probe: (() => boolean) | undefined;
    const spy = ((_v: unknown, _e: unknown, _id: unknown, _cfg: unknown, deps: { adShowing?: () => boolean } = {}) => {
      probe = deps.adShowing;
      return { setObserving() {}, dispose() {} };
    }) as unknown as Parameters<typeof createBrowserSampler>[4];
    const video = newVideo();
    const make = (classes: string[], sourceS: number | null) => {
      createBrowserSampler({ video: video as unknown as HTMLVideoElement, player: newPlayer(classes) }, () => {}, () => VID, () => sourceS, spy);
      return probe!;
    };
    expect(make([], 600)()).toBe(false);
    expect(make(["ad-showing"], 600)()).toBe(true);
    video.duration = 15;
    expect(make([], 600)()).toBe(true);
  });
});
