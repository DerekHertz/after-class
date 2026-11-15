import { describe, expect, test } from "bun:test";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import type { FullRoomLayout, Rect, Size } from "../src/app/room/layout";
import { FRONT_ROW_ROOMS } from "../src/app/room/rooms";

const rooms = Object.keys(FRONT_ROW_ROOMS) as SceneId[];
const full = (scene: SceneId, window: Size): FullRoomLayout => {
  const layout = layoutRoom(scene, window, "full");
  if (layout.composition !== "full") throw new Error("a full window lays out the full room");
  return layout;
};
const right = (r: Rect) => r.left + r.width;
const bottom = (r: Rect) => r.top + r.height;
const overlaps = (a: Rect, b: Rect) => a.left < right(b) && b.left < right(a) && a.top < bottom(b) && b.top < bottom(a);
const EPS = 1e-9;
const inside = (r: Rect, { width, height }: Size) => r.left >= -EPS && r.top >= -EPS && right(r) <= width + EPS && bottom(r) <= height + EPS;

/** Desktop windows from the smallest full room to about 4K, in 40 px steps. */
const windows: Size[] = [];
for (let width = 900; width <= 3840; width += 40) for (let height = 560; height <= 2160; height += 40) windows.push({ width, height });

/** Each placed thing that is not a full-window layer, by name. */
const placed = (layout: FullRoomLayout): Record<string, Rect> => ({
  board: layout.layers.board.rect, mat: layout.layers.mat.rect, boardText: layout.text.board, deskText: layout.text.desk,
  companion: layout.companion.box, source: layout.objects.source, history: layout.objects.history,
  ...Object.fromEntries(layout.layers.extras.map((extra, i) => [`${extra.name}-${i}`, extra.rect])),
});

describe("the room fits every desktop window", () => {
  test("the background covers the window down to the desk, and the desk spans the window and runs past its bottom", () => {
    for (const scene of rooms) for (const window of windows) {
      const { background: bg, desk } = full(scene, window).layers;
      expect({ scene, window, covers: bg.left <= EPS && bg.top <= EPS && right(bg) >= window.width - EPS && bottom(bg) >= desk.rect.top })
        .toEqual({ scene, window, covers: true });
      expect({ scene, window, desk: desk.rect.left === 0 && desk.rect.width === window.width && bottom(desk.rect) >= window.height })
        .toEqual({ scene, window, desk: true });
    }
  });

  test("everything else lies inside the window, except the rail classroom's vine, which may hang off its left edge", () => {
    for (const scene of rooms) for (const window of windows) {
      const outside = Object.entries(placed(full(scene, window))).filter(([, rect]) => !inside(rect, window)).map(([name]) => name);
      expect({ scene, window, outside: outside.filter((name) => !(scene === "last-desk" && name === "vine-1")) }).toEqual({ scene, window, outside: [] });
    }
    expect(full("last-desk", { width: 900, height: 560 }).layers.extras[1]!.rect.left).toBeLessThan(0);
  });

  test("the text areas never overlap each other, the companion, the folio or the notebook", () => {
    for (const scene of rooms) for (const window of windows) {
      const layout = full(scene, window);
      const hits = [layout.text.board, layout.text.desk].flatMap((text, i) =>
        [layout.companion.box, layout.objects.source, layout.objects.history, i === 0 ? layout.text.desk : null]
          .filter((other): other is Rect => other !== null && overlaps(text, other)).map(() => i === 0 ? "board" : "desk"));
      expect({ scene, window, hits }).toEqual({ scene, window, hits: [] });
    }
  });

  test("the text areas have room to write in on any window no taller than twice its width", () => {
    for (const scene of rooms) for (const window of windows.filter(({ width, height }) => height <= 2 * width)) {
      const { board, desk } = full(scene, window).text;
      expect({ scene, window, board: board.width > 0 && board.height > 0, desk: desk.width > 0 && desk.height > 0 }).toEqual({ scene, window, board: true, desk: true });
    }
  });
});

describe("the room scales with the window", () => {
  test("a window scaled by k lays out the same room scaled by k", () => {
    const scaled = (r: Rect, k: number) => [r.left * k, r.top * k, r.width * k, r.height * k];
    const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-6);
    for (const scene of rooms) for (const window of windows.filter((_, i) => i % 7 === 0)) for (const k of [1.25, 1.5, 2]) {
      const small = full(scene, window);
      const large = full(scene, { width: window.width * k, height: window.height * k });
      const pairs: [Rect, Rect][] = [
        [small.layers.background, large.layers.background], [small.layers.desk.rect, large.layers.desk.rect],
        ...Object.keys(placed(small)).map((name): [Rect, Rect] => [placed(small)[name]!, placed(large)[name]!]),
      ];
      expect({ scene, window, k, u: Math.abs(large.u - small.u * k) < 1e-9, rects: pairs.every(([a, b]) => close(scaled(a, k), scaled(b, 1))) })
        .toEqual({ scene, window, k, u: true, rects: true });
    }
  });

  test("a taller window never shrinks the room's scale", () => {
    for (const scene of rooms) for (const window of windows) {
      const taller = full(scene, { width: window.width, height: window.height + 40 });
      expect({ scene, window, grows: taller.u >= full(scene, window).u }).toEqual({ scene, window, grows: true });
    }
  });

  test("the nine-slice borders are the art's cuts at the room's scale", () => {
    const layout = full("last-desk", { width: 1440, height: 900 });
    expect(layout.layers.board.border.top / layout.u).toBeCloseTo(44, 9);
    expect(layout.layers.desk.border.left / layout.u).toBeCloseTo(150, 9);
    expect(layout.layers.mat.border.right / layout.u).toBeCloseTo(30, 9);
  });
});

describe("the layout is what the stylesheet drew before it moved here", () => {
  /**
   * Boxes Chrome measured with getBoundingClientRect when front-row.css computed this geometry in calc(), before this module
   * existed: [left, top, width, height] in CSS px. Chrome keeps layout positions in 1/64 px, so they agree to that.
   */
  type Box = readonly [number, number, number, number];
  const measured: Record<string, { readonly board: Box; readonly mat: Box; readonly companion: Box; readonly source: Box; readonly history: Box; readonly extras: readonly Box[]; readonly boardText: Box; readonly deskText: Box }> = {
    "last-desk@1440x900": {
      board: [32.671875, 108, 1049.578125, 452.421875], mat: [266.015625, 642.140625, 907.9375, 245.15625], companion: [21.59375, 685.75, 199.734375, 199.734375],
      source: [1289.03125, 637.296875, 122.5625, 101.359375], history: [1282.21875, 745.921875, 136.1875, 135.921875],
      extras: [[127.140625, 480.515625, 497.546875, 49.921875], [-103.5, 51.703125, 236.96875, 358.625]],
      boardText: [103.5, 160.65625, 907.03125, 329.875], deskText: [300.515625, 673, 837.109375, 181.609375],
    },
    "study-bench@1440x900": {
      board: [154.34375, 135, 1131.296875, 592.484375], mat: [266.015625, 642.140625, 907.9375, 245.15625], companion: [21.59375, 663.953125, 199.734375, 199.734375],
      source: [1289.03125, 637.296875, 122.5625, 101.359375], history: [1282.21875, 745.921875, 136.1875, 135.921875],
      extras: [[303.054688, 49.640625, 109.859375, 98.046875], [665.070312, 49.640625, 109.859375, 98.046875], [1027.085938, 49.640625, 109.859375, 98.046875], [1161.265625, 0, 278.734375, 314.140625], [8.625, 775.625, 225.15625, 111.671875]],
      boardText: [217.90625, 194.921875, 1004.171875, 303.78125], deskText: [315.046875, 687.53125, 809.875, 154.375],
    },
    "projection-booth@1440x900": {
      board: [374.0625, 63, 1033.234375, 508.3125], mat: [266.015625, 642.140625, 907.9375, 245.15625], companion: [21.59375, 685.75, 199.734375, 199.734375],
      source: [1289.03125, 637.296875, 122.5625, 101.359375], history: [1282.21875, 745.921875, 136.1875, 135.921875],
      extras: [[868.445312, 565.875, 44.484375, 47.203125], [21.78125, 442.40625, 215.171875, 230.609375]],
      boardText: [477.578125, 170.125, 826.21875, 343.09375], deskText: [307.78125, 680.265625, 824.40625, 168.890625],
    },
    "study-bench@1920x1080": {
      board: [205.796875, 162, 1508.390625, 687.984375], mat: [354.703125, 736.1875, 1210.578125, 326.875], companion: [28.796875, 765.25, 266.328125, 266.328125],
      source: [1718.703125, 729.71875, 163.421875, 135.15625], history: [1709.625, 874.5625, 181.578125, 181.234375],
      extras: [[404.0625, 48.203125, 146.46875, 130.734375], [886.765625, 48.203125, 146.46875, 130.734375], [1369.453125, 48.203125, 146.46875, 130.734375], [1548.359375, 0, 371.640625, 418.859375], [11.515625, 914.171875, 300.21875, 148.890625]],
      boardText: [290.53125, 241.890625, 1338.90625, 303.03125], deskText: [420.0625, 796.71875, 1079.84375, 205.8125],
    },
    "projection-booth@2560x1440": {
      board: [665.015625, 100.796875, 1836.859375, 754.875], mat: [472.9375, 981.578125, 1614.109375, 435.828125], companion: [38.390625, 1059.09375, 355.09375, 355.09375],
      source: [2291.59375, 972.9375, 217.90625, 180.21875], history: [2279.5, 1166.078125, 242.109375, 241.640625],
      extras: [[1543.914062, 846, 79.078125, 83.921875], [38.734375, 626.5, 382.546875, 409.984375]],
      boardText: [849.015625, 291.265625, 1468.84375, 461.125], deskText: [547.1875, 1049.375, 1465.609375, 300.234375],
    },
  };
  const box = (r: Rect): Box => [r.left, r.top, r.width, r.height];
  const near = (a: Box, b: Box) => a.every((x, i) => Math.abs(x - b[i]!) <= 1 / 16);

  for (const [key, want] of Object.entries(measured)) {
    test(`${key} places every layer, text area and object where Chrome drew it`, () => {
      const [scene, size] = key.split("@") as [SceneId, string];
      const [width, height] = size.split("x").map(Number) as [number, number];
      const got = full(scene, { width, height });
      const pairs: [string, Box, Box][] = [
        ["board", box(got.layers.board.rect), want.board], ["mat", box(got.layers.mat.rect), want.mat], ["companion", box(got.companion.box), want.companion],
        ["source", box(got.objects.source), want.source], ["history", box(got.objects.history), want.history],
        ["boardText", box(got.text.board), want.boardText], ["deskText", box(got.text.desk), want.deskText],
        ...got.layers.extras.map((extra, i): [string, Box, Box] => [extra.name, box(extra.rect), want.extras[i]!]),
      ];
      expect(got.layers.extras).toHaveLength(want.extras.length);
      for (const [name, a, b] of pairs) expect({ name, a, near: near(a, b) }).toEqual({ name, a, near: true });
    });
  }
});

test("a phone or short window recomposes the room, so nothing is placed", () => {
  for (const scene of rooms) expect(layoutRoom(scene, { width: 390, height: 844 }, "compact")).toEqual({ composition: "compact" });
});
