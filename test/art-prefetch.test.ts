import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prefetchReviewArt, readRoomArt } from "../src/app/art-prefetch";
import type { HintDocument } from "../src/app/art-prefetch";
import { COMPANIONS } from "../src/app/appearance";
import type { RoomArtTable } from "../src/shared/room-art";

const table: RoomArtTable = {
  rooms: { "last-desk": { plate: "/app/last-desk-aaaaaaaa.webp", layers: ["/app/rail-background-bbbbbbbb.webp", "/app/rail-board-cccccccc.webp"] }, "study-bench": { plate: "/app/study-bench-dddddddd.webp", layers: ["/app/harbor-background-eeeeeeee.webp"] } },
  shared: ["/app/closed-folio-ffffffff.webp", "/app/source-folio-gggggggg.webp"],
};

function page(json: string | null) {
  const links: { rel: string; as: string; href: string }[] = [];
  const doc: HintDocument = {
    getElementById: () => (json === null ? null : { textContent: json }),
    createElement: () => ({ rel: "", as: "", href: "" }),
    head: { append: (node) => links.push(node as unknown as (typeof links)[number]) },
  };
  return { doc, links };
}

describe("prefetching the review room while the learner is on another screen", () => {
  test("hints the room's layers, then the folio and notebook, as image prefetches", () => {
    const { doc, links } = page(JSON.stringify(table));
    expect(prefetchReviewArt("last-desk", doc)).toBe(4);
    expect(links).toEqual([...table.rooms["last-desk"]!.layers, ...table.shared].map((href) => ({ rel: "prefetch", as: "image", href })));
  });

  test("hints a file once per page, and another room's layers when the room changes", () => {
    const { doc, links } = page(JSON.stringify(table));
    prefetchReviewArt("last-desk", doc);
    expect(prefetchReviewArt("last-desk", doc)).toBe(0);
    expect(prefetchReviewArt("study-bench", doc)).toBe(1);
    expect(links.map((l) => l.href).filter((h) => h.includes("folio"))).toHaveLength(2);
  });

  test("a page without the table, with a broken one, or for an unknown room hints nothing", () => {
    for (const json of [null, "{", ""]) {
      const { doc, links } = page(json);
      expect(prefetchReviewArt("last-desk", doc)).toBe(0);
      expect(links).toEqual([]);
    }
    expect(prefetchReviewArt("attic", page(JSON.stringify(table)).doc)).toBe(0);
    expect(readRoomArt(page("{").doc)).toBeNull();
  });
});

describe("each companion has a small sheet for small places and a large one for the review room", () => {
  const css = readFileSync(new URL("../src/app/hd-companion.css", import.meta.url), "utf8");
  test("the stylesheet names both sheets of every companion", () => {
    for (const id of Object.keys(COMPANIONS)) {
      expect(css).toContain(`.companion-sprite[data-companion="${id}"] { --companion-sheet: url('./assets/companions-v3/${id}-small.webp'); --companion-sheet-large: url('./assets/companions-v3/${id}.webp'); }`);
    }
    expect(css).toContain(".front-row-buddy .companion-sprite { --companion-sheet: var(--companion-sheet-large); }");
  });
});
