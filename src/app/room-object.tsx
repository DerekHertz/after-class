import { useEffect, useId } from "react";
import type { CSSProperties, ReactNode, Ref, RefObject } from "react";

/** The two things on the desk the learner can pick up and read: the lecture folio and the review notebook. */
export type RoomObject = "source" | "history";

/** At most one object is in the learner's hands. `null` means both are on the desk and the room is in front of them. */
export type Inspecting = RoomObject | null;

/** Where focus goes when the object is put down: the control that picked it up, or the question on the board. */
export type PutDown = "origin" | "question";

type Hex = `#${string}`;

/** Pixel edges of a frame, measured on its 1448x1086 art. */
type Edges = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };

export type ObjectArt = {
  readonly eyebrow: string | null;
  readonly title: string;
  readonly close: string;
  /**
   * Nine-slice cuts. Each corner holds a whole ornament (the folio's clips, spine motifs and first tab; the notebook's
   * ribbon and moon), so only plain wood, cover or parchment stretches when a phone makes the frame tall.
   */
  readonly slice: Edges;
  /**
   * How the edges fill a frame of another shape. The notebook's ring column repeats: its middle cut, y 130 to 754, holds
   * exactly five rings at their 124.75 px pitch, so the rings stay round instead of stretching.
   */
  readonly repeat: "stretch" | "stretch round";
  /** The blank page that holds the live text, as fractions of the art. */
  readonly page: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  /** Ink on the page's amber parchment. */
  readonly ink: Hex;
  readonly inkSoft: Hex;
  readonly link: Hex;
  readonly danger: Hex;
};

export const OBJECT_ART_SIZE = { width: 1448, height: 1086 } as const;

export const ROOM_OBJECTS = {
  source: {
    eyebrow: "From the lecture",
    title: "Lecture evidence",
    close: "Close source",
    slice: { top: 345, right: 308, bottom: 270, left: 340 },
    repeat: "stretch",
    page: { left: 0.12, top: 0.15, right: 0.91, bottom: 0.88 },
    ink: "#2a1a0b", inkSoft: "#563719", link: "#1b3a7a", danger: "#821a12",
  },
  history: {
    eyebrow: null,
    title: "Earlier in this review",
    close: "Hide earlier",
    slice: { top: 130, right: 158, bottom: 332, left: 205 },
    repeat: "stretch round",
    page: { left: 0.14, top: 0.12, right: 0.89, bottom: 0.82 },
    ink: "#1d1a2e", inkSoft: "#47405a", link: "#1b3a7a", danger: "#821a12",
  },
} as const satisfies Record<RoomObject, ObjectArt>;

/** The frame as the custom properties front-row.css reads: slices and page insets in art pixels, then the ink. */
export function objectStyle(object: RoomObject): CSSProperties {
  const art: ObjectArt = ROOM_OBJECTS[object];
  const { width, height } = OBJECT_ART_SIZE;
  return {
    "--obj-slice-top": art.slice.top, "--obj-slice-right": art.slice.right, "--obj-slice-bottom": art.slice.bottom, "--obj-slice-left": art.slice.left,
    "--obj-page-top": art.page.top * height, "--obj-page-right": (1 - art.page.right) * width,
    "--obj-page-bottom": (1 - art.page.bottom) * height, "--obj-page-left": art.page.left * width,
    "--obj-repeat": art.repeat,
    "--obj-ink": art.ink, "--obj-ink-soft": art.inkSoft, "--obj-link": art.link, "--obj-danger": art.danger,
  };
}

/** The attributes that draw an object's art around an element: which raster (front-row.css) and how ROOM_OBJECTS cuts it. */
export function objectFrame(object: RoomObject): { readonly "data-object": RoomObject; readonly style: CSSProperties } {
  return { "data-object": object, style: objectStyle(object) };
}

/** The open source button says how much the current reply cites, so the learner sees there is something to read. */
export function sourceButtonLabel(cited: number): string {
  return cited === 0 ? "Open source" : `Open source · ${cited} cited`;
}

/** Focus goes back to the control that picked the object up while it is still on the page, else to the fallback. */
export function returnTarget<T extends { readonly isConnected: boolean }>(origin: T | null, fallback: T | null): T | null {
  return origin !== null && origin.isConnected ? origin : fallback;
}

/**
 * The object the learner is holding, shown over the room as a modal dialog so focus stays inside it. The room stays in
 * view around it. One dialog serves both objects, so a citation in the notebook turns it into the folio without closing.
 * Escape, the close control and Back to the question all put it down through `onPutDown`.
 */
export function RoomInspector({ object, headingRef, pageRef, onPageScroll, onPutDown, detail, tools, children }: {
  readonly object: Inspecting;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly pageRef?: Ref<HTMLDivElement>;
  readonly onPageScroll?: () => void;
  readonly onPutDown: (to: PutDown) => void;
  readonly detail?: ReactNode;
  readonly tools?: ReactNode;
  readonly children?: ReactNode;
}) {
  const headingId = useId();
  const dialog = (node: HTMLDialogElement | null) => {
    if (node === null) return;
    if (object === null && node.open) node.close();
    if (object !== null && !node.open) node.showModal();
  };
  useEffect(() => {
    if (object !== null) headingRef.current?.focus({ preventScroll: true });
  }, [object, headingRef]);
  const art = object === null ? null : ROOM_OBJECTS[object];
  return (
    <dialog
      ref={dialog}
      className="room-object"
      {...(object === null ? {} : { ...objectFrame(object), "aria-labelledby": headingId })}
      onCancel={(e) => { e.preventDefault(); onPutDown("origin"); }}
    >
      {art !== null && <>
        <header className="room-object-head">
          <div className="room-object-title">
            {art.eyebrow !== null && <p className="room-object-eyebrow">{art.eyebrow}</p>}
            <h2 ref={headingRef} id={headingId} tabIndex={-1}>{art.title}</h2>
            {detail}
          </div>
          <div className="room-object-tools">
            {tools}
            <button type="button" onClick={() => onPutDown("origin")}>{art.close}</button>
          </div>
        </header>
        <div key={object} ref={pageRef} className="room-object-page" role="region" aria-labelledby={headingId} tabIndex={0} onScroll={onPageScroll}>{children}</div>
        <footer className="room-object-foot">
          <button type="button" className="source-return" onClick={() => onPutDown("question")}>Back to the question</button>
        </footer>
      </>}
    </dialog>
  );
}
