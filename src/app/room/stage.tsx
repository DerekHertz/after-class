import { useLayoutEffect, useRef } from "react";
import type { SceneId } from "../appearance";
import { layoutRoom } from "./layout";
import type { Composition, Size } from "./layout";
import { buildScene } from "./scene";
import type { Draw, DrawList } from "./scene";
import { pieces } from "./paint";
import type { Scale } from "./paint";

/**
 * The canvas behind the room's text and controls. It paints the draw list of `scene` at the window's device pixels and
 * repaints only when the room, its size or a decoded picture changes, or while the list says something moves. Until every
 * picture of a room has decoded it keeps the room it last finished, or stays empty so the page's backdrop shows through.
 */
export function RoomStage({ scene, composition }: { readonly scene: SceneId; readonly composition: Composition }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const stage = new Stage(canvas, context);
    stageRef.current = stage;
    return () => { stage.stop(); stageRef.current = null; };
  }, []);
  useLayoutEffect(() => { stageRef.current?.show(scene, composition); }, [scene, composition]);
  return <canvas ref={canvasRef} className="front-row-canvas" aria-hidden="true" />;
}

type Wanted = { readonly scene: SceneId; readonly composition: Composition };
/** The canvas's box: its size in CSS pixels and the device pixels of its backing store. */
type Box = { readonly css: Size; readonly device: Size };

class Stage {
  private wanted: Wanted | null = null;
  private shown: SceneId | null = null;
  private box: Box | null = null;
  private frame: number | null = null;
  /** Set when a change arrived while the tab was hidden, so the stage paints it once the tab shows again. */
  private stale = false;
  private readonly observer: ResizeObserver | null;
  private readonly onVisibility = () => { if (!document.hidden && this.stale) this.paint(); };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly context: CanvasRenderingContext2D) {
    this.observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => entry && this.resize(entry));
    try {
      this.observer?.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      this.observer?.observe(canvas);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    // A browser may drop a hidden canvas's pixels to save memory. It restores the context empty, and nothing else would repaint it.
    canvas.addEventListener("contextrestored", this.paint);
  }

  show(scene: SceneId, composition: Composition): void {
    this.wanted = { scene, composition };
    this.paint();
  }

  stop(): void {
    this.observer?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("contextrestored", this.paint);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.wanted = null;
  }

  /** Runs before the browser paints the resized frame, so a cleared backing store is never seen. */
  private resize(entry: ResizeObserverEntry): void {
    const css = { width: entry.contentRect.width, height: entry.contentRect.height };
    const near = { width: Math.round(css.width * devicePixelRatio), height: Math.round(css.height * devicePixelRatio) };
    // The exact device box can differ from the rounded product by a pixel of snapping. Chrome's device emulation reports it
    // at one pixel per CSS pixel whatever the emulated ratio, so a box that far off is not taken.
    const exact = entry.devicePixelContentBoxSize?.[0];
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

  private paint = (): void => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    const { wanted, box } = this;
    if (wanted === null || box === null || box.css.width === 0 || box.css.height === 0) return;
    this.stale = document.hidden;
    if (this.stale) return;
    const list = (scene: SceneId) => buildScene(scene, layoutRoom(scene, box.css, wanted.composition));
    let drawn: DrawList | null = list(wanted.scene);
    if (decoded(drawn, this.paint)) this.shown = wanted.scene;
    else drawn = this.shown === null ? null : list(this.shown);
    if (drawn !== null && !decoded(drawn, this.paint)) drawn = null;
    const { context } = this;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, box.device.width, box.device.height);
    if (drawn !== null) for (const draw of drawn.draws) paintDraw(context, draw, scaleOf(box));
    this.canvas.toggleAttribute("data-painted", drawn !== null);
    if (drawn?.next != null) this.frame = requestAnimationFrame(this.paint);
  };
}

/** Device pixels per CSS pixel on each axis, as the backing store was sized. */
const scaleOf = ({ css, device }: Box) => ({ x: device.width / css.width, y: device.height / css.height });

/** Whether every picture `list` draws has decoded. Starts any that have not, and calls `onReady` when one finishes. */
function decoded(list: DrawList, onReady: () => void): boolean {
  let all = true;
  for (const draw of list.draws) if (picture(draw.src, onReady) === null) all = false;
  return all;
}

type Picture = { image: HTMLImageElement; decoded: boolean; readonly waiting: Set<() => void> };
/** Every picture the stage has asked for, decoded once per page and kept, so switching back to a room is instant. */
const pictures = new Map<string, Picture>();

function picture(src: string, onReady: () => void): HTMLImageElement | null {
  let entry = pictures.get(src);
  if (entry === undefined) {
    const image = new Image();
    image.src = src;
    const created: Picture = { image, decoded: false, waiting: new Set() };
    entry = created;
    pictures.set(src, created);
    image.decode().then(() => {
      created.decoded = true;
      for (const wake of created.waiting) wake();
      created.waiting.clear();
    }, () => created.waiting.clear());
  }
  if (entry.decoded) return entry.image;
  entry.waiting.add(onReady);
  return null;
}

function paintDraw(context: CanvasRenderingContext2D, draw: Draw, scale: Scale): void {
  const { image } = pictures.get(draw.src)!;
  const smooth = draw.kind === "image" && draw.sampling === "smooth";
  context.imageSmoothingEnabled = smooth;
  if (smooth) context.imageSmoothingQuality = "medium";
  for (const { sx, sy, sw, sh, dx, dy, dw, dh } of pieces(draw, { width: image.naturalWidth, height: image.naturalHeight }, scale)) {
    context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}
