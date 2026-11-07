import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPANIONS, SCENES, parseAppearance } from "../src/app/appearance";
import type { CompanionId, SceneId } from "../src/app/appearance";
import { CROP_LIMIT, FRONT_ROW_ROOMS, FrontRowScene, PLATE, reserveNavSpace, roomStyle, stageBox, topCropLimit } from "../src/app/front-row";
import type { FrontRowLayout, PlateBox } from "../src/app/front-row";
import { contrast, medianColor, readPng } from "./png";

const rooms = Object.keys(FRONT_ROW_ROOMS) as SceneId[];
const plate = (scene: SceneId) => readPng(new URL(`../src/app/assets/front-row/${scene}.png`, import.meta.url));
const overlaps = (a: PlateBox, b: PlateBox) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe("the three skins keep saved preferences", () => {
  test("each saved scene ID opens its selected skin", () => {
    expect(SCENES["last-desk"].name).toBe("Rail-side Classroom");
    expect(SCENES["study-bench"].name).toBe("Harbor Study Terrace");
    expect(SCENES["projection-booth"].name).toBe("Lantern Canal Film Club");
    for (const scene of rooms) expect(parseAppearance(JSON.stringify({ scene })).scene).toBe(scene);
  });
});

describe("each room's text sits on its own art and reads clearly", () => {
  test("every plate is the measured size with no transparency", () => {
    for (const scene of rooms) {
      const png = plate(scene);
      expect({ scene, width: png.width, height: png.height, alpha: png.alpha }).toEqual({ scene, ...PLATE, alpha: false });
    }
  });

  test("board and mat ink pass WCAG AA against the colour the plate actually has there", () => {
    for (const scene of rooms) {
      const png = plate(scene);
      const room = FRONT_ROW_ROOMS[scene];
      for (const [surface, spec] of [["board", room.board], ["mat", room.mat]] as const) {
        const painted = medianColor(png, spec.box);
        for (const ink of [spec.ink, spec.inkSoft]) expect({ scene, surface, ink, ratio: contrast(ink, painted) >= 4.5 }).toEqual({ scene, surface, ink, ratio: true });
        // A phone draws the surface in flat colour; it must be the art's own colour, not a recolour.
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(spec.fill.slice(i, i + 2), 16));
        expect({ scene, surface, distance: Math.abs(r! - painted[0]) + Math.abs(g! - painted[1]) + Math.abs(b! - painted[2]) < 24 }).toEqual({ scene, surface, distance: true });
      }
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
  test("board above mat, companion and notebook beside the mat, all inside the shown part of the plate", () => {
    for (const scene of rooms) {
      const room = FRONT_ROW_ROOMS[scene];
      for (const box of [room.board.box, room.mat.box, room.companion, room.notebook]) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(1);
        expect(box.top).toBeGreaterThanOrEqual(room.cropTop);
        expect(box.bottom).toBeLessThanOrEqual(1);
        expect(box.left).toBeLessThan(box.right);
        expect(box.top).toBeLessThan(box.bottom);
      }
      expect(room.board.box.bottom).toBeLessThan(room.mat.box.top);
      for (const side of [room.companion, room.notebook]) {
        expect(overlaps(side, room.mat.box)).toBe(false);
        expect(overlaps(side, room.board.box)).toBe(false);
      }
    }
  });

  test("at the full-bleed crop limits the board stays mostly in view and the notebook and companion stay over their art", () => {
    const perSide = CROP_LIMIT.sides / 2;
    for (const scene of rooms) {
      const room = FRONT_ROW_ROOMS[scene];
      const board = stageBox(room.board.box, room.cropTop);
      const kept = (board.top + board.height - topCropLimit(scene) * 100) / board.height;
      expect({ scene, kept: kept >= 0.75 }).toEqual({ scene, kept: true });
      expect(roomStyle(scene)["--fr-max-crop-top"]).toBe(topCropLimit(scene));
      for (const [name, box] of [["notebook", room.notebook], ["companion", room.companion]] as const) {
        const slide = Math.max(0, perSide - Math.min(box.left, 1 - box.right));
        expect({ scene, name, overArt: slide <= (box.right - box.left) / 2 }).toEqual({ scene, name, overArt: true });
      }
      expect({ scene, matWhole: perSide < room.mat.box.left && perSide < 1 - room.mat.box.right }).toEqual({ scene, matWhole: true });
    }
  });

  test("a plate box moves into scene percentages under the cropped top bar", () => {
    expect(stageBox({ left: 0.25, top: 0.1, right: 0.75, bottom: 1 }, 0.1)).toEqual({ left: 25, top: 0, width: 50, height: 100 });
    expect(stageBox({ left: 0, top: 0.5, right: 1, bottom: 0.75 }, 0)).toEqual({ left: 0, top: 50, width: 100, height: 25 });
    expect(roomStyle("study-bench")).toMatchObject({ "--fr-board-left": "20.5%", "--fr-field-ink": FRONT_ROW_ROOMS["study-bench"].palette.fieldInk });
  });
});

describe("switching room or companion keeps one tree", () => {
  const layout: FrontRowLayout = { kind: "review", board: "Two threads each hold a lock the other needs.", desk: <textarea aria-label="Your thinking" defaultValue="A draft in progress" /> };
  const scene = (room: SceneId, companion: CompanionId, visible = true) => renderToStaticMarkup(
    <FrontRowScene scene={room} layout={layout} appearance={{ companion, visible, motion: "system" }} activity="idle" onNotebook={() => {}} />,
  );
  const skeleton = (html: string) => html.replace(/ (data-[a-z-]+|style|aria-label)="[^"]*"/g, "").replace(/>[^<]+</g, "><");

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
    expect(html).toContain(">My notebook</span></button>");
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
