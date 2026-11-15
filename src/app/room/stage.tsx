import { useLayoutEffect, useRef } from "react";
import type { SceneId } from "../appearance";
import { layoutRoom } from "./layout";
import type { Composition, Rect, Size } from "./layout";
import { buildScene } from "./scene";
import type { Draw, DrawList } from "./scene";

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
  private readonly observer: ResizeObserver | null;
  private readonly onVisibility = () => this.paint();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly context: CanvasRenderingContext2D) {
    this.observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => entry && this.resize(entry));
    try {
      this.observer?.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      this.observer?.observe(canvas);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  show(scene: SceneId, composition: Composition): void {
    this.wanted = { scene, composition };
    this.paint();
  }

  stop(): void {
    this.observer?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.wanted = null;
  }

  /** Runs before the browser paints the resized frame, so a cleared backing store is never seen. */
  private resize(entry: ResizeObserverEntry): void {
    const css = { width: entry.contentRect.width, height: entry.contentRect.height };
    const exact = entry.devicePixelContentBoxSize?.[0];
    const device = exact
      ? { width: exact.inlineSize, height: exact.blockSize }
      : { width: Math.round(css.width * devicePixelRatio), height: Math.round(css.height * devicePixelRatio) };
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
    if (drawn?.next != null && !document.hidden) this.frame = requestAnimationFrame(this.paint);
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

type Scale = { readonly x: number; readonly y: number };

/** Edges in device pixels, rounded the way a browser snaps a box to whole pixels. */
const snap = (rect: Rect, s: Scale) => ({
  left: Math.round(rect.left * s.x), right: Math.round((rect.left + rect.width) * s.x),
  top: Math.round(rect.top * s.y), bottom: Math.round((rect.top + rect.height) * s.y),
});

function paintDraw(context: CanvasRenderingContext2D, draw: Draw, s: Scale): void {
  const image = pictures.get(draw.src)!.image;
  const { naturalWidth: w, naturalHeight: h } = image;
  const box = snap(draw.rect, s);
  if (draw.kind === "image") {
    context.imageSmoothingEnabled = draw.sampling === "smooth";
    if (draw.sampling === "smooth") context.imageSmoothingQuality = "medium";
    context.drawImage(image, 0, 0, w, h, box.left, box.top, box.right - box.left, box.bottom - box.top);
    return;
  }
  context.imageSmoothingEnabled = false;
  const { slice, border } = draw;
  // As Chrome paints border-image: each border width rounds to whole device pixels from the snapped box's own edges, and
  // widths that would overlap all shrink by one factor.
  const widths = { left: Math.round(border.left * s.x), right: Math.round(border.right * s.x), top: Math.round(border.top * s.y), bottom: Math.round(border.bottom * s.y) };
  const fit = Math.min(1, (box.right - box.left) / Math.max(1, widths.left + widths.right), (box.bottom - box.top) / Math.max(1, widths.top + widths.bottom));
  const xs = [box.left, box.left + Math.floor(widths.left * fit), box.right - Math.floor(widths.right * fit), box.right];
  const ys = [box.top, box.top + Math.floor(widths.top * fit), box.bottom - Math.floor(widths.bottom * fit), box.bottom];
  const us = [0, slice.left, w - slice.right, w];
  const vs = [0, slice.top, h - slice.bottom, h];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const [sw, sh, dw, dh] = [us[col + 1]! - us[col]!, vs[row + 1]! - vs[row]!, xs[col + 1]! - xs[col]!, ys[row + 1]! - ys[row]!];
    if (sw > 0 && sh > 0 && dw > 0 && dh > 0) context.drawImage(image, us[col]!, vs[row]!, sw, sh, xs[col]!, ys[row]!, dw, dh);
  }
}
