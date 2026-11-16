import type { SceneId } from "../appearance";
import { ambientDraws } from "./ambient";
import { ROOM_LAYER_ART } from "./art";
import { companionAt, companionDraw } from "./companion";
import { FRONT_ROW_ROOMS } from "./rooms";
import type { CompanionCue, Frame, Idle } from "./companion";
import { BALLOON_AT, BALLOON_CELLS } from "./balloon";
import type { Edge, Rect, RoomLayout } from "./layout";

/**
 * How a picture is resampled to its box. The room's plate is pixelated, as the HD pixel look needs. A phone's backdrop is
 * smooth, as `.scene-shell::before` draws it on every other page, so the review does not change the picture under the learner.
 */
export type Sampling = "pixelated" | "smooth";

/**
 * One thing the stage paints, in CSS pixels of the stage. `src` names the picture by its bundle URL. `image` draws the whole
 * picture into `rect`. `edge` stretches the plate's outermost row or column of pixels over `rect`, to fill what the plate
 * does not cover with its own edge colours. `companion` draws column `column` of `columns` equal cells of its picture,
 * pixelated, with the companion's drop shadow. It never holds the room back: until its picture decodes the stage draws
 * `standIn` in its place, or nothing.
 */
export type PictureDraw =
  | { readonly kind: "image"; readonly src: string; readonly rect: Rect; readonly sampling: Sampling }
  | { readonly kind: "edge"; readonly src: string; readonly edge: Edge; readonly rect: Rect };
export type CompanionDraw = {
  readonly kind: "companion"; readonly frame: Frame; readonly src: string; readonly rect: Rect; readonly column: number; readonly columns: number;
  readonly standIn: CompanionDraw | null;
};

/** Plain squares of one colour at one opacity, in CSS pixels of the stage: the ambient specks of room/ambient.ts. */
export type Specks = { readonly kind: "specks"; readonly color: string; readonly alpha: number; readonly rects: readonly Rect[] };

/** The question balloon over a waiting companion, drawn from cells (room/balloon.ts) into `rect`. */
export type BalloonDraw = { readonly kind: "balloon"; readonly rect: Rect };

/** Pictures stay put until the room or the window changes. The companion, its balloon and the specks change as the room moves. */
export type Draw = PictureDraw | CompanionDraw | Specks | BalloonDraw;

/**
 * What the stage paints, back to front. `next` is the `performance.now()` time at which the list changes by itself, so the
 * stage runs its frame loop only while it is not null. It is null while the room is still, and the stage then paints only
 * when the room, the window or a decoded picture changes. `ahead` names pictures the list will draw soon, to decode now.
 */
export type DrawList = { readonly draws: readonly Draw[]; readonly next: number | null; readonly ahead?: readonly string[] };

/** The companion the room shows, its idle clock, and the device pixels per CSS pixel it is drawn at. */
export type CompanionScene = { readonly cue: CompanionCue; readonly idle: Idle; readonly ratio: number };

/**
 * Depths of the room's own layers: the plate is 0, and the ambient life of room/ambient.ts sits between its depths. The plate is
 * one picture, so the board, desk and mat are in it. The companion is in front of everything.
 */
const DEPTH = { plate: 0 } as const;

/**
 * The draw list of `scene` laid out as `layout`: the plate's edge fills, the plate, the ambient life, then the companion and
 * its balloon. `now` is the `performance.now()` time of the frame, or null while the room is still (see motion.ts): the
 * room's ambient life is drawn only for a time. Unlocked objects are not drawn for now (room/unlocks.ts keeps their slots).
 */
export function buildScene(scene: SceneId, layout: RoomLayout, now: number | null = null, companion: CompanionScene | null = null): DrawList {
  const art = ROOM_LAYER_ART[scene];
  if (layout.composition === "compact") {
    return { draws: [{ kind: "image", src: art.background, rect: layout.layers.background, sampling: "smooth" }], next: null };
  }
  const fills = layout.fills.map(({ edge, rect }): Draw => ({ kind: "edge", src: art.plate, edge, rect }));
  const layered: { readonly z: number; readonly draw: Draw }[] = [{ z: DEPTH.plate, draw: { kind: "image", src: art.plate, rect: layout.plate, sampling: "pixelated" } }];
  const ambient = now === null ? null : ambientDraws(scene, layout, now);
  if (ambient !== null) layered.push(...ambient.draws);
  const draws = [...fills, ...layered.sort((a, b) => a.z - b.z).map(({ draw }) => draw)];
  if (companion === null) return { draws, next: ambient?.next ?? null };
  const shown = companionAt(companion.cue, companion.idle, now);
  const { draw, files } = companionDraw(companion.cue.id, shown, layout.companion.box, companion.ratio, FRONT_ROW_ROOMS[scene].plate.companion.height);
  const next = [ambient?.next, shown.next].filter((at): at is number => at != null);
  const balloon = companion.cue.activity === "waiting" ? [balloonDraw(layout.companion.box)] : [];
  return { draws: [...draws, draw, ...balloon], next: next.length === 0 ? null : Math.min(...next), ahead: files };
}

/** The balloon over the companion's cell `box`: its tail's tip just over the companion's head, a little right of its middle. */
function balloonDraw(box: Rect): Draw {
  const width = BALLOON_AT.width * box.height;
  const height = (width * BALLOON_CELLS.height) / BALLOON_CELLS.width;
  return { kind: "balloon", rect: { left: box.left + box.width / 2 + BALLOON_AT.left * box.height, top: box.top + BALLOON_AT.tip * box.height - height, width, height } };
}
