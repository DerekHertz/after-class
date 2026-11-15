import type { SceneId } from "../appearance";
import { ROOM_LAYER_ART } from "./art";
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
 * screen pixels, and stretches the edges and the middle, as CSS `border-image` with `fill` does.
 */
export type Draw =
  | { readonly kind: "image"; readonly src: string; readonly rect: Rect; readonly sampling: Sampling }
  | { readonly kind: "nine-slice"; readonly src: string; readonly rect: Rect; readonly slice: Edges; readonly border: Edges };

/**
 * What the stage paints, back to front. `next` is the `performance.now()` time at which the list changes by itself, so the
 * stage runs its frame loop only while it is not null. Nothing animates yet, so it is always null and the stage paints only
 * when the room, the window or a decoded picture changes.
 */
export type DrawList = { readonly draws: readonly Draw[]; readonly next: number | null };

/**
 * Depths of the room's own layers, as front-row.css stacked them. Each extra carries its own depth in rooms.ts: 1 behind the
 * board, 3 on it, 6 in front of the desk.
 */
const DEPTH = { background: 0, board: 2, desk: 5, mat: 6 } as const;

/** The draw list of `scene` laid out as `layout`. Layers of equal depth keep the order they are listed in, the mat last. */
export function buildScene(scene: SceneId, layout: RoomLayout): DrawList {
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
  return { draws: layered.sort((a, b) => a.z - b.z).map(({ draw }) => draw), next: null };
}
