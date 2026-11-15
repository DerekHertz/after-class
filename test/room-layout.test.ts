import { describe, expect, test } from "bun:test";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import type { FullRoomLayout, Rect, Size } from "../src/app/room/layout";
import { FRONT_ROW_ROOMS, ROOM_ART } from "../src/app/room/rooms";

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
  test("the background covers the frame down to the desk, and the desk spans the frame and runs past its bottom", () => {
    for (const scene of rooms) for (const window of windows) {
      const { frame, layers: { background: bg, desk } } = full(scene, window);
      expect({ scene, window, covers: bg.left <= frame.left + EPS && bg.top <= EPS && right(bg) >= right(frame) - EPS && bottom(bg) >= desk.rect.top })
        .toEqual({ scene, window, covers: true });
      expect({ scene, window, desk: Math.abs(desk.rect.left - frame.left) < EPS && Math.abs(desk.rect.width - frame.width) < EPS && bottom(desk.rect) >= window.height })
        .toEqual({ scene, window, desk: true });
    }
  });

  test("the frame is the whole window up to the widest aspect, and beyond it a centred box of that aspect with the backdrop either side", () => {
    for (const scene of rooms) for (const window of windows) {
      const { frame, layers: { backdrop } } = full(scene, window);
      const wide = window.width > window.height * ROOM_ART.maxAspect;
      const width = wide ? window.height * ROOM_ART.maxAspect : window.width;
      const centred = Math.abs(frame.left - (window.width - width) / 2) < EPS && Math.abs(frame.width - width) < EPS && frame.top === 0 && frame.height === window.height;
      const covers = backdrop === null ? !wide
        : wide && backdrop.cover.left <= EPS && backdrop.cover.top <= EPS && right(backdrop.cover) >= window.width - EPS && bottom(backdrop.cover) >= window.height - EPS
          && Math.abs(right(backdrop.bands[0]) - frame.left) < EPS && Math.abs(backdrop.bands[1].left - right(frame)) < EPS;
      expect({ scene, window, centred, covers }).toEqual({ scene, window, centred: true, covers: true });
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

describe("a large or wide window shows the same room, larger", () => {
  /** Screens the room is checked on, in CSS pixels, with the owner's 3840x2160 monitor at 150 percent first (its browser window, and full screen). */
  const large: Size[] = [
    { width: 2560, height: 1290 }, { width: 2560, height: 1340 }, { width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 },
    { width: 1920, height: 1200 }, { width: 2560, height: 1440 }, { width: 2560, height: 1600 }, { width: 3440, height: 1440 }, { width: 3840, height: 2160 },
    { width: 5120, height: 1440 },
  ];
  const aspect = (r: Rect) => r.width / r.height;
  const surfaces = (layout: FullRoomLayout) => ({ board: aspect(layout.layers.board.rect), desk: aspect(layout.layers.desk.rect), mat: aspect(layout.layers.mat.rect) });

  test("the whole composition is one scale: the background, the desk, the surfaces and every object", () => {
    for (const scene of rooms) for (const window of large) {
      const { u, layers: { background } } = full(scene, window);
      const one = Math.abs(background.width / ROOM_ART.plate.width - u) < EPS && Math.abs(background.height / ROOM_ART.plate.height - u) < EPS;
      expect({ scene, window, one }).toEqual({ scene, window, one: true });
    }
  });

  test("no nine-slice is drawn wider than it is in the widest frame", () => {
    for (const scene of rooms) {
      const widest = surfaces(full(scene, { width: 1920, height: 1080 }));
      for (const window of large) {
        const got = surfaces(full(scene, window));
        const wider = (Object.keys(widest) as (keyof typeof widest)[]).filter((name) => got[name] > widest[name] + EPS);
        expect({ scene, window, wider }).toEqual({ scene, window, wider: [] });
      }
    }
  });

  test("a window wider than the frame lays out the frame-wide room, moved to the centre", () => {
    const rects = (layout: FullRoomLayout, dx: number) => [
      layout.frame, layout.layers.background, layout.layers.board.rect, layout.layers.desk.rect, layout.layers.mat.rect, layout.text.board, layout.text.desk,
      layout.companion.box, layout.objects.source, layout.objects.history, layout.progress,
      ...layout.layers.extras.map((extra) => extra.rect), ...layout.layers.unlocks.map((slot) => slot.rect),
    ].map((r) => [r.left - dx, r.top, r.width, r.height]);
    for (const scene of rooms) for (const window of large.filter(({ width, height }) => width > height * ROOM_ART.maxAspect)) {
      const width = window.height * ROOM_ART.maxAspect;
      const wide = rects(full(scene, window), (window.width - width) / 2);
      const framed = rects(full(scene, { width, height: window.height }), 0);
      const same = wide.every((r, i) => r.every((x, j) => Math.abs(x - framed[i]![j]!) < 1e-6));
      expect({ scene, window, same }).toEqual({ scene, window, same: true });
    }
  });

  test("text and controls grow with the room from 1440x900, where their sizes were set, up to three times", () => {
    const type = (width: number, height: number) => full("last-desk", { width, height }).type;
    expect(type(1440, 900)).toBeCloseTo(1, 9);
    expect(type(1366, 768)).toBe(1);
    expect(type(2880, 1800)).toBeCloseTo(2, 9);
    expect(type(2560, 1290)).toBeCloseTo(full("last-desk", { width: 2560, height: 1290 }).u / (1440 / ROOM_ART.plate.width), 9);
    expect(type(3440, 1440)).toBeCloseTo(type(2560, 1440), 9);
    expect(type(7680, 4320)).toBe(3);
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
  /**
   * The full-window layers, measured from the same old stylesheet on origin/feat/live-room (5ebc01b). The desk is a
   * getBoundingClientRect box. The background was the stage's ::before, so its box is the resolved left, top, width and
   * height of that pseudo-element. Windows with a negative top are cropped at the top, the 1280x1270 ones at the sides,
   * and each room anchors its crop differently (right, centre, left).
   */
  const measuredLayers: Record<string, { readonly background: Box; readonly desk: Box }> = {
    "last-desk@1440x900": { background: [0, -0.149811, 1440, 900.672], desk: [0, 618.53125, 1440, 325.9375] },
    "study-bench@1440x900": { background: [0, -0.204288, 1440, 900.672], desk: [0, 618.53125, 1440, 328.671875] },
    "projection-booth@1440x900": { background: [0, -0.149811, 1440, 900.672], desk: [0, 618.53125, 1440, 372.25] },
    "last-desk@1920x1080": { background: [0, -26.5997, 1920, 1200.91], desk: [0, 704.703125, 1920, 434.59375] },
    "study-bench@1920x1080": { background: [0, -36.2724, 1920, 1200.91], desk: [0, 704.703125, 1920, 438.234375] },
    "projection-booth@1920x1080": { background: [0, -26.5997, 1920, 1200.91], desk: [0, 704.703125, 1920, 496.328125] },
    "last-desk@2560x1440": { background: [0, -35.4663, 2560, 1601.2], desk: [0, 939.609375, 2560, 579.46875] },
    "study-bench@2560x1440": { background: [0, -48.3632, 2560, 1601.2], desk: [0, 939.609375, 2560, 584.3125] },
    "projection-booth@2560x1440": { background: [0, -35.4663, 2560, 1601.2], desk: [0, 939.609375, 2560, 661.78125] },
    "last-desk@1280x1270": { background: [-476.27, 0, 1756.27, 1098.48], desk: [0, 957.25, 1280, 362.15625] },
    "study-bench@1280x1270": { background: [-238.135, 0, 1756.27, 1098.48], desk: [0, 957.25, 1280, 365.1875] },
    "projection-booth@1280x1270": { background: [0, 0, 1756.27, 1098.48], desk: [0, 957.25, 1280, 413.609375] },
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

  for (const [key, want] of Object.entries(measuredLayers)) {
    test(`${key} places the background and the desk where Chrome drew them`, () => {
      const [scene, size] = key.split("@") as [SceneId, string];
      const [width, height] = size.split("x").map(Number) as [number, number];
      const { background, desk } = full(scene, { width, height }).layers;
      for (const [name, a, b] of [["background", box(background), want.background], ["desk", box(desk.rect), want.desk]] as const) {
        expect({ name, a, near: near(a, b) }).toEqual({ name, a, near: true });
      }
    });
  }
});

describe("a phone or short window recomposes the room over its background alone", () => {
  const compact = (scene: SceneId, window: Size) => {
    const layout = layoutRoom(scene, window, "compact");
    if (layout.composition !== "compact") throw new Error("a compact window lays out the compact room");
    return layout;
  };
  const phones: Size[] = [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 899, height: 900 }, { width: 1440, height: 559 }, { width: 600, height: 300 }];

  test("the background covers the window from its top edge at the plate's own proportions", () => {
    for (const scene of rooms) for (const window of phones) {
      const { background: bg } = compact(scene, window).layers;
      const covers = bg.left <= EPS && bg.top === 0 && right(bg) >= window.width - EPS && bottom(bg) >= window.height - EPS;
      const tight = Math.abs(bg.width - window.width) < EPS || Math.abs(bg.height - window.height) < EPS;
      const aspect = Math.abs(bg.width / bg.height - ROOM_ART.plate.width / ROOM_ART.plate.height) < EPS;
      expect({ scene, window, covers, tight, aspect }).toEqual({ scene, window, covers: true, tight: true, aspect: true });
    }
  });

  test("each room shows the part of its picture its phone layout names: the rail's right, the harbor's middle, the canal's left", () => {
    const window = { width: 390, height: 844 };
    const { background: rail } = compact("last-desk", window).layers;
    const { background: harbor } = compact("study-bench", window).layers;
    const { background: canal } = compact("projection-booth", window).layers;
    expect(right(rail)).toBeCloseTo(window.width, 9);
    expect(harbor.left + harbor.width / 2).toBeCloseTo(window.width / 2, 9);
    expect(canal.left).toBeCloseTo(0, 9);
  });
});
