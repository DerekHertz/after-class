import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPANIONS, SCENES, parseAppearance } from "../src/app/appearance";
import type { CompanionId, SceneId } from "../src/app/appearance";
import { FRONT_ROW_ROOMS, FrontRowScene, ROOM_ART, reserveNavSpace, roomStyle } from "../src/app/front-row";
import type { FrontRowLayout, NineSlice } from "../src/app/front-row";
import { OBJECT_ART_SIZE, ROOM_OBJECTS } from "../src/app/room-object";
import type { ObjectArt, RoomObject } from "../src/app/room-object";
import { contrast, medianColor, readPng } from "./png";

const rooms = Object.keys(FRONT_ROW_ROOMS) as SceneId[];
/** The asset names of each room's layers, as the files in assets/front-row-v2 are called. */
const ART = { "last-desk": "rail", "study-bench": "harbor", "projection-booth": "canal" } as const satisfies Record<SceneId, string>;
const decoded = new Map<string, ReturnType<typeof readPng>>();
/** The layers are large, so each is decoded once. */
const layer = (scene: SceneId, name: string) => {
  const file = `${ART[scene]}-${name}.png`;
  if (!decoded.has(file)) decoded.set(file, readPng(new URL(`../src/app/assets/front-row-v2/${file}`, import.meta.url)));
  return decoded.get(file)!;
};
const plate = (scene: SceneId) => readPng(new URL(`../src/app/assets/front-row/${scene}.png`, import.meta.url));
/** The plain area of a nine-slice as fractions of the image, for sampling the colour the text sits on. */
const innerBox = ({ size, inner }: NineSlice) => ({ left: inner.left / size.width, top: inner.top / size.height, right: 1 - inner.right / size.width, bottom: 1 - inner.bottom / size.height });

describe("the three skins keep saved preferences", () => {
  test("each saved scene ID opens its selected skin", () => {
    expect(SCENES["last-desk"].name).toBe("Rail-side Classroom");
    expect(SCENES["study-bench"].name).toBe("Harbor Study Terrace");
    expect(SCENES["projection-booth"].name).toBe("Lantern Canal Film Club");
    for (const scene of rooms) expect(parseAppearance(JSON.stringify({ scene })).scene).toBe(scene);
  });
});

describe("each room's text sits on its own art and reads clearly", () => {
  test("every layer is the measured size, and only the background is opaque", () => {
    for (const scene of rooms) {
      const room = FRONT_ROW_ROOMS[scene];
      const bg = layer(scene, "background");
      expect({ scene, width: bg.width, height: bg.height, alpha: bg.alpha }).toEqual({ scene, width: ROOM_ART.plate.width * ROOM_ART.scale, height: ROOM_ART.plate.height * ROOM_ART.scale, alpha: false });
      for (const [name, art] of [["board", room.board.art], ["desk", room.desk.art], ["mat", room.mat.art]] as const) {
        const png = layer(scene, name);
        expect({ scene, name, width: png.width, height: png.height, alpha: png.alpha }).toEqual({ scene, name, ...art.size, alpha: true });
      }
    }
  }, 60_000);

  test("each nine-slice keeps its corners apart, and its plain area ends inside the corner cuts so it never stretches", () => {
    for (const scene of rooms) {
      const room = FRONT_ROW_ROOMS[scene];
      for (const [name, art] of [["board", room.board.art], ["mat", room.mat.art]] as const) {
        const { slice, inner, size } = art;
        expect({ scene, name, apart: slice.left + slice.right < size.width && slice.top + slice.bottom < size.height }).toEqual({ scene, name, apart: true });
        expect({ scene, name, inside: inner.left <= slice.left && inner.right <= slice.right + 2 && inner.top <= slice.top && inner.bottom <= slice.bottom + 2 }).toEqual({ scene, name, inside: true });
      }
      const { slice, size } = room.desk.art;
      expect({ scene, desk: slice.top === 0 && slice.bottom === 0 && slice.left + slice.right < size.width }).toEqual({ scene, desk: true });
    }
  });

  test("board and mat ink pass WCAG AA against the colour the layer actually has in its plain area", () => {
    for (const scene of rooms) {
      const room = FRONT_ROW_ROOMS[scene];
      for (const [surface, spec] of [["board", room.board], ["mat", room.mat]] as const) {
        const painted = medianColor(layer(scene, surface), innerBox(spec.art));
        for (const ink of [spec.ink, spec.inkSoft]) expect({ scene, surface, ink, ratio: contrast(ink, painted) >= 4.5 }).toEqual({ scene, surface, ink, ratio: true });
        // A phone draws the surface in flat colour; it must be the art's own colour, not a recolour.
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(spec.fill.slice(i, i + 2), 16));
        expect({ scene, surface, distance: Math.abs(r! - painted[0]) + Math.abs(g! - painted[1]) + Math.abs(b! - painted[2]) < 24 }).toEqual({ scene, surface, distance: true });
      }
    }
  });

  test("the room picker's plates are still the measured size with no transparency", () => {
    for (const scene of rooms) {
      const png = plate(scene);
      expect({ scene, width: png.width, height: png.height, alpha: png.alpha }).toEqual({ scene, width: 1585, height: 992, alpha: false });
    }
  });

  test("the canal film club writes dark ink on its light screen and light ink on its dark mat", () => {
    const canal = FRONT_ROW_ROOMS["projection-booth"];
    expect([canal.board.tone, canal.mat.tone]).toEqual(["light", "dark"]);
    for (const scene of ["last-desk", "study-bench"] as const) expect([FRONT_ROW_ROOMS[scene].board.tone, FRONT_ROW_ROOMS[scene].mat.tone]).toEqual(["dark", "light"]);
  });

  test("the response field, buttons, bar and focus ring have enough contrast in every room", () => {
    for (const scene of rooms) {
      const { palette: p, mat } = FRONT_ROW_ROOMS[scene];
      const pairs = { field: contrast(p.fieldInk, p.field), share: contrast(p.accentInk, p.accent), quiet: contrast(p.quietInk, p.quiet), bar: contrast(p.barInk, p.bar) };
      for (const [name, ratio] of Object.entries(pairs)) expect({ scene, name, aa: ratio >= 4.5 }).toEqual({ scene, name, aa: true });
      expect({ scene, focus: contrast(p.focus, mat.fill) >= 3 }).toEqual({ scene, focus: true });
    }
  });
});

describe("room geometry", () => {
  test("the roomStyle custom properties carry the nine-slice cuts, the text insets and the palette", () => {
    const rail = roomStyle("last-desk");
    expect(rail).toMatchObject({ "--fr-board-slice": "88 128 124 128", "--fr-mat-slice": "56 60 60 56", "--fr-desk-slice": "0 300 0 300", "--fr-bg-ax": 1, "--fr-wall-to": 1228 });
    expect(rail["--fr-board-bw"]).toBe("calc(var(--fr-u) * 44) calc(var(--fr-u) * 64) calc(var(--fr-u) * 62) calc(var(--fr-u) * 64)");
    expect(rail["--fr-board-il"]).toBe(`calc(var(--fr-u) * ${128 / ROOM_ART.scale + ROOM_ART.boardTextPad})`);
    expect(roomStyle("study-bench")).toMatchObject({ "--fr-board-min-aspect": 0, "--fr-field-ink": FRONT_ROW_ROOMS["study-bench"].palette.fieldInk, "--fr-phone-x": "50%" });
  });

  test("each extra is the size its room declares, and the harbor stands three lamps on its beam", () => {
    for (const scene of rooms) for (const extra of FRONT_ROW_ROOMS[scene].extras) {
      const png = layer(scene, extra.name);
      expect({ scene, name: extra.name, width: png.width / ROOM_ART.scale, height: png.height / ROOM_ART.scale, alpha: png.alpha, placed: Object.keys(extra.place).length > 0 })
        .toEqual({ scene, name: extra.name, width: extra.width, height: extra.height, alpha: true, placed: true });
    }
    expect(FRONT_ROW_ROOMS["study-bench"].extras.filter((e) => e.name === "lamp")).toHaveLength(3);
  });
});

describe("switching room or companion keeps one tree", () => {
  const layout: FrontRowLayout = { kind: "review", board: "Two threads each hold a lock the other needs.", desk: <textarea aria-label="Your thinking" defaultValue="A draft in progress" />, objects: { cited: 0, open: () => {} } };
  const scene = (room: SceneId, companion: CompanionId, visible = true) => renderToStaticMarkup(
    <FrontRowScene scene={room} layout={layout} appearance={{ companion, visible, motion: "system" }} activity="idle" />,
  );
  // The art layers differ by room, but they sit in one wrapper ahead of the text areas, so they never move the response field.
  const skeleton = (html: string) => html.replace(/<div class="front-row-art"[^>]*>.*?<\/div>/, "<art/>").replace(/ (data-[a-z-]+|style|aria-label)="[^"]*"/g, "").replace(/>[^<]+</g, "><");

  test("every room renders the same elements in the same order, so the draft is never remounted", () => {
    const shapes = new Set(rooms.map((room) => skeleton(scene(room, "mote"))));
    expect(shapes.size).toBe(1);
    for (const room of rooms) expect(scene(room, "mote")).toContain("A draft in progress");
  });

  test("every companion works in every room through the same slot", () => {
    for (const room of rooms) {
      const shapes = new Set((Object.keys(COMPANIONS) as CompanionId[]).map((id) => skeleton(scene(room, id))));
      expect(shapes.size).toBe(1);
      for (const id of Object.keys(COMPANIONS) as CompanionId[]) expect(scene(room, id)).toContain(`data-companion="${id}"`);
    }
  });

  test("a hidden companion leaves its status in words, and the notebook stays on the desk", () => {
    const html = scene("projection-booth", "yun", false);
    expect(html).not.toContain("data-companion");
    expect(html).toContain('<span class="quiet-status" role="status">Ready when you are</span>');
    expect(html).toContain('aria-label="Earlier in this review"');
  });
});

describe("the folio and the notebook on the desk open the source and history", () => {
  const render = (layout: FrontRowLayout) => renderToStaticMarkup(
    <FrontRowScene scene="last-desk" layout={layout} appearance={{ companion: "mote", visible: true, motion: "system" }} activity="idle" />,
  );
  const review = (cited: number): FrontRowLayout => ({ kind: "review", board: "Why?", desk: "Draft", objects: { cited, open: () => {} } });

  test("each object is one dialog-opening button named for what it opens, with the citation count on the folio", () => {
    const html = render(review(2));
    expect(html).toMatch(/<button type="button" class="front-row-object" data-object="source" aria-label="Open source · 2 cited" aria-haspopup="dialog">.*?>Source · 2<\/span><\/button>/);
    expect(html).toMatch(/<button type="button" class="front-row-object" data-object="history" aria-label="Earlier in this review" aria-haspopup="dialog">.*?>Earlier<\/span><\/button>/);
    expect(render(review(0))).toContain('aria-label="Open source" aria-haspopup="dialog"');
  });

  test("before the review starts, the desk offers neither the source nor the history", () => {
    const html = render({ kind: "setup", form: "Choose a starting point" });
    expect(html).not.toContain("front-row-object");
    expect(html).not.toContain("Open source");
    expect(html).not.toContain("Earlier in this review");
  });
});

describe("the folio and the notebook are the supplied art, and their pages read clearly", () => {
  const objects = Object.keys(ROOM_OBJECTS) as RoomObject[];
  const art = (object: RoomObject) => readPng(new URL(`../src/app/assets/room-objects/${object === "source" ? "source-folio" : "review-notebook"}.png`, import.meta.url));
  const pixel = (png: ReturnType<typeof art>, x: number, y: number) => png.rgba.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4);

  test("each frame is the measured size, with transparent outer corners so the room shows around it", () => {
    for (const object of objects) {
      const png = art(object);
      expect({ object, width: png.width, height: png.height, alpha: png.alpha }).toEqual({ object, ...OBJECT_ART_SIZE, alpha: true });
      for (const [x, y] of [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]] as const) expect({ object, x, y, alpha: pixel(png, x, y)[3] }).toEqual({ object, x, y, alpha: 0 });
    }
  });

  test("ink, soft ink, links and errors pass WCAG AA on the parchment each page actually has", () => {
    for (const object of objects) {
      const page = medianColor(art(object), ROOM_OBJECTS[object].page);
      const spec: ObjectArt = ROOM_OBJECTS[object];
      for (const ink of [spec.ink, spec.inkSoft, spec.link, spec.danger]) expect({ object, ink, aa: contrast(ink, page) >= 4.5 }).toEqual({ object, ink, aa: true });
    }
  });

  test("the notebook's repeating cut starts and ends at the same point of the ring column, so the rings tile without a seam", () => {
    const png = art("history");
    const { slice } = ROOM_OBJECTS.history;
    const end = png.height - slice.bottom;
    let diff = 0;
    for (let x = 0; x < slice.left; x++) for (let c = 0; c < 3; c++) diff += Math.abs(pixel(png, x, slice.top)[c]! - pixel(png, x, end)[c]!);
    expect(diff / (slice.left * 3)).toBeLessThan(12);
  });
});

describe("the board starts below the navigation", () => {
  test("the reserve follows the navigation's measured bottom, including when it wraps to a second row", () => {
    const reserve = new Map<string, string>();
    let resize = () => {};
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const style = { setProperty: (name: string, value: string) => reserve.set(name, value), removeProperty: (name: string) => reserve.delete(name) };
      const bar = { offsetTop: 8, offsetHeight: 44, parentElement: { style } };
      const release = reserveNavSpace(bar as unknown as HTMLElement);
      resize();
      expect(reserve.get("--fr-nav-reserve")).toBe("64px");
      bar.offsetHeight = 102;
      resize();
      expect(reserve.get("--fr-nav-reserve")).toBe("122px");
      release();
      expect(reserve.has("--fr-nav-reserve")).toBe(false);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
