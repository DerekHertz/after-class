import type { Rect, Size } from "./layout";
import type { CompanionDraw, Draw, PictureDraw, Shade } from "./scene";

/** Where the stage is with a picture: still loading or decoding, ready to draw, or failed and left out. */
export type PictureState = "pending" | "decoded" | "failed";

/**
 * What of `draws` to paint now, or null while the room waits. The room waits until every layer's picture has settled, and
 * a layer that failed is left out rather than holding it. An unlocked object never holds the room: it is left out until its
 * picture decodes. The companion passes through, as the stage picks its frame or stand-in itself, and so do the specks and
 * the shade, which need no picture.
 */
export function readyDraws(draws: readonly Draw[], state: (src: string) => PictureState): readonly Draw[] | null {
  let waits = false;
  const ready = draws.filter((draw) => {
    if (draw.kind === "companion" || draw.kind === "specks" || draw.kind === "shade") return true;
    const settled = state(draw.src);
    if (draw.kind === "image" && draw.unlock !== undefined) return settled === "decoded";
    if (settled === "pending") waits = true;
    return true;
  });
  return waits ? null : ready;
}

/** Device pixels per CSS pixel on each axis. */
export type Scale = { readonly x: number; readonly y: number };

/** One `drawImage` call: the picture's source rect in its own pixels and the destination rect in device pixels. */
export type Piece = {
  readonly sx: number; readonly sy: number; readonly sw: number; readonly sh: number;
  readonly dx: number; readonly dy: number; readonly dw: number; readonly dh: number;
};

/**
 * The `drawImage` calls that paint `draw` from a picture of `natural` size at `scale`, on the device pixels Chrome painted
 * the same layer on when CSS drew it, so the canvas keeps the room's pixels.
 */
export function pieces(draw: PictureDraw | CompanionDraw, natural: Size, scale: Scale): readonly Piece[] {
  const box = snap(draw, scale);
  const { width: w, height: h } = natural;
  if (draw.kind === "image") {
    const whole = { sx: 0, sy: 0, sw: w, sh: h, dx: box.left, dy: box.top, dw: box.right - box.left, dh: box.bottom - box.top };
    if (draw.beside === undefined) return [whole];
    // Each part keeps the whole picture's mapping from device pixels to its own, so each pixel lands where it would.
    const k = w / whole.dw;
    return beside(draw.beside, scale, box.left, box.right).map(([from, to]) => ({ ...whole, sx: (from - box.left) * k, sw: (to - from) * k, dx: from, dw: to - from }));
  }
  if (draw.kind === "companion") {
    const sw = w / draw.columns;
    return [{ sx: sw * draw.column, sy: 0, sw, sh: h, dx: box.left, dy: box.top, dw: box.right - box.left, dh: box.bottom - box.top }];
  }
  const { slice, border } = draw;
  // As Chrome paints border-image: each border width floors to whole device pixels, measured in from the snapped box's own
  // edges, after widths that would overlap all shrink by one factor.
  const fit = Math.min(1, (box.right - box.left) / ((border.left + border.right) * scale.x || 1), (box.bottom - box.top) / ((border.top + border.bottom) * scale.y || 1));
  const width = (edge: number, s: number) => Math.floor(edge * s * fit);
  const xs = [box.left, box.left + width(border.left, scale.x), box.right - width(border.right, scale.x), box.right];
  const ys = [box.top, box.top + width(border.top, scale.y), box.bottom - width(border.bottom, scale.y), box.bottom];
  const us = [0, slice.left, w - slice.right, w];
  const vs = [0, slice.top, h - slice.bottom, h];
  const out: Piece[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const piece = { sx: us[col]!, sy: vs[row]!, sw: us[col + 1]! - us[col]!, sh: vs[row + 1]! - vs[row]!, dx: xs[col]!, dy: ys[row]!, dw: xs[col + 1]! - xs[col]!, dh: ys[row + 1]! - ys[row]! };
    if (piece.sw > 0 && piece.sh > 0 && piece.dw > 0 && piece.dh > 0) out.push(piece);
  }
  return out;
}

/** Whole device pixels, from the stage's top left. */
export type DeviceBox = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * The device columns from `from` to `to` that lie left and right of those an image laid in `rect` covers at `scale`, as
 * [start, end) spans. A picture drawn in them and the image meet with no gap and no overlap, whatever the fractions.
 */
export function beside(rect: Rect, scale: Scale, from: number, to: number): readonly (readonly [number, number])[] {
  const [left, right] = snapSpan(rect.left, rect.width, scale.x, true);
  return ([[from, Math.min(left, to)], [Math.max(right, from), to]] as const).filter(([start, end]) => end > start);
}

/** The device pixels `shade` covers on a stage of `device` pixels. */
export function shadeBoxes(shade: Shade, scale: Scale, device: Size): readonly DeviceBox[] {
  return beside(shade.beside, scale, 0, device.width).map(([from, to]) => ({ x: from, y: 0, width: to - from, height: device.height }));
}

/**
 * Snaps a span of `start` and `size` CSS pixels to whole device pixels as Chrome snaps a box: each value truncates to
 * 1/64 pixel, the start rounds half up, and the size rounds together with the start's signed fraction. A background
 * image also ends no later than its rounded size from the start, as Chrome's BackgroundImageGeometry clips its tile.
 */
function snapSpan(start: number, size: number, scale: number, image: boolean): readonly [number, number] {
  const fixed = (v: number) => Math.trunc(v * scale * 64) / 64;
  const round = (v: number) => Math.floor(v + 0.5);
  const [at, length] = [fixed(start), fixed(size)];
  const fraction = at % 1;
  const from = round(at);
  const to = from + round(fraction + length) - round(fraction);
  return [from, image ? Math.min(to, from + round(length)) : to];
}

function snap({ rect, kind }: PictureDraw | CompanionDraw, s: Scale) {
  const [left, right] = snapSpan(rect.left, rect.width, s.x, kind !== "nine-slice");
  const [top, bottom] = snapSpan(rect.top, rect.height, s.y, kind !== "nine-slice");
  return { left, right, top, bottom };
}
