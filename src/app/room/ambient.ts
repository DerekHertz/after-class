import type { SceneId } from "../appearance";
import type { FullRoomLayout, Rect } from "./layout";
import { ROOM_ART } from "./rooms";
import type { Draw, Specks } from "./scene";

type Hex = `#${string}`;

/** A span of the room's background, in plate pixels from its top left. */
export type PlateRegion = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * One kind of speck a room has in the air: dust, petals, rain, a glint on the water. All measures are in plate pixels, the
 * pixels of the room's art, so the speck keeps the art's grain and moves a whole plate pixel at a time. `depth` is how far
 * behind the room's surfaces it falls: `far` sits on the background, `mid` behind the board and `near` in front of the board
 * and behind the desk. `speed` is plate pixels per second, and a negative `y` rises. `sway` swings it sideways. `blink` shows
 * it for `on` of every `period` seconds, each speck at its own phase.
 */
export type AmbientLayer = {
  readonly name: string;
  readonly depth: "far" | "mid" | "near";
  readonly region: PlateRegion;
  readonly count: number;
  readonly size: { readonly width: number; readonly height: number };
  readonly speed: { readonly x: number; readonly y: number };
  readonly sway?: { readonly amplitude: number; readonly period: number };
  readonly blink?: { readonly period: number; readonly on: number };
  readonly color: Hex;
  readonly alpha: number;
  /** Specks are left out where they would cross the board, so they never run behind its text. */
  readonly clearOfBoard?: boolean;
};

/** Frames per second the ambient life steps at. Specks hold still between steps, as the art's own grain suggests. */
export const AMBIENT_FPS = 12;

/** Draw order of each depth, between the layers of scene.ts: the background is 0, the board 2, the desk 5. */
const DEPTH_Z = { far: 0.5, mid: 1.5, near: 2.5 } as const;

/**
 * Each room's ambient life. Regions are measured on the room's background, which is also where the window and the sea are.
 * The rail room's petals blow in from the cherry tree in its window, the canal's rain falls in its window, and the harbor's
 * water glints. Dust catches the light in the two rooms with lamps.
 */
export const AMBIENT: { readonly [S in SceneId]: readonly AmbientLayer[] } = {
  "last-desk": [
    { name: "window petals", depth: "far", region: { x: 1262, y: 140, width: 272, height: 450 }, count: 8, size: { width: 4, height: 3 }, speed: { x: -5, y: 12 }, sway: { amplitude: 6, period: 5 }, color: "#f6b6c8", alpha: 0.9 },
    { name: "drifting petals", depth: "mid", region: { x: 0, y: 0, width: 1586, height: 992 }, count: 14, size: { width: 6, height: 4 }, speed: { x: -16, y: 20 }, sway: { amplitude: 14, period: 6 }, color: "#f4a9c0", alpha: 0.85 },
    { name: "near petals", depth: "near", region: { x: 0, y: 0, width: 1586, height: 992 }, count: 6, size: { width: 9, height: 6 }, speed: { x: -30, y: 44 }, sway: { amplitude: 22, period: 4.5 }, color: "#f9c3d3", alpha: 0.8, clearOfBoard: true },
    { name: "dust", depth: "mid", region: { x: 0, y: 40, width: 1586, height: 560 }, count: 18, size: { width: 2, height: 2 }, speed: { x: 3, y: -4 }, blink: { period: 4, on: 2.6 }, color: "#fff1c9", alpha: 0.7 },
  ],
  "study-bench": [
    { name: "water glints", depth: "far", region: { x: 420, y: 440, width: 760, height: 105 }, count: 26, size: { width: 4, height: 1 }, speed: { x: 0, y: 0 }, blink: { period: 2.4, on: 0.7 }, color: "#f4fdff", alpha: 0.85 },
    { name: "far glints", depth: "far", region: { x: 1200, y: 440, width: 370, height: 130 }, count: 16, size: { width: 5, height: 1 }, speed: { x: 0, y: 0 }, blink: { period: 3.2, on: 0.8 }, color: "#dff6ff", alpha: 0.7 },
    { name: "sunlit motes", depth: "mid", region: { x: 0, y: 0, width: 1586, height: 640 }, count: 14, size: { width: 2, height: 2 }, speed: { x: 4, y: -5 }, blink: { period: 5, on: 3 }, color: "#fffbe0", alpha: 0.75 },
    { name: "near motes", depth: "near", region: { x: 0, y: 0, width: 1586, height: 640 }, count: 4, size: { width: 4, height: 4 }, speed: { x: 7, y: -10 }, blink: { period: 6, on: 3.6 }, color: "#fff6c4", alpha: 0.4, clearOfBoard: true },
  ],
  "projection-booth": [
    { name: "window rain", depth: "far", region: { x: 52, y: 158, width: 286, height: 494 }, count: 40, size: { width: 1, height: 5 }, speed: { x: -4, y: 150 }, color: "#a9c4f0", alpha: 0.55 },
    { name: "near window rain", depth: "mid", region: { x: 52, y: 158, width: 286, height: 494 }, count: 16, size: { width: 1, height: 8 }, speed: { x: -7, y: 260 }, color: "#d3e2fb", alpha: 0.6 },
    { name: "lamplit dust", depth: "mid", region: { x: 380, y: 40, width: 1206, height: 640 }, count: 16, size: { width: 2, height: 2 }, speed: { x: 3, y: -4 }, blink: { period: 4.5, on: 2.8 }, color: "#ffd9a0", alpha: 0.65 },
    { name: "near dust", depth: "near", region: { x: 380, y: 40, width: 1206, height: 640 }, count: 4, size: { width: 4, height: 4 }, speed: { x: 6, y: -9 }, blink: { period: 6, on: 3.6 }, color: "#ffdcae", alpha: 0.35, clearOfBoard: true },
  ],
};

/** Mixes two integers into a number in [0, 1), so each speck keeps its place and phase for good without any stored state. */
function unit(layer: number, speck: number, salt: number): number {
  let h = Math.imul(layer + 1, 0x9e3779b1) ^ Math.imul(speck + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const mod = (value: number, size: number) => ((value % size) + size) % size;

/**
 * Where each speck of `layer` is `seconds` after the page loaded, in whole plate pixels of the layer's region. A pure
 * function of the time, so any frame can be drawn alone and a lost frame costs nothing.
 */
export function speckPositions(layer: AmbientLayer, index: number, seconds: number): readonly { readonly x: number; readonly y: number }[] {
  const { region, size, speed, sway, blink } = layer;
  const [spanX, spanY] = [region.width - size.width, region.height - size.height];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < layer.count; i++) {
    const [fx, fy, phase] = [unit(index, i, 0), unit(index, i, 1), unit(index, i, 2)];
    if (blink && mod(seconds / blink.period + phase, 1) * blink.period >= blink.on) continue;
    const swing = sway ? sway.amplitude * Math.sin(2 * Math.PI * (seconds / sway.period + phase)) : 0;
    out.push({
      x: region.x + Math.floor(mod(fx * spanX + speed.x * seconds + swing, spanX + 1)),
      y: region.y + Math.floor(mod(fy * spanY + speed.y * seconds, spanY + 1)),
    });
  }
  return out;
}

/**
 * A shaft of window light: a band of `width` plate pixels whose top edge starts at `from` and whose bottom edge ends at `to`,
 * drawn as plain rows `row` plate pixels tall, each moved sideways a whole plate pixel. Its alpha rises and falls between
 * `alpha.low` and `alpha.high` over `alpha.period` seconds, in `alpha.steps` steps.
 */
export type LightShaft = {
  readonly name: string;
  readonly depth: AmbientLayer["depth"];
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly row: number;
  readonly color: Hex;
  readonly alpha: { readonly low: number; readonly high: number; readonly period: number; readonly steps: number };
};

/**
 * Each room's window light. Only the rail room has a sunlit window: the canal's is a rainy night and the harbor has no
 * walls. The shaft falls from that window down to the left, over the board's edge and onto the wall.
 */
export const LIGHT: { readonly [S in SceneId]: readonly LightShaft[] } = {
  "last-desk": [
    { name: "window light", depth: "near", from: { x: 1262, y: 150 }, to: { x: 860, y: 740 }, width: 272, row: 6, color: "#fff4d6", alpha: { low: 0.08, high: 0.16, period: 9, steps: 4 } },
  ],
  "study-bench": [],
  "projection-booth": [],
};

/** The rows of `shaft` in plate pixels, and its alpha `seconds` after the page loaded. */
export function shaftRows(shaft: LightShaft, seconds: number): { readonly alpha: number; readonly rows: readonly PlateRegion[] } {
  const { from, to, width, row, alpha } = shaft;
  const rows: PlateRegion[] = [];
  for (let y = from.y; y < to.y; y += row) {
    const x = Math.round(from.x + ((to.x - from.x) * (y - from.y)) / (to.y - from.y));
    rows.push({ x, y, width, height: Math.min(row, to.y - y) });
  }
  const wave = 0.5 - 0.5 * Math.cos((2 * Math.PI * seconds) / alpha.period);
  const level = Math.min(alpha.steps - 1, Math.floor(wave * alpha.steps)) / Math.max(1, alpha.steps - 1);
  return { alpha: alpha.low + (alpha.high - alpha.low) * level, rows };
}

const overlaps = (a: Rect, b: Rect) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

/**
 * The specks of `scene` at `now` (milliseconds, `performance.now()`), as draws with their depth, and the time the next step
 * is due. Time is quantised to `AMBIENT_FPS`, so a frame drawn between two steps repeats the last one.
 */
export function ambientDraws(scene: SceneId, layout: FullRoomLayout, now: number): { readonly draws: readonly { readonly z: number; readonly draw: Draw }[]; readonly next: number } {
  const step = Math.floor((now / 1000) * AMBIENT_FPS);
  const seconds = step / AMBIENT_FPS;
  const { background, board } = layout.layers;
  const scale = background.width / ROOM_ART.plate.width;
  const onStage = ({ x, y, width, height }: PlateRegion): Rect => ({ left: background.left + x * scale, top: background.top + y * scale, width: width * scale, height: height * scale });
  const specks = (z: number, color: string, alpha: number, rects: readonly Rect[]) => ({ z, draw: { kind: "specks", color, alpha, rects } as const satisfies Specks });
  const light = LIGHT[scene].map((shaft) => {
    const { alpha, rows } = shaftRows(shaft, seconds);
    return specks(DEPTH_Z[shaft.depth], shaft.color, alpha, rows.map(onStage));
  });
  const motes = AMBIENT[scene].flatMap((layer, index) => {
    const rects = speckPositions(layer, index, seconds)
      .map(({ x, y }) => onStage({ x, y, ...layer.size }))
      .filter((rect) => !(layer.clearOfBoard && overlaps(rect, board.rect)));
    return rects.length === 0 ? [] : [specks(DEPTH_Z[layer.depth], layer.color, layer.alpha, rects)];
  });
  return { draws: [...light, ...motes], next: ((step + 1) / AMBIENT_FPS) * 1000 };
}
