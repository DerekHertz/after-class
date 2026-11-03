/**
 * Frame candidates by cheap pixel diff (W1; flow B: "Code proposes frame candidates by cheap pixel diff").
 * Jev decides teaching value later, in the backend. This module only decides
 * "something on screen changed and has settled" or "it's been a while".
 *
 * Pixels come from `drawImage(video)` into an OffscreenCanvas. YouTube plays
 * MSE blob media, so the canvas should not be tainted (probe on Windows Chrome
 * first; fallback is chrome.tabs.captureVisibleTab from the SW, cropped).
 *
 * Hidden tab: Chrome stops decoding background video, so sampling stops. We do
 * NOT synthesize frames. We say so with a `channel` fact (stalled, tab_hidden)
 * and the backend also derives the gap from span.tabVisible=false.
 *
 * R2: "Ad time never becomes evidence." The sampler takes the same fail-closed
 * ad predicate as the tracker and draws nothing while it holds.
 */
import { FRAME_BOUNDS } from "../../shared/domain";
import type { CaptureFactBody, FrameTrigger } from "../../shared/domain";
import { media } from "../../shared/time";
import { createAdProbe, findPlayer } from "./capture";
import type { Emit } from "./capture";

export type FrameSamplerConfig = {
  readonly sampleEveryMediaS: number; // 1.0
  readonly changeThreshold: number; // mean abs gray diff vs LAST KEPT thumb (catches slow handwriting cumulatively)
  readonly settleThreshold: number; // diff vs previous sample below this ⇒ the change has settled
  readonly maxSettleWaitMediaS: number; // 4.0: keep anyway if the board never settles (animation)
  readonly keyframeEveryMediaS: number; // 30.0
  readonly thumb: { readonly w: number; readonly h: number }; // 64 × 36
  readonly jpegQuality: number; // 0.85; PNG is a one-line switch if equations soften
};

/** Starting values from the flow doc's "tune on held-out clips" stance; not yet tuned on a real lecture. */
export const FRAME_DEFAULTS: FrameSamplerConfig = {
  sampleEveryMediaS: 1,
  changeThreshold: 2,
  settleThreshold: 0.5,
  maxSettleWaitMediaS: 4,
  keyframeEveryMediaS: 30,
  thumb: { w: 64, h: 36 },
  jpegQuality: 0.85,
};

export type FrameSampler = { setObserving(on: boolean): void; dispose(): void };

/** Media seconds of advance with the tab visible and no frame callback before we call decode stalled. */
export const STALL_MEDIA_S = 3;
const STALL_JUMP_SLACK_S = 1.5;

// ───────────────────────────── Pure pixel helpers ───────────────────────────

/**
 * Pure: scale so the long side ≤ FRAME_BOUNDS.maxLongSide (1280) and the short
 * side ≥ FRAME_BOUNDS.minShortSide (280), or null if the aspect ratio makes both impossible.
 * Small sources are scaled up to the minimum rather than refused.
 */
export function normalizedSize(w: number, h: number): { readonly w: number; readonly h: number } | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const scale = long > FRAME_BOUNDS.maxLongSide ? FRAME_BOUNDS.maxLongSide / long : short < FRAME_BOUNDS.minShortSide ? FRAME_BOUNDS.minShortSide / short : 1;
  const scaledLong = Math.round(long * scale);
  const scaledShort = Math.round(short * scale);
  if (scaledLong > FRAME_BOUNDS.maxLongSide || scaledShort < FRAME_BOUNDS.minShortSide) return null;
  return w >= h ? { w: scaledLong, h: scaledShort } : { w: scaledShort, h: scaledLong };
}

/** Pure: mean absolute difference of two equal-length grayscale buffers, 0..255. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new RangeError(`meanAbsDiff: lengths differ (${a.length} vs ${b.length})`);
  if (a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/** Pure: RGBA bytes (canvas ImageData order) to Rec. 601 luma, one byte per pixel. */
export function lumaFromRgba(rgba: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.floor(rgba.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = (77 * rgba[i * 4]! + 150 * rgba[i * 4 + 1]! + 29 * rgba[i * 4 + 2]!) >> 8;
  return out;
}

// ───────────────────────────── Pure sampling step ───────────────────────────

export type FrameStepState = {
  readonly lastSampleT: number | null;
  readonly prev: Uint8Array | null;
  readonly kept: { readonly thumb: Uint8Array; readonly t: number } | null;
  readonly pendingT: number | null; // media time the change over `kept` was first seen
};

export const freshFrameState: FrameStepState = { lastSampleT: null, prev: null, kept: null, pendingT: null };

export type FrameKeep = { readonly trigger: FrameTrigger; readonly diff: number };

/** Cheap gate before reading pixels. A backward jump (seek back) always samples. */
export function shouldSample(st: FrameStepState, t: number, cfg: FrameSamplerConfig): boolean {
  return st.lastSampleT === null || t < st.lastSampleT || t - st.lastSampleT >= cfg.sampleEveryMediaS;
}

/**
 * One sample at media time `t`. Change is measured against the last KEPT
 * thumbnail, so slow handwriting accumulates; the frame is sent once the
 * picture settles (or the wait runs out), so we send the finished board and
 * not the half-drawn one.
 */
export function stepFrame(st: FrameStepState, t: number, thumb: Uint8Array, cfg: FrameSamplerConfig): { readonly state: FrameStepState; readonly keep: FrameKeep | null } {
  let { prev, kept, pendingT } = st;
  if (st.lastSampleT !== null && t < st.lastSampleT) {
    // Seek back: the previous sample and any half-seen change belong to another moment.
    prev = null;
    pendingT = null;
    if (kept !== null && t < kept.t) kept = { ...kept, t };
  }
  const dKept = kept === null ? 0 : meanAbsDiff(thumb, kept.thumb);
  const dPrev = prev === null ? Number.POSITIVE_INFINITY : meanAbsDiff(thumb, prev);

  let keep: FrameKeep | null = null;
  if (kept === null) {
    keep = { trigger: "first", diff: 0 };
  } else if (pendingT !== null) {
    const timedOut = t - pendingT > cfg.maxSettleWaitMediaS;
    if (timedOut || dPrev < cfg.settleThreshold) {
      if (timedOut || dKept > cfg.changeThreshold) keep = { trigger: "change_settled", diff: dKept };
      else pendingT = null; // settled back to what we already kept: motion or an occlusion, not a new board
    }
  } else if (dKept > cfg.changeThreshold) {
    pendingT = t;
  } else if (t - kept.t > cfg.keyframeEveryMediaS) {
    keep = { trigger: "keyframe", diff: dKept };
  }

  if (keep !== null) {
    kept = { thumb, t };
    pendingT = null;
  }
  return { state: { lastSampleT: t, prev: thumb, kept, pendingT }, keep };
}

// ───────────────────────────── Channel health ───────────────────────────────

export type HealthCause = "tab_hidden" | "decode_stalled" | "readback" | "size" | "encode";
export type FrameHealth = { readonly state: "unknown" | "ok" | "stalled" | "failed"; readonly cause: HealthCause | null };

export const initialHealth: FrameHealth = { state: "unknown", cause: null };

const CAUSE_STATE: Record<HealthCause, "stalled" | "failed"> = {
  tab_hidden: "stalled",
  decode_stalled: "stalled",
  readback: "failed",
  size: "failed",
  encode: "failed",
};

/** Report a problem. Repeating the same cause reports nothing, so a persistent fault is one fact, not one per second. */
export function degrade(h: FrameHealth, cause: HealthCause): { readonly health: FrameHealth; readonly report: "stalled" | "failed" | null } {
  if (h.cause === cause) return { health: h, report: null };
  const state = CAUSE_STATE[cause];
  return { health: { state, cause }, report: state };
}

/** Clear any of `causes`; with `fromUnknown`, also the initial unknown state. Reports `ok` only on a real change. */
export function recover(h: FrameHealth, causes: readonly HealthCause[], fromUnknown: boolean): { readonly health: FrameHealth; readonly report: "ok" | null } {
  const clears = (h.cause !== null && causes.includes(h.cause)) || (fromUnknown && h.state === "unknown");
  return clears ? { health: { state: "ok", cause: null }, report: "ok" } : { health: h, report: null };
}

// ───────────────────────────── DOM shell ────────────────────────────────────

/** Pixel IO, kept behind one seam so the sampler runs in tests with synthetic pixels. */
export type FramePixels = {
  /** Gray thumbnail of what is on screen now (cfg.thumb.w × cfg.thumb.h). Throws if the canvas is unreadable. */
  thumb(): Uint8Array;
  /**
   * Base64 JPEG of what is on screen now at w × h. Must draw synchronously
   * before its first await: the frame at the decision instant is the frame sent.
   */
  jpegBase64(w: number, h: number): Promise<string>;
};

export type FrameDeps = {
  pixels: FramePixels;
  isHidden(): boolean;
  /** Fail-closed ad predicate, the same one the playback tracker uses (createAdProbe). */
  adShowing(): boolean;
  every(ms: number, fn: () => void): () => void;
};

export function canvasPixels(video: HTMLVideoElement, cfg: FrameSamplerConfig): FramePixels {
  let thumbCtx: OffscreenCanvasRenderingContext2D | null = null;
  return {
    thumb() {
      if (thumbCtx === null) {
        const ctx = new OffscreenCanvas(cfg.thumb.w, cfg.thumb.h).getContext("2d", { willReadFrequently: true });
        if (ctx === null) throw new Error("2d context unavailable");
        ctx.imageSmoothingQuality = "high"; // thin chalk lines alias away at 64 px otherwise
        thumbCtx = ctx;
      }
      thumbCtx.drawImage(video, 0, 0, cfg.thumb.w, cfg.thumb.h);
      return lumaFromRgba(thumbCtx.getImageData(0, 0, cfg.thumb.w, cfg.thumb.h).data);
    },
    async jpegBase64(w, h) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("2d context unavailable");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: cfg.jpegQuality });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    },
  };
}

/**
 * R2: "Ad time never becomes evidence." Looks the player up on every call (YouTube
 * can swap it on navigation) and fails closed: no player to ask means an ad may be playing.
 * The sampler has no source duration, so only the DOM signal applies here; callers
 * who hold the duration inject their own createAdProbe.
 */
function defaultAdProbe(video: HTMLVideoElement): () => boolean {
  return () => {
    const found = findPlayer();
    return found === null ? true : createAdProbe(found.player, video, () => null)();
  };
}

function browserFrameDeps(video: HTMLVideoElement, cfg: FrameSamplerConfig): FrameDeps {
  return {
    pixels: canvasPixels(video, cfg),
    isHidden: () => document.hidden,
    adShowing: defaultAdProbe(video),
    every: (ms, fn) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
  };
}

const DETAIL: Record<HealthCause, string> = {
  tab_hidden: "tab hidden: Chrome stops decoding background video, no frames sampled",
  decode_stalled: `media time advanced ${STALL_MEDIA_S}s with the tab visible and no video frame presented`,
  readback: "canvas readback failed",
  size: "video size cannot be normalized into Jev's bounds",
  encode: "JPEG encoding failed",
};

type FrameChannel = Extract<CaptureFactBody, { kind: "channel" }>;

/**
 * Samples video frames while observing and proposes candidates (`frame` facts).
 * Driven by requestVideoFrameCallback and gated on media-time progress, so a
 * paused video costs nothing and a seek is just another sample.
 *
 * Never invented: a frame fact is one real presented frame, drawn at the moment
 * of the decision. A hidden tab or a decode stall produces a `channel` fact, never a frame.
 */
export function createFrameSampler(video: HTMLVideoElement, emit: Emit, videoId: () => string, cfg: FrameSamplerConfig, deps: Partial<FrameDeps> = {}): FrameSampler {
  const d: FrameDeps = { ...browserFrameDeps(video, cfg), ...deps };
  let observing = false;
  let disposed = false;
  let fs = freshFrameState;
  let fsVideoId = "";
  let health = initialHealth;
  let stallBaseT: number | null = null;
  let lastCheckT: number | null = null;
  let epoch = 0; // bumped on every on/off flip, so an encode begun in one capture cannot land in the next

  const report = (r: "ok" | "stalled" | "failed" | null, cause: HealthCause, vid: string, atMediaS: number, extra = "") => {
    if (r === null) return;
    const fact: FrameChannel = {
      kind: "channel",
      channel: "frames",
      health: r,
      videoId: vid === "" ? null : vid,
      atMediaS: Number.isFinite(atMediaS) && atMediaS >= 0 ? media(atMediaS) : null,
      detail: r === "ok" ? "frames flowing" : `${DETAIL[cause]}${extra}`,
    };
    emit(fact);
  };
  const fail = (cause: HealthCause, vid: string, atMediaS: number, extra = "") => {
    const r = degrade(health, cause);
    health = r.health;
    report(r.report, cause, vid, atMediaS, extra);
  };
  const ok = (causes: readonly HealthCause[], fromUnknown: boolean, vid: string, atMediaS: number) => {
    const r = recover(health, causes, fromUnknown);
    health = r.health;
    report(r.report, "readback", vid, atMediaS);
  };

  const resetStall = () => {
    stallBaseT = null;
    lastCheckT = null;
  };

  const keepFrame = async (k: FrameKeep, vid: string, t: number, size: { readonly w: number; readonly h: number }) => {
    const startedIn = epoch;
    // The encode is async: the world can change between the decision and the bytes.
    const stale = () => disposed || !observing || epoch !== startedIn || d.isHidden() || d.adShowing();
    let jpegBase64: string;
    try {
      jpegBase64 = await d.pixels.jpegBase64(size.w, size.h);
    } catch (e) {
      if (!stale()) fail("encode", vid, t, `: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (stale()) return;
    emit({ kind: "frame", videoId: vid, frameId: crypto.randomUUID(), mediaS: media(t), width: size.w, height: size.h, trigger: k.trigger, diff: k.diff, jpegBase64 });
    ok(["size", "encode"], false, vid, t);
  };

  const onFrame = (t: number) => {
    const vid = videoId();
    if (vid !== fsVideoId) {
      fs = freshFrameState; // next video in the same tab: its first frame is a "first"
      fsVideoId = vid;
    }
    if (!observing || vid === "") return;
    if (d.isHidden() || d.adShowing()) {
      resetStall();
      return;
    }
    stallBaseT = t;
    lastCheckT = t;
    ok(["tab_hidden", "decode_stalled"], false, vid, t);
    if (video.videoWidth === 0 || video.videoHeight === 0) return; // no picture yet
    if (!shouldSample(fs, t, cfg)) return;
    const size = normalizedSize(video.videoWidth, video.videoHeight);
    if (size === null) {
      fs = { ...fs, lastSampleT: t };
      fail("size", vid, t, ` (${video.videoWidth}x${video.videoHeight})`);
      return;
    }
    let thumb: Uint8Array;
    try {
      thumb = d.pixels.thumb();
    } catch (e) {
      fs = { ...fs, lastSampleT: t }; // a tainted canvas throws on every read; retry once per sample interval, not per frame
      fail("readback", vid, t, `: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    ok(["readback"], true, vid, t);
    const r = stepFrame(fs, t, thumb, cfg);
    fs = r.state;
    if (r.keep !== null) void keepFrame(r.keep, vid, t, size);
  };

  const check = () => {
    if (!observing || disposed) return;
    const vid = videoId();
    if (vid === "") return;
    if (video.paused || video.ended || video.seeking || d.adShowing()) {
      resetStall();
      return;
    }
    const t = video.currentTime;
    if (d.isHidden()) {
      resetStall();
      fail("tab_hidden", vid, t);
      return;
    }
    // Playback moves at most rate seconds per 1 s tick; anything else was a seek, so the old baseline says nothing.
    if (lastCheckT !== null && (t < lastCheckT || t - lastCheckT > Math.max(video.playbackRate, 1) + STALL_JUMP_SLACK_S)) resetStall();
    lastCheckT = t;
    if (stallBaseT === null) stallBaseT = t;
    else if (t - stallBaseT >= STALL_MEDIA_S) fail("decode_stalled", vid, t);
  };

  video.addEventListener("seeking", resetStall);
  video.addEventListener("seeked", resetStall);

  let handle = 0;
  const loop: VideoFrameRequestCallback = (_now, meta) => {
    if (disposed) return;
    handle = video.requestVideoFrameCallback(loop);
    onFrame(meta.mediaTime);
  };
  handle = video.requestVideoFrameCallback(loop);
  const stopInterval = d.every(1000, check);

  return {
    setObserving(on) {
      if (on === observing) return;
      observing = on;
      epoch++;
      fs = freshFrameState; // a resumed capture starts with a "first" frame of what is on screen
      fsVideoId = "";
      resetStall();
    },
    dispose() {
      disposed = true;
      observing = false;
      stopInterval();
      video.removeEventListener("seeking", resetStall);
      video.removeEventListener("seeked", resetStall);
      video.cancelVideoFrameCallback(handle);
    },
  };
}
