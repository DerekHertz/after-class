import { describe, expect, test } from "bun:test";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import type { Size } from "../src/app/room/layout";
import { pieces } from "../src/app/room/paint";
import { buildScene } from "../src/app/room/scene";
import type { Draw, PictureDraw } from "../src/app/room/scene";
import { ROOM_LAYER_ART } from "../src/app/room/art";
import { FRONT_ROW_ROOMS } from "../src/app/room/rooms";

const rooms = Object.keys(FRONT_ROW_ROOMS) as SceneId[];
const isPicture = (draw: Draw): draw is PictureDraw => draw.kind === "image" || draw.kind === "edge";
const full = (scene: SceneId, window: Size) => {
  const list = buildScene(scene, layoutRoom(scene, window, "full"));
  return { ...list, draws: list.draws.filter(isPicture) };
};

describe("the stage's draw list", () => {
  test("a full room is its wide plate, one pixelated picture that holds the board, desk and mat, drawn at the plate's own shape", () => {
    for (const scene of rooms) {
      const { draws } = full(scene, { width: 1920, height: 1080 });
      const images = draws.filter((d) => d.kind === "image");
      expect(images).toHaveLength(1);
      const [plate] = images;
      expect(plate).toMatchObject({ kind: "image", sampling: "pixelated", src: ROOM_LAYER_ART[scene].plate });
      expect(plate!.rect.width / plate!.rect.height).toBeCloseTo(2314 / 992, 9);
    }
  });

  test("the plate's edge fills come first and use the plate's own picture, so the plate is painted over them", () => {
    const { draws } = full("study-bench", { width: 3440, height: 1440 });
    expect(draws.at(-1)!.kind).toBe("image");
    const edges = draws.filter((d) => d.kind === "edge");
    expect(edges.map((d) => d.kind === "edge" && d.edge).sort()).toEqual(["bottom", "left", "right", "top"]);
    expect(edges.every((d) => d.src === ROOM_LAYER_ART["study-bench"].plate)).toBe(true);
  });

  test("a phone draws only the background, smooth, covering the window", () => {
    for (const scene of rooms) {
      const list = buildScene(scene, layoutRoom(scene, { width: 390, height: 844 }, "compact"));
      expect(list.draws).toHaveLength(1);
      const [bg] = list.draws.filter(isPicture);
      expect(bg).toMatchObject({ kind: "image", sampling: "smooth", src: ROOM_LAYER_ART[scene].background });
      const { left, top, width, height } = bg!.rect;
      expect({ scene, covers: top <= 0 && left <= 0 && left + width >= 390 - 1e-9 && top + height >= 844 - 1e-9 }).toEqual({ scene, covers: true });
    }
  });

  test("a room without a companion is still, so no list asks the stage for another frame", () => {
    for (const scene of rooms) for (const composition of ["full", "compact"] as const) {
      expect(buildScene(scene, layoutRoom(scene, { width: 1440, height: 900 }, composition)).next).toBeNull();
    }
  });

  test("a waiting companion shows the question balloon over its head, and no other activity does", () => {
    const cue = (activity: "waiting" | "idle" | "listening") => ({ cue: { id: "pip" as const, activity, gesture: null }, idle: { since: 0, seed: 1 }, ratio: 1 });
    for (const scene of rooms) {
      const layout = layoutRoom(scene, { width: 1440, height: 900 }, "full");
      if (layout.composition !== "full") throw new Error("full");
      const waiting = buildScene(scene, layout, null, cue("waiting")).draws;
      const balloon = waiting.find((d) => d.kind === "balloon");
      expect(balloon).toBeDefined();
      const box = layout.companion.box;
      expect(balloon!.rect.top + balloon!.rect.height).toBeLessThan(box.top + box.height / 2);
      expect(balloon!.rect.left).toBeGreaterThan(box.left + box.width / 2);
      for (const activity of ["idle", "listening"] as const) expect(buildScene(scene, layout, null, cue(activity)).draws.some((d) => d.kind === "balloon")).toBe(false);
    }
  });
});

describe("the stage paints each picture on the device pixels Chrome painted its CSS layer on", () => {
  // Each expectation was read from Chrome's own CSS rendering with coded test images (see the PR body).
  test("the plate, drawn wider than the window, starts off its edge where its 1/64 pixel position rounds half up", () => {
    const [plate] = full("last-desk", { width: 1440, height: 900 }).draws.filter((d) => d.kind === "image");
    const [piece] = pieces(plate!, { width: 2314, height: 992 }, { x: 1, y: 1 });
    const from = Math.floor(plate!.rect.left + 0.5);
    expect(piece!.dx).toBe(from);
    expect(piece!.dx).toBeLessThan(0);
    expect(piece!.dx + piece!.dw).toBeLessThanOrEqual(from + Math.floor(plate!.rect.width + 0.5));
  });

  test("an edge fill takes one row or column of the plate's pixels", () => {
    const edge = (name: "left" | "right" | "top" | "bottom") => pieces({ kind: "edge", src: "", edge: name, rect: { left: 0, top: 0, width: 10, height: 10 } }, { width: 2314, height: 992 }, { x: 1, y: 1 })[0]!;
    expect([edge("left").sx, edge("left").sw, edge("left").sh]).toEqual([0, 1, 992]);
    expect([edge("right").sx, edge("right").sw]).toEqual([2313, 1]);
    expect([edge("top").sy, edge("top").sh, edge("top").sw]).toEqual([0, 1, 2314]);
    expect([edge("bottom").sy, edge("bottom").sh]).toEqual([991, 1]);
  });

  test("an image ends no later than its rounded size from its start", () => {
    const [piece] = pieces({ kind: "image", src: "", rect: { left: 10.5, top: 0, width: 20.4, height: 10 }, sampling: "pixelated" }, { width: 8, height: 8 }, { x: 1, y: 1 });
    expect([piece!.dx, piece!.dx + piece!.dw]).toEqual([11, 31]);
  });
});

describe("the stage snaps a box at the window's device pixel ratio, where a real display of that ratio painted it", () => {
  // Each span was read from Chrome under xvfb with --force-device-scale-factor, a real display scale. Playwright's device
  // emulation lays out at one pixel per CSS pixel and scales the result, so it cannot settle these. Each sits on a rounding
  // edge that one wrong rule would cross: rounding to 1/64 px instead of truncating, ending at the snapped start + size, or
  // snapping in CSS pixels before scaling.
  const cases: readonly { kind: "image"; start: number; size: number; scale: number; chrome: readonly [number, number] }[] = [
    { kind: "image", start: 10.496, size: 20, scale: 1, chrome: [10, 30] },
    { kind: "image", start: 10.51, size: 20.99, scale: 1, chrome: [11, 31] },
    { kind: "image", start: 10.26, size: 20.49, scale: 2, chrome: [21, 61] },
    { kind: "image", start: 10.28, size: 20.48, scale: 2, chrome: [21, 62] },
    { kind: "image", start: 10, size: 20.25, scale: 2, chrome: [20, 61] },
    { kind: "image", start: 10, size: 20.33, scale: 1.5, chrome: [15, 45] },
    { kind: "image", start: 10, size: 20.34, scale: 1.5, chrome: [15, 46] },
    { kind: "image", start: 10.34, size: 20.66, scale: 1.5, chrome: [16, 46] },
  ];
  for (const { kind, start, size, scale, chrome } of cases) {
    test(`an image from ${start} CSS px, ${size} wide, at ${scale}x covers device pixels ${chrome[0]} to ${chrome[1]}`, () => {
      const rect = { left: start, top: start, width: size, height: size };
      const draw: PictureDraw = { kind, src: "", rect, sampling: "pixelated" };
      const [piece] = pieces(draw, { width: 8, height: 8 }, { x: scale, y: scale });
      expect([piece!.dx, piece!.dx + piece!.dw, piece!.dy, piece!.dy + piece!.dh]).toEqual([...chrome, ...chrome]);
    });
  }
});
