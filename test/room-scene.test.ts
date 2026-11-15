import { describe, expect, test } from "bun:test";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import type { Size } from "../src/app/room/layout";
import { pieces } from "../src/app/room/paint";
import { buildScene } from "../src/app/room/scene";
import type { Draw } from "../src/app/room/scene";
import { ROOM_LAYER_ART } from "../src/app/room/art";
import { FRONT_ROW_ROOMS } from "../src/app/room/rooms";

const rooms = Object.keys(FRONT_ROW_ROOMS) as SceneId[];
const full = (scene: SceneId, window: Size) => buildScene(scene, layoutRoom(scene, window, "full"));
const named = (draw: Draw) => draw.src.split("/").pop()!.replace(/\.webp$/, "");

describe("the stage's draw list", () => {
  test("a full room paints its layers back to front, as the CSS stacked them", () => {
    expect(full("study-bench", { width: 1440, height: 900 }).draws.map(named)).toEqual([
      "harbor-background", "harbor-awning", "harbor-board", "harbor-lamp", "harbor-lamp", "harbor-lamp", "harbor-desk", "harbor-cushion", "harbor-mat",
    ]);
    expect(full("last-desk", { width: 1440, height: 900 }).draws.map(named)).toEqual(["rail-background", "rail-board", "rail-ledge-items", "rail-vine", "rail-desk", "rail-mat"]);
  });

  test("a full room draws every layer pixelated, and the board, desk and mat as nine-slices of their files", () => {
    for (const scene of rooms) {
      const { draws } = full(scene, { width: 1920, height: 1080 });
      expect(draws.filter((d) => d.kind === "nine-slice").map(named).sort()).toEqual(["board", "desk", "mat"].map((l) => named({ src: ROOM_LAYER_ART[scene][l as "board"] } as Draw)).sort());
      expect(draws.every((d) => d.kind === "nine-slice" || d.sampling === "pixelated")).toBe(true);
    }
  });

  test("a phone draws only the background, smooth, covering the window", () => {
    for (const scene of rooms) {
      const list = buildScene(scene, layoutRoom(scene, { width: 390, height: 844 }, "compact"));
      expect(list.draws).toHaveLength(1);
      const [bg] = list.draws;
      expect(bg).toMatchObject({ kind: "image", sampling: "smooth", src: ROOM_LAYER_ART[scene].background });
      const { left, top, width, height } = bg!.rect;
      expect({ scene, covers: top <= 0 && left <= 0 && left + width >= 390 - 1e-9 && top + height >= 844 - 1e-9 }).toEqual({ scene, covers: true });
    }
  });

  test("nothing in a room moves yet, so no list asks the stage for another frame", () => {
    for (const scene of rooms) for (const composition of ["full", "compact"] as const) {
      expect(buildScene(scene, layoutRoom(scene, { width: 1440, height: 900 }, composition)).next).toBeNull();
    }
  });
});

describe("the stage paints each layer on the device pixels Chrome painted its CSS layer on", () => {
  // Each expectation was read from Chrome's own CSS rendering with coded test images (see the PR body).
  const span = (scene: SceneId, window: Size, name: string, natural: Size, scale = 1) => {
    const draw = full(scene, window).draws.find((d) => named(d).endsWith(name))!;
    return pieces(draw, natural, { x: scale, y: scale });
  };

  test("an image starting off the window's edge starts where its 1/64 pixel position rounds half up", () => {
    const [vine] = span("last-desk", { width: 1440, height: 900 }, "vine", { width: 261, height: 395 });
    expect([vine!.dx, vine!.dx + vine!.dw]).toEqual([-103, 133]);
  });

  test("an image ends no later than its rounded size from its start", () => {
    const [tab] = span("projection-booth", { width: 1440, height: 900 }, "pull-tab", { width: 49, height: 52 });
    expect([tab!.dx, tab!.dx + tab!.dw]).toEqual([868, 912]);
    const [cushion] = span("study-bench", { width: 1440, height: 900 }, "cushion", { width: 248, height: 123 });
    expect([cushion!.dy, cushion!.dy + cushion!.dh]).toEqual([776, 887]);
  });

  test("a nine-slice's borders floor to whole device pixels from its snapped box", () => {
    const board = span("last-desk", { width: 1440, height: 900 }, "board", { width: 1473, height: 844 });
    const xs = [...new Set(board.map((p) => p.dx))].sort((a, b) => a - b);
    const ys = [...new Set(board.map((p) => p.dy))].sort((a, b) => a - b);
    expect({ xs, ys }).toEqual({ xs: [33, 91, 1024], ys: [108, 147, 504] });
    expect(board.map((p) => [p.sx, p.sy, p.sw, p.sh])).toContainEqual([0, 0, 64, 44]);
  });
});

describe("the stage snaps a box at the window's device pixel ratio, where a real display of that ratio painted it", () => {
  // Each span was read from Chrome under xvfb with --force-device-scale-factor, a real display scale. Playwright's device
  // emulation lays out at one pixel per CSS pixel and scales the result, so it cannot settle these. Each sits on a rounding
  // edge that one wrong rule would cross: rounding to 1/64 px instead of truncating, ending at the snapped start + size, or
  // snapping in CSS pixels before scaling.
  const cases: readonly { kind: Draw["kind"]; start: number; size: number; scale: number; chrome: readonly [number, number] }[] = [
    { kind: "image", start: 10.496, size: 20, scale: 1, chrome: [10, 30] },
    { kind: "image", start: 10.51, size: 20.99, scale: 1, chrome: [11, 31] },
    { kind: "nine-slice", start: 10.01, size: 20.48, scale: 1, chrome: [10, 30] },
    { kind: "nine-slice", start: 10.01, size: 20.49, scale: 1, chrome: [10, 30] },
    { kind: "image", start: 10.26, size: 20.49, scale: 2, chrome: [21, 61] },
    { kind: "image", start: 10.28, size: 20.48, scale: 2, chrome: [21, 62] },
    { kind: "image", start: 10, size: 20.25, scale: 2, chrome: [20, 61] },
    { kind: "nine-slice", start: 10.01, size: 20.24, scale: 2, chrome: [20, 60] },
    { kind: "nine-slice", start: 10, size: 20.25, scale: 2, chrome: [20, 61] },
    { kind: "image", start: 10, size: 20.33, scale: 1.5, chrome: [15, 45] },
    { kind: "image", start: 10, size: 20.34, scale: 1.5, chrome: [15, 46] },
    { kind: "image", start: 10.34, size: 20.66, scale: 1.5, chrome: [16, 46] },
    { kind: "nine-slice", start: 10.01, size: 20.33, scale: 1.5, chrome: [15, 45] },
  ];
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const { kind, start, size, scale, chrome } of cases) {
    test(`${kind === "image" ? "an image" : "a nine-slice"} from ${start} CSS px, ${size} wide, at ${scale}x covers device pixels ${chrome[0]} to ${chrome[1]}`, () => {
      const rect = { left: start, top: start, width: size, height: size };
      const draw: Draw = kind === "image" ? { kind, src: "", rect, sampling: "pixelated" } : { kind, src: "", rect, slice: none, border: none };
      const [piece] = pieces(draw, { width: 8, height: 8 }, { x: scale, y: scale });
      expect([piece!.dx, piece!.dx + piece!.dw, piece!.dy, piece!.dy + piece!.dh]).toEqual([...chrome, ...chrome]);
    });
  }
});
