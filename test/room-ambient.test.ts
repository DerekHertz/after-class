import { describe, expect, test } from "bun:test";
import type { SceneId } from "../src/app/appearance";
import { AMBIENT_FPS, LIGHT, shaftRows } from "../src/app/room/ambient";
import { layoutRoom } from "../src/app/room/layout";
import type { FullRoomLayout } from "../src/app/room/layout";
import { companionAt } from "../src/app/room/companion";
import { motionOn } from "../src/app/room/motion";
import { FRONT_ROW_ROOMS } from "../src/app/room/rooms";
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

  test("only the rail room's window light moves, and only it asks for frames; the other rooms are still pictures", () => {
    for (const scene of rooms) {
      const list = buildScene(scene, fullLayout(scene), T);
      if (scene !== "last-desk") {
        expect({ scene, specks: specksOf(list.draws).length, next: list.next }).toEqual({ scene, specks: 0, next: null });
        continue;
      }
      expect(specksOf(list.draws)).toHaveLength(1);
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

  test("window light is plain rows on whole plate pixels, edge to edge with no gap or overlap, from the window to the floor", () => {
    const shaft = LIGHT["last-desk"][0]!;
    const { rows } = shaftRows(shaft, 3);
    expect(rows[0]).toMatchObject({ x: shaft.from.x, y: shaft.from.y, width: shaft.width });
    expect(shaft.from).toEqual({ x: 0, y: 0 });
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
