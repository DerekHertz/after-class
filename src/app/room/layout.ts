import type { SceneId } from "../appearance";
import type { RoomObject } from "../room-object";
import { FRONT_ROW_ROOMS, ROOM_ART } from "./rooms";
import type { Anchor, Edges, FrontRowRoom, NineSlice, Placement } from "./rooms";

/** A size or a box in CSS pixels of the window. */
export type Size = { readonly width: number; readonly height: number };
export type Rect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

/** A nine-slice layer on screen: its box, and how far its four cuts sit from its edges, in screen pixels. */
export type NineSliceLayer = { readonly rect: Rect; readonly border: Edges };
export type ExtraLayer = { readonly name: string; readonly rect: Rect; readonly z: number };

/**
 * The room built from layers, as a window at least `FULL_ROOM_MIN` shows it. Every rectangle is in CSS pixels from the
 * window's top left. `u` is the screen pixels of one plate pixel at the object scale, which also sizes the board's type.
 */
export type FullRoomLayout = {
  readonly composition: "full";
  readonly window: Size;
  readonly u: number;
  readonly layers: {
    readonly background: Rect;
    readonly board: NineSliceLayer;
    readonly desk: NineSliceLayer;
    readonly mat: NineSliceLayer;
    readonly extras: readonly ExtraLayer[];
  };
  /** Where the board's and the mat's text may go: each plain area less its pad. */
  readonly text: { readonly board: Rect; readonly desk: Rect };
  readonly companion: { readonly box: Rect };
  readonly objects: Readonly<Record<RoomObject, Rect>>;
};

/** A phone or short window recomposes the room: the page stacks flat surfaces over the background, so nothing is placed here. */
export type CompactRoomLayout = { readonly composition: "compact" };

export type RoomLayout = FullRoomLayout | CompactRoomLayout;
export type Composition = RoomLayout["composition"];

/**
 * Where everything in `scene` goes in a window of `window` CSS pixels. Two scales apply, both screen pixels per plate
 * pixel. `b` makes the background cover the window's width and reach down behind the desk. `u` sizes everything else, and
 * is the smaller of `b` and `u0`, so a tall or very wide window does not magnify the desk and the objects.
 */
export function layoutRoom(scene: SceneId, window: Size, composition: Composition): RoomLayout {
  if (composition === "compact") return { composition };
  const room: FrontRowRoom = FRONT_ROW_ROOMS[scene];
  const { width: W, height: H } = window;
  const { plate } = ROOM_ART;
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

  const frames = { board, window: { left: 0, top: 0, width: W, height: H } };
  const along = (anchor: Anchor, start: number, length: number, size: number) =>
    start + length * anchor.share + u * anchor.offset - size * { start: 0, center: 0.5, end: 1 }[anchor.align];
  const place = ({ on, x, y }: Placement, width: number, height: number): Rect => {
    const frame = frames[on];
    return { left: along(x, frame.left, frame.width, width), top: along(y, frame.top, frame.height, height), width, height };
  };

  return {
    composition, window, u,
    layers: {
      background,
      board: { rect: board, border: scaled(room.board.art.slice, u) },
      desk: { rect: { left: 0, top: deskTop, width: W, height: u * room.desk.art.size.height }, border: scaled(room.desk.art.slice, u) },
      mat: { rect: mat, border: scaled(room.mat.art.slice, u) },
      extras: room.extras.map((extra) => ({ name: extra.name, z: extra.z, rect: place(extra.place, u * extra.width, u * extra.height) })),
    },
    text: {
      board: inset(board, room.board.art, { x: ROOM_ART.boardTextPad, y: ROOM_ART.boardTextPad }, u),
      desk: inset(mat, room.mat.art, ROOM_ART.matTextPad, u),
    },
    companion: { box: { left: side, top: H - u * room.companionBottom - buddy, width: buddy, height: buddy } },
    objects: { source, history },
  };
}

const scaled = (edges: Edges, u: number): Edges => ({ top: u * edges.top, right: u * edges.right, bottom: u * edges.bottom, left: u * edges.left });

/** A surface's plain inner area less a pad, in `u`. */
function inset(rect: Rect, art: NineSlice, pad: { readonly x: number; readonly y: number }, u: number): Rect {
  const { inner } = art;
  const [top, right, bottom, left] = [u * (inner.top + pad.y), u * (inner.right + pad.x), u * (inner.bottom + pad.y), u * (inner.left + pad.x)];
  return { left: rect.left + left, top: rect.top + top, width: rect.width - left - right, height: rect.height - top - bottom };
}
