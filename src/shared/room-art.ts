/**
 * The file-name prefix of each room's layers in assets/front-row-v2 (`rail-board`, `harbor-desk`, ...). scripts/build-app.ts
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

/** The layers every review room draws first, back to front. Any other layer of the room comes after these. */
export const ROOM_LAYER_ORDER = ["background", "board", "desk", "mat"] as const;

/** The folio and the notebook, closed on the desk and open over the room. Every room draws the same four files. */
export const SHARED_ROOM_ART = ["closed-folio", "closed-notebook", "source-folio", "review-notebook"] as const;

/** What the built page carries as `<script id="room-art" type="application/json">`: bundle URLs, written by scripts/build-app.ts. */
export type RoomArtTable = {
  /** Each room's plate, which is every non-review page's backdrop, and its review layers, background first. */
  readonly rooms: Readonly<Record<string, { readonly plate: string; readonly layers: readonly string[] }>>;
  readonly shared: readonly string[];
};
