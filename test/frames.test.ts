/**
 * Frame candidates from synthetic pixel buffers and a scripted video. No DOM,
 * no canvas: pixels come from a FramePixels fake.
 */
import { describe, expect, test } from "bun:test";
import { FRAME_BOUNDS } from "../src/shared/domain";
import type { CaptureFactBody } from "../src/shared/domain";
import { createFrameSampler, degrade, FRAME_DEFAULTS, freshFrameState, initialHealth, lumaFromRgba, meanAbsDiff, normalizedSize, recover, shouldSample, stepFrame, STALL_MEDIA_S } from "../src/extension/content/frames";
import type { FrameStepState } from "../src/extension/content/frames";

const CFG = FRAME_DEFAULTS;
const N = CFG.thumb.w * CFG.thumb.h;

/** Flat board with `ink` pixels (of 2304) set dark: handwriting grows ink a little at a time. */
function board(ink: number, background = 200): Uint8Array {
  const b = new Uint8Array(N).fill(background);
  for (let i = 0; i < ink; i++) b[i * 7 % N] = 20;
  return b;
}

describe("normalizedSize", () => {
  test("a size already inside the bounds is unchanged", () => {
    expect(normalizedSize(1280, 720)).toEqual({ w: 1280, h: 720 });
    expect(normalizedSize(640, 480)).toEqual({ w: 640, h: 480 });
  });
  test("a large source is scaled so the long side is exactly 1280", () => {
    expect(normalizedSize(1920, 1080)).toEqual({ w: 1280, h: 720 });
    expect(normalizedSize(3840, 2160)).toEqual({ w: 1280, h: 720 });
    expect(normalizedSize(1080, 1920)).toEqual({ w: 720, h: 1280 });
  });
  test("a small source is scaled up to the 280 px minimum", () => {
    expect(normalizedSize(256, 144)).toEqual({ w: 498, h: 280 });
    expect(normalizedSize(100, 100)).toEqual({ w: 280, h: 280 });
  });
  test("an aspect ratio that cannot satisfy both bounds is null", () => {
    expect(normalizedSize(2000, 200)).toBeNull();
    expect(normalizedSize(100, 1000)).toBeNull();
  });
  test("non-positive or non-finite sizes are null", () => {
    for (const [w, h] of [[0, 0], [0, 720], [Number.NaN, 720], [1280, Number.POSITIVE_INFINITY], [-1, 5]] as const) expect(normalizedSize(w, h)).toBeNull();
  });
  test("every result lies within Jev's bounds on both sides", () => {
    for (let w = 50; w <= 4000; w += 97) {
      for (let h = 50; h <= 4000; h += 113) {
        const s = normalizedSize(w, h);
        if (s === null) continue;
        expect(Math.max(s.w, s.h)).toBeLessThanOrEqual(FRAME_BOUNDS.maxLongSide);
        expect(Math.min(s.w, s.h)).toBeGreaterThanOrEqual(FRAME_BOUNDS.minShortSide);
        expect(Number.isInteger(s.w) && Number.isInteger(s.h)).toBe(true);
      }
    }
  });
});

describe("pixel helpers", () => {
  test("meanAbsDiff is symmetric, zero for equal buffers, and 0..255", () => {
    const a = new Uint8Array([0, 10, 20, 255]);
    const b = new Uint8Array([5, 10, 0, 0]);
    expect(meanAbsDiff(a, a)).toBe(0);
    expect(meanAbsDiff(a, b)).toBe((5 + 0 + 20 + 255) / 4);
    expect(meanAbsDiff(a, b)).toBe(meanAbsDiff(b, a));
    expect(meanAbsDiff(new Uint8Array(4), new Uint8Array(4).fill(255))).toBe(255);
    expect(meanAbsDiff(new Uint8Array(0), new Uint8Array(0))).toBe(0);
  });
  test("meanAbsDiff refuses buffers of different lengths", () => {
    expect(() => meanAbsDiff(new Uint8Array(3), new Uint8Array(4))).toThrow(RangeError);
  });
  test("lumaFromRgba weights green over red over blue and ignores alpha", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 9, 255, 255, 255, 255, 0, 0, 0, 255]);
    const y = lumaFromRgba(rgba);
    expect(y.length).toBe(5);
    expect(y[1]!).toBeGreaterThan(y[0]!);
    expect(y[0]!).toBeGreaterThan(y[2]!);
    expect(y[3]).toBe(255);
    expect(y[4]).toBe(0);
  });
});

function run(samples: readonly (readonly [number, Uint8Array])[], cfg = CFG): { t: number; trigger: string; diff: number }[] {
  let st: FrameStepState = freshFrameState;
  const kept: { t: number; trigger: string; diff: number }[] = [];
  for (const [t, thumb] of samples) {
    if (!shouldSample(st, t, cfg)) continue;
    const r = stepFrame(st, t, thumb, cfg);
    st = r.state;
    if (r.keep) kept.push({ t, trigger: r.keep.trigger, diff: r.keep.diff });
  }
  return kept;
}

const every = (from: number, to: number, f: (t: number) => Uint8Array): [number, Uint8Array][] => {
  const out: [number, Uint8Array][] = [];
  for (let t = from; t <= to; t += 1) out.push([t, f(t)]);
  return out;
};

describe("stepFrame", () => {
  test("the first sample is kept as `first`", () => {
    expect(run([[0, board(0)]])).toEqual([{ t: 0, trigger: "first", diff: 0 }]);
  });

  test("a still board is kept once, then only a keyframe after the floor", () => {
    const kept = run(every(0, 100, () => board(0)));
    expect(kept.map((k) => [k.t, k.trigger])).toEqual([[0, "first"], [31, "keyframe"], [62, "keyframe"], [93, "keyframe"]]);
  });

  test("sampling runs once per sampleEveryMediaS, not per frame", () => {
    const st = { ...freshFrameState, lastSampleT: 10 };
    expect(shouldSample(st, 10.4, CFG)).toBe(false);
    expect(shouldSample(st, 11, CFG)).toBe(true);
    expect(shouldSample(st, 3, CFG)).toBe(true); // seek back
  });

  test("a slide change is sent only after it settles, with the settled picture", () => {
    const slide2 = board(400);
    const kept = run([[0, board(0)], [1, board(0)], [2, slide2], [3, slide2]]);
    expect(kept.map((k) => [k.t, k.trigger])).toEqual([[0, "first"], [3, "change_settled"]]);
    expect(kept[1]!.diff).toBeGreaterThan(CFG.changeThreshold);
  });

  test("slow handwriting never jumps the per-sample diff but is caught against the last kept frame", () => {
    // ~5 ink pixels per second: each step diff is below the settle threshold.
    const perStep = meanAbsDiff(board(0), board(5));
    expect(perStep).toBeLessThan(CFG.settleThreshold);
    const written = every(0, 60, (t) => board(Math.floor(t * 5)));
    const kept = run(written);
    const settled = kept.filter((k) => k.trigger === "change_settled");
    expect(settled.length).toBeGreaterThan(0);
    for (const k of settled) expect(k.diff).toBeGreaterThan(CFG.changeThreshold);
  });

  test("a board that never settles is kept after the max wait, not held forever", () => {
    let flip = false;
    const animating = every(1, 30, () => { flip = !flip; return board(flip ? 300 : 700); });
    const kept = run([[0, board(0)], ...animating]);
    const settled = kept.filter((k) => k.trigger === "change_settled");
    expect(settled.length).toBeGreaterThan(0);
    expect(settled[0]!.t).toBeGreaterThan(1 + CFG.maxSettleWaitMediaS);
    expect(settled[0]!.t).toBeLessThanOrEqual(1 + CFG.maxSettleWaitMediaS + 1);
  });

  test("motion that returns to what was kept (speaker walks past) sends nothing", () => {
    const kept = run([[0, board(0)], [1, board(500)], [2, board(0)], [3, board(0)], [4, board(0)]]);
    expect(kept.map((k) => k.trigger)).toEqual(["first"]);
  });

  test("seeking back resets the half-seen change and the keyframe clock", () => {
    const early = run([[500, board(0)], [501, board(0)], [20, board(0)], [21, board(0)], [60, board(0)]]);
    expect(early.map((k) => [k.t, k.trigger])).toEqual([[500, "first"], [60, "keyframe"]]);
  });

  test("never invents a frame: no sample, no keep", () => {
    expect(run([])).toEqual([]);
  });
});

describe("channel health", () => {
  test("a persistent fault is reported once, and recovery once", () => {
    let h = initialHealth;
    const reports: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const r = degrade(h, "readback");
      h = r.health;
      reports.push(r.report);
    }
    expect(reports).toEqual(["failed", null, null]);
    const r1 = recover(h, ["readback"], true);
    expect(r1.report).toBe("ok");
    expect(recover(r1.health, ["readback"], true).report).toBeNull();
  });
  test("a stall is not cleared by an unrelated recovery", () => {
    const h = degrade(initialHealth, "tab_hidden").health;
    expect(recover(h, ["readback"], true).report).toBeNull();
    expect(recover(h, ["tab_hidden", "decode_stalled"], false).report).toBe("ok");
  });
});

// ─────────────────────────── The sampler against a scripted video ───────────

type FrameCb = (now: number, meta: { mediaTime: number }) => void;

function rig(opts: { width?: number; height?: number; holdJpeg?: boolean; failJpeg?: boolean } = {}) {
  const held: (() => void)[] = [];
  const facts: CaptureFactBody[] = [];
  let hidden = false;
  let ad = false;
  let current = "aaaaaaaaaaa";
  let screen = board(0);
  let thumbThrows: Error | null = null;
  let reads = 0;
  let cb: FrameCb | null = null;
  const intervals = new Set<() => void>();
  const jpegCalls: { w: number; h: number; screen: Uint8Array }[] = [];

  const video = Object.assign(new EventTarget(), {
    videoWidth: opts.width ?? 1920,
    videoHeight: opts.height ?? 1080,
    currentTime: 0,
    playbackRate: 1,
    paused: false,
    ended: false,
    seeking: false,
    requestVideoFrameCallback: (f: FrameCb) => {
      cb = f;
      return 1;
    },
    cancelVideoFrameCallback: () => {
      cb = null;
    },
  }) as unknown as HTMLVideoElement;

  const sampler = createFrameSampler(video, (f) => facts.push(f), () => current, CFG, {
    pixels: {
      thumb: () => {
        reads++;
        if (thumbThrows) throw thumbThrows;
        return screen;
      },
      jpegBase64: async (w, h) => {
        jpegCalls.push({ w, h, screen });
        if (opts.holdJpeg) await new Promise<void>((res) => held.push(res));
        if (opts.failJpeg) throw new Error("encode boom");
        return "QUJD";
      },
    },
    isHidden: () => hidden,
    adShowing: () => ad,
    every: (_ms, fn) => {
      intervals.add(fn);
      return () => intervals.delete(fn);
    },
  });

  const sim = {
    facts,
    sampler,
    video,
    jpegCalls,
    hasCallback: () => cb !== null,
    reads: () => reads,
    releaseJpegs: async () => {
      for (const res of held.splice(0)) res();
      await Promise.resolve();
      await Promise.resolve();
    },
    frames: () => facts.filter((f): f is Extract<CaptureFactBody, { kind: "frame" }> => f.kind === "frame"),
    channels: () => facts.filter((f): f is Extract<CaptureFactBody, { kind: "channel" }> => f.kind === "channel"),
    show: (b: Uint8Array) => (screen = b),
    setHidden: (h: boolean) => (hidden = h),
    setAd: (a: boolean) => (ad = a),
    setVideoId: (id: string) => (current = id),
    throwOnRead: (e: Error | null) => (thumbThrows = e),
    /** A seek between health ticks; `signalled: false` models a jump the element never announced. */
    seek(to: number, signalled = true) {
      (video as unknown as { currentTime: number }).currentTime = to;
      if (signalled) {
        video.dispatchEvent(new Event("seeking"));
        video.dispatchEvent(new Event("seeked"));
      }
    },
    /** One presented frame at media time t, then let async JPEG encoding finish. */
    async frame(t: number) {
      (video as unknown as { currentTime: number }).currentTime = t;
      cb!(0, { mediaTime: t });
      await Promise.resolve();
      await Promise.resolve();
    },
    /** Media time advances with no frame callback, ticking the 1 s health check each second. */
    advanceWithoutFrames(from: number, seconds: number) {
      for (let i = 1; i <= seconds; i++) {
        (video as unknown as { currentTime: number }).currentTime = from + i;
        for (const fn of Array.from(intervals)) fn();
      }
    },
  };
  return sim;
}

describe("frame sampler", () => {
  test("emits nothing until capture is on", async () => {
    const r = rig();
    await r.frame(0);
    await r.frame(1);
    expect(r.facts).toEqual([]);
  });

  test("a frame fact carries the real frame: id, media time, normalized size, trigger, jpeg", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(12.5);
    const [f] = r.frames();
    expect(f!.videoId).toBe("aaaaaaaaaaa");
    expect(Number(f!.mediaS)).toBe(12.5);
    expect([f!.width, f!.height]).toEqual([1280, 720]);
    expect(f!.trigger).toBe("first");
    expect(f!.jpegBase64).toBe("QUJD");
    expect(f!.frameId.length).toBeGreaterThan(0);
    expect(r.jpegCalls[0]).toMatchObject({ w: 1280, h: 720 });
  });

  test("the first healthy sample reports the frames channel ok exactly once", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    await r.frame(1);
    await r.frame(2);
    expect(r.channels().map((c) => c.health)).toEqual(["ok"]);
  });

  test("a changed and settled board is sent once, and the jpeg is of the settled picture", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    r.show(board(500));
    await r.frame(1);
    expect(r.frames().length).toBe(1);
    const settledScreen = board(500);
    r.show(settledScreen);
    await r.frame(2);
    expect(r.frames().map((f) => f.trigger)).toEqual(["first", "change_settled"]);
    expect(r.jpegCalls[1]!.screen).toBe(settledScreen);
  });

  test("callbacks inside the sample interval are ignored", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    r.show(board(900));
    for (const t of [0.2, 0.4, 0.6, 0.8]) await r.frame(t);
    expect(r.frames().length).toBe(1);
  });

  test("R2: no frame is drawn while an ad is showing", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    r.setAd(true);
    for (let t = 0; t < 10; t++) await r.frame(t);
    expect(r.facts).toEqual([]);
    expect(r.jpegCalls).toEqual([]);
  });

  test("a hidden tab samples nothing and logs one frame gap, then recovers on the first visible frame", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    r.setHidden(true);
    r.advanceWithoutFrames(0, 5);
    for (let t = 1; t <= 5; t++) await r.frame(t);
    const gap = r.channels().filter((c) => c.health === "stalled");
    expect(gap.length).toBe(1);
    expect(gap[0]).toMatchObject({ channel: "frames", videoId: "aaaaaaaaaaa" });
    expect(gap[0]!.detail).toContain("tab hidden");
    expect(r.frames().length).toBe(1);

    r.setHidden(false);
    await r.frame(6);
    expect(r.channels().map((c) => c.health)).toEqual(["ok", "stalled", "ok"]);
  });

  test("a paused hidden tab is not a frame gap", () => {
    const r = rig();
    r.sampler.setObserving(true);
    r.setHidden(true);
    (r.video as unknown as { paused: boolean }).paused = true;
    r.advanceWithoutFrames(0, 5);
    expect(r.facts).toEqual([]);
  });

  test("media time advancing 3 s on a visible tab with no frame callback is a decode stall", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    r.advanceWithoutFrames(0, STALL_MEDIA_S + 2);
    const stalls = r.channels().filter((c) => c.health === "stalled");
    expect(stalls.length).toBe(1);
    expect(stalls[0]!.detail).toContain("no video frame");
    await r.frame(6);
    expect(r.channels().at(-1)!.health).toBe("ok");
  });

  test("a healthy stream of frames never reports a stall", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    for (let t = 0; t < 10; t += 0.5) {
      await r.frame(t);
      r.advanceWithoutFrames(t, 0);
    }
    r.advanceWithoutFrames(9.5, 1);
    expect(r.channels().filter((c) => c.health !== "ok")).toEqual([]);
  });

  test("a tainted canvas is reported failed once, never as frames", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    r.throwOnRead(new Error("SecurityError: tainted"));
    for (let t = 0; t < 6; t++) await r.frame(t);
    expect(r.frames()).toEqual([]);
    const failed = r.channels().filter((c) => c.health === "failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.detail).toContain("tainted");
  });

  test("an unreadable canvas is retried once per sample interval, not on every presented frame", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    r.throwOnRead(new Error("tainted"));
    for (let i = 0; i < 60; i++) await r.frame(i / 20); // 20 fps for 3 s
    expect(r.reads()).toBeLessThanOrEqual(4);
  });

  test("a video size that cannot meet Jev's bounds is a failed channel, not a bad frame", async () => {
    const r = rig({ width: 2000, height: 200 });
    r.sampler.setObserving(true);
    await r.frame(0);
    await r.frame(1);
    expect(r.frames()).toEqual([]);
    expect(r.channels().filter((c) => c.health === "failed").length).toBe(1);
  });

  test("a video with no picture yet is not a failure", async () => {
    const r = rig({ width: 0, height: 0 });
    r.sampler.setObserving(true);
    await r.frame(0);
    expect(r.facts).toEqual([]);
  });

  test("the next video in the same tab starts over with a `first` frame under its own id", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    r.setVideoId("bbbbbbbbbbb");
    await r.frame(1);
    expect(r.frames().map((f) => [f.videoId, f.trigger])).toEqual([["aaaaaaaaaaa", "first"], ["bbbbbbbbbbb", "first"]]);
  });

  test("resuming capture starts over with a `first` frame", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    r.sampler.setObserving(false);
    await r.frame(5);
    r.sampler.setObserving(true);
    await r.frame(40);
    expect(r.frames().map((f) => [Number(f.mediaS), f.trigger])).toEqual([[0, "first"], [40, "first"]]);
  });

  test("dispose stops the frame loop and drops an encode still in flight", async () => {
    const r = rig({ holdJpeg: true });
    r.sampler.setObserving(true);
    await r.frame(0);
    expect(r.jpegCalls.length).toBe(1);
    r.sampler.dispose();
    expect(r.hasCallback()).toBe(false);
    await r.releaseJpegs();
    expect(r.frames()).toEqual([]);
  });

  test("an encode that finishes after the tab hid drops the frame", async () => {
    const r = rig({ holdJpeg: true });
    r.sampler.setObserving(true);
    await r.frame(0);
    r.setHidden(true);
    await r.releaseJpegs();
    expect(r.frames()).toEqual([]);
  });

  test("R2: an encode that finishes after an ad started drops the frame", async () => {
    const r = rig({ holdJpeg: true });
    r.sampler.setObserving(true);
    await r.frame(0);
    r.setAd(true);
    await r.releaseJpegs();
    expect(r.frames()).toEqual([]);
  });

  test("an encode that finishes after capture stopped drops the frame, even if capture resumed", async () => {
    const r = rig({ holdJpeg: true });
    r.sampler.setObserving(true);
    await r.frame(0);
    r.sampler.setObserving(false);
    await r.releaseJpegs();
    expect(r.frames()).toEqual([]);

    r.sampler.setObserving(true);
    await r.frame(40);
    r.sampler.setObserving(false);
    r.sampler.setObserving(true);
    await r.releaseJpegs();
    expect(r.frames()).toEqual([]);
  });

  test("an encode that fails after capture stopped reports nothing", async () => {
    const r = rig({ holdJpeg: true, failJpeg: true });
    r.sampler.setObserving(true);
    await r.frame(0);
    r.sampler.setObserving(false);
    await r.releaseJpegs();
    expect(r.facts.filter((f) => f.kind === "channel" && f.health === "failed")).toEqual([]);
  });
});

describe("decode-stall baseline", () => {
  test("a seek between health ticks is not a decode stall", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    r.advanceWithoutFrames(0, 1);
    r.seek(20);
    r.advanceWithoutFrames(20, 1);
    expect(r.channels().filter((c) => c.health === "stalled")).toEqual([]);
  });

  test("a jump the element never announced is not a decode stall", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(0);
    r.advanceWithoutFrames(0, 1);
    r.seek(20, false);
    r.advanceWithoutFrames(20, 1);
    expect(r.channels().filter((c) => c.health === "stalled")).toEqual([]);
  });

  test("a backward seek is not a decode stall either, and a real stall after it is still caught", async () => {
    const r = rig();
    r.sampler.setObserving(true);
    await r.frame(50);
    r.advanceWithoutFrames(50, 2);
    r.seek(5);
    r.advanceWithoutFrames(5, STALL_MEDIA_S + 2);
    expect(r.channels().filter((c) => c.health === "stalled").length).toBe(1);
  });
});

describe("default ad probe", () => {
  type Doc = { querySelector(sel: string): unknown };
  const g = globalThis as unknown as { document?: Doc | undefined };

  /** The four-argument call a caller makes, with only pixels and timers injected. */
  async function emitsFramesWith(page: { player: { adClass: boolean } | null }): Promise<number> {
    const saved = g.document;
    const facts: CaptureFactBody[] = [];
    const video = Object.assign(new EventTarget(), { videoWidth: 1920, videoHeight: 1080, currentTime: 0, playbackRate: 1, paused: false, ended: false, seeking: false, duration: 600 });
    let cb: ((n: number, m: { mediaTime: number }) => void) | null = null;
    (video as unknown as { requestVideoFrameCallback: unknown }).requestVideoFrameCallback = (f: typeof cb) => ((cb = f), 1);
    (video as unknown as { cancelVideoFrameCallback: unknown }).cancelVideoFrameCallback = () => {};
    const player =
      page.player === null
        ? null
        : { classList: { contains: (c: string) => page.player!.adClass && c === "ad-showing" }, querySelector: (sel: string) => (sel.startsWith("video") ? video : null) };
    g.document = { querySelector: (sel: string) => (sel === "#movie_player" ? player : null) };
    try {
      const sampler = createFrameSampler(video as unknown as HTMLVideoElement, (f) => facts.push(f), () => "aaaaaaaaaaa", CFG, {
        pixels: { thumb: () => board(0), jpegBase64: async () => "QUJD" },
        isHidden: () => false,
        every: () => () => {},
      });
      sampler.setObserving(true);
      for (let t = 0; t < 5; t++) {
        cb!(0, { mediaTime: t });
        await Promise.resolve();
        await Promise.resolve();
      }
      sampler.dispose();
    } finally {
      g.document = saved;
    }
    return facts.filter((f) => f.kind === "frame").length;
  }

  test("R2: with no injected probe, an ad in the real player emits no frames", async () => {
    expect(await emitsFramesWith({ player: { adClass: true } })).toBe(0);
  });

  test("R2: with no injected probe and no player to ask, ads are assumed showing", async () => {
    expect(await emitsFramesWith({ player: null })).toBe(0);
  });

  test("with no injected probe, a player showing content still yields frames", async () => {
    expect(await emitsFramesWith({ player: { adClass: false } })).toBeGreaterThan(0);
  });
});
