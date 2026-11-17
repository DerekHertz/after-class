import { describe, expect, test } from "bun:test";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom, plateScale } from "../src/app/room/layout";
import type { FullRoomLayout, Rect, Size } from "../src/app/room/layout";
import { pieces } from "../src/app/room/paint";
import { buildScene } from "../src/app/room/scene";
import type { Draw, PictureDraw } from "../src/app/room/scene";
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

/** The windows the room is checked at: Derek's monitor at 150%, a laptop, 1080p and a 3440x1440 ultrawide. */
const common: Size[] = [{ width: 2560, height: 1290 }, { width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 3440, height: 1440 }];

describe("the plate is drawn at one scale and the board is never cropped", () => {
  test("the scale is min(H / 992, W / 1586), the same on both axes, so the plate keeps its shape", () => {
    for (const scene of rooms) for (const window of [...windows, ...common]) {
      const layout = full(scene, window);
      expect({ scene, window, s: Math.abs(layout.s - Math.min(window.height / 992, window.width / 1586)) < EPS }).toEqual({ scene, window, s: true });
      expect({ scene, window, shape: Math.abs(layout.plate.width / layout.plate.height - 2314 / 992) < 1e-9 }).toEqual({ scene, window, shape: true });
      expect(plateScale(scene, window)).toBe(layout.s);
    }
  });

  test("the whole 16:10 core, which holds the board, mat, companion and notebook, is inside the window", () => {
    for (const scene of rooms) for (const window of [...windows, ...common]) {
      const layout = full(scene, window);
      const buddy = layout.companion.box;
      // The companion's cell has clear padding around the figure, so its middle and ground line are what must be on screen.
      const placed = { core: layout.core, board: layout.text.board, mat: layout.text.desk, companion: { left: buddy.left + buddy.width / 2, top: buddy.top, width: 0, height: buddy.height }, source: layout.objects.source, history: layout.objects.history };
      const outside = Object.entries(placed).filter(([, rect]) => !inside(rect, window)).map(([name]) => name);
      expect({ scene, window, outside }).toEqual({ scene, window, outside: [] });
    }
  });

  test("at 2560x1290, 1920x1080, 1440x900 and 3440x1440 the board is fully visible and the scale is uniform", () => {
    for (const scene of rooms) for (const window of common) {
      const layout = full(scene, window);
      expect({ scene, window, board: inside(layout.text.board, window), mat: inside(layout.text.desk, window) }).toEqual({ scene, window, board: true, mat: true });
      const { core } = FRONT_ROW_ROOMS[scene].plate;
      expect(layout.core.width / core.width).toBeCloseTo(layout.s, 9);
      expect(layout.core.height / core.height).toBeCloseTo(layout.s, 9);
    }
  });

  test("a wide window shows more of the strips, and a 16:10 window shows the core and no more", () => {
    const wide = full("last-desk", { width: 2560, height: 1290 });
    expect(wide.plate.left).toBeLessThan(0);
    expect(wide.plate.left + wide.plate.width).toBeGreaterThan(2560);
    expect(wide.core.left).toBeGreaterThan(0);
    const tight = full("last-desk", { width: 1586, height: 992 });
    expect(tight.core.left).toBeCloseTo(0, 9);
    expect(tight.core.width).toBeCloseTo(1586, 9);
  });

  test("past 21:9 and below 16:10 the bare rows and columns show the backdrop, and a window the plate covers has none", () => {
    for (const window of [{ width: 3440, height: 1440 }, { width: 3840, height: 1080 }, { width: 1000, height: 900 }, { width: 1900, height: 1900 }, { width: 1200, height: 1600 }]) {
      expect({ window, backdrop: full("study-bench", window).backdrop }).toEqual({ window, backdrop: true });
    }
    for (const window of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 2314, height: 992 }]) {
      expect({ window, backdrop: full("study-bench", window).backdrop }).toEqual({ window, backdrop: false });
    }
    expect(full("study-bench", { width: 1000, height: 900 }).plate.top).toBeGreaterThan(0);
  });

  test("the plate is never cropped past the core to fill a tall window: its scale and place do not change with the backdrop", () => {
    for (const scene of rooms) for (const window of [{ width: 1900, height: 1900 }, { width: 1200, height: 1600 }, { width: 900, height: 1500 }]) {
      const layout = full(scene, window);
      expect(layout.s).toBeCloseTo(window.width / 1586, 9);
      expect(layout.core.left).toBeCloseTo(0, 9);
      expect(layout.plate.top + layout.plate.height / 2).toBeCloseTo(window.height / 2, 9);
    }
  });
});

describe("the text areas and objects", () => {
  test("the text areas never overlap each other, the companion, the folio or the notebook", () => {
    for (const scene of rooms) for (const window of windows) {
      const layout = full(scene, window);
      const hits = [layout.text.board, layout.text.desk].flatMap((text, i) =>
        [layout.companion.box, layout.objects.source, layout.objects.history, i === 0 ? layout.text.desk : null]
          .filter((other): other is Rect => other !== null && overlaps(text, other)).map(() => i === 0 ? "board" : "desk"));
      expect({ scene, window, hits }).toEqual({ scene, window, hits: [] });
    }
  });

  test("a window scaled by k lays out the same room scaled by k", () => {
    const scaled = (r: Rect, k: number) => [r.left * k, r.top * k, r.width * k, r.height * k];
    const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-6);
    for (const scene of rooms) for (const window of windows.filter((_, i) => i % 7 === 0)) for (const k of [1.25, 1.5, 2]) {
      const small = full(scene, window);
      const large = full(scene, { width: window.width * k, height: window.height * k });
      const pick = (l: FullRoomLayout) => [l.plate, l.core, l.text.board, l.text.desk, l.companion.box, l.objects.source, l.objects.history];
      expect({ scene, window, k, s: Math.abs(large.s - small.s * k) < 1e-9, rects: pick(small).every((a, i) => close(scaled(a, k), scaled(pick(large)[i]!, 1))) })
        .toEqual({ scene, window, k, s: true, rects: true });
    }
  });

  test("the board's text and the companion sit where the plate's data puts them", () => {
    for (const scene of rooms) {
      const layout = full(scene, { width: 2560, height: 1290 });
      const { plate } = FRONT_ROW_ROOMS[scene];
      expect(layout.text.board.left).toBeCloseTo(layout.plate.left + plate.board.x * layout.s, 9);
      expect(layout.text.board.width).toBeCloseTo(plate.board.width * layout.s, 9);
      expect(bottom(layout.companion.box)).toBeCloseTo(layout.plate.top + plate.companion.bottom * layout.s, 9);
      expect(layout.companion.box.left + layout.companion.box.width / 2).toBeCloseTo(layout.plate.left + plate.companion.x * layout.s, 9);
      expect(layout.companion.box.height / layout.s).toBeCloseTo(plate.companion.height, 9);
    }
  });
});

describe("every column and row of the window is painted, at fractional sizes and device pixel ratios too", () => {
  const isPicture = (draw: Draw): draw is PictureDraw => draw.kind === "image" || draw.kind === "backdrop";
  /** Whether the device pixels the draw list's pictures cover include every column and every row of the window's backing store. */
  const covered = (scene: SceneId, window: Size, ratio: number) => {
    const [W, H] = [Math.round(window.width * ratio), Math.round(window.height * ratio)];
    const [columns, rows] = [new Uint8Array(W), new Uint8Array(H)];
    const list = buildScene(scene, layoutRoom(scene, window, "full"));
    for (const draw of list.draws.filter(isPicture)) {
      for (const piece of pieces(draw, { width: 2314, height: 992 }, { x: W / window.width, y: H / window.height })) {
        for (let x = Math.max(0, piece.dx); x < Math.min(W, piece.dx + piece.dw); x++) columns[x] = 1;
        for (let y = Math.max(0, piece.dy); y < Math.min(H, piece.dy + piece.dh); y++) rows[y] = 1;
      }
    }
    return { columns: columns.every((c) => c === 1), rows: rows.every((r) => r === 1) };
  };

  test("no column or row is left unpainted", () => {
    const sizes: Size[] = [
      ...common, { width: 1439.5, height: 899.3 }, { width: 1366.4, height: 768.7 }, { width: 2559.75, height: 1289.25 }, { width: 1707.33, height: 1067.6 },
      { width: 3440.4, height: 1439.9 }, { width: 3840, height: 1080 }, { width: 1000.5, height: 900.25 }, { width: 900, height: 1500.5 },
    ];
    for (const scene of rooms) for (const window of sizes) for (const ratio of [1, 1.25, 1.5, 2]) {
      expect({ scene, window, ratio, ...covered(scene, window, ratio) }).toEqual({ scene, window, ratio, columns: true, rows: true });
    }
  });
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
