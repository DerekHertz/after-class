/**
 * The file-name prefix of each room's pictures: its wide plate in assets/room-plates (`rail-wide`) and its background in
 * assets/front-row-v2 (`rail-background`). scripts/build-app.ts
 * finds a room's art by it, to preload the first screen's picture and to list what the browser may fetch while the learner is
 * on another screen. test/front-row.test.tsx keeps it in step with front-row.css.
 */
export const ROOM_ART_PREFIX = { "last-desk": "rail", "study-bench": "harbor", "projection-booth": "canal" } as const;

/**
 * Where the browser keeps the learner's saved room (src/app/appearance.tsx owns the rest of that value), and the room a page
 * shows when nothing is saved. The build's preload script reads both before the app has loaded, and the build cannot import
 * src/app, which the server's image does not carry. test/front-row.test.tsx keeps these equal to appearance.tsx's.
 */
export const APPEARANCE_STORAGE_KEY = "afterclass.appearance.v1";
export const DEFAULT_ROOM = "last-desk";

/** The pictures a full review room draws: its wide plate, which holds the board, desk and mat. */
export const ROOM_LAYER_ORDER = ["wide"] as const;

/**
 * The window size from which a review is drawn as the room's wide plate. Below it (a phone, a short window) the review is
 * recomposed: the room's background fills the page and the board and desk are flat colour, so the plate is not drawn.
 * src/app/front-row.css and hd-companion.css switch layouts at these sizes, and test/art-prefetch.test.ts keeps them equal.
 * The page's head script and the prefetch hook ask the browser the same question, so they fetch what the layout will draw.
 */
export const FULL_ROOM_MIN = { width: 900, height: 560 } as const;
export const FULL_ROOM_QUERY = `(min-width: ${FULL_ROOM_MIN.width}px) and (min-height: ${FULL_ROOM_MIN.height}px)`;
/** The pictures the compact layout draws. */
export const COMPACT_ROOM_LAYERS = ["background"] as const;

/**
 * True when `key` is a string that names an entry the table itself holds. A value read from storage is anything, and
 * `{"scene":"constructor"}` or `"__proto__"` must not find an inherited member. parseAppearance validates a saved room with this,
 * and scripts/build-app.ts writes this function's source into the page's head script so the two cannot differ. Keep it
 * to syntax every browser reads without a build step.
 */
export function ownKey(table: object, key: unknown): key is string {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);
}

/** The folio and the notebook, closed on the desk and open over the room. Every room draws the same four files. */
export const SHARED_ROOM_ART = ["closed-folio", "closed-notebook", "source-folio", "review-notebook"] as const;

/** What the built page carries as `<script id="room-art" type="application/json">`: bundle URLs, written by scripts/build-app.ts. */
export type RoomArtTable = {
  /** Each room's plate, which is every non-review page's backdrop, its review pictures, and the ones of those that the compact layout draws. */
  readonly rooms: Readonly<Record<string, { readonly plate: string; readonly layers: readonly string[]; readonly compact: readonly string[] }>>;
  readonly shared: readonly string[];
};
