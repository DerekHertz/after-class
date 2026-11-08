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

/** A rectangle on a room's plate, in fractions of the plate's width and height, measured from the art. */
export type PlateBox = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/**
 * Which way a surface's text runs. A dark board or mat carries light ink, a light one dark ink. The canal film club is the
 * one room with a light screen and a dark mat, so the board and the mat each carry their own tone.
 */
export type SurfaceTone = "dark" | "light";

/** A surface in the art that holds real text: where to put it, and the flat colour that stands in for it on a phone. */
export type Surface = { readonly box: PlateBox; readonly tone: SurfaceTone; readonly fill: Hex; readonly ink: Hex; readonly inkSoft: Hex };

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

export type FrontRowRoom = {
  /** The blank plate's own painted top bar, which is never shown. A fraction of the plate's height. */
  readonly cropTop: number;
  readonly surfaceName: string;
  /** The board or screen the question is written on, and how each approved design sets the question on it. */
  readonly board: Surface & { readonly align: "start" | "center" };
  /** The mat on the near desk that holds Your thinking. `actions` follows each approved design. */
  readonly mat: Surface & { readonly actions: "below" | "beside" };
  readonly companion: PlateBox;
  /** The notebook drawn on the desk, which opens Earlier in this review. The lecture folio sits on the desk above it. */
  readonly notebook: PlateBox;
  /** Which part of the plate shows behind the phone layout, as a horizontal background position. */
  readonly phoneArtX: `${number}%`;
  readonly palette: RoomPalette;
};

export const PLATE = { width: 1585, height: 992 } as const;

/**
 * The three selected skins. Scene IDs predate the skins and are kept, so a saved preference still finds its room:
 * last-desk is the Rail-side Classroom, study-bench the Harbor Study Terrace and projection-booth the Lantern Canal Film Club.
 * Boxes are the safe insets inside each plate's board and mat, measured on the 1585x992 plates.
 */
export const FRONT_ROW_ROOMS = {
  "last-desk": {
    cropTop: 0.056,
    surfaceName: "Chalkboard",
    board: { align: "start", box: { left: 0.115, top: 0.15, right: 0.765, bottom: 0.52 }, tone: "dark", fill: "#18564b", ink: "#f6efd9", inkSoft: "#c9e6cf" },
    mat: { box: { left: 0.205, top: 0.68, right: 0.8, bottom: 0.955 }, tone: "light", fill: "#fef0e2", ink: "#1e2b45", inkSoft: "#4b5468", actions: "below" },
    companion: { left: 0.015, top: 0.68, right: 0.165, bottom: 0.93 },
    notebook: { left: 0.835, top: 0.755, right: 0.99, bottom: 0.945 },
    phoneArtX: "92%",
    palette: {
      field: "#fffaf3", fieldInk: "#1e2b45", fieldBorder: "#2f4f86", accent: "#2d5aa8", accentInk: "#ffffff",
      quiet: "#f4e8d2", quietInk: "#2a2620", focus: "#c2410c", bar: "#1a2b3b", barInk: "#f6ecd8", wall: "#6d90a4", frame: "#b8875a", desk: "#9f6650",
    },
  },
  "study-bench": {
    cropTop: 0,
    surfaceName: "Learning board",
    board: { align: "center", box: { left: 0.205, top: 0.24, right: 0.795, bottom: 0.572 }, tone: "dark", fill: "#0f725e", ink: "#fbf6e6", inkSoft: "#dff3e6" },
    mat: { box: { left: 0.2, top: 0.735, right: 0.83, bottom: 0.955 }, tone: "light", fill: "#feebcd", ink: "#22252e", inkSoft: "#4f4a40", actions: "beside" },
    companion: { left: 0.015, top: 0.68, right: 0.16, bottom: 0.915 },
    notebook: { left: 0.855, top: 0.795, right: 0.99, bottom: 0.965 },
    phoneArtX: "96%",
    palette: {
      field: "#fffaf0", fieldInk: "#22252e", fieldBorder: "#5b5240", accent: "#0f6b5d", accentInk: "#ffffff",
      quiet: "#fbefd8", quietInk: "#2a2620", focus: "#1d4ed8", bar: "#1d3f7a", barInk: "#fdf6e4", wall: "#5597fb", frame: "#a98a62", desk: "#c27d4d",
    },
  },
  "projection-booth": {
    cropTop: 0.066,
    surfaceName: "Projection screen",
    board: { align: "start", box: { left: 0.305, top: 0.18, right: 0.915, bottom: 0.575 }, tone: "light", fill: "#fbe1c5", ink: "#191d42", inkSoft: "#3b3f63" },
    mat: { box: { left: 0.2, top: 0.75, right: 0.82, bottom: 0.95 }, tone: "dark", fill: "#2c3a61", ink: "#f8ead0", inkSoft: "#d9cdb5", actions: "beside" },
    companion: { left: 0.01, top: 0.72, right: 0.145, bottom: 0.95 },
    notebook: { left: 0.865, top: 0.775, right: 0.99, bottom: 0.965 },
    phoneArtX: "10%",
    palette: {
      field: "#1f2a4b", fieldInk: "#f8ead0", fieldBorder: "#d9cdb5", accent: "#f2b648", accentInk: "#24180a",
      quiet: "#2c3a61", quietInk: "#f8ead0", focus: "#f2b648", bar: "#1f2340", barInk: "#f3e3c3", wall: "#353f67", frame: "#8f8597", desk: "#81494a",
    },
  },
} as const satisfies Record<SceneId, FrontRowRoom>;

/** A plate box moved into the scene, whose top edge is the plate's `cropTop`, as CSS percentages. */
export function stageBox(box: PlateBox, cropTop: number): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } {
  const span = 1 - cropTop;
  return { left: box.left * 100, top: ((box.top - cropTop) / span) * 100, width: (box.right - box.left) * 100, height: ((box.bottom - box.top) / span) * 100 };
}

/**
 * How far the art may be cropped so it fills a window whose shape differs from the plate's. The two sides together may
 * lose `sides` of the shown plate's width, and the companion and notebook slide inward to stay in view. The top may lose
 * the strip above the board plus `navOverlap` of the shown plate's height, where the navigation already sits over the art;
 * the board's text then starts below the navigation. Past either limit the plate stops growing and a blurred copy of it
 * fills the rest of the window.
 */
export const CROP_LIMIT = { sides: 0.08, navOverlap: 0.06 } as const;

/** The most of the shown plate's height that the top may lose: the strip above the board, plus the navigation's overlap. */
export function topCropLimit(scene: SceneId): number {
  const room: FrontRowRoom = FRONT_ROW_ROOMS[scene];
  return stageBox(room.board.box, room.cropTop).top / 100 + CROP_LIMIT.navOverlap;
}

/** The room as the custom properties front-row.css reads: geometry in scene percentages, crop limits, then the palette. */
export function roomStyle(scene: SceneId): CSSProperties {
  const room: FrontRowRoom = FRONT_ROW_ROOMS[scene];
  const style: CSSProperties = {
    "--fr-ratio": PLATE.width / (PLATE.height * (1 - room.cropTop)),
    "--fr-crop-top": room.cropTop,
    "--fr-plate-height": `${100 / (1 - room.cropTop)}%`,
    "--fr-plate-tall": PLATE.height / PLATE.width,
    "--fr-max-crop-x": CROP_LIMIT.sides,
    "--fr-max-crop-top": topCropLimit(scene),
    "--fr-phone-x": room.phoneArtX,
    "--fr-board-fill": room.board.fill, "--fr-board-ink": room.board.ink, "--fr-board-ink-soft": room.board.inkSoft,
    "--fr-mat-fill": room.mat.fill, "--fr-mat-ink": room.mat.ink, "--fr-mat-ink-soft": room.mat.inkSoft,
  };
  for (const [area, box] of [["board", room.board.box], ["mat", room.mat.box], ["buddy", room.companion], ["book", room.notebook]] as const) {
    const b = stageBox(box, room.cropTop);
    Object.assign(style, { [`--fr-${area}-left`]: `${b.left}%`, [`--fr-${area}-top`]: `${b.top}%`, [`--fr-${area}-width`]: `${b.width}%`, [`--fr-${area}-height`]: `${b.height}%` });
  }
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
      {/* The plate at the size that fills the window; every control is placed in its coordinates. */}
      <div className="front-row-stage">
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

/**
 * The folio or the notebook lying on the desk, and the whole object is the button. On a desktop the notebook is the one
 * painted in the room, so only its tag shows over it; the folio, and on a phone both objects, show their own raster.
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
