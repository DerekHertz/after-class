import type { SceneId } from "../appearance";
import type { RoomObject } from "../room-object";
import { FRONT_ROW_ROOMS, ROOM_ART } from "./rooms";
import type { Anchor, Edges, FrontRowRoom, NineSlice, Placement } from "./rooms";
import type { UnlockId } from "./progress";
import { UNLOCK_SLOTS } from "./unlocks";

/** A size or a box in CSS pixels of the window. */
export type Size = { readonly width: number; readonly height: number };
export type Rect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

/** A nine-slice layer on screen: its box, and how far its four cuts sit from its edges, in screen pixels. */
export type NineSliceLayer = { readonly rect: Rect; readonly border: Edges };
export type ExtraLayer = { readonly name: string; readonly rect: Rect; readonly z: number };
/** Where an unlocked object stands, whether or not it is unlocked yet. */
export type UnlockLayer = { readonly id: UnlockId; readonly rect: Rect; readonly z: number };

/**
 * The room built from layers, as a window at least `FULL_ROOM_MIN` shows it. Every rectangle is in CSS pixels from the
 * window's top left. `u` is the screen pixels of one plate pixel at the object scale, which also sizes the board's type.
 */
export type FullRoomLayout = {
  readonly composition: "full";
  readonly window: Size;
  /**
   * The part of the window the room is composed in: all of it, or on a window wider than `ROOM_ART.maxAspect` a box of that
   * aspect, full height and centred. Every layer below lies in it, at one scale. The bands either side show the backdrop.
   */
  readonly frame: Rect;
  readonly u: number;
  /** How much larger than at 1440x900 the room's text and controls are drawn, so they keep their share of the room. */
  readonly type: number;
  readonly layers: {
    /** On a window wider than the frame: the background covering the whole window, and the two bands beside the frame it shows in, dimmed. */
    readonly backdrop: { readonly cover: Rect; readonly bands: readonly [Rect, Rect] } | null;
    readonly background: Rect;
    readonly board: NineSliceLayer;
    readonly desk: NineSliceLayer;
    readonly mat: NineSliceLayer;
    readonly extras: readonly ExtraLayer[];
    /** Every unlock slot of the room, in the order they open (room/unlocks.ts). */
    readonly unlocks: readonly UnlockLayer[];
  };
  /** Where the board's and the mat's text may go: each plain area less its pad. */
  readonly text: { readonly board: Rect; readonly desk: Rect };
  readonly companion: { readonly box: Rect };
  readonly objects: Readonly<Record<RoomObject, Rect>>;
  /** The desk's corner left of the mat, around the companion, where the progress panel opens. */
  readonly progress: Rect;
};

/**
 * A phone or short window recomposes the room: the page stacks flat surfaces over the background, so only the background is
 * placed. It covers the window, top-aligned, and the room's `phoneArtX` says which part of its width shows.
 */
export type CompactRoomLayout = { readonly composition: "compact"; readonly window: Size; readonly layers: { readonly background: Rect } };

export type RoomLayout = FullRoomLayout | CompactRoomLayout;
export type Composition = RoomLayout["composition"];

/** `u` at 1440x900, where the room's text sizes were set: `type` is 1 there and grows with `u` up to `TYPE_MAX`. */
const TYPE_REF = 1440 / ROOM_ART.plate.width;
const TYPE_MAX = 3;

/**
 * Where everything in `scene` goes in a window of `window` CSS pixels. The room is composed in `frame`, which caps its
 * aspect at `ROOM_ART.maxAspect`, so a wide window shows the same room larger with bands either side rather than a
 * wider board and desk. Two scales apply in the frame, both screen pixels per plate pixel. `b` makes the background cover
 * the frame's width and reach down behind the desk. `u` sizes everything else, and is the smaller of `b` and `u0`, so a
 * tall window does not magnify the desk and the objects. From an aspect of 1.1 up to the cap, `u0` never binds below `b`, so
 * the frame is one scale.
 */
export function layoutRoom(scene: SceneId, window: Size, composition: Composition): RoomLayout {
  const room: FrontRowRoom = FRONT_ROW_ROOMS[scene];
  const { plate } = ROOM_ART;
  if (composition === "compact") {
    const { width: W, height: H } = window;
    const cover = Math.max(W / plate.width, H / plate.height);
    const [width, height] = [cover * plate.width, cover * plate.height];
    return { composition, window, layers: { background: { left: (W - width) * parseFloat(room.phoneArtX) / 100, top: 0, width, height } } };
  }
  const H = window.height;
  const W = Math.min(window.width, H * ROOM_ART.maxAspect);
  const x0 = (window.width - W) / 2;
  const u0 = Math.min(1.12 * H / plate.height, 1.25 * W / plate.width);
  const b = Math.max(W / plate.width, (H - u0 * ROOM_ART.deskCovers) / plate.height);
  const u = Math.min(b, u0);

  const bgWidth = b * plate.width;
  const bgHeight = b * plate.height;
  const bgLeft = (W - bgWidth) * room.background.anchorX;
  const background = { left: bgLeft, top: Math.min(0, (H - bgHeight) * room.background.anchorY), width: bgWidth, height: bgHeight };
  const wallLeft = Math.max(0, bgLeft + b * room.background.wall.from);
  const wallRight = Math.min(W, bgLeft + b * room.background.wall.to);

  const deskTop = H - u * ROOM_ART.deskReach;
  const boardTop = H * room.board.top;
  const boardHeight0 = deskTop - u * room.board.gapAboveDesk - boardTop;
  const boardWidth = Math.min(wallRight - wallLeft - u * room.board.sideMargin * 2, boardHeight0 * room.board.maxAspect);
  const boardHeight = Math.min(boardHeight0, boardWidth / Math.max(room.board.minAspect ?? 0, 0.01));
  const board = { left: wallLeft + (wallRight - wallLeft - boardWidth) / 2, top: boardTop, width: boardWidth, height: boardHeight };

  const matWidth = Math.min(W - u * ROOM_ART.matSideReserve * 2, u * ROOM_ART.matMaxWidth);
  const matTop = deskTop + u * ROOM_ART.matTop;
  const mat = { left: (W - matWidth) / 2, top: matTop, width: matWidth, height: H - u * ROOM_ART.matBottom - matTop };

  const side = W * ROOM_ART.sideInset;
  const book = { width: u * ROOM_ART.notebook.width, height: u * ROOM_ART.notebook.height };
  const history = { left: W - side - book.width, top: H - u * ROOM_ART.notebook.bottom - book.height, ...book };
  const folioWidth = book.width * ROOM_ART.folio.width;
  const folioHeight = folioWidth / ROOM_ART.folio.aspect;
  const source = { left: history.left + (book.width - folioWidth) / 2, top: history.top - u * ROOM_ART.folio.gap - folioHeight, width: folioWidth, height: folioHeight };
  const buddy = u * ROOM_ART.companionSize;

  const frames = { board, window: { left: 0, top: 0, width: W, height: H }, background };
  const along = (anchor: Anchor, start: number, length: number, size: number) =>
    start + length * anchor.share + u * anchor.offset - size * { start: 0, center: 0.5, end: 1 }[anchor.align];
  const place = ({ on, x, y }: Placement, width: number, height: number): Rect => {
    const frame = frames[on];
    return { left: along(x, frame.left, frame.width, width), top: along(y, frame.top, frame.height, height), width, height };
  };

  const at = (rect: Rect): Rect => ({ ...rect, left: x0 + rect.left });
  return {
    composition, window, frame: { left: x0, top: 0, width: W, height: H }, u, type: Math.min(TYPE_MAX, Math.max(1, u / TYPE_REF)),
    layers: {
      backdrop: x0 > 0 ? backdrop(window, x0) : null,
      background: at(background),
      board: { rect: at(board), border: scaled(room.board.art.slice, u) },
      desk: { rect: at({ left: 0, top: deskTop, width: W, height: u * room.desk.art.size.height }), border: scaled(room.desk.art.slice, u) },
      mat: { rect: at(mat), border: scaled(room.mat.art.slice, u) },
      extras: room.extras.map((extra) => ({ name: extra.name, z: extra.z, rect: at(place(extra.place, u * extra.width, u * extra.height)) })),
      unlocks: UNLOCK_SLOTS[scene].map((slot) => ({ id: slot.id, z: slot.z, rect: at(place(slot.place, u * slot.width, u * slot.height)) })),
    },
    text: {
      board: at(inset(board, room.board.art, { x: ROOM_ART.boardTextPad, y: ROOM_ART.boardTextPad }, u)),
      desk: at(inset(mat, room.mat.art, ROOM_ART.matTextPad, u)),
    },
    companion: { box: at({ left: side, top: H - u * room.companionBottom - buddy, width: buddy, height: buddy }) },
    objects: { source: at(source), history: at(history) },
    progress: at({ left: side, top: matTop, width: mat.left - 2 * side, height: H - side - matTop }),
  };
}

function backdrop({ width, height }: Size, band: number): NonNullable<FullRoomLayout["layers"]["backdrop"]> {
  const { plate } = ROOM_ART;
  const cover = width / plate.width;
  return {
    cover: { left: 0, top: (height - cover * plate.height) / 2, width, height: cover * plate.height },
    bands: [{ left: 0, top: 0, width: band, height }, { left: width - band, top: 0, width: band, height }],
  };
}

const scaled = (edges: Edges, u: number): Edges => ({ top: u * edges.top, right: u * edges.right, bottom: u * edges.bottom, left: u * edges.left });

/** A surface's plain inner area less a pad, in `u`. */
function inset(rect: Rect, art: NineSlice, pad: { readonly x: number; readonly y: number }, u: number): Rect {
  const { inner } = art;
  const [top, right, bottom, left] = [u * (inner.top + pad.y), u * (inner.right + pad.x), u * (inner.bottom + pad.y), u * (inner.left + pad.x)];
  return { left: rect.left + left, top: rect.top + top, width: rect.width - left - right, height: rect.height - top - bottom };
}
