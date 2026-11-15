import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_CELL } from "../scripts/build-art";
import type { ArtEntry } from "../scripts/build-art";
import { readImage } from "./png";
import type { Png } from "./png";

const REPO = join(import.meta.dir, "..");
const MASTERS = join(REPO, "art/masters");
const ASSETS = join(REPO, "src/app/assets");
const manifest = JSON.parse(readFileSync(join(REPO, "art/manifest.json"), "utf8")) as ArtEntry[];
const GESTURES = ["blink", "look-board", "look-mat", "nod", "hop-crouch", "hop-air", "think", "cheer", "talk"] as const;
/** Frames the companion leaves the ground in. Their base is not the ground line, so their offset from it is recorded instead. */
const AIRBORNE = new Set(["hop-air"]);
/** Frames that carry a separate opaque island on purpose: think's sweat drop. */
const ISLANDS: Record<string, number> = { think: 1 };

const png = (path: string) => readImage(new URL(`file://${path}`));

/** The lowest opaque row of the largest connected opaque region, and how many separate regions there are. */
export function bodyOf(image: Png): { bottom: number; islands: number } {
  const { width, height, rgba } = image;
  const label = new Int32Array(width * height);
  const sizes: number[] = [];
  const bottoms: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (label[start] !== 0 || rgba[start * 4 + 3]! <= 128) continue;
    const id = sizes.length + 1;
    let size = 0, bottom = 0;
    const stack = [start];
    label[start] = id;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % width, y = (p - x) / width;
      if (y > bottom) bottom = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (label[q] === 0 && rgba[q * 4 + 3]! > 128) { label[q] = id; stack.push(q); }
      }
    }
    sizes.push(size); bottoms.push(bottom);
  }
  return { bottom: bottoms[sizes.indexOf(Math.max(...sizes))]!, islands: sizes.length };
}

describe("Pip's gesture frames ship through the art pipeline", () => {
  test("every frame has a master, a large and a small file in the manifest, with its provenance", () => {
    for (const name of GESTURES) {
      const entries = manifest.filter((e) => e.master === `companion-frames/pip/${name}.png`);
      expect(entries.map((e) => e.ship).sort()).toEqual([`companion-frames/pip/${name}-small.webp`, `companion-frames/pip/${name}.webp`]);
      for (const e of entries) {
        expect(e.provenance?.model).toBe("nano-banana-pro");
        expect(e.provenance?.credits).toBe(9);
        expect(e.provenance?.meshyTaskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
        expect(e.provenance?.prompt.length).toBeGreaterThan(40);
      }
    }
    expect(manifest.filter((e) => e.master.startsWith("companion-frames/")).length).toBe(GESTURES.length * 2);
  });

  test("the large file is the master's pixels at the drawn cell, and the small one is the sheet's small size", async () => {
    for (const name of GESTURES) {
      const master = await png(join(MASTERS, `companion-frames/pip/${name}.png`));
      const large = await png(join(ASSETS, `companion-frames/pip/${name}.webp`));
      const small = await png(join(ASSETS, `companion-frames/pip/${name}-small.webp`));
      expect({ name, w: master.width, h: master.height }).toEqual({ name, w: COMPANION_CELL.large, h: COMPANION_CELL.large });
      expect({ name, w: large.width, h: large.height }).toEqual({ name, w: COMPANION_CELL.large, h: COMPANION_CELL.large });
      expect({ name, w: small.width, h: small.height }).toEqual({ name, w: COMPANION_CELL.small, h: COMPANION_CELL.small });
      let differing = 0;
      for (let i = 0; i < master.rgba.length; i += 4) {
        if (large.rgba[i + 3] !== master.rgba[i + 3]) differing++;
        else if (master.rgba[i + 3] !== 0 && (large.rgba[i] !== master.rgba[i] || large.rgba[i + 1] !== master.rgba[i + 1] || large.rgba[i + 2] !== master.rgba[i + 2])) differing++;
      }
      expect({ name, differing }).toEqual({ name, differing: 0 });
    }
  }, 120_000);

  test("mechanical cleanup holds: binary alpha, no specks, and one shared canvas and ground line", async () => {
    const provenance = JSON.parse(readFileSync(join(MASTERS, "companion-frames/pip/provenance.json"), "utf8")) as { groundRow: number; frames: Record<string, { shiftY: number; bodyBottomRow: number }> };
    const idle = await png(join(MASTERS, "companions-v3/pip.png"));
    // Idle is the first cell of the approved sheet (soft alpha, as approved), and its body's lowest row is the ground line the frames share.
    const cell: Png = { width: COMPANION_CELL.large, height: COMPANION_CELL.large, alpha: true, rgba: new Uint8Array(COMPANION_CELL.large ** 2 * 4) };
    for (let y = 0; y < cell.height; y++) cell.rgba.set(idle.rgba.subarray(y * idle.width * 4, (y * idle.width + cell.width) * 4), y * cell.width * 4);
    const ground = bodyOf(cell).bottom;
    expect(provenance.groundRow).toBe(ground);
    const offsets: Record<string, number> = {};
    for (const name of GESTURES) {
      const frame = await png(join(MASTERS, `companion-frames/pip/${name}.png`));
      for (let i = 3; i < frame.rgba.length; i += 4) if (frame.rgba[i] !== 0 && frame.rgba[i] !== 255) throw new Error(`${name} has a partly transparent pixel`);
      const { bottom, islands } = bodyOf(frame);
      expect({ name, islands }).toEqual({ name, islands: 1 + (ISLANDS[name] ?? 0) });
      offsets[name] = bottom - ground;
      expect(provenance.frames[name]!.bodyBottomRow).toBe(bottom);
    }
    for (const name of GESTURES) if (!AIRBORNE.has(name)) expect({ name, offset: offsets[name] }).toEqual({ name, offset: 0 });
    expect(offsets["hop-air"]).toBe(54);
  }, 120_000);
});

describe("nothing prefetches or draws the frames before #222 wires them", () => {
  const read = (path: string) => readFileSync(join(REPO, path), "utf8");
  const sources = (dir: string): string[] => readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "assets" ? [] : sources(join(dir, e.name))) : [join(dir, e.name)]));
  test("no app source, stylesheet or room-art table names companion-frames, so the room's prefetch hints are unchanged", () => {
    const named = [...sources("src"), "scripts/build-app.ts"].filter((f) => read(f).includes("companion-frames"));
    expect(named).toEqual([]);
  });
});
