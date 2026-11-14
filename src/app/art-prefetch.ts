import { useEffect } from "react";
import { useAppearance } from "./appearance";
import type { RoomArtTable } from "../shared/room-art";

/** The slice of Document that hinting needs, so a test can stand in for it. */
export type HintDocument = {
  getElementById(id: string): { textContent: string | null } | null;
  createElement(tag: "link"): { rel: string; as: string; href: string };
  readonly head: { append(node: never): void };
};

const hinted = new WeakMap<object, Set<string>>();

export function readRoomArt(doc: Pick<HintDocument, "getElementById">): RoomArtTable | null {
  try {
    const text = doc.getElementById("room-art")?.textContent;
    return text ? (JSON.parse(text) as RoomArtTable) : null;
  } catch { return null; }
}

/**
 * Asks the browser to fetch the review room's art at idle priority: the room's layers, then the folio and notebook. The files
 * are named by their content and cached for a year, so a review that opens afterwards finds them in the cache. A page built
 * without the table (the extension's, a test's) hints nothing.
 */
export function prefetchReviewArt(scene: string, doc: HintDocument = document as unknown as HintDocument): number {
  const table = readRoomArt(doc);
  const room = table?.rooms[scene];
  if (table === null || room === undefined) return 0;
  const done = hinted.get(doc) ?? new Set<string>();
  hinted.set(doc, done);
  let added = 0;
  for (const href of [...room.layers, ...table.shared]) {
    if (done.has(href)) continue;
    done.add(href);
    const link = doc.createElement("link");
    link.rel = "prefetch";
    link.as = "image";
    link.href = href;
    doc.head.append(link as never);
    added++;
  }
  return added;
}

/**
 * On a screen where the learner waits (sign-in, the capture page and its Processing wait), fetch the room they are about to review in.
 * Home is left out: it draws its own art at once, and a prefetch there would share the connection with it.
 */
export function usePrefetchReviewArt(): void {
  const { appearance } = useAppearance();
  useEffect(() => { prefetchReviewArt(appearance.scene); }, [appearance.scene]);
}
