import type { SceneId } from "../appearance";
import type { RoomObject } from "../room-object";
import { FRONT_ROW_ROOMS, ROOM_ART } from "./rooms";
import type { FrontRowRoom, PlatePoint, PlateRect } from "./rooms";

/** A size or a box in CSS pixels of the window. */
export type Size = { readonly width: number; readonly height: number };
export type Rect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

/**
 * The room as a window at least `FULL_ROOM_MIN` shows it: one wide plate drawn at one scale, with its text, companion and
 * notebook placed on it. Every rectangle is in CSS pixels from the window's top left. `s` is the screen pixels of one plate
 * pixel. It is the same on both axes, so nothing is stretched, and it sizes the room's type.
 */
export type FullRoomLayout = {
  readonly composition: "full";
  readonly window: Size;
  readonly s: number;
  /** Where the whole plate is drawn. A wide window crops its side strips, and a narrow or tall one leaves the backdrop showing. */
  readonly plate: Rect;
  /** Where the 16:10 core of the plate is: the part every window shows whole. */
  readonly core: Rect;
  /**
   * Whether the plate leaves part of the window bare. The stage then paints a blurred, darkened, mirrored continuation of the
   * plate under it, so the bare rows or columns carry the room's own colours in soft shapes, never stretched edge pixels.
   */
  readonly backdrop: boolean;
  /** Where the board's and the mat's text go. */
  readonly text: { readonly board: Rect; readonly desk: Rect };
  /** The companion's painted cell. */
  readonly companion: { readonly box: Rect };
  /** The two tags on the desk: the folio (Source) above the notebook's, and the notebook's stack with its tag at the bottom. */
  readonly objects: Readonly<Record<RoomObject, Rect>>;
  /** Where the room's live light effect starts. */
  readonly light: { readonly left: number; readonly top: number };
};

/**
 * A phone or short window recomposes the room: the page stacks flat surfaces over the background, so only the background is
 * placed. It covers the window, top-aligned, and the room's `phoneArtX` says which part of its width shows.
 */
export type CompactRoomLayout = { readonly composition: "compact"; readonly window: Size; readonly layers: { readonly background: Rect } };

export type RoomLayout = FullRoomLayout | CompactRoomLayout;
export type Composition = RoomLayout["composition"];

/** The tags on the desk, in plate pixels: the notebook's stack the tag sits under, and the source tag above the notebook's tag. */
const NOTEBOOK = { width: 200, height: 266, tagBelow: 16 } as const;
const SOURCE = { width: 150, height: 34, above: 52 } as const;
/** The plate covers the window when it falls short of an edge by no more than this many CSS pixels, a rounding error. */
const COVERED = 1e-6;

/**
 * The scale at which the plate's 16:10 core just fits `window` on its shorter side: s = min(H / plate height, W / core width).
 * A window of the core's own shape shows the core whole, a wider one shows more of the strips, and a taller one leaves room
 * above and below.
 */
export function plateScale(scene: SceneId, window: Size): number {
  const { size, core } = FRONT_ROW_ROOMS[scene].plate;
  return Math.min(window.height / size.height, window.width / core.width);
}

/** Where everything in `scene` goes in a window of `window` CSS pixels. */
export function layoutRoom(scene: SceneId, window: Size, composition: Composition): RoomLayout {
  const room: FrontRowRoom = FRONT_ROW_ROOMS[scene];
  const { width: W, height: H } = window;
  if (composition === "compact") {
    const { plate } = ROOM_ART;
    const cover = Math.max(W / plate.width, H / plate.height);
    const [width, height] = [cover * plate.width, cover * plate.height];
    return { composition, window, layers: { background: { left: (W - width) * parseFloat(room.phoneArtX) / 100, top: 0, width, height } } };
  }
  const { size, core } = room.plate;
  const s = plateScale(scene, window);
  const drawn = { left: (W - size.width * s) / 2, top: (H - size.height * s) / 2, width: size.width * s, height: size.height * s };
  const rect = ({ x, y, width, height }: PlateRect): Rect => ({ left: drawn.left + x * s, top: drawn.top + y * s, width: width * s, height: height * s });
  const point = ({ x, y }: PlatePoint) => ({ left: drawn.left + x * s, top: drawn.top + y * s });

  // Covering the window with the plate itself is not possible for a window narrower than the core: the core's width is what
  // must stay in view, so a taller window has bare rows above and below. Those rows, and any column a window wider than the
  // plate leaves bare, show a blurred mirror of the plate instead of its stretched edge pixels.
  const backdrop = drawn.left > COVERED || drawn.top > COVERED || drawn.left + drawn.width < W - COVERED || drawn.top + drawn.height < H - COVERED;

  const { companion, notebook } = room.plate;
  const tag = point(notebook);
  const history = { left: tag.left - (NOTEBOOK.width / 2) * s, top: tag.top - (NOTEBOOK.height - NOTEBOOK.tagBelow) * s, width: NOTEBOOK.width * s, height: NOTEBOOK.height * s };
  const source = { left: tag.left - (SOURCE.width / 2) * s, top: tag.top - SOURCE.above * s, width: SOURCE.width * s, height: SOURCE.height * s };

  return {
    composition, window, s, plate: drawn, core: rect(core), backdrop,
    text: { board: rect(room.plate.board), desk: rect(room.plate.mat) },
    companion: { box: rect({ x: companion.x - companion.height / 2, y: companion.bottom - companion.height, width: companion.height, height: companion.height }) },
    objects: { source, history },
    light: point(room.plate.light),
  };
}
