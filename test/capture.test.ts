/**
 * Playback tracker, driven by simulated <video> events on a fake clock. No DOM:
 * the video is an EventTarget with the properties the tracker reads.
 */
import { describe, expect, test } from "bun:test";
import type { CaptureFactBody } from "../src/shared/domain";
import { createAdProbe, createPlaybackTracker, isAdShowing, parseWatchUrl, readAdSignals } from "../src/extension/content/capture";
import type { PlaybackEnv } from "../src/extension/content/capture";

type Span = Extract<CaptureFactBody, { kind: "span" }>;
type Ad = Extract<CaptureFactBody, { kind: "ad" }>;
type PlainSpan = Omit<Span, "start" | "end"> & { readonly start: number; readonly end: number };

const VID = "aaaaaaaaaaa";
const VID2 = "bbbbbbbbbbb";
const CONTENT_S = 600;
const AD_S = 15;

type SimVideo = EventTarget & {
  currentTime: number;
  playbackRate: number;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  readyState: number;
  duration: number;
};

function rig() {
  const facts: CaptureFactBody[] = [];
  let wall = 1000;
  let hidden = false;
  let currentId = VID;
  const intervals = new Set<() => void>();
  const visibility = new Set<() => void>();
  const classes = new Set<string>();

  const video = Object.assign(new EventTarget(), {
    currentTime: 100,
    playbackRate: 1,
    paused: true,
    seeking: false,
    ended: false,
    readyState: 4,
    duration: CONTENT_S,
  }) as SimVideo;
  const player = { classList: { contains: (c: string) => classes.has(c) }, querySelector: () => null } as unknown as HTMLElement;
  const env: PlaybackEnv = {
    now: () => wall,
    isHidden: () => hidden,
    every: (_ms, fn) => {
      intervals.add(fn);
      return () => intervals.delete(fn);
    },
    onVisibilityChange: (fn) => {
      visibility.add(fn);
      return () => visibility.delete(fn);
    },
  };
  const tracker = createPlaybackTracker(video as unknown as HTMLVideoElement, player, (f) => facts.push(f), () => currentId, () => CONTENT_S, env);

  const fire = (name: string) => video.dispatchEvent(new Event(name));
  const sim = {
    facts,
    video,
    tracker,
    classes,
    spans: (): PlainSpan[] => facts.filter((f): f is Span => f.kind === "span").map((f) => ({ ...f, start: Number(f.start), end: Number(f.end) })),
    ads: () => facts.filter((f): f is Ad => f.kind === "ad"),
    setVideoId: (id: string) => (currentId = id),
    /** Advance wall time in 250 ms steps like timeupdate, ticking the 1 s interval too. */
    play(seconds: number) {
      for (let i = 0; i < Math.round(seconds * 4); i++) {
        wall += 250;
        if (!video.paused && !video.seeking) video.currentTime += 0.25 * video.playbackRate;
        fire("timeupdate");
        if (i % 4 === 3) for (const fn of [...intervals]) fn();
      }
    },
    /** Wall time passes while the player buffers: currentTime does not move. */
    stall(seconds: number) {
      for (let i = 0; i < Math.round(seconds * 4); i++) {
        wall += 250;
        fire("timeupdate");
        if (i % 4 === 3) for (const fn of [...intervals]) fn();
      }
    },
    start() {
      video.paused = false;
      fire("play");
      fire("playing");
    },
    pause() {
      video.paused = true;
      fire("pause");
    },
    seek(to: number) {
      video.seeking = true;
      video.currentTime = to;
      fire("seeking");
      wall += 200;
      video.seeking = false;
      fire("seeked");
    },
    setRate(r: number) {
      video.playbackRate = r;
      fire("ratechange");
    },
    setHidden(h: boolean) {
      hidden = h;
      for (const fn of [...visibility]) fn();
    },
    startAd(domClass: boolean) {
      if (domClass) classes.add("ad-showing");
      video.duration = AD_S;
      video.currentTime = 0;
      fire("loadstart");
      fire("timeupdate");
    },
    endAd(resumeAt: number) {
      classes.clear();
      video.duration = CONTENT_S;
      video.currentTime = resumeAt;
      fire("loadstart");
      fire("timeupdate");
    },
  };
  return sim;
}

describe("isAdShowing", () => {
  const base = { domAdShowing: false, videoDurationS: 600, sourceDurationS: 600 };
  test("no signal means no ad", () => {
    expect(isAdShowing(base)).toBeNull();
  });
  test("R2 fails closed: either signal alone is an ad", () => {
    expect(isAdShowing({ ...base, domAdShowing: true })).toEqual(["dom_class"]);
    expect(isAdShowing({ ...base, videoDurationS: 15 })).toEqual(["duration_mismatch"]);
    expect(isAdShowing({ ...base, domAdShowing: true, videoDurationS: 15 })).toEqual(["dom_class", "duration_mismatch"]);
  });
  test("a duration within 1.5 s of the source is the same stream", () => {
    expect(isAdShowing({ ...base, videoDurationS: 601.4 })).toBeNull();
    expect(isAdShowing({ ...base, videoDurationS: 601.6 })).toEqual(["duration_mismatch"]);
  });
  test("an unknown source duration or no metadata yet gives no duration signal", () => {
    expect(isAdShowing({ ...base, sourceDurationS: null, videoDurationS: 15 })).toBeNull();
    expect(isAdShowing({ ...base, videoDurationS: Number.NaN })).toBeNull();
    expect(isAdShowing({ ...base, videoDurationS: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe("readAdSignals and createAdProbe", () => {
  const player = (cls: string[], overlay = false) => ({ classList: { contains: (c: string) => cls.includes(c) }, querySelector: () => (overlay ? {} : null) }) as unknown as Element;
  const video = { duration: 600 } as HTMLVideoElement;
  test("ad-showing, ad-interrupting or the ad overlay each set the DOM signal", () => {
    expect(readAdSignals(player([]), video, 600).domAdShowing).toBe(false);
    expect(readAdSignals(player(["ad-showing"]), video, 600).domAdShowing).toBe(true);
    expect(readAdSignals(player(["ad-interrupting"]), video, 600).domAdShowing).toBe(true);
    expect(readAdSignals(player([], true), video, 600).domAdShowing).toBe(true);
  });
  test("the probe combines both signals", () => {
    expect(createAdProbe(player([]), video, () => 600)()).toBe(false);
    expect(createAdProbe(player([]), video, () => 30)()).toBe(true);
    expect(createAdProbe(player(["ad-showing"]), video, () => 600)()).toBe(true);
  });
});

describe("parseWatchUrl", () => {
  test("only /watch pages with an 11-character v param", () => {
    expect(parseWatchUrl("https://www.youtube.com/watch?v=QgWz_s7uugE&list=PLx&index=134")).toBe("QgWz_s7uugE");
    expect(parseWatchUrl("https://www.youtube.com/")).toBeNull();
    expect(parseWatchUrl("https://www.youtube.com/results?search_query=x")).toBeNull();
    expect(parseWatchUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseWatchUrl("not a url")).toBeNull();
  });
});

describe("playback tracker spans", () => {
  test("R1: nothing is emitted until capture is on", () => {
    const r = rig();
    r.start();
    r.play(8);
    r.pause();
    expect(r.facts).toEqual([]);
  });

  test("an uninterrupted play flushes every 5 s of media and each span starts where the last ended", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(12);
    r.pause();
    const spans = r.spans();
    expect(spans.length).toBe(3);
    expect(spans[0]!.start).toBe(100);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBe(spans[i - 1]!.end);
    expect(spans.at(-1)!.end).toBeCloseTo(112, 5);
    expect(spans.every((s) => s.rate === 1 && s.tabVisible)).toBe(true);
  });

  test("pause ends the span at the observed time; resuming opens a new one, so the pause is a hole", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.pause();
    r.play(60);
    r.start();
    r.play(2);
    r.pause();
    const [a, b] = r.spans();
    expect(a!.start).toBe(100);
    expect(a!.end).toBeCloseTo(103, 5);
    expect(b!.start).toBeCloseTo(103, 5);
    expect(b!.end).toBeCloseTo(105, 5);
    expect(r.spans().length).toBe(2);
  });

  test("a signalled seek closes the span before the jump and reopens at the target", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.seek(400);
    r.play(2);
    r.pause();
    const [a, b] = r.spans();
    expect(a!.end).toBeCloseTo(103, 5);
    expect(b!.start).toBe(400);
    expect(b!.end).toBeCloseTo(402, 5);
  });

  test("a short forward seek, too small for the wall-clock check, is still a hole", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.seek(104);
    r.play(2);
    r.pause();
    const [a, b] = r.spans();
    expect(a!.end).toBeCloseTo(103, 5);
    expect(b!.start).toBe(104);
  });

  test("an un-signalled jump is caught by the wall-clock check and never bridged", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.video.currentTime += 120; // no seeking event
    r.play(2);
    r.pause();
    const [a, b] = r.spans();
    expect(a!.end).toBeCloseTo(103, 5);
    expect(b!.start).toBeGreaterThan(220);
  });

  test("an un-signalled backward jump closes the span too", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(4);
    r.video.currentTime = 50;
    r.play(2);
    r.pause();
    const [a, b] = r.spans();
    expect(a!.end).toBeCloseTo(104, 5);
    expect(b!.start).toBeGreaterThanOrEqual(50);
    expect(b!.end).toBeLessThan(54);
  });

  test("a rate change splits the span; wall time shows 2x playback", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    r.setRate(2);
    r.play(2);
    r.pause();
    const [a, b] = r.spans();
    expect(a!.rate).toBe(1);
    expect(b!.rate).toBe(2);
    expect(b!.start).toBe(a!.end);
    expect(b!.end - b!.start).toBeCloseTo(4, 5);
    expect(b!.wallDurationMs).toBeGreaterThanOrEqual(1500);
    expect(b!.wallDurationMs).toBeLessThanOrEqual(2500);
  });

  test("a hidden tab splits the span, carries tabVisible false, and stays continuous", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    r.setHidden(true);
    r.play(2);
    r.setHidden(false);
    r.play(1);
    r.pause();
    const spans = r.spans();
    expect(spans.map((s) => s.tabVisible)).toEqual([true, false, true]);
    expect(spans[1]!.start).toBe(spans[0]!.end);
    expect(spans[2]!.start).toBe(spans[1]!.end);
  });

  test("buffering does not widen a span past what was observed", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    const frozen = r.video.currentTime;
    r.stall(3);
    r.pause();
    expect(r.spans().at(-1)!.end).toBeCloseTo(frozen, 5);
  });

  test("turning capture off folds the last observed time in and closes the span", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    r.tracker.setObserving(false);
    r.play(10);
    expect(r.spans().length).toBe(1);
    expect(r.spans()[0]!.end).toBeCloseTo(102, 5);
  });

  test("pause and capture-off record the time at the instant they happen, not the last timeupdate", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    r.video.currentTime += 0.1;
    r.pause();
    expect(r.spans()[0]!.end).toBeCloseTo(102.1, 5);

    const q = rig();
    q.tracker.setObserving(true);
    q.start();
    q.play(2);
    q.video.currentTime += 0.1;
    q.tracker.setObserving(false);
    expect(q.spans()[0]!.end).toBeCloseTo(102.1, 5);
  });

  test("spans shorter than 0.25 s are dropped", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.video.playbackRate = 0.5;
    r.start();
    r.play(0.25);
    r.pause();
    expect(r.spans()).toEqual([]);
  });

  test("the next video in the same tab closes the old span under the old id", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.setVideoId(VID2);
    r.video.currentTime = 10;
    r.video.dispatchEvent(new Event("emptied"));
    r.play(2);
    r.pause();
    const [a, b] = r.spans();
    expect(a!.videoId).toBe(VID);
    expect(a!.end).toBeCloseTo(103, 5);
    expect(b!.videoId).toBe(VID2);
    expect(b!.start).toBeGreaterThanOrEqual(10);
  });

  test("a navigation that changes the id without any video event never relabels a span or opens one on the old stream", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    r.setVideoId(VID2);
    r.play(2);
    r.pause();
    expect(r.spans().map((s) => s.videoId)).toEqual([VID]);
  });

  test("after an id change, the old stream's time is never a span under the new id", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.setVideoId(VID2);
    r.play(2); // still the old stream, 103 to 105
    r.video.currentTime = 0;
    r.video.dispatchEvent(new Event("emptied"));
    r.video.dispatchEvent(new Event("loadstart"));
    r.play(3);
    r.pause();
    const forNew = r.spans().filter((s) => s.videoId === VID2);
    expect(forNew.length).toBe(1);
    expect(forNew[0]!.start).toBeLessThan(1);
    expect(forNew[0]!.end).toBeCloseTo(3, 5);
    expect(forNew.some((s) => s.end > 103 && s.start < 105)).toBe(false);
  });

  test("a seek after an id change proves the stream moved on", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    r.setVideoId(VID2);
    r.play(1);
    r.seek(300);
    r.play(2);
    r.pause();
    const forNew = r.spans().filter((s) => s.videoId === VID2);
    expect(forNew.length).toBe(1);
    expect(forNew[0]!.start).toBeGreaterThanOrEqual(300);
  });

  test("a currentTime back near 0 after an id change proves the stream moved on", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    r.setVideoId(VID2);
    r.play(1);
    r.video.currentTime = 0;
    r.play(2);
    r.pause();
    const forNew = r.spans().filter((s) => s.videoId === VID2);
    expect(forNew.length).toBe(1);
    expect(forNew[0]!.start).toBeLessThan(1);
  });

  test("dispose closes the span and stops listening", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(2);
    r.tracker.dispose();
    const n = r.facts.length;
    r.play(5);
    expect(r.facts.length).toBe(n);
    expect(r.spans().length).toBe(1);
  });
});

describe("playback tracker ads", () => {
  test("R2: an ad closes the open span, becomes its own fact, and content resumes in a new span", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.startAd(true);
    r.play(6);
    r.endAd(103);
    r.play(2);
    r.pause();

    const spans = r.spans();
    expect(spans.length).toBe(2);
    expect(spans[0]!.end).toBeCloseTo(103, 5);
    expect(spans[1]!.start).toBeCloseTo(103, 5);
    const [ad] = r.ads();
    expect(r.ads().length).toBe(1);
    expect(ad!.atContentS).toBeCloseTo(103, 5);
    expect(ad!.signals).toEqual(["dom_class", "duration_mismatch"]);
    expect(ad!.wallDurationMs).toBeGreaterThanOrEqual(5500);
    // ad stream time (0..15) never appears in any span
    expect(spans.every((s) => s.start >= 100)).toBe(true);
  });

  test("the duration signal alone suppresses evidence while the DOM class lags", () => {
    const r = rig();
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.startAd(false);
    r.play(4);
    r.endAd(103);
    r.play(1);
    r.pause();
    expect(r.ads()[0]!.signals).toEqual(["duration_mismatch"]);
    expect(r.spans().every((s) => s.start >= 100)).toBe(true);
  });

  test("a pre-roll before any content is logged at content time 0", () => {
    const r = rig();
    r.startAd(true);
    r.tracker.setObserving(true);
    r.start();
    r.play(3);
    r.endAd(0);
    r.pause();
    expect(Number(r.ads()[0]!.atContentS)).toBe(0);
    expect(r.spans()).toEqual([]);
  });

  test("no ad facts while capture is off", () => {
    const r = rig();
    r.start();
    r.startAd(true);
    r.play(3);
    r.endAd(100);
    expect(r.facts).toEqual([]);
  });
});

/**
 * Ground truth: a seeded random viewer. The simulator records the media
 * intervals actually played as content while capture was on; every emitted
 * span must lie inside them (R1) and none may touch ad playback (R2).
 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("simulated viewing sessions", () => {
  test("R1 and R2: every span lies inside truly watched content time, across 150 random sessions", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rand = prng(seed);
      const r = rig();
      const truth: [number, number][] = [];
      let observing = false;
      let adOn = false;
      r.video.currentTime = 100;
      r.tracker.setObserving((observing = true));

      for (let step = 0; step < 300; step++) {
        const x = rand();
        if (x < 0.04) r.video.paused ? r.start() : r.pause();
        else if (x < 0.07) r.seek(100 + Math.floor(rand() * 400));
        else if (x < 0.09) r.setRate([0.5, 1, 1.5, 2][Math.floor(rand() * 4)]!);
        else if (x < 0.11) r.setHidden(rand() < 0.5);
        else if (x < 0.13 && !adOn) {
          adOn = true;
          r.startAd(rand() < 0.7);
        } else if (x < 0.17 && adOn) {
          adOn = false;
          r.endAd(100 + Math.floor(rand() * 400));
        } else if (x < 0.19) r.tracker.setObserving((observing = !observing));
        else if (x < 0.205 && !adOn) r.video.currentTime += 8 + Math.floor(rand() * 100); // un-signalled jump

        const before = r.video.currentTime;
        const playing = !r.video.paused && !r.video.seeking && !adOn && observing;
        r.play(0.25);
        if (playing && r.video.currentTime > before) truth.push([before, r.video.currentTime]);
      }

      const inTruth = (s: number, e: number) => coveredByUnion(truth, s, e);
      for (const s of r.spans()) {
        expect(s.end).toBeGreaterThan(s.start);
        // ad media time is 0..AD_S+; content here always starts at 100
        expect(s.start).toBeGreaterThanOrEqual(100 - 1e-6);
        if (!inTruth(s.start, s.end)) throw new Error(`seed ${seed}: span [${s.start}, ${s.end}] is not inside watched content ${JSON.stringify(truth.slice(-5))}`);
      }
    }
  });
});

function coveredByUnion(parts: readonly (readonly [number, number])[], s: number, e: number): boolean {
  const sorted = [...parts].sort((p, q) => p[0] - q[0]);
  let cursor = s;
  for (const [a, b] of sorted) {
    if (b < cursor - 1e-6) continue;
    if (a > cursor + 1e-6) return false;
    cursor = Math.max(cursor, b);
    if (cursor >= e - 1e-6) return true;
  }
  return cursor >= e - 1e-6;
}
