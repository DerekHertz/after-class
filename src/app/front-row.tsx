import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref, RefObject } from "react";
import type { Appearance, CompanionActivity, SceneId } from "./appearance";
import { COMPANION_STATUS, Companion } from "./companion";
import { clearCompanionReaction } from "./companion-reaction";
import { sourceButtonLabel } from "./room-object";
import type { RoomObject } from "./room-object";

declare module "react" {
  interface CSSProperties { [variable: `--${string}`]: string | number | undefined }
}

type Hex = `#${string}`;

/** Four sides of a rectangle, in the units of the thing it describes. */
export type Edges = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };

/**
 * A layer drawn as a nine-slice. Sizes and cuts are in asset pixels, which are `ROOM_ART.scale` per plate pixel. `slice`
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
 * A small image the room has besides the board, desk and mat. `place` is CSS written in terms of the board and the window
 * (`BOARD`, `u`), and front-row.css chooses the picture by `name`. Sizes are in `u`.
 */
export type Extra = { readonly name: string; readonly width: number; readonly height: number; readonly z: number; readonly place: CSSProperties };

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
    readonly top: `${number}cqh`;
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
 * Layout constants shared by the rooms, in `u`, the screen pixels of one plate pixel at the object scale (front-row.css
 * defines `--fr-u`). The assets are exact doubles of the generated art, `scale` asset pixels to a plate pixel.
 */
export const ROOM_ART = {
  scale: 2,
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
  notebook: { bottom: 20, width: 200 },
  /** Distance of the companion and the notebook from the window's side edges. */
  sideInset: "1.5cqw",
  /** Space kept between a text area and the edge of the plain area it sits in. */
  boardTextPad: 14,
  matTextPad: { x: 10, y: 6 },
} as const;

const u = (n: number): string => `calc(var(--fr-u) * ${n})`;
const BOARD = {
  at: (share: number): string => `calc(var(--fr-board-l) + var(--fr-board-w) * ${share})`,
  top: (offset: number): string => `calc(var(--fr-board-top) + ${u(offset)})`,
  bottom: (offset: number): string => `calc(var(--fr-board-top) + var(--fr-board-h) + ${u(offset)})`,
};

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
      art: { size: { width: 2946, height: 1688 }, slice: { top: 88, right: 128, bottom: 124, left: 128 }, inner: { top: 88, right: 130, bottom: 126, left: 128 } },
      align: "start", top: "12cqh", gapAboveDesk: 64, sideMargin: 36, maxAspect: 2.7, minAspect: 1.3,
      tone: "dark", fill: "#18564b", ink: "#f6efd9", inkSoft: "#c9e6cf",
    },
    desk: { art: { size: { width: 4344, height: 718 }, slice: { top: 0, right: 300, bottom: 0, left: 300 } } },
    mat: {
      art: { size: { width: 2916, height: 970 }, slice: { top: 56, right: 60, bottom: 60, left: 56 }, inner: { top: 56, right: 60, bottom: 60, left: 56 } },
      tone: "light", fill: "#fef0e2", ink: "#1e2b45", inkSoft: "#4b5468", actions: "below",
    },
    companionBottom: 16,
    extras: [
      { name: "ledge-items", width: 548, height: 55, z: 3, place: { left: BOARD.at(0.09), top: BOARD.bottom(-(33 + 55)) } },
      { name: "vine", width: 261, height: 395, z: 3, place: { left: `calc(var(--fr-board-l) - ${u(150)})`, top: BOARD.top(-62) } },
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
      art: { size: { width: 2892, height: 1660 }, slice: { top: 112, right: 430, bottom: 484, left: 430 }, inner: { top: 104, right: 112, bottom: 476, left: 112 } },
      align: "center", top: "15cqh", gapAboveDesk: -120, sideMargin: 170, maxAspect: 2.7, minAspect: null,
      tone: "dark", fill: "#096359", ink: "#fbf6e6", inkSoft: "#dff3e6",
    },
    desk: { art: { size: { width: 4344, height: 724 }, slice: { top: 0, right: 240, bottom: 0, left: 240 } } },
    mat: {
      art: { size: { width: 2872, height: 956 }, slice: { top: 88, right: 88, bottom: 88, left: 88 }, inner: { top: 88, right: 88, bottom: 88, left: 88 } },
      tone: "light", fill: "#feebcd", ink: "#22252e", inkSoft: "#4f4a40", actions: "beside",
    },
    companionBottom: 40,
    extras: [
      ...[0.18, 0.5, 0.82].map((share) => ({ name: "lamp", width: 121, height: 108, z: 3, place: { left: BOARD.at(share), top: BOARD.top(14 - 108), translate: "-50% 0" } })),
      { name: "awning", width: 307, height: 346, z: 1, place: { right: 0, top: 0 } },
      { name: "cushion", width: 248, height: 123, z: 6, place: { left: "0.6cqw", bottom: u(14) } },
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
      art: { size: { width: 2926, height: 1646 }, slice: { top: 208, right: 200, bottom: 100, left: 200 }, inner: { top: 208, right: 200, bottom: 100, left: 200 } },
      align: "start", top: "12cqh", gapAboveDesk: 78, sideMargin: 36, maxAspect: 2.7, minAspect: 1.3,
      tone: "light", fill: "#fbe1c5", ink: "#191d42", inkSoft: "#3b3f63",
    },
    desk: { art: { size: { width: 4344, height: 820 }, slice: { top: 0, right: 220, bottom: 0, left: 220 } } },
    mat: {
      art: { size: { width: 2910, height: 866 }, slice: { top: 72, right: 72, bottom: 72, left: 72 }, inner: { top: 72, right: 72, bottom: 72, left: 72 } },
      tone: "dark", fill: "#2c3a61", ink: "#f8ead0", inkSoft: "#d9cdb5", actions: "beside",
    },
    companionBottom: 16,
    extras: [
      { name: "pull-tab", width: 49, height: 52, z: 3, place: { left: BOARD.at(0.5), top: BOARD.bottom(-6), translate: "-50% 0" } },
      { name: "projector", width: 237, height: 254, z: 6, place: { left: u(24), bottom: u(250) } },
    ],
    phoneArtX: "0%",
    palette: {
      field: "#1f2a4b", fieldInk: "#f8ead0", fieldBorder: "#d9cdb5", accent: "#f2b648", accentInk: "#24180a",
      quiet: "#2c3a61", quietInk: "#f8ead0", focus: "#f2b648", bar: "#1f2340", barInk: "#f3e3c3", wall: "#353f67", frame: "#8f8597", desk: "#81494a",
    },
  },
} as const satisfies Record<SceneId, FrontRowRoom>;

/** A nine-slice as CSS: the cuts in asset pixels, and the border widths they draw at, in `u`. */
function nineSlice(prefix: string, art: Pick<NineSlice, "slice">): CSSProperties {
  const { top, right, bottom, left } = art.slice;
  return {
    [`--fr-${prefix}-slice`]: `${top} ${right} ${bottom} ${left}`,
    [`--fr-${prefix}-bw`]: [top, right, bottom, left].map((n) => u(n / ROOM_ART.scale)).join(" "),
  };
}

/** A surface's text area as CSS: the plain inner area less a pad, as distances from the surface's edges in `u`. */
function textInsets(prefix: string, art: NineSlice, pad: { readonly x: number; readonly y: number }): CSSProperties {
  const { top, right, bottom, left } = art.inner;
  return {
    [`--fr-${prefix}-it`]: u(top / ROOM_ART.scale + pad.y), [`--fr-${prefix}-ir`]: u(right / ROOM_ART.scale + pad.x),
    [`--fr-${prefix}-ib`]: u(bottom / ROOM_ART.scale + pad.y), [`--fr-${prefix}-il`]: u(left / ROOM_ART.scale + pad.x),
  };
}

/** The room as the custom properties front-row.css reads: geometry in `u`, then the surface colours, then the palette. */
export function roomStyle(scene: SceneId): CSSProperties {
  const room: FrontRowRoom = FRONT_ROW_ROOMS[scene];
  const { board, desk, mat, background } = room;
  const style: CSSProperties = {
    "--fr-bg-ax": background.anchorX, "--fr-bg-ay": background.anchorY, "--fr-wall-from": background.wall.from, "--fr-wall-to": background.wall.to,
    "--fr-phone-x": room.phoneArtX,
    "--fr-board-top": board.top, "--fr-board-gap": u(board.gapAboveDesk), "--fr-board-margin": u(board.sideMargin * 2),
    "--fr-board-max-aspect": board.maxAspect, "--fr-board-min-aspect": board.minAspect ?? 0,
    "--fr-desk-reach": u(ROOM_ART.deskReach), "--fr-desk-h": u(desk.art.size.height / ROOM_ART.scale),
    "--fr-mat-reserve": u(ROOM_ART.matSideReserve * 2), "--fr-mat-max": u(ROOM_ART.matMaxWidth),
    "--fr-mat-top": u(ROOM_ART.matTop), "--fr-mat-bottom": u(ROOM_ART.matBottom),
    "--fr-side-inset": ROOM_ART.sideInset,
    "--fr-buddy-bottom": u(room.companionBottom), "--fr-buddy-size": u(ROOM_ART.companionSize),
    "--fr-book-bottom": u(ROOM_ART.notebook.bottom), "--fr-book-w": u(ROOM_ART.notebook.width), "--fr-book-h": u(ROOM_ART.notebook.width * 0.75),
    "--fr-board-fill": board.fill, "--fr-board-ink": board.ink, "--fr-board-ink-soft": board.inkSoft,
    "--fr-mat-fill": mat.fill, "--fr-mat-ink": mat.ink, "--fr-mat-ink-soft": mat.inkSoft,
    ...nineSlice("board", board.art), ...nineSlice("desk", desk.art), ...nineSlice("mat", mat.art),
    ...textInsets("board", board.art, { x: ROOM_ART.boardTextPad, y: ROOM_ART.boardTextPad }), ...textInsets("mat", mat.art, ROOM_ART.matTextPad),
  };
  for (const [name, value] of Object.entries(room.palette)) style[`--fr-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value;
  return style;
}

/**
 * Keeps `--fr-nav-reserve` on the review at the measured bottom of its navigation, so the board's text starts below the
 * chips however many rows they wrap into. The wrap depends on the lecture title and which buttons the phase shows, so no
 * breakpoint can predict it. Used as a ref callback on the navigation.
 */
export function reserveNavSpace(bar: HTMLElement): () => void {
  const review = bar.parentElement;
  if (review === null || typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => review.style.setProperty("--fr-nav-reserve", `${bar.offsetTop + bar.offsetHeight + NAV_GAP}px`));
  observer.observe(bar);
  return () => { observer.disconnect(); review.style.removeProperty("--fr-nav-reserve"); };
}

const NAV_GAP = 12;

/** The folio and notebook on the desk during a review: how much the current reply cites, and how to pick either up. */
export type DeskObjects = { readonly cited: number; readonly open: (object: RoomObject, origin: HTMLButtonElement) => void };

export type FrontRowLayout =
  | { readonly kind: "setup"; readonly form: ReactNode }
  | { readonly kind: "review"; readonly board: ReactNode; readonly desk: ReactNode; readonly objects: DeskObjects };

/**
 * The review seen from the front-row desk. Every room renders this same tree; a room only changes data attributes and
 * custom properties, so switching rooms or companions never remounts the response field and its draft.
 */
export function FrontRowScene({ scene, layout, appearance, activity, boardRef }: {
  readonly scene: SceneId;
  readonly layout: FrontRowLayout;
  readonly appearance: Pick<Appearance, "companion" | "visible" | "motion">;
  readonly activity: CompanionActivity;
  readonly boardRef?: Ref<HTMLElement>;
}) {
  const room = FRONT_ROW_ROOMS[scene];
  useEffect(() => { clearCompanionReaction(); }, [scene, appearance.companion, appearance.visible]);
  return (
    <div className="front-row-scene" data-room={scene} data-board-tone={room.board.tone} data-mat-tone={room.mat.tone} data-mat-actions={room.mat.actions} data-board-align={room.board.align} data-phase={layout.kind}>
      {/* The window's layers, back to front, with every control placed on them by front-row.css. */}
      <div className="front-row-stage">
        <RoomLayers room={room} />
        {layout.kind === "setup" ? layout.form : <>
          <ScrollArea area="board" label={room.surfaceName} areaRef={boardRef}>{layout.board}</ScrollArea>
          <ScrollArea area="desk" label="Your desk">{layout.desk}</ScrollArea>
        </>}
        <div className="front-row-buddy">
          {appearance.visible ? <Companion id={appearance.companion} activity={activity} /> : <span className="quiet-status" role="status">{COMPANION_STATUS[activity]}</span>}
        </div>
        {layout.kind === "review" && <>
          <DeskObject object="source" label={sourceButtonLabel(layout.objects.cited)} tag={layout.objects.cited === 0 ? "Source" : `Source · ${layout.objects.cited}`} open={layout.objects.open} />
          <DeskObject object="history" label="Earlier in this review" tag="Earlier" open={layout.objects.open} />
        </>}
      </div>
    </div>
  );
}

/** The room's pictures, drawn behind its text and controls. The wrapper has no box, so each layer stacks by its own z-index. */
function RoomLayers({ room }: { readonly room: FrontRowRoom }) {
  return (
    <div className="front-row-art" aria-hidden="true">
      <span data-layer="board" />
      <span data-layer="desk" />
      {room.extras.map((extra, i) => <span key={`${extra.name}-${i}`} data-extra={extra.name} style={{ width: `calc(var(--fr-u) * ${extra.width})`, height: `calc(var(--fr-u) * ${extra.height})`, zIndex: extra.z, ...extra.place }} />)}
      <span data-layer="mat" />
    </div>
  );
}

/**
 * The folio or the notebook lying on the desk, and the whole object is the button. Each shows its own raster with
 * its tag over it.
 */
function DeskObject({ object, label, tag, open }: { readonly object: RoomObject; readonly label: string; readonly tag: string; readonly open: DeskObjects["open"] }) {
  return (
    <button type="button" className="front-row-object" data-object={object} aria-label={label} aria-haspopup="dialog" onClick={(e) => open(object, e.currentTarget)}>
      <span className="front-row-object-art" />
      <span className="front-row-object-tag">{tag}</span>
    </button>
  );
}

/** A board or desk that scrolls its own long content. It joins the tab order only while it has something to scroll. */
function ScrollArea({ area, label, areaRef, children }: { readonly area: "board" | "desk"; readonly label: string; readonly areaRef?: Ref<HTMLElement> | undefined; readonly children: ReactNode }) {
  const own = useRef<HTMLElement>(null);
  const scrolls = useOverflow(own);
  return (
    <section
      ref={(node) => {
        own.current = node;
        if (typeof areaRef === "function") areaRef(node);
        // React ref forwarding writes the supplied ref during commit, never during render.
        // eslint-disable-next-line react/immutability
        else if (areaRef) areaRef.current = node;
      }}
      className="front-row-area" data-area={area} aria-label={label} {...(scrolls ? { tabIndex: 0 } : {})}
    >{children}</section>
  );
}

function useOverflow(ref: RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    const mutations = new MutationObserver(() => {
      for (const child of node.children) observer.observe(child);
      measure();
    });
    mutations.observe(node, { childList: true, subtree: true, characterData: true });
    measure();
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [ref]);
  return overflows;
}
