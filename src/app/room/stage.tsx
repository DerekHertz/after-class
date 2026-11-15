import { useLayoutEffect, useRef } from "react";
import type { SceneId } from "../appearance";
import { layoutRoom } from "./layout";
import type { Composition, Size } from "./layout";
import { buildScene } from "./scene";
import type { Draw, DrawList, Specks } from "./scene";
import { pieces } from "./paint";
import { ROOM_LAYER_ART } from "./art";
import type { Scale } from "./paint";

/**
 * The canvas behind the room's text and controls. It paints the draw list of `scene` at the window's device pixels and
 * repaints only when the room, its size or a decoded picture changes, or while the list says something moves, which it does
 * only when `motion` is on (room/motion.ts). Until every
 * picture of a room has decoded it keeps the room it last finished, or stays empty so the page's backdrop shows through.
 * Its `data-stage` attribute says which, and front-row.css holds the room's words back only while it is `waiting`.
 */
export function RoomStage({ scene, composition, motion }: { readonly scene: SceneId; readonly composition: Composition; readonly motion: boolean }) {
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
  useLayoutEffect(() => { stageRef.current?.show(scene, composition, motion); }, [scene, composition, motion]);
  return <canvas ref={canvasRef} className="front-row-canvas" aria-hidden="true" />;
}

/**
 * `waiting` until the stage has painted a room, `painted` once it has, and `off` when this browser gives the stage no
 * canvas it can size and draw on, so the page's backdrop stays the room's picture.
 */
type StageState = "waiting" | "painted" | "off";
const setState = (canvas: HTMLCanvasElement, state: StageState) => { canvas.dataset.stage = state; };

type Wanted = { readonly scene: SceneId; readonly composition: Composition; readonly motion: boolean };
/** The canvas's box: its size in CSS pixels and the device pixels of its backing store. */
type Box = { readonly css: Size; readonly device: Size };

class Stage {
  private wanted: Wanted | null = null;
  private shown: SceneId | null = null;
  private box: Box | null = null;
  private frame: number | null = null;
  /** Waits out the time until the list's `next`, so a room that changes a few times a second does not wake every frame. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set when a change arrived while the tab was hidden, so the stage paints it once the tab shows again. */
  private stale = false;
  /** The pictures this stage waits on, so it stops waiting on those of a room it no longer shows. */
  private readonly awaited = new Set<Picture>();
  private readonly observer: ResizeObserver;
  /** Set where the observer sees only CSS pixels, as in Safari, to catch a change of pixel ratio that keeps the CSS size. */
  private ratio: MediaQueryList | null = null;
  private readonly onVisibility = () => { if (!document.hidden && this.stale) this.paint(); };

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
    canvas.addEventListener("contextrestored", this.paint);
  }

  show(scene: SceneId, composition: Composition, motion: boolean): void {
    this.wanted = { scene, composition, motion };
    this.paint();
  }

  stop(): void {
    this.observer.disconnect();
    this.ratio?.removeEventListener("change", this.onRatio);
    this.release();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("contextrestored", this.paint);
    this.cancelFrame();
    this.wanted = null;
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
    if (wanted === null || box === null || box.css.width === 0 || box.css.height === 0) return;
    this.stale = document.hidden;
    if (this.stale) return;
    const now = wanted.motion ? performance.now() : null;
    const list = (scene: SceneId) => buildScene(scene, layoutRoom(scene, box.css, wanted.composition), now);
    let drawn: DrawList | null = list(wanted.scene);
    if (this.decoded(drawn)) this.shown = wanted.scene;
    else drawn = this.shown === null ? null : list(this.shown);
    if (drawn !== null && !this.decoded(drawn)) drawn = null;
    const { context } = this;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, box.device.width, box.device.height);
    if (drawn !== null) for (const draw of drawn.draws) paintDraw(context, draw, scaleOf(box));
    setState(this.canvas, drawn === null ? "waiting" : "painted");
    if (drawn?.next != null) {
      this.timer = setTimeout(() => { this.timer = null; this.frame = requestAnimationFrame(this.paint); }, Math.max(0, drawn.next - performance.now()));
    }
  };

  /**
   * Whether every picture `list` draws has settled, decoded or failed. Starts any that have not, and repaints when one
   * settles. A picture that failed is left out of the room rather than holding the room back.
   */
  private decoded(list: DrawList): boolean {
    let all = true;
    for (const draw of list.draws) {
      if (draw.kind === "specks") continue;
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

function paintDraw(context: CanvasRenderingContext2D, draw: Draw, scale: Scale): void {
  if (draw.kind === "specks") return paintSpecks(context, draw, scale);
  const { image, state } = pictures.get(draw.src)!;
  if (state !== "decoded") return;
  const smooth = draw.kind === "image" && draw.sampling === "smooth";
  context.imageSmoothingEnabled = smooth;
  if (smooth) context.imageSmoothingQuality = "medium";
  for (const { sx, sy, sw, sh, dx, dy, dw, dh } of pieces(draw, { width: image.naturalWidth, height: image.naturalHeight }, scale)) {
    context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

/** Fills each speck on whole device pixels, at least one, so a speck is never smeared across two. */
function paintSpecks(context: CanvasRenderingContext2D, { color, alpha, rects }: Specks, scale: Scale): void {
  context.fillStyle = color;
  context.globalAlpha = alpha;
  for (const { left, top, width, height } of rects) {
    const [x, y] = [Math.round(left * scale.x), Math.round(top * scale.y)];
    context.fillRect(x, y, Math.max(1, Math.round((left + width) * scale.x) - x), Math.max(1, Math.round((top + height) * scale.y) - y));
  }
  context.globalAlpha = 1;
}
