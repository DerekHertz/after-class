import type { SceneId } from "../appearance";
import type { FullRoomLayout, Rect } from "./layout";
import { FRONT_ROW_ROOMS } from "./rooms";
import type { Draw, Specks } from "./scene";

type Hex = `#${string}`;

/**
 * A span of the room, in pixels of its 16:10 core from the core's top left (the mockup's pixels). The plate's strips lie
 * beyond the core, so a region may start left of 0 or run past its width.
 */
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
 * Each room's ambient life, measured on the room's core. Only the harbor's water glints: Derek found falling rain and
 * floating dust and petals distracting.
 */
export const AMBIENT: { readonly [S in SceneId]: readonly AmbientLayer[] } = {
  "last-desk": [],
  "study-bench": [
    { name: "water glints", depth: "far", region: { x: 420, y: 440, width: 760, height: 105 }, count: 26, size: { width: 4, height: 1 }, speed: { x: 0, y: 0 }, blink: { period: 2.4, on: 0.7 }, color: "#f4fdff", alpha: 0.85 },
    { name: "far glints", depth: "far", region: { x: 1200, y: 440, width: 370, height: 130 }, count: 16, size: { width: 5, height: 1 }, speed: { x: 0, y: 0 }, blink: { period: 3.2, on: 0.8 }, color: "#dff6ff", alpha: 0.7 },
  ],
  "projection-booth": [],
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
 * both in plate pixels from the room's light anchor (`light` in room/rooms.ts),
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
    { name: "window light", depth: "near", from: { x: 0, y: 0 }, to: { x: -402, y: 590 }, width: 272, row: 6, color: "#fff4d6", alpha: { low: 0.08, high: 0.16, period: 9, steps: 4 } },
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
  const { plate: drawn, s: scale } = layout;
  const { core, light: anchor } = FRONT_ROW_ROOMS[scene].plate;
  const onPlate = ({ x, y, width, height }: PlateRegion): Rect => ({ left: drawn.left + x * scale, top: drawn.top + y * scale, width: width * scale, height: height * scale });
  const onStage = (region: PlateRegion): Rect => onPlate({ ...region, x: region.x + core.x });
  const specks = (z: number, color: string, alpha: number, rects: readonly Rect[]) => ({ z, draw: { kind: "specks", color, alpha, rects } as const satisfies Specks });
  const light = LIGHT[scene].map((shaft) => {
    const { alpha, rows } = shaftRows(shaft, seconds);
    return specks(DEPTH_Z[shaft.depth], shaft.color, alpha, rows.map((row) => onPlate({ ...row, x: row.x + anchor.x, y: row.y + anchor.y })));
  });
  // A layer with no speck in view stays in the list, so the stage's runs of still pictures keep their bounds at every step.
  const motes = AMBIENT[scene].map((layer, index) => {
    const rects = speckPositions(layer, index, seconds)
      .map(({ x, y }) => onStage({ x, y, ...layer.size }))
      .filter((rect) => !(layer.clearOfBoard && overlaps(rect, layout.text.board)));
    return specks(DEPTH_Z[layer.depth], layer.color, layer.alpha, rects);
  });
  return { draws: [...light, ...motes], next: ((step + 1) / AMBIENT_FPS) * 1000 };
}
