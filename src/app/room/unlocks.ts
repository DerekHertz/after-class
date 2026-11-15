import type { RoomId, UnlockId } from "./progress";
import type { Anchor, Placement } from "./rooms";
import { ROOM_ART } from "./rooms";

/**
 * A fixed spot in a room where one unlocked object stands. `width` and `height` are its box in `u`, the plate pixels of the
 * room's objects. `place` sets the box on a frame of the room as the room's extras are set. `z` is the depth it is drawn at
 * among the room's layers (scene.ts): 1 in front of the background and behind the board, 3 on the board, 5 on the desk behind
 * the mat. `object` says what the art step paints there. The learner cannot move it (docs/design/live-room/README.md, open
 * question 2).
 */
export type UnlockSlot = {
  readonly id: UnlockId;
  readonly object: string;
  readonly width: number;
  readonly height: number;
  readonly z: 1 | 3 | 5;
  readonly place: Placement;
};

const at = (share: number, offset = 0, align: Anchor["align"] = "start"): Anchor => ({ share, offset, align });

/** A point of the room's background, in plate pixels, so the object stays on its sill or rail at any window. */
const onBackground = (x: number, y: number, alignX: Anchor["align"], alignY: Anchor["align"]): Placement =>
  ({ on: "background", x: at(x / ROOM_ART.plate.width, 0, alignX), y: at(y / ROOM_ART.plate.height, 0, alignY) });

/** How far below the desk's far edge an object on the desk stands, in `u`. The mat's top edge is 26 below it. */
const DESK_FOOT = 18;

/**
 * Standing on the desk's far edge, its foot just above the mat's top edge, so the mat hides it. `fromCentre` is in `u` from
 * the window's centre, behind the mat, which is centred and never narrower than 270 `u` short of each window edge.
 */
const behindMat = (fromCentre: number): Placement =>
  ({ on: "window", x: at(0.5, fromCentre, "center"), y: at(1, -(ROOM_ART.deskReach - DESK_FOOT), "end") });

/** Between the mat's right edge and the folio, standing on the desk's far edge. */
const besideFolio: Placement = { on: "window", x: at(1, -262), y: at(1, -(ROOM_ART.deskReach - DESK_FOOT), "end") };

/**
 * The slots of each room, in the order they open (progress.ts opens a prefix). The positions are measured on each room's
 * background master in art/masters/front-row-v2 and checked against every desktop window by test/room-unlocks.test.ts.
 * docs/design/live-room/unlocks.md lists the crop of the room each object is generated from.
 */
export const UNLOCK_SLOTS: { readonly [R in RoomId]: readonly UnlockSlot[] } = {
  "last-desk": [
    { id: "last-desk/1", object: "a pencil cup on the desk", width: 52, height: 74, z: 5, place: besideFolio },
    { id: "last-desk/2", object: "a small potted plant on the window sill", width: 70, height: 84, z: 1, place: onBackground(1262, 610, "start", "end") },
    { id: "last-desk/3", object: "a short stack of books on the desk", width: 112, height: 52, z: 5, place: behindMat(-380) },
    { id: "last-desk/4", object: "an apple on the chalk ledge", width: 40, height: 40, z: 3, place: { on: "board", x: at(0.8, 0, "center"), y: at(1, -33, "end") } },
    { id: "last-desk/5", object: "two books leaning on the window sill", width: 64, height: 70, z: 1, place: onBackground(1556, 610, "end", "end") },
    { id: "last-desk/6", object: "a small globe on the desk", width: 64, height: 72, z: 5, place: behindMat(330) },
  ],
  "study-bench": [
    { id: "study-bench/1", object: "a potted herb on the terrace rail", width: 56, height: 64, z: 1, place: onBackground(1426, 558, "start", "end") },
    { id: "study-bench/2", object: "a glass of lemonade on the desk", width: 44, height: 64, z: 5, place: besideFolio },
    { id: "study-bench/3", object: "a paper lantern hanging from the awning", width: 52, height: 84, z: 1, place: { on: "window", x: at(1, -72, "center"), y: at(0, 214) } },
    { id: "study-bench/4", object: "a short stack of books on the desk", width: 112, height: 52, z: 5, place: behindMat(-380) },
    { id: "study-bench/5", object: "a seashell on the desk", width: 60, height: 40, z: 5, place: behindMat(330) },
    { id: "study-bench/6", object: "a small bird on the terrace rail", width: 44, height: 40, z: 1, place: onBackground(16, 558, "start", "end") },
  ],
  "projection-booth": [
    { id: "projection-booth/1", object: "a cup of tea on the desk", width: 52, height: 56, z: 5, place: besideFolio },
    { id: "projection-booth/2", object: "a paper lantern hanging in the window", width: 50, height: 80, z: 1, place: onBackground(290, 346, "start", "start") },
    { id: "projection-booth/3", object: "a stack of film canisters on the desk", width: 100, height: 56, z: 5, place: behindMat(-380) },
    { id: "projection-booth/4", object: "a wind chime hanging in the window", width: 40, height: 84, z: 1, place: onBackground(110, 346, "start", "start") },
    { id: "projection-booth/5", object: "a small desk lamp on the desk", width: 60, height: 74, z: 5, place: behindMat(330) },
    { id: "projection-booth/6", object: "a ticket stub jar on the desk", width: 48, height: 58, z: 5, place: behindMat(-150) },
  ],
};

/**
 * The painted picture of each unlocked object, as a bundle URL, once the art step has made it (#226; Meshy spend waits on
 * Derek's OK). A slot with no picture here draws nothing, however far the learner has come, so the room never shows a
 * broken or placeholder image. Each entry is added with its master in art/masters and its line in art/manifest.json.
 */
export const UNLOCK_ART: Readonly<Partial<Record<UnlockId, string>>> = {};
