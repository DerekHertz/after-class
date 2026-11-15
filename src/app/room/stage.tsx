import { useLayoutEffect, useRef } from "react";
import type { SceneId } from "../appearance";
import { layoutRoom } from "./layout";
import type { Composition, Rect, Size } from "./layout";
import { buildScene } from "./scene";
import type { CompanionDraw, Draw, DrawList, PictureDraw, Specks } from "./scene";
import { restsFrom } from "./companion";
import type { CompanionCue, Idle } from "./companion";
import { pieces } from "./paint";
import { ROOM_LAYER_ART } from "./art";
import type { Scale } from "./paint";

/**
 * The canvas behind the room's text and controls. It paints the draw list of `scene` at the window's device pixels and
 * repaints only when the room, its size or a decoded picture changes, or while the list says something moves. Until every
 * picture of a room has decoded it keeps the room it last finished, or stays empty so the page's backdrop shows through.
 * Its `data-stage` attribute says which, and front-row.css holds the room's words back only while it is `waiting`.
 * `companion` draws the companion in front of the room, animated only while `motion` is on (room/motion.ts). The frame it
 * last drew is the canvas's `data-companion` attribute.
 */
export function RoomStage({ scene, composition, motion, companion }: {
  readonly scene: SceneId;
  readonly composition: Composition;
  readonly motion: boolean;
  readonly companion: CompanionCue | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context || typeof ResizeObserver === "undefined") {
      setState(canvas, "off");
      return;
    }
    const stage = new Stage(canvas, context);
    stageRef.current = stage;
    return () => { stage.stop(); stageRef.current = null; };
  }, []);
  // The cue is rebuilt from its fields so a render that changes none of them, as typing in the answer does, never repaints.
  const { id, activity } = companion ?? {};
  const gesture = companion?.gesture?.name;
  const at = companion?.gesture?.at;
  useLayoutEffect(() => {
    const cue = id === undefined || activity === undefined ? null : { id, activity, gesture: gesture === undefined || at === undefined ? null : { name: gesture, at } };
    stageRef.current?.show({ scene, composition, motion, companion: cue });
  }, [scene, composition, motion, id, activity, gesture, at]);
  return <canvas ref={canvasRef} className="front-row-canvas" aria-hidden="true" />;
}

/**
 * `waiting` until the stage has painted a room, `painted` once it has, and `off` when this browser gives the stage no
 * canvas it can size and draw on, so the page's backdrop stays the room's picture.
 */
type StageState = "waiting" | "painted" | "off";
const setState = (canvas: HTMLCanvasElement, state: StageState) => { canvas.dataset.stage = state; };

type Wanted = { readonly scene: SceneId; readonly composition: Composition; readonly motion: boolean; readonly companion: CompanionCue | null };
/** The canvas's box: its size in CSS pixels and the device pixels of its backing store. */
type Box = { readonly css: Size; readonly device: Size };

class Stage {
  private wanted: Wanted | null = null;
  private shown: SceneId | null = null;
  private box: Box | null = null;
  private frame: number | null = null;
  /** Waits out the time until the list's `next`, so a room that changes a few times a second does not wake every frame. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Idle blinks count from when the stage started or the last gesture ended, at intervals drawn from a seed of its own. */
  private idle: Idle = { since: performance.now(), seed: Math.floor(Math.random() * 2 ** 32) };
  /** Set when a change arrived while the tab was hidden, so the stage paints it once the tab shows again. */
  private stale = false;
  /** The pictures this stage waits on, so it stops waiting on those of a room it no longer shows. */
  private readonly awaited = new Set<Picture>();
  /** What the stage last painted of a room in motion, or null while the room is still or its pixels are gone. */
  private moving: Moving | null = null;
  private readonly observer: ResizeObserver;
  /** Set where the observer sees only CSS pixels, as in Safari, to catch a change of pixel ratio that keeps the CSS size. */
  private ratio: MediaQueryList | null = null;
  /**
   * A hidden tab runs no animation frames, so a step queued before it hid would never come to drop the bands. The stage
   * drops them here, stops stepping, and paints the room afresh once the tab shows again.
   */
  private readonly onVisibility = () => {
    if (!document.hidden) {
      if (this.stale) this.paint();
      return;
    }
    this.cancelFrame();
    this.forget();
    this.stale = this.wanted !== null;
  };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly context: CanvasRenderingContext2D) {
    setState(canvas, "waiting");
    this.observer = new ResizeObserver(([entry]) => entry && this.resize({ width: entry.contentRect.width, height: entry.contentRect.height }, entry.devicePixelContentBoxSize?.[0]));
    try {
      this.observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      this.observer.observe(canvas);
      this.watchRatio();
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    // A browser may drop a hidden canvas's pixels to save memory. It restores the context empty, and nothing else would repaint it.
    canvas.addEventListener("contextrestored", this.restore);
  }

  private readonly restore = (): void => {
    this.forget();
    this.paint();
  };

  show(wanted: Wanted): void {
    if (wanted.companion !== null) this.idle = { ...this.idle, since: Math.max(this.idle.since, restsFrom(wanted.companion)) };
    this.wanted = wanted;
    this.paint();
  }

  stop(): void {
    this.observer.disconnect();
    this.ratio?.removeEventListener("change", this.onRatio);
    this.release();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("contextrestored", this.restore);
    this.cancelFrame();
    this.wanted = null;
    this.forget();
  }

  /** Frees the bands' backing stores at once rather than whenever the collector gets to them. */
  private forget(): void {
    for (const { canvas } of this.moving?.bands ?? []) canvas.width = canvas.height = 0;
    this.moving = null;
  }

  private watchRatio(): void {
    this.ratio = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    this.ratio.addEventListener("change", this.onRatio, { once: true });
  }

  private readonly onRatio = (): void => {
    this.watchRatio();
    if (this.box !== null) this.resize(this.box.css);
  };

  /** Runs before the browser paints the resized frame, so a cleared backing store is never seen. */
  private resize(css: Size, exact?: ResizeObserverSize): void {
    const near = { width: Math.round(css.width * devicePixelRatio), height: Math.round(css.height * devicePixelRatio) };
    // The exact device box can differ from the rounded product by a pixel of snapping. Chrome's device emulation reports it
    // at one pixel per CSS pixel whatever the emulated ratio, so a box that far off is not taken.
    const device = exact && Math.abs(exact.inlineSize - near.width) <= 1 && Math.abs(exact.blockSize - near.height) <= 1
      ? { width: exact.inlineSize, height: exact.blockSize }
      : near;
    this.box = { css, device };
    if (this.canvas.width !== device.width || this.canvas.height !== device.height) {
      this.canvas.width = device.width;
      this.canvas.height = device.height;
      // Resizing cleared the backing store, so what the bands and damage were measured against is gone.
      this.forget();
    }
    this.paint();
  }

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.timer !== null) clearTimeout(this.timer);
    this.frame = this.timer = null;
  }

  private paint = (): void => {
    this.cancelFrame();
    this.release();
    const { wanted, box } = this;
    if (wanted === null || box === null) return;
    if (box.css.width === 0 || box.css.height === 0) {
      this.forget();
      this.stale = true;
      return;
    }
    this.stale = document.hidden;
    if (this.stale) {
      this.forget();
      return;
    }
    const now = wanted.motion ? performance.now() : null;
    const companion = wanted.companion === null ? null : { cue: wanted.companion, idle: this.idle, ratio: scaleOf(box).y };
    const list = (scene: SceneId) => buildScene(scene, layoutRoom(scene, box.css, wanted.composition), now, companion);
    let drawn: DrawList | null = list(wanted.scene);
    if (this.decoded(drawn)) this.shown = wanted.scene;
    else drawn = this.shown === null ? null : list(this.shown);
    if (drawn !== null && !this.decoded(drawn)) drawn = null;
    let companionFrame: string | undefined;
    const painted = (drawn?.draws ?? []).flatMap((draw): Draw[] => {
      if (draw.kind !== "companion") return [draw];
      const shown = this.companion(draw);
      companionFrame = shown?.frame;
      return shown === null ? [] : [shown];
    });
    const { context } = this;
    context.setTransform(1, 0, 0, 1, 0, 0);
    if (drawn?.next == null) {
      this.forget();
      context.clearRect(0, 0, box.device.width, box.device.height);
      for (const draw of painted) paintDraw(context, draw, scaleOf(box));
    } else this.paintMoving(painted, box);
    if (companionFrame === undefined) delete this.canvas.dataset.companion;
    else this.canvas.dataset.companion = companionFrame;
    setState(this.canvas, drawn === null ? "waiting" : "painted");
    for (const src of drawn?.ahead ?? []) picture(src);
    if (drawn?.next != null) {
      // Rounded up, since a timer truncates its delay to whole milliseconds and would wake just before the change, paint the same frame and wait again.
      this.timer = setTimeout(() => { this.timer = null; this.frame = requestAnimationFrame(this.paint); }, Math.max(0, Math.ceil(drawn.next - performance.now())));
    }
  };

  /**
   * Paints a room that moves. Each run of pictures between two live draws comes from its band, painted again only when its
   * pictures or the box change. A step then repaints only the device pixels a changed live draw covered or now covers, in
   * the same order as a whole repaint, so those pixels come out as they would and every other pixel is already right.
   */
  private paintMoving(draws: readonly Draw[], box: Box): void {
    const scale = scaleOf(box);
    const before = this.moving;
    let whole = false;
    const bands: Band[] = [];
    const live: Live[] = [];
    const layers: (Band | LiveDraw)[] = [];
    for (const run of runs(draws)) {
      if ("kind" in run) {
        live.push({ key: JSON.stringify(run), boxes: liveBoxes(run, scale) });
        layers.push(run);
        continue;
      }
      const key = JSON.stringify([box, run]);
      const old = before?.bands[bands.length];
      const band = old?.key === key ? old : paintBand(run, box, key, old?.canvas);
      if (band !== old) whole = true;
      bands.push(band);
      layers.push(band);
    }
    if (before === null || before.bands.length !== bands.length || before.live.length !== live.length) whole = true;
    this.moving = { bands, live };
    const damage = whole || before === null ? null : live.flatMap((now, i) => (now.key === before.live[i]!.key ? [] : [...before.live[i]!.boxes, ...now.boxes]));
    if (damage?.length === 0) return;
    const { context } = this;
    if (damage !== null) {
      context.save();
      context.beginPath();
      for (const { x, y, width, height } of damage) context.rect(x, y, width, height);
      context.clip();
    }
    context.clearRect(0, 0, box.device.width, box.device.height);
    for (const layer of layers) {
      if ("kind" in layer) paintDraw(context, layer, scale);
      else context.drawImage(layer.canvas, 0, 0);
    }
    if (damage !== null) context.restore();
  }

  /** What to paint for the companion: its frame once decoded, else its stand-in once that is, else nothing. Repaints on decode. */
  private companion(draw: CompanionDraw): CompanionDraw | null {
    for (let candidate: CompanionDraw | null = draw; candidate !== null; candidate = candidate.standIn) {
      const entry = picture(candidate.src);
      if (entry.state === "decoded") return candidate;
      if (entry.state === "pending") {
        entry.waiting.add(this.paint);
        this.awaited.add(entry);
      }
    }
    return null;
  }

  /**
   * Whether every picture `list` draws has settled, decoded or failed. Starts any that have not, and repaints when one
   * settles. A picture that failed is left out of the room rather than holding the room back.
   */
  private decoded(list: DrawList): boolean {
    let all = true;
    for (const draw of list.draws) {
      if (!isPicture(draw)) continue;
      const entry = picture(draw.src);
      if (entry.state !== "pending") continue;
      entry.waiting.add(this.paint);
      this.awaited.add(entry);
      all = false;
    }
    return all;
  }

  private release(): void {
    for (const entry of this.awaited) entry.waiting.delete(this.paint);
    this.awaited.clear();
  }
}

/** Device pixels per CSS pixel on each axis, as the backing store was sized. */
const scaleOf = ({ css, device }: Box) => ({ x: device.width / css.width, y: device.height / css.height });

type Picture = { readonly image: HTMLImageElement; state: "pending" | "decoded" | "failed"; readonly waiting: Set<() => void> };
/** Every picture the stage has asked for, decoded once per page and kept, so switching back to a room is instant. */
const pictures = new Map<string, Picture>();

function picture(src: string): Picture {
  const known = pictures.get(src);
  if (known !== undefined) return known;
  const image = new Image();
  image.src = src;
  const entry: Picture = { image, state: "pending", waiting: new Set() };
  pictures.set(src, entry);
  const settle = (state: Picture["state"]) => () => {
    entry.state = state;
    for (const wake of entry.waiting) wake();
    entry.waiting.clear();
  };
  image.decode().then(settle("decoded"), settle("failed"));
  return entry;
}

// A review page preloads its saved room's layers (scripts/build-app.ts). They start decoding as this script runs, so the
// stage can paint the room as soon as it mounts instead of a decode later.
if (typeof document !== "undefined") {
  const art = new Set(Object.values(ROOM_LAYER_ART).flatMap(({ extras, ...layers }) => [...Object.values(layers), ...Object.values(extras)]));
  for (const link of document.querySelectorAll('link[rel="preload"][as="image"]')) {
    const href = link.getAttribute("href");
    if (href !== null && art.has(href)) picture(href);
  }
}

/**
 * A run of pictures painted once onto a canvas of its own, the size of the stage's, so each picture lands on the same device
 * pixels with the same sampling as when the stage paints it directly. `key` names the run and the box it was painted for.
 */
type Band = { readonly key: string; readonly canvas: HTMLCanvasElement };

/** A draw that changes as the room moves. The stage paints it every time rather than keeping it in a band. */
type LiveDraw = Exclude<Draw, PictureDraw>;

/** Whole device pixels, from the stage's top left. */
type DeviceBox = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** A live draw as last painted: `key` names it, and `boxes` hold every device pixel it touched. */
type Live = { readonly key: string; readonly boxes: readonly DeviceBox[] };

/** The bands and live draws of the last frame of a room in motion, back to front. */
type Moving = { readonly bands: readonly Band[]; readonly live: readonly Live[] };

const isPicture = (draw: Draw): draw is PictureDraw => draw.kind === "image" || draw.kind === "nine-slice";

/** `draws` with each run of pictures gathered into an array, and each live draw on its own. */
function runs(draws: readonly Draw[]): readonly (LiveDraw | readonly PictureDraw[])[] {
  const out: (LiveDraw | PictureDraw[])[] = [];
  for (const draw of draws) {
    const last = out.at(-1);
    if (!isPicture(draw)) out.push(draw);
    else if (Array.isArray(last)) last.push(draw);
    else out.push([draw]);
  }
  return out;
}

/** The device pixels `draw` touches. Each new kind of live draw names its own here. */
function liveBoxes(draw: LiveDraw, scale: Scale): readonly DeviceBox[] {
  switch (draw.kind) {
    case "specks": return draw.rects.map((rect) => deviceBox(rect, scale));
    case "companion": {
      const { image } = pictures.get(draw.src)!;
      const shadow = companionShadow(scale);
      return pieces(draw, { width: image.naturalWidth, height: image.naturalHeight }, scale).map(({ dx, dy, dw, dh }) => ({ x: dx, y: dy, width: dw, height: dh + shadow }));
    }
  }
}

/** The drop shadow the companion had as a CSS filter: 4 CSS pixels straight down, unblurred, at a quarter black. */
const companionShadow = (scale: Scale) => Math.round(4 * scale.y);

/** A rect of the stage in whole device pixels, at least one each way, so a speck is never smeared across two. */
function deviceBox({ left, top, width, height }: Rect, scale: Scale): DeviceBox {
  const [x, y] = [Math.round(left * scale.x), Math.round(top * scale.y)];
  return { x, y, width: Math.max(1, Math.round((left + width) * scale.x) - x), height: Math.max(1, Math.round((top + height) * scale.y) - y) };
}

/** Paints `run` onto `reuse` or a new canvas of the stage's size. */
function paintBand(run: readonly PictureDraw[], box: Box, key: string, reuse?: HTMLCanvasElement): Band {
  const { device } = box;
  const canvas = reuse ?? document.createElement("canvas");
  canvas.width = device.width;
  canvas.height = device.height;
  const context = canvas.getContext("2d");
  if (context !== null) for (const draw of run) paintDraw(context, draw, scaleOf(box));
  return { key, canvas };
}

function paintDraw(context: CanvasRenderingContext2D, draw: Draw, scale: Scale): void {
  if (draw.kind === "specks") return paintSpecks(context, draw, scale);
  const { image, state } = pictures.get(draw.src)!;
  if (state !== "decoded") return;
  const smooth = draw.kind === "image" && draw.sampling === "smooth";
  context.imageSmoothingEnabled = smooth;
  if (smooth) context.imageSmoothingQuality = "medium";
  if (draw.kind === "companion") Object.assign(context, { shadowColor: "#00000040", shadowOffsetY: companionShadow(scale) });
  for (const { sx, sy, sw, sh, dx, dy, dw, dh } of pieces(draw, { width: image.naturalWidth, height: image.naturalHeight }, scale)) {
    context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  if (draw.kind === "companion") Object.assign(context, { shadowColor: "transparent", shadowOffsetY: 0 });
}

/** Fills each speck on whole device pixels. */
function paintSpecks(context: CanvasRenderingContext2D, { color, alpha, rects }: Specks, scale: Scale): void {
  context.fillStyle = color;
  context.globalAlpha = alpha;
  for (const rect of rects) {
    const { x, y, width, height } = deviceBox(rect, scale);
    context.fillRect(x, y, width, height);
  }
  context.globalAlpha = 1;
}
