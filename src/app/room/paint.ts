import type { Size } from "./layout";
import type { CompanionDraw, Draw, PictureDraw } from "./scene";

/** Where the stage is with a picture: still loading or decoding, ready to draw, or failed and left out. */
export type PictureState = "pending" | "decoded" | "failed";

/**
 * What of `draws` to paint now, or null while the room waits. The room waits until every layer's picture has settled, and
 * a layer that failed is left out rather than holding it. The companion passes through, as the stage picks its frame or
 * stand-in itself, and so do the specks and the balloon, which need no picture.
 */
export function readyDraws(draws: readonly Draw[], state: (src: string) => PictureState): readonly Draw[] | null {
  let waits = false;
  const ready = draws.filter((draw) => {
    if (draw.kind === "companion" || draw.kind === "specks" || draw.kind === "balloon") return true;
    const settled = state(draw.src);
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
 * the same layer on when CSS drew it, so the canvas keeps the room's pixels. An edge fill takes its one row or column of source pixels.
 */
export function pieces(draw: PictureDraw | CompanionDraw, natural: Size, scale: Scale): readonly Piece[] {
  const box = snap(draw, scale);
  const { width: w, height: h } = natural;
  const [dx, dy, dw, dh] = [box.left, box.top, box.right - box.left, box.bottom - box.top];
  if (draw.kind === "image") return [{ sx: 0, sy: 0, sw: w, sh: h, dx, dy, dw, dh }];
  if (draw.kind === "companion") {
    const sw = w / draw.columns;
    return [{ sx: sw * draw.column, sy: 0, sw, sh: h, dx, dy, dw, dh }];
  }
  switch (draw.edge) {
    case "left": return [{ sx: 0, sy: 0, sw: 1, sh: h, dx, dy, dw, dh }];
    case "right": return [{ sx: w - 1, sy: 0, sw: 1, sh: h, dx, dy, dw, dh }];
    case "top": return [{ sx: 0, sy: 0, sw: w, sh: 1, dx, dy, dw, dh }];
    case "bottom": return [{ sx: 0, sy: h - 1, sw: w, sh: 1, dx, dy, dw, dh }];
  }
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
  const [left, right] = snapSpan(rect.left, rect.width, s.x, kind !== "edge");
  const [top, bottom] = snapSpan(rect.top, rect.height, s.y, kind !== "edge");
  return { left, right, top, bottom };
}
