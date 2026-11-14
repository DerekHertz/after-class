import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prefetchReviewArt, readRoomArt } from "../src/app/art-prefetch";
import type { HintDocument } from "../src/app/art-prefetch";
import { COMPANIONS } from "../src/app/appearance";
import { ROOM_ART } from "../src/app/front-row";
import { COMPANION_CELL, MAX_DEVICE_PIXEL_RATIO } from "../scripts/build-art";
import { COMPACT_ROOM_LAYERS, FULL_ROOM_MIN, FULL_ROOM_QUERY } from "../src/shared/room-art";
import type { RoomArtTable } from "../src/shared/room-art";

const table: RoomArtTable = {
  rooms: { "last-desk": { plate: "/app/last-desk-aaaaaaaa.webp", layers: ["/app/rail-background-bbbbbbbb.webp", "/app/rail-board-cccccccc.webp"], compact: ["/app/rail-background-bbbbbbbb.webp"] }, "study-bench": { plate: "/app/study-bench-dddddddd.webp", layers: ["/app/harbor-background-eeeeeeee.webp"], compact: ["/app/harbor-background-eeeeeeee.webp"] } },
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
    expect(prefetchReviewArt("last-desk", doc, true)).toBe(4);
    expect(links).toEqual([...table.rooms["last-desk"]!.layers, ...table.shared].map((href) => ({ rel: "prefetch", as: "image", href })));
  });

  test("a phone's layout, which draws only the background, is hinted the background and the frames, not the board, desk and mat", () => {
    const { doc, links } = page(JSON.stringify(table));
    expect(prefetchReviewArt("last-desk", doc, false)).toBe(3);
    expect(links.map((l) => l.href)).toEqual([...table.rooms["last-desk"]!.compact, ...table.shared]);
  });

  test("hints a file once per page, and another room's layers when the room changes", () => {
    const { doc, links } = page(JSON.stringify(table));
    prefetchReviewArt("last-desk", doc, true);
    expect(prefetchReviewArt("last-desk", doc, true)).toBe(0);
    expect(prefetchReviewArt("study-bench", doc, true)).toBe(1);
    expect(links.map((l) => l.href).filter((h) => h.includes("folio"))).toHaveLength(2);
  });

  test("a page without the table, with a broken one, or for an unknown room hints nothing", () => {
    for (const json of [null, "{", ""]) {
      const { doc, links } = page(json);
      expect(prefetchReviewArt("last-desk", doc, true)).toBe(0);
      expect(links).toEqual([]);
    }
    for (const scene of ["attic", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const { doc, links } = page(JSON.stringify(table));
      expect({ scene, hinted: prefetchReviewArt(scene, doc, true) }).toEqual({ scene, hinted: 0 });
      expect(links).toEqual([]);
    }
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

describe("the layout switch and the companion's sheet follow the size the art is drawn at", () => {
  const frontRow = readFileSync(new URL("../src/app/front-row.css", import.meta.url), "utf8");
  const companion = readFileSync(new URL("../src/app/hd-companion.css", import.meta.url), "utf8");

  test("the full layout and the compact one switch at FULL_ROOM_MIN in the stylesheets, as the head script and the prefetch ask", () => {
    const { width, height } = FULL_ROOM_MIN;
    expect(FULL_ROOM_QUERY).toBe(`(min-width: ${width}px) and (min-height: ${height}px)`);
    expect(frontRow).toContain(`@media ${FULL_ROOM_QUERY} {`);
    expect(frontRow).toContain(`@media (max-width: ${width - 1}px), (max-height: ${height - 1}px) {`);
    expect(frontRow).toContain(`@media (min-width: ${width}px) and (max-width: 1359px) and (min-height: ${height}px) {`);
    const stray = [...frontRow.matchAll(/@media ([^{]*)\{/g)].map((m) => m[1]!.trim()).filter((q) => /\b(899|900|559|560)px/.test(q) && !q.startsWith("(min-width: 1360px)"));
    expect([...new Set(stray)].sort()).toEqual([FULL_ROOM_QUERY, `(max-width: ${width - 1}px), (max-height: ${height - 1}px)`, `(min-width: ${width}px) and (max-width: 1359px) and (min-height: ${height}px)`].sort());
    expect(COMPACT_ROOM_LAYERS).toEqual(["background"]);
  });

  /** Whether a window matches a media query list, for the features hd-companion.css uses. */
  function matches(list: string, window: { width: number; height: number; dppx: number }): boolean {
    const feature = (text: string): boolean => {
      const m = text.match(/^\((min|max)-(width|height|resolution):\s*([\d.]+)(px|dppx)\)$/);
      if (m === null) throw new Error(`the test cannot evaluate ${text}`);
      const value = window[m[2] === "resolution" ? "dppx" : (m[2] as "width" | "height")];
      return m[1] === "min" ? value >= Number(m[3]) : value <= Number(m[3]);
    };
    const group = (text: string): boolean => {
      const terms: string[] = [];
      let depth = 0, start = 0;
      const ops: string[] = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        else if (depth === 0 && /^ (and|or) /.test(text.slice(i, i + 5))) { terms.push(text.slice(start, i)); ops.push(text.slice(i + 1).startsWith("and") ? "and" : "or"); start = i + (ops.at(-1) === "and" ? 5 : 4); i = start - 1; }
      }
      terms.push(text.slice(start));
      const values = terms.map((t) => { const x = t.trim(); return x.startsWith("((") ? group(x.slice(1, -1)) : feature(x); });
      expect(new Set(ops).size).toBeLessThanOrEqual(1);
      return ops[0] === "or" ? values.some(Boolean) : values.every(Boolean);
    };
    return list.split(/,\s*/).some((q) => group(q.trim()));
  }

  /** CSS px tall that the review room draws the companion, from front-row.css's --fr-u0, --fr-b and --fr-u, and ROOM_ART.companionSize. Below the full layout it is 72. */
  function drawnHeight(width: number, height: number): number {
    if (width < FULL_ROOM_MIN.width || height < FULL_ROOM_MIN.height) return 72;
    const u0 = Math.min((1.12 * height) / 992, (1.25 * width) / 1586);
    const b = Math.max(width / 1586, (height - u0 * 170) / 992);
    return ROOM_ART.companionSize * Math.min(b, u0);
  }

  const query = companion.match(/@media\s+([^{]*?)\s*\{\s*\.front-row-buddy \.companion-sprite \{ --companion-sheet: var\(--companion-sheet-large\); \}/)?.[1];
  const widths = [390, 768, 899, 900, 1024, 1280, 1366, 1440, 1536, 1600, 1680, 1920, 2048, 2400, 2560, 3000, 3440, 3840, 5120];
  const heights = [500, 559, 560, 600, 720, 768, 800, 900, 1000, 1080, 1200, 1300, 1440, 1600, 2160];
  const ratios = [1, 1.1, 1.25, 1.33, 1.5, 1.75, 2, 2.25, 2.5, 2.625, 2.75, 3];

  test("the stylesheet's formulas are the ones the test draws the companion with", () => {
    expect(frontRow).toContain("--fr-u0: min(calc(1.12 * 100cqh / 992), calc(1.25 * 100cqw / 1586));");
    expect(frontRow).toContain("--fr-b: max(calc(100cqw / 1586), calc((100cqh - var(--fr-u0) * 170) / 992));");
    expect(frontRow).toContain("--fr-u: min(var(--fr-b), var(--fr-u0));");
    expect(ROOM_ART.plate).toEqual({ width: 1586, height: 992 });
    expect(ROOM_ART.deskCovers).toBe(170);
    expect(query).toBeDefined();
  });

  test("the sheet a window gets has as many pixels as the companion is drawn with, at any pixel ratio up to 3", () => {
    const wasted: string[] = [];
    for (const width of widths) for (const height of heights) for (const dppx of ratios) {
      const needed = drawnHeight(width, height) * dppx;
      const cell = matches(query!, { width, height, dppx }) ? COMPANION_CELL.large : COMPANION_CELL.small;
      expect({ width, height, dppx, covered: cell >= Math.min(needed, COMPANION_CELL.large) }).toEqual({ width, height, dppx, covered: true });
      if (cell === COMPANION_CELL.large && needed <= COMPANION_CELL.small * 0.75) wasted.push(`${width}x${height}@${dppx} needs ${Math.round(needed)}`);
    }
    expect(MAX_DEVICE_PIXEL_RATIO).toBe(3);
    expect(wasted).toEqual([]);
  });

  test("the cases that decided this: 1920x1080 at 1.5x needs the large sheet, 1440x900 at 1x and a phone do not", () => {
    expect(drawnHeight(1920, 1080) * 1.5).toBeCloseTo(399.5, 0);
    expect(matches(query!, { width: 1920, height: 1080, dppx: 1.5 })).toBe(true);
    expect(matches(query!, { width: 1440, height: 900, dppx: 1 })).toBe(false);
    expect(matches(query!, { width: 1440, height: 900, dppx: 2 })).toBe(true);
    expect(matches(query!, { width: 390, height: 844, dppx: 3 })).toBe(false);
    expect(matches(query!, { width: 1920, height: 1080, dppx: 1 })).toBe(false);
  });
});
