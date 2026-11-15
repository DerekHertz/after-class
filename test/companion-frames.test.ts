import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_CELL } from "../scripts/build-art";
import type { ArtEntry } from "../scripts/build-art";
import { decodePng, readImage } from "./png";
import type { Png } from "./png";

const REPO = join(import.meta.dir, "..");
const MASTERS = join(REPO, "art/masters");
const ASSETS = join(REPO, "src/app/assets");
const manifest = JSON.parse(readFileSync(join(REPO, "art/manifest.json"), "utf8")) as ArtEntry[];
const GESTURES = ["blink", "look-board", "look-mat", "nod", "hop-crouch", "hop-air", "think", "cheer", "talk"] as const;
const COMPANIONS = ["pip", "mote", "mote-moonlit", "mote-pagewing", "lumi", "yun"] as const;
type Companion = (typeof COMPANIONS)[number];
/** Frames the companion leaves the ground in. Their base is not the ground line, so their offset from it is recorded instead. */
const AIRBORNE = new Set(["hop-air"]);
/** Frames that carry a separate opaque island on purpose: Pip's think sweat drop. No other companion has one. */
const ISLANDS: Partial<Record<Companion, Record<string, number>>> = { pip: { think: 1 } };
/** Frames that failed the mechanical checks, are not shipped, and wait on Derek: Lumi's cheer has ten separate sparkle islands. */
const REJECTED: Partial<Record<Companion, readonly string[]>> = { lumi: ["cheer"] };
/** How far below the ground line each companion's drawn hop-air frame sits, in cell pixels. Issue #275 settles the rule for placing it. */
const AIR_DROP: Record<Companion, number> = { pip: 54, mote: 38, "mote-moonlit": 46, "mote-pagewing": 61, lumi: 0, yun: 39 };
const framesOf = (who: Companion) => GESTURES.filter((g) => !REJECTED[who]?.includes(g));
type SourceFrame = { prompt: string; meshy_task_id: string; credits: number };
type SourceRecord = { master: string; model: string; frames: Record<string, SourceFrame> };
/** The generator's record of each frame, in the design folder. Provenance in the masters and the manifest must repeat it. */
const source = (who: Companion) => JSON.parse(readFileSync(join(REPO, "docs/design/live-room/painted", who, "provenance.json"), "utf8")) as SourceRecord;
/** The fields of a frame's source record that must survive into every copy. */
const pick = (f: SourceFrame) => ({ prompt: f.prompt, meshy_task_id: f.meshy_task_id, credits: f.credits });

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

/** Mean absolute difference per channel between two same-size images, with colour weighted by alpha so the hidden colour of a transparent pixel does not count. */
function meanDiff(a: Png, b: Png): number {
  let sum = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) sum += Math.abs((a.rgba[i + c]! * a.rgba[i + 3]!) / 255 - (b.rgba[i + c]! * b.rgba[i + 3]!) / 255);
    sum += Math.abs(a.rgba[i + 3]! - b.rgba[i + 3]!);
  }
  return sum / a.rgba.length;
}

for (const who of COMPANIONS) describe(`${who}'s gesture frames ship through the art pipeline`, () => {
  test("every frame has a master, a large and a small file in the manifest, and its provenance is the source record's", () => {
    const record = source(who);
    for (const name of framesOf(who)) {
      const entries = manifest.filter((e) => e.master === `companion-frames/${who}/${name}.png`);
      expect(entries.map((e) => e.ship).sort()).toEqual([`companion-frames/${who}/${name}-small.webp`, `companion-frames/${who}/${name}.webp`]);
      const from = record.frames[name]!;
      for (const e of entries) expect({ name, provenance: e.provenance }).toEqual({ name, provenance: { model: record.model, prompt: from.prompt, meshyTaskId: from.meshy_task_id, credits: from.credits } });
    }
    expect(manifest.filter((e) => e.master.startsWith(`companion-frames/${who}/`)).length).toBe(framesOf(who).length * 2);
  });

  test("the master folder's provenance repeats the source record, and names the frames it rejected", () => {
    const record = source(who);
    const mine = JSON.parse(readFileSync(join(MASTERS, `companion-frames/${who}/provenance.json`), "utf8")) as SourceRecord & { rejected?: Record<string, string> };
    expect({ master: mine.master, model: mine.model }).toEqual({ master: record.master, model: record.model });
    expect(Object.keys(mine.frames)).toEqual(framesOf(who));
    for (const name of framesOf(who)) expect({ name, ...pick(mine.frames[name]!) }).toEqual({ name, ...pick(record.frames[name]!) });
    expect(Object.keys(mine.rejected ?? {})).toEqual([...(REJECTED[who] ?? [])]);
  });

  test("the large file is the master's pixels, and the small one is the master resized to the sheet's small size", async () => {
    for (const name of framesOf(who)) {
      const masterPath = join(MASTERS, `companion-frames/${who}/${name}.png`);
      const master = await png(masterPath);
      const large = await png(join(ASSETS, `companion-frames/${who}/${name}.webp`));
      const small = await png(join(ASSETS, `companion-frames/${who}/${name}-small.webp`));
      expect({ name, w: master.width, h: master.height }).toEqual({ name, w: COMPANION_CELL.large, h: COMPANION_CELL.large });
      expect({ name, w: large.width, h: large.height }).toEqual({ name, w: COMPANION_CELL.large, h: COMPANION_CELL.large });
      expect({ name, w: small.width, h: small.height }).toEqual({ name, w: COMPANION_CELL.small, h: COMPANION_CELL.small });
      let differing = 0;
      for (let i = 0; i < master.rgba.length; i += 4) {
        if (large.rgba[i + 3] !== master.rgba[i + 3]) differing++;
        else if (master.rgba[i + 3] !== 0 && (large.rgba[i] !== master.rgba[i] || large.rgba[i + 1] !== master.rgba[i + 1] || large.rgba[i + 2] !== master.rgba[i + 2])) differing++;
      }
      expect({ name, differing }).toEqual({ name, differing: 0 });
      const resized = await new Bun.Image(readFileSync(masterPath)).resize(COMPANION_CELL.small, COMPANION_CELL.small, { filter: "lanczos3", fit: "fill" }).png().bytes();
      // Two different frames of one companion differ by far more than this, so a swapped small file fails.
      const diff = meanDiff(small, decodePng(Buffer.from(resized), name));
      expect({ name, close: diff < 0.1 }).toEqual({ name, close: true });
    }
  }, 120_000);

  test("mechanical cleanup holds: binary alpha, no specks, and one shared canvas and ground line", async () => {
    const provenance = JSON.parse(readFileSync(join(MASTERS, `companion-frames/${who}/provenance.json`), "utf8")) as { groundRow: number; frames: Record<string, { shiftY: number; bodyBottomRow: number }> };
    const idle = await png(join(MASTERS, `companions-v3/${who}.png`));
    // Idle is the first cell of the approved sheet (soft alpha, as approved), and its body's lowest row is the ground line the frames share.
    const cell: Png = { width: COMPANION_CELL.large, height: COMPANION_CELL.large, alpha: true, rgba: new Uint8Array(COMPANION_CELL.large ** 2 * 4) };
    for (let y = 0; y < cell.height; y++) cell.rgba.set(idle.rgba.subarray(y * idle.width * 4, (y * idle.width + cell.width) * 4), y * cell.width * 4);
    const ground = bodyOf(cell).bottom;
    expect(provenance.groundRow).toBe(ground);
    const offsets: Record<string, number> = {};
    for (const name of framesOf(who)) {
      const frame = await png(join(MASTERS, `companion-frames/${who}/${name}.png`));
      for (let i = 3; i < frame.rgba.length; i += 4) if (frame.rgba[i] !== 0 && frame.rgba[i] !== 255) throw new Error(`${who} ${name} has a partly transparent pixel`);
      const { bottom, islands } = bodyOf(frame);
      expect({ name, islands }).toEqual({ name, islands: 1 + (ISLANDS[who]?.[name] ?? 0) });
      offsets[name] = bottom - ground;
      expect(provenance.frames[name]!.bodyBottomRow).toBe(bottom);
    }
    for (const name of framesOf(who)) if (!AIRBORNE.has(name)) expect({ name, offset: offsets[name] }).toEqual({ name, offset: 0 });
    expect(offsets["hop-air"]).toBe(AIR_DROP[who]);
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
