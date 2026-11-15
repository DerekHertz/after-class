import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { CSSProperties, ReactNode, Ref, RefObject } from "react";
import type { Appearance, CompanionActivity, SceneId } from "./appearance";
import { COMPANION_STATUS, Companion } from "./companion";
import { clearReaction } from "./room/reaction-store";
import { sourceButtonLabel } from "./room-object";
import type { RoomObject } from "./room-object";
import { layoutRoom } from "./room/layout";
import type { FullRoomLayout, NineSliceLayer, Rect, Size } from "./room/layout";
import { FRONT_ROW_ROOMS } from "./room/rooms";
import type { Edges, FrontRowRoom } from "./room/rooms";
import { FULL_ROOM_QUERY } from "../shared/room-art";

declare module "react" {
  interface CSSProperties { [variable: `--${string}`]: string | number | undefined }
}

/** A nine-slice's cuts in asset pixels, as border-image-slice reads them. */
const slice = ({ top, right, bottom, left }: Edges): string => `${top} ${right} ${bottom} ${left}`;

/** The room's art and colours as the custom properties front-row.css reads: the nine-slice cuts, the surface colours, then the palette. */
export function roomStyle(scene: SceneId): CSSProperties {
  const room: FrontRowRoom = FRONT_ROW_ROOMS[scene];
  const { board, desk, mat } = room;
  const style: CSSProperties = {
    "--fr-phone-x": room.phoneArtX,
    "--fr-board-fill": board.fill, "--fr-board-ink": board.ink, "--fr-board-ink-soft": board.inkSoft,
    "--fr-mat-fill": mat.fill, "--fr-mat-ink": mat.ink, "--fr-mat-ink-soft": mat.inkSoft,
    "--fr-board-slice": slice(board.art.slice), "--fr-desk-slice": slice(desk.art.slice), "--fr-mat-slice": slice(mat.art.slice),
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
 * The review seen from the front-row desk. Every room renders this same tree; a room only changes data attributes, custom
 * properties and the positions room/layout.ts gives, so switching rooms or companions never remounts the response field and
 * its draft.
 */
export function FrontRowScene({ scene, layout, appearance, activity, boardRef }: {
  readonly scene: SceneId;
  readonly layout: FrontRowLayout;
  readonly appearance: Pick<Appearance, "companion" | "visible" | "motion">;
  readonly activity: CompanionActivity;
  readonly boardRef?: Ref<HTMLElement>;
}) {
  const room = FRONT_ROW_ROOMS[scene];
  const sceneRef = useRef<HTMLDivElement>(null);
  const size = useContentSize(sceneRef);
  const composition = useFullRoom() ? "full" : "compact";
  const placed = size === null ? null : layoutRoom(scene, size, composition);
  const full = placed?.composition === "full" ? placed : null;
  useEffect(() => { clearReaction(); }, [scene, appearance.companion, appearance.visible]);
  return (
    <div ref={sceneRef} className="front-row-scene" data-room={scene} data-board-tone={room.board.tone} data-mat-tone={room.mat.tone} data-mat-actions={room.mat.actions} data-board-align={room.board.align} data-phase={layout.kind}>
      {/* The window's layers, back to front, with every control placed on them from room/layout.ts. */}
      <div className="front-row-stage" style={full ? stageStyle(full) : undefined}>
        <RoomLayers room={room} full={full} />
        {layout.kind === "setup" ? layout.form : <>
          <ScrollArea area="board" label={room.surfaceName} areaRef={boardRef}>{layout.board}</ScrollArea>
          <ScrollArea area="desk" label="Your desk">{layout.desk}</ScrollArea>
        </>}
        <div className="front-row-buddy" style={full ? box(full.companion.box) : undefined}>
          {appearance.visible ? <Companion id={appearance.companion} activity={activity} /> : <span className="quiet-status" role="status">{COMPANION_STATUS[activity]}</span>}
        </div>
        {layout.kind === "review" && <>
          <DeskObject object="source" label={sourceButtonLabel(layout.objects.cited)} tag={layout.objects.cited === 0 ? "Source" : `Source · ${layout.objects.cited}`} open={layout.objects.open} rect={full?.objects.source} />
          <DeskObject object="history" label="Earlier in this review" tag="Earlier" open={layout.objects.open} rect={full?.objects.history} />
        </>}
      </div>
    </div>
  );
}

const box = ({ left, top, width, height }: Rect): CSSProperties => ({ left, top, width, height });
const edges = ({ top, right, bottom, left }: Edges): string => `${top}px ${right}px ${bottom}px ${left}px`;

/**
 * The scale the board's type follows, and the two text areas. The setup form draws its own text areas, so they are placed
 * through custom properties rather than on the elements. The board's text starts below the navigation where the board's own
 * top would sit under it.
 */
function stageStyle({ u, window, text }: FullRoomLayout): CSSProperties {
  const sides = ({ left, top, width, height }: Rect, topEdge: string) => `${topEdge} ${window.width - left - width}px ${window.height - top - height}px ${left}px`;
  return {
    "--fr-u": `${u}px`,
    "--fr-board-text": sides(text.board, `max(${text.board.top}px, var(--fr-nav-reserve))`),
    "--fr-desk-text": sides(text.desk, `${text.desk.top}px`),
  };
}

/** The scene's content box, which is the window the room is laid out in. It is applied before the frame that changed it paints. */
function useContentSize(ref: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      flushSync(() => setSize((old) => old?.width === width && old.height === height ? old : { width, height }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

const fullRoom = typeof matchMedia === "undefined" ? null : matchMedia(FULL_ROOM_QUERY);
const onFullRoomChange = (change: () => void) => {
  fullRoom?.addEventListener("change", change);
  return () => fullRoom?.removeEventListener("change", change);
};

/** Whether the window is large enough for the room built from layers, asked the way front-row.css's media queries ask. */
function useFullRoom(): boolean {
  return useSyncExternalStore(onFullRoomChange, () => fullRoom?.matches ?? false, () => false);
}

/** The room's pictures, drawn behind its text and controls. The wrapper has no box, so each layer stacks by its own z-index. */
function RoomLayers({ room, full }: { readonly room: FrontRowRoom; readonly full: FullRoomLayout | null }) {
  const layers = full?.layers;
  const nineSlice = (layer: NineSliceLayer | undefined) => layer && { ...box(layer.rect), "--fr-bw": edges(layer.border) };
  return (
    <div className="front-row-art" aria-hidden="true">
      <span data-layer="background" style={layers && box(layers.background)} />
      <span data-layer="board" style={nineSlice(layers?.board)} />
      <span data-layer="desk" style={nineSlice(layers?.desk)} />
      {room.extras.map((extra, i) => {
        const placed = layers?.extras[i];
        return <span key={`${extra.name}-${i}`} data-extra={extra.name} style={placed && { ...box(placed.rect), zIndex: placed.z }} />;
      })}
      <span data-layer="mat" style={nineSlice(layers?.mat)} />
    </div>
  );
}

/**
 * The folio or the notebook lying on the desk, and the whole object is the button. Each shows its own raster with
 * its tag over it.
 */
function DeskObject({ object, label, tag, open, rect }: { readonly object: RoomObject; readonly label: string; readonly tag: string; readonly open: DeskObjects["open"]; readonly rect: Rect | undefined }) {
  return (
    <button type="button" className="front-row-object" data-object={object} aria-label={label} aria-haspopup="dialog" style={rect && box(rect)} onClick={(e) => open(object, e.currentTarget)}>
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
