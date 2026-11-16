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

/** Frames per second the ambient life steps at. Specks hold still between steps, as the art's own grain suggests. */
export const AMBIENT_FPS = 12;

/** Draw order of each depth, between the layers of scene.ts: the background is 0, the board 2, the desk 5. */
const DEPTH_Z = { far: 0.5, mid: 1.5, near: 2.5 } as const;

/**
 * A shaft of window light: a band of `width` plate pixels whose top edge starts at `from` and whose bottom edge ends at `to`,
 * both in plate pixels from the room's light anchor (`light` in room/rooms.ts),
 * drawn as plain rows `row` plate pixels tall, each moved sideways a whole plate pixel. Its alpha rises and falls between
 * `alpha.low` and `alpha.high` over `alpha.period` seconds, in `alpha.steps` steps.
 */
export type LightShaft = {
  readonly name: string;
  readonly depth: keyof typeof DEPTH_Z;
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

/**
 * The specks of `scene` at `now` (milliseconds, `performance.now()`), as draws with their depth, and the time the next step
 * is due. Time is quantised to `AMBIENT_FPS`, so a frame drawn between two steps repeats the last one.
 */
export function ambientDraws(scene: SceneId, layout: FullRoomLayout, now: number): { readonly draws: readonly { readonly z: number; readonly draw: Draw }[]; readonly next: number | null } {
  const step = Math.floor((now / 1000) * AMBIENT_FPS);
  const seconds = step / AMBIENT_FPS;
  const { plate: drawn, s: scale } = layout;
  const { light: anchor } = FRONT_ROW_ROOMS[scene].plate;
  const onPlate = ({ x, y, width, height }: PlateRegion): Rect => ({ left: drawn.left + x * scale, top: drawn.top + y * scale, width: width * scale, height: height * scale });
  const specks = (z: number, color: string, alpha: number, rects: readonly Rect[]) => ({ z, draw: { kind: "specks", color, alpha, rects } as const satisfies Specks });
  const light = LIGHT[scene].map((shaft) => {
    const { alpha, rows } = shaftRows(shaft, seconds);
    return specks(DEPTH_Z[shaft.depth], shaft.color, alpha, rows.map((row) => onPlate({ ...row, x: row.x + anchor.x, y: row.y + anchor.y })));
  });
  // A room with nothing in the air asks for no frame of its own, so it repaints only when its companion moves.
  const draws = light;
  return { draws, next: draws.length === 0 ? null : ((step + 1) / AMBIENT_FPS) * 1000 };
}
