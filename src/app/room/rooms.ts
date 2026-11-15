import type { SceneId } from "../appearance";

type Hex = `#${string}`;

/** Four sides of a rectangle, in the units of the thing it describes. */
export type Edges = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };

/**
 * A layer drawn as a nine-slice. Sizes and cuts are in asset pixels, one per plate pixel. `slice`
 * is how far the four cuts sit from each edge, so the corners keep their size and the middle stretches. `inner` is the
 * plain area the text may use, as its distance from each edge.
 */
export type NineSlice = { readonly size: { readonly width: number; readonly height: number }; readonly slice: Edges; readonly inner: Edges };

/**
 * Which way a surface's text runs. A dark board or mat carries light ink, a light one dark ink. The canal film club is the
 * one room with a light screen and a dark mat, so the board and the mat each carry their own tone.
 */
export type SurfaceTone = "dark" | "light";

/** A surface in the art that holds real text: its nine-slice, and the flat colour that stands in for it on a phone. */
export type Surface = { readonly art: NineSlice; readonly tone: SurfaceTone; readonly fill: Hex; readonly ink: Hex; readonly inkSoft: Hex };

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

/** A picture placed on the board or on the window, one anchor per axis. */
export type Placement = { readonly on: "board" | "window"; readonly x: Anchor; readonly y: Anchor };

/** A small image the room has besides the board, desk and mat. Sizes are in `u`, and front-row.css chooses the picture by `name`. */
export type Extra = { readonly name: string; readonly width: number; readonly height: number; readonly z: number; readonly place: Placement };

export type FrontRowRoom = {
  readonly surfaceName: string;
  /**
   * `anchorX` is the share of the window's extra width taken off the left of the background: 0 keeps its left edge, 0.5
   * centres it and 1 keeps its right edge. `anchorY` is the share of the vertical crop taken off the top. `wall` is the
   * plain span of the picture, in plate pixels, that the board may use.
   */
  readonly background: { readonly anchorX: 0 | 0.5 | 1; readonly anchorY: number; readonly wall: { readonly from: number; readonly to: number } };
  /** The board or screen the question is written on, how each approved design sets the question on it, and where it goes on the wall. */
  readonly board: Surface & {
    readonly align: "start" | "center";
    /** The board's top edge as a share of the window's height. */
    readonly top: number;
    /** Distance above the desk's far edge, in `u`. Negative where the board's legs run behind the desk. */
    readonly gapAboveDesk: number;
    readonly sideMargin: number;
    readonly maxAspect: number;
    readonly minAspect: number | null;
  };
  readonly desk: { readonly art: Pick<NineSlice, "size" | "slice"> };
  /** The mat on the near desk that holds Your thinking. `actions` follows each approved design. */
  readonly mat: Surface & { readonly actions: "below" | "beside" };
  /** The companion's bottom edge above the window's bottom, in `u`. */
  readonly companionBottom: number;
  readonly extras: readonly Extra[];
  /** Which part of the background shows behind the phone layout, as a horizontal background position. */
  readonly phoneArtX: `${number}%`;
  readonly palette: RoomPalette;
};

/**
 * Layout constants shared by the rooms, in `u`, the screen pixels of one plate pixel at the object scale (room/layout.ts
 * computes it). The layers in assets/front-row-v2 are stored at plate resolution, one asset pixel to a plate pixel, so every
 * size and cut below is in asset pixels and in plate pixels at once.
 */
export const ROOM_ART = {
  plate: { width: 1586, height: 992 },
  /** The desk hides this much of the background's bottom, so a tall window need not magnify the background. */
  deskCovers: 170,
  /** The desk's far edge above the window's bottom. */
  deskReach: 310,
  /** The mat spans the desk less this much on each side for the companion and the notebook, up to `matMaxWidth`. */
  matSideReserve: 270,
  matMaxWidth: 1000,
  matTop: 26,
  matBottom: 14,
  companionSize: 220,
  /** The closed notebook, and the closed folio lying above it at `width` of its width, centred on it, `gap` above it. */
  notebook: { bottom: 20, width: 150, height: 150 * 1028 / 1030 },
  folio: { width: 0.9, aspect: 1180 / 976, gap: 8 },
  /** Distance of the companion and the notebook from the window's side edges, as a share of the window's width. */
  sideInset: 0.015,
  /** Space kept between a text area and the edge of the plain area it sits in. */
  boardTextPad: 14,
  matTextPad: { x: 10, y: 6 },
} as const;

const board = (x: Anchor, y: Anchor): Placement => ({ on: "board", x, y });
const at = (share: number, offset = 0, align: Anchor["align"] = "start"): Anchor => ({ share, offset, align });

/**
 * The three selected skins. Scene IDs predate the skins and are kept, so a saved preference still finds its room:
 * last-desk is the Rail-side Classroom, study-bench the Harbor Study Terrace and projection-booth the Lantern Canal Film Club.
 * Sizes, cuts and plain areas are measured from the layered assets in assets/front-row-v2 and recorded in
 * docs/design/front-row/rooms-v2/manifest.json.
 */
export const FRONT_ROW_ROOMS = {
  "last-desk": {
    surfaceName: "Chalkboard",
    background: { anchorX: 1, anchorY: 0.22, wall: { from: 0, to: 1228 } },
    board: {
      art: { size: { width: 1473, height: 844 }, slice: { top: 44, right: 64, bottom: 62, left: 64 }, inner: { top: 44, right: 65, bottom: 63, left: 64 } },
      align: "start", top: 0.12, gapAboveDesk: 64, sideMargin: 36, maxAspect: 2.7, minAspect: 1.3,
      tone: "dark", fill: "#18564b", ink: "#f6efd9", inkSoft: "#c9e6cf",
    },
    desk: { art: { size: { width: 2172, height: 359 }, slice: { top: 0, right: 150, bottom: 0, left: 150 } } },
    mat: {
      art: { size: { width: 1458, height: 485 }, slice: { top: 28, right: 30, bottom: 30, left: 28 }, inner: { top: 28, right: 30, bottom: 30, left: 28 } },
      tone: "light", fill: "#fef0e2", ink: "#1e2b45", inkSoft: "#4b5468", actions: "below",
    },
    companionBottom: 16,
    extras: [
      { name: "ledge-items", width: 548, height: 55, z: 3, place: board(at(0.09), at(1, -(33 + 55))) },
      { name: "vine", width: 261, height: 395, z: 3, place: board(at(0, -150), at(0, -62)) },
    ],
    phoneArtX: "100%",
    palette: {
      field: "#fffaf3", fieldInk: "#1e2b45", fieldBorder: "#2f4f86", accent: "#2d5aa8", accentInk: "#ffffff",
      quiet: "#f4e8d2", quietInk: "#2a2620", focus: "#c2410c", bar: "#1a2b3b", barInk: "#f6ecd8", wall: "#6d90a4", frame: "#b8875a", desk: "#9f6650",
    },
  },
  "study-bench": {
    surfaceName: "Learning board",
    background: { anchorX: 0.5, anchorY: 0.3, wall: { from: 0, to: 1586 } },
    board: {
      art: { size: { width: 1446, height: 830 }, slice: { top: 56, right: 215, bottom: 242, left: 215 }, inner: { top: 52, right: 56, bottom: 238, left: 56 } },
      align: "center", top: 0.15, gapAboveDesk: -120, sideMargin: 170, maxAspect: 2.7, minAspect: null,
      tone: "dark", fill: "#096359", ink: "#fbf6e6", inkSoft: "#dff3e6",
    },
    desk: { art: { size: { width: 2172, height: 362 }, slice: { top: 0, right: 120, bottom: 0, left: 120 } } },
    mat: {
      art: { size: { width: 1436, height: 478 }, slice: { top: 44, right: 44, bottom: 44, left: 44 }, inner: { top: 44, right: 44, bottom: 44, left: 44 } },
      tone: "light", fill: "#feebcd", ink: "#22252e", inkSoft: "#4f4a40", actions: "beside",
    },
    companionBottom: 40,
    extras: [
      ...[0.18, 0.5, 0.82].map((share) => ({ name: "lamp", width: 121, height: 108, z: 3, place: board(at(share, 0, "center"), at(0, 14 - 108)) })),
      { name: "awning", width: 307, height: 346, z: 1, place: { on: "window", x: at(1, 0, "end"), y: at(0) } },
      { name: "cushion", width: 248, height: 123, z: 6, place: { on: "window", x: at(0.006), y: at(1, -14, "end") } },
    ],
    phoneArtX: "50%",
    palette: {
      field: "#fffaf0", fieldInk: "#22252e", fieldBorder: "#5b5240", accent: "#0f6b5d", accentInk: "#ffffff",
      quiet: "#fbefd8", quietInk: "#2a2620", focus: "#1d4ed8", bar: "#1d3f7a", barInk: "#fdf6e4", wall: "#5597fb", frame: "#a98a62", desk: "#c27d4d",
    },
  },
  "projection-booth": {
    surfaceName: "Projection screen",
    background: { anchorX: 0, anchorY: 0.22, wall: { from: 376, to: 1586 } },
    board: {
      art: { size: { width: 1463, height: 823 }, slice: { top: 104, right: 100, bottom: 50, left: 100 }, inner: { top: 104, right: 100, bottom: 50, left: 100 } },
      align: "start", top: 0.07, gapAboveDesk: 52, sideMargin: 36, maxAspect: 2.7, minAspect: 1.3,
      tone: "light", fill: "#fbe1c5", ink: "#191d42", inkSoft: "#3b3f63",
    },
    desk: { art: { size: { width: 2172, height: 410 }, slice: { top: 0, right: 110, bottom: 0, left: 110 } } },
    mat: {
      art: { size: { width: 1455, height: 433 }, slice: { top: 36, right: 36, bottom: 36, left: 36 }, inner: { top: 36, right: 36, bottom: 36, left: 36 } },
      tone: "dark", fill: "#2c3a61", ink: "#f8ead0", inkSoft: "#d9cdb5", actions: "beside",
    },
    companionBottom: 16,
    extras: [
      { name: "pull-tab", width: 49, height: 52, z: 3, place: board(at(0.5, 0, "center"), at(1, -6)) },
      { name: "projector", width: 237, height: 254, z: 6, place: { on: "window", x: at(0, 24), y: at(1, -250, "end") } },
    ],
    phoneArtX: "0%",
    palette: {
      field: "#1f2a4b", fieldInk: "#f8ead0", fieldBorder: "#d9cdb5", accent: "#f2b648", accentInk: "#24180a",
      quiet: "#2c3a61", quietInk: "#f8ead0", focus: "#f2b648", bar: "#1f2340", barInk: "#f3e3c3", wall: "#353f67", frame: "#8f8597", desk: "#81494a",
    },
  },
} as const satisfies Record<SceneId, FrontRowRoom>;
