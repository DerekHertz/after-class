import type { SceneId } from "../appearance";

type Hex = `#${string}`;

/**
 * Which way a surface's text runs. A dark board or mat carries light ink, a light one dark ink. The canal film club is the
 * one room with a light screen and a dark mat, so the board and the mat each carry their own tone.
 */
export type SurfaceTone = "dark" | "light";

/** The ink a surface in the art carries, and the flat colour that stands in for it on a phone. */
export type Surface = { readonly tone: SurfaceTone; readonly fill: Hex; readonly ink: Hex; readonly inkSoft: Hex };

export type RoomPalette = {
  /** The response field on the mat. */
  readonly field: Hex;
  readonly fieldInk: Hex;
  readonly fieldBorder: Hex;
  /** Share my thinking. */
  readonly accent: Hex;
  readonly accentInk: Hex;
  /** Hint, I don't know and the other secondary buttons. */
  readonly quiet: Hex;
  readonly quietInk: Hex;
  readonly focus: Hex;
  /** The navigation chips laid over the art, and the wall colour under the panels that open below the room. */
  readonly bar: Hex;
  readonly barInk: Hex;
  readonly wall: Hex;
  /** The board's frame and the desk's wood, drawn in flat colour where a phone recomposes the room. */
  readonly frame: Hex;
  readonly desk: Hex;
};

/**
 * Where a picture's edge or centre sits along one axis of the frame it is placed on: `share` of the frame's length from its
 * start, plus `offset` in `u`. `align` says which part of the picture sits there.
 */
export type Anchor = { readonly share: number; readonly offset: number; readonly align: "start" | "center" | "end" };

/**
 * A picture placed on the board, on the window or on the room's background, one anchor per axis. On the background a share
 * is a share of the plate, so a picture placed there stays on the same spot of the painted room at any window.
 */
export type Placement = { readonly on: "board" | "window" | "background"; readonly x: Anchor; readonly y: Anchor };

/** A box of the plate, in plate pixels from its top left. */
export type PlateRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
/** A point of the plate, in plate pixels. */
export type PlatePoint = { readonly x: number; readonly y: number };

/**
 * One room's wide plate, an empty room painted wide enough to fill a 21:9 window, with every value in plate pixels from its top
 * left. `core` is the 16:10 part signed off as the mockup: the room's text, companion and notebook all sit inside it, so a
 * window of that shape shows the room as designed and a wider one shows more of the strips on each side. `board` and `mat` are
 * the rects the question and the answer's text go in. `companion` is where the companion stands: `x` is the middle of its
 * painted cell, `bottom` its ground line and `height` the cell's height. `notebook` is the middle of the tag on the notebook,
 * and `light` where the room's live light effect starts. `src` is the file the plate ships as in src/app/assets.
 * docs/design/live-room/plates/measure.py measures them from the plates and mockups in docs/design/live-room.
 */
export type Plate = {
  readonly src: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly core: PlateRect;
  readonly board: PlateRect;
  readonly mat: PlateRect;
  readonly companion: { readonly x: number; readonly bottom: number; readonly height: number };
  readonly notebook: PlatePoint;
  readonly light: PlatePoint;
};

export type FrontRowRoom = {
  readonly surfaceName: string;
  readonly plate: Plate;
  /** The board or screen the question is written on, and how the approved design sets the question on it. */
  readonly board: Surface & { readonly align: "start" | "center" };
  /** The mat on the near desk that holds Your thinking. `actions` says where its buttons go. */
  readonly mat: Surface & { readonly actions: "below" | "beside" };
  /** Which part of the background shows behind the phone layout, as a horizontal background position. */
  readonly phoneArtX: `${number}%`;
  readonly palette: RoomPalette;
};

/**
 * The plate every room's background shares, and the desk's reach. The background is the room as the phone layout draws it,
 * and `unlocks.ts` still places its slots by them. A full room is laid out from its own `Plate` (room/layout.ts).
 */
export const ROOM_ART = {
  plate: { width: 1586, height: 992 },
  /** The desk's far edge above the window's bottom. */
  deskReach: 310,
} as const;

const PLATE_SIZE = { width: 2314, height: 992 } as const;
/** Each plate's file holds this many pixels per plate pixel: the Meshy takes are upscaled before the plate is composed. */
export const PLATE_FILE_SCALE = 2;
const CORE = { x: 364, y: 0, width: 1586, height: 992 } as const;

/**
 * The three selected skins. Scene IDs predate the skins and are kept, so a saved preference still finds its room:
 * last-desk is the Rail-side Classroom, study-bench the Harbor Study Terrace and projection-booth the Lantern Canal Film Club.
 */
export const FRONT_ROW_ROOMS = {
  "last-desk": {
    surfaceName: "Chalkboard",
    plate: {
      src: "room-plates/rail-wide.webp", size: PLATE_SIZE, core: CORE,
      board: { x: 560, y: 96, width: 1000, height: 424 },
      mat: { x: 694, y: 682, width: 930, height: 243 },
      companion: { x: 549, bottom: 922, height: 282 },
      notebook: { x: 1819, y: 911 },
      light: { x: 1626, y: 150 },
    },
    board: { align: "start", tone: "dark", fill: "#18564b", ink: "#f6efd9", inkSoft: "#c9e6cf" },
    mat: { tone: "light", fill: "#fef0e2", ink: "#1e2b45", inkSoft: "#4b5468", actions: "below" },
    phoneArtX: "100%",
    palette: {
      field: "#fffaf3", fieldInk: "#1e2b45", fieldBorder: "#2f4f86", accent: "#2d5aa8", accentInk: "#ffffff",
      quiet: "#f4e8d2", quietInk: "#2a2620", focus: "#c2410c", bar: "#1a2b3b", barInk: "#f6ecd8", wall: "#6d90a4", frame: "#b8875a", desk: "#9f6650",
    },
  },
  "study-bench": {
    surfaceName: "Learning board",
    plate: {
      src: "room-plates/harbor-wide.webp", size: PLATE_SIZE, core: CORE,
      board: { x: 672, y: 212, width: 944, height: 328 },
      mat: { x: 675, y: 703, width: 975, height: 209 },
      companion: { x: 491, bottom: 928, height: 294 },
      notebook: { x: 1845, y: 915 },
      light: { x: 1154, y: 150 },
    },
    board: { align: "start", tone: "dark", fill: "#2a6b56", ink: "#fbf6e6", inkSoft: "#dff3e6" },
    mat: { tone: "light", fill: "#feebcd", ink: "#22252e", inkSoft: "#4f4a40", actions: "below" },
    phoneArtX: "50%",
    palette: {
      field: "#fffaf0", fieldInk: "#22252e", fieldBorder: "#5b5240", accent: "#0f6b5d", accentInk: "#ffffff",
      quiet: "#fbefd8", quietInk: "#2a2620", focus: "#1d4ed8", bar: "#1d3f7a", barInk: "#fdf6e4", wall: "#5597fb", frame: "#a98a62", desk: "#c27d4d",
    },
  },
  "projection-booth": {
    surfaceName: "Projection screen",
    plate: {
      src: "room-plates/canal-wide.webp", size: PLATE_SIZE, core: CORE,
      board: { x: 850, y: 115, width: 1010, height: 405 },
      mat: { x: 677, y: 700, width: 1028, height: 195 },
      companion: { x: 471, bottom: 922, height: 270 },
      notebook: { x: 1840, y: 905 },
      light: { x: 514, y: 545 },
    },
    board: { align: "start", tone: "light", fill: "#fbe1c5", ink: "#191d42", inkSoft: "#3b3f63" },
    mat: { tone: "dark", fill: "#2c3a61", ink: "#f8ead0", inkSoft: "#d9cdb5", actions: "below" },
    phoneArtX: "0%",
    palette: {
      field: "#1f2a4b", fieldInk: "#f8ead0", fieldBorder: "#d9cdb5", accent: "#f2b648", accentInk: "#24180a",
      quiet: "#2c3a61", quietInk: "#f8ead0", focus: "#f2b648", bar: "#1f2340", barInk: "#f3e3c3", wall: "#353f67", frame: "#8f8597", desk: "#81494a",
    },
  },
} as const satisfies Record<SceneId, FrontRowRoom>;
