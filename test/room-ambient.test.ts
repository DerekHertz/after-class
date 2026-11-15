import { describe, expect, test } from "bun:test";
import type { SceneId } from "../src/app/appearance";
import { AMBIENT, AMBIENT_FPS, LIGHT, shaftRows, speckPositions } from "../src/app/room/ambient";
import { layoutRoom } from "../src/app/room/layout";
import type { FullRoomLayout, Rect } from "../src/app/room/layout";
import { companionAt } from "../src/app/room/companion";
import { motionOn } from "../src/app/room/motion";
import { FRONT_ROW_ROOMS, ROOM_ART } from "../src/app/room/rooms";
import { buildScene } from "../src/app/room/scene";
import type { Draw, Specks } from "../src/app/room/scene";

const rooms = Object.keys(FRONT_ROW_ROOMS) as SceneId[];
const window = { width: 1440, height: 900 };
const fullLayout = (scene: SceneId) => layoutRoom(scene, window, "full") as FullRoomLayout;
const specksOf = (draws: readonly Draw[]) => draws.filter((d): d is Specks => d.kind === "specks");
const pictures = (draws: readonly Draw[]) => draws.filter((d) => d.kind !== "specks");
const T = 12_345;

describe("the one motion switch", () => {
  const on = { setting: "system", systemReduced: false, composition: "full" } as const;
  test("motion is on only for a full room that neither the app nor the system asks to hold still", () => {
    expect(motionOn(on)).toBe(true);
    expect(motionOn({ ...on, setting: "reduced" })).toBe(false);
    expect(motionOn({ ...on, systemReduced: true })).toBe(false);
    expect(motionOn({ ...on, composition: "compact" })).toBe(false);
  });
});

describe("ambient life on the draw list", () => {
  test("a still room has no specks and asks for no frame", () => {
    for (const scene of rooms) {
      const list = buildScene(scene, fullLayout(scene), null);
      expect(specksOf(list.draws)).toHaveLength(0);
      expect(list.next).toBeNull();
    }
  });

  test("a moving room adds specks and asks for the next step within one step's time", () => {
    for (const scene of rooms) {
      const list = buildScene(scene, fullLayout(scene), T);
      expect(specksOf(list.draws).length).toBeGreaterThan(0);
      expect(list.next!).toBeGreaterThan(T);
      expect(list.next!).toBeLessThanOrEqual(T + 1000 / AMBIENT_FPS + 1e-6);
    }
  });

  test("a phone's backdrop stays still whatever the time", () => {
    for (const scene of rooms) {
      const list = buildScene(scene, layoutRoom(scene, { width: 390, height: 844 }, "compact"), T);
      expect(list).toMatchObject({ next: null });
      expect(specksOf(list.draws)).toHaveLength(0);
    }
  });

  test("the painted layers are the same draws, in the same order and places, with motion on or off", () => {
    for (const scene of rooms) {
      const layout = fullLayout(scene);
      expect(pictures(buildScene(scene, layout, T).draws)).toEqual(pictures(buildScene(scene, layout, null).draws));
    }
  });

  test("every room has specks at three depths, drawn behind the desk", () => {
    for (const scene of rooms) {
      expect(new Set(AMBIENT[scene].map((layer) => layer.depth))).toEqual(new Set(["far", "mid", "near"]));
      const draws = buildScene(scene, fullLayout(scene), T).draws;
      const desk = draws.findIndex((d) => d.kind === "nine-slice" && d.src.includes("-desk"));
      draws.forEach((d, i) => { if (d.kind === "specks") expect(i).toBeLessThan(desk); });
    }
  });

  test("a step holds until the next one, and the next one moves the specks", () => {
    const layout = fullLayout("last-desk");
    const at = (ms: number) => JSON.stringify(specksOf(buildScene("last-desk", layout, ms).draws));
    const step = 1000 / AMBIENT_FPS;
    const start = Math.ceil(T / step) * step;
    expect(at(start + 1)).toBe(at(start + step - 1));
    expect(at(start + step + 1)).not.toBe(at(start + 1));
  });

  test("specks sit on whole plate pixels and stay inside their region", () => {
    for (const scene of rooms) {
      AMBIENT[scene].forEach((layer, index) => {
        for (const seconds of [0, 0.5, 7.25, 913.75]) {
          for (const { x, y } of speckPositions(layer, index, seconds)) {
            expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
            const { region, size } = layer;
            expect(x).toBeGreaterThanOrEqual(region.x);
            expect(y).toBeGreaterThanOrEqual(region.y);
            expect(x + size.width).toBeLessThanOrEqual(region.x + region.width);
            expect(y + size.height).toBeLessThanOrEqual(region.y + region.height);
          }
        }
      });
    }
  });

  test("each speck is a whole number of plate pixels from the background's corner and as big as its plate size", () => {
    const layout = fullLayout("projection-booth");
    const { background } = layout.layers;
    const scale = background.width / ROOM_ART.plate.width;
    const rain = specksOf(buildScene("projection-booth", layout, T).draws).find((s) => s.color === "#a9c4f0")!;
    for (const { left, top, width, height } of rain.rects) {
      expect((left - background.left) / scale).toBeCloseTo(Math.round((left - background.left) / scale), 6);
      expect((top - background.top) / scale).toBeCloseTo(Math.round((top - background.top) / scale), 6);
      expect(width / scale).toBeCloseTo(1, 6);
      expect(height / scale).toBeCloseTo(5, 6);
    }
  });

  test("specks that fall in front of the board keep clear of it", () => {
    const overlaps = (a: Rect, b: Rect) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
    for (const scene of rooms) {
      const layout = fullLayout(scene);
      const near = new Set<string>(AMBIENT[scene].filter((l) => l.clearOfBoard).map((l) => l.color));
      for (const seconds of [1, 20, 333]) {
        for (const specks of specksOf(buildScene(scene, layout, seconds * 1000).draws).filter((s) => near.has(s.color))) {
          for (const rect of specks.rects) expect(overlaps(rect, layout.layers.board.rect)).toBe(false);
        }
      }
    }
  });

  test("window light is plain rows on whole plate pixels, edge to edge with no gap or overlap, from the window to the floor", () => {
    const shaft = LIGHT["last-desk"][0]!;
    const { rows } = shaftRows(shaft, 3);
    expect(rows[0]).toMatchObject({ x: shaft.from.x, y: shaft.from.y, width: shaft.width });
    expect(rows.at(-1)!.y + rows.at(-1)!.height).toBe(shaft.to.y);
    for (const [i, row] of rows.entries()) {
      expect([row.x, row.y, row.width, row.height].every(Number.isInteger)).toBe(true);
      if (i > 0) expect(row.y).toBe(rows[i - 1]!.y + rows[i - 1]!.height);
    }
  });

  test("window light's alpha moves between its low and high in a few steps, never more than one step at a time", () => {
    const shaft = LIGHT["last-desk"][0]!;
    const { low, high, steps } = shaft.alpha;
    const levels = new Set<number>();
    let previous: number | null = null;
    for (let step = 0; step < 12 * 30; step++) {
      const { alpha } = shaftRows(shaft, step / 12);
      expect(alpha).toBeGreaterThanOrEqual(low - 1e-9);
      expect(alpha).toBeLessThanOrEqual(high + 1e-9);
      if (previous !== null) expect(Math.abs(alpha - previous)).toBeLessThanOrEqual((high - low) / (steps - 1) + 1e-9);
      levels.add(Math.round(alpha * 1e6));
      previous = alpha;
    }
    expect(levels.size).toBe(steps);
  });

  test("the rail room's window light is drawn while it moves and gone while it is still", () => {
    const layout = fullLayout("last-desk");
    const lit = (now: number | null) => specksOf(buildScene("last-desk", layout, now).draws).some((s) => s.color === LIGHT["last-desk"][0]!.color);
    expect(lit(T)).toBe(true);
    expect(lit(null)).toBe(false);
  });

  test("with the companion in the room, the list asks for whichever comes first, its next step or the companion's", () => {
    const layout = fullLayout("last-desk");
    const companion = { cue: { id: "lumi", activity: "idle", gesture: { name: "nod", at: T } }, idle: { since: 0, seed: 7 }, ratio: 1 } as const;
    const firsts = new Set<string>();
    for (let now = T; now < T + 3000; now += 7) {
      const both = buildScene("last-desk", layout, now, companion);
      const specksNext = buildScene("last-desk", layout, now).next!;
      const companionNext = companionAt(companion.cue, companion.idle, now).next ?? Infinity;
      expect(both.next).toBe(Math.min(specksNext, companionNext));
      firsts.add(companionNext < specksNext ? "companion" : "specks");
      expect(specksOf(both.draws).length).toBeGreaterThan(0);
      expect(both.draws.at(-1)).toMatchObject({ kind: "companion" });
    }
    expect([...firsts].sort()).toEqual(["companion", "specks"]);
  });
});
