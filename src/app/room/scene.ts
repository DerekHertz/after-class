import type { SceneId } from "../appearance";
import { ambientDraws } from "./ambient";
import { ROOM_LAYER_ART } from "./art";
import { companionAt, companionDraw } from "./companion";
import type { CompanionCue, Frame, Idle } from "./companion";
import type { NineSliceLayer, Rect, RoomLayout } from "./layout";
import { FRONT_ROW_ROOMS } from "./rooms";
import type { Edges } from "./rooms";

/**
 * How a picture is resampled to its box. The room's layers are pixelated, as the HD pixel look needs. A phone's backdrop is
 * smooth, as `.scene-shell::before` draws it on every other page, so the review does not change the picture under the learner.
 */
export type Sampling = "pixelated" | "smooth";

/**
 * One thing the stage paints, in CSS pixels of the stage. `src` names the picture by its bundle URL. `image` draws the whole
 * picture into `rect`. `nine-slice` cuts the picture `slice` asset pixels from each edge, keeps the corners at `border`
 * screen pixels, and stretches the edges and the middle, as CSS `border-image` with `fill` does. `companion` draws column
 * `column` of `columns` equal cells of its picture, pixelated, with the companion's drop shadow. It never holds the room
 * back: until its picture decodes the stage draws `standIn` in its place, or nothing.
 */
export type PictureDraw =
  | { readonly kind: "image"; readonly src: string; readonly rect: Rect; readonly sampling: Sampling }
  | { readonly kind: "nine-slice"; readonly src: string; readonly rect: Rect; readonly slice: Edges; readonly border: Edges };
export type CompanionDraw = {
  readonly kind: "companion"; readonly frame: Frame; readonly src: string; readonly rect: Rect; readonly column: number; readonly columns: number;
  readonly standIn: CompanionDraw | null;
};

/** Plain squares of one colour at one opacity, in CSS pixels of the stage: the ambient specks of room/ambient.ts. */
export type Specks = { readonly kind: "specks"; readonly color: string; readonly alpha: number; readonly rects: readonly Rect[] };

/** Pictures stay put until the room or the window changes. The companion and the specks change as the room moves. */
export type Draw = PictureDraw | CompanionDraw | Specks;

/**
 * What the stage paints, back to front. `next` is the `performance.now()` time at which the list changes by itself, so the
 * stage runs its frame loop only while it is not null. It is null while the room is still, and the stage then paints only
 * when the room, the window or a decoded picture changes. `ahead` names pictures the list will draw soon, to decode now.
 */
export type DrawList = { readonly draws: readonly Draw[]; readonly next: number | null; readonly ahead?: readonly string[] };

/** The companion the room shows, its idle clock, and the device pixels per CSS pixel it is drawn at. */
export type CompanionScene = { readonly cue: CompanionCue; readonly idle: Idle; readonly ratio: number };

/**
 * Depths of the room's own layers, as front-row.css stacked them. Each extra carries its own depth in rooms.ts: 1 behind the
 * board, 3 on it, 6 in front of the desk.
 */
const DEPTH = { background: 0, board: 2, desk: 5, mat: 6 } as const;

/**
 * The draw list of `scene` laid out as `layout`. Layers of equal depth keep the order they are listed in, the mat last, and
 * the companion in front of them all. `now` is the `performance.now()` time of the frame, or null while the room is still
 * (see motion.ts): the room's ambient life is drawn only for a time.
 */
export function buildScene(scene: SceneId, layout: RoomLayout, now: number | null = null, companion: CompanionScene | null = null): DrawList {
  const art = ROOM_LAYER_ART[scene];
  if (layout.composition === "compact") {
    return { draws: [{ kind: "image", src: art.background, rect: layout.layers.background, sampling: "smooth" }], next: null };
  }
  const room = FRONT_ROW_ROOMS[scene];
  const { background, board, desk, mat, extras } = layout.layers;
  const extraArt: Readonly<Record<string, string>> = art.extras;
  const nineSlice = (src: string, layer: NineSliceLayer, slice: Edges): Draw => ({ kind: "nine-slice", src, rect: layer.rect, slice, border: layer.border });
  const layered: { readonly z: number; readonly draw: Draw }[] = [
    { z: DEPTH.background, draw: { kind: "image", src: art.background, rect: background, sampling: "pixelated" } },
    { z: DEPTH.board, draw: nineSlice(art.board, board, room.board.art.slice) },
    { z: DEPTH.desk, draw: nineSlice(art.desk, desk, room.desk.art.slice) },
    ...extras.map((extra) => ({ z: extra.z, draw: { kind: "image", src: extraArt[extra.name]!, rect: extra.rect, sampling: "pixelated" } as const })),
    { z: DEPTH.mat, draw: nineSlice(art.mat, mat, room.mat.art.slice) },
  ];
  const ambient = now === null ? null : ambientDraws(scene, layout, now);
  if (ambient !== null) layered.push(...ambient.draws);
  const draws = layered.sort((a, b) => a.z - b.z).map(({ draw }) => draw);
  if (companion === null) return { draws, next: ambient?.next ?? null };
  const shown = companionAt(companion.cue, companion.idle, now);
  const { draw, files } = companionDraw(companion.cue.id, shown, layout.companion.box, companion.ratio);
  const next = [ambient?.next, shown.next].filter((at): at is number => at != null);
  return { draws: [...draws, draw], next: next.length === 0 ? null : Math.min(...next), ahead: files };
}
