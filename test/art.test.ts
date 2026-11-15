import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { MAX_DEVICE_PIXEL_RATIO } from "../scripts/build-art";
import type { ArtEntry } from "../scripts/build-art";
import { COMPANION_ART } from "../src/app/room/companion-art";
import { ROOM_LAYER_ART } from "../src/app/room/art";
import { readImage } from "./png";
import type { Png } from "./png";

const REPO = join(import.meta.dir, "..");
const MASTERS = join(REPO, "art/masters");
const ASSETS = join(REPO, "src/app/assets");
const manifest = JSON.parse(readFileSync(join(REPO, "art/manifest.json"), "utf8")) as ArtEntry[];
const RASTER = /\.(png|webp|jpe?g|gif|avif)$/;
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const rel = (root: string, path: string) => relative(root, path).split("\\").join("/");
/** The room layers and companion frames the review's canvas stage draws (src/app/room/stage.tsx), which import their files instead of naming them in a stylesheet. */
const STAGE_DRAWN = new Set([
  ...Object.values(ROOM_LAYER_ART).flatMap(({ extras, ...layers }) => [...Object.values(layers), ...Object.values(extras)]),
  ...Object.values(COMPANION_ART).flatMap(({ sheet, frames }) => [sheet, ...Object.values(frames)].flatMap((sized) => [sized.large, sized.small])),
].map((file: string) => rel(ASSETS, file)));

/** True when every k x k block of pixels is one colour, so the image is a smaller one drawn k times larger. */
export function isIntegerUpscale(png: Png, k: number): boolean {
  if (png.width % k !== 0 || png.height % k !== 0) return false;
  const at = (x: number, y: number) => (y * png.width + x) * 4;
  for (let y = 0; y < png.height; y += k) for (let x = 0; x < png.width; x += k) {
    const o = at(x, y);
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      if (dx === 0 && dy === 0) continue;
      const p = at(x + dx, y + dy);
      if (png.rgba[o] !== png.rgba[p] || png.rgba[o + 1] !== png.rgba[p + 1] || png.rgba[o + 2] !== png.rgba[p + 2] || png.rgba[o + 3] !== png.rgba[p + 3]) return false;
    }
  }
  return true;
}

type Rule = { readonly selector: string; readonly body: string; readonly smoothOk: string | null };

/** The rules of a stylesheet, flattened out of any @media block. A `/* smooth-ok: reason *\/` comment right before a rule becomes that rule's `smoothOk`. */
export function parseRules(css: string): Rule[] {
  const marked = css.replace(/\/\*\s*smooth-ok:([\s\S]*?)\*\//g, (_, why: string) => `§${why.trim().replace(/\s+/g, " ")}§`).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...marked.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.replace(/§[^§]*§/g, "").trim(), body: m[2]!, smoothOk: m[1]!.match(/§([^§]*)§/)?.[1] ?? null }));
}

/**
 * The rules that draw a halved image without `image-rendering: pixelated` and without a recorded reason. A file stored at half
 * size is the same picture only while it is enlarged by repeating pixels, and a rule that drew the doubled file smooth drew it
 * smooth from a file that held each pixel four times. Each such rule is either pixelated, directly or through a parent whose
 * every child is (`.x > *`), or carries a `smooth-ok` comment that says why smooth drawing is the right one.
 */
export function unprotectedHalvedImages(stylesheets: readonly string[], halved: readonly string[]): string[] {
  const rules = stylesheets.flatMap(parseRules);
  const pixelated = (r: Rule) => /image-rendering:\s*pixelated/.test(r.body);
  const parents = rules.filter(pixelated).map((r) => r.selector.match(/^(.+) > \*$/)?.[1]).filter((p): p is string => p !== undefined);
  const problems: string[] = [];
  for (const ship of halved) {
    const named = rules.filter((r) => r.body.includes(`/${ship}'`) || r.body.includes(`/${ship}"`) || r.body.includes(`/${ship})`));
    const consumers = named.flatMap((r) => {
      const property = r.body.match(new RegExp(`(--[\\w-]+|background-image)\\s*:[^;]*/${ship.replace(/[.]/g, "\\.")}`))?.[1];
      return property === undefined ? [] : property.startsWith("--") ? rules.filter((c) => c.body.includes(`var(${property})`)) : [r];
    });
    if (consumers.length === 0) problems.push(`${ship}: no rule draws it`);
    for (const c of consumers) {
      if (pixelated(c) || parents.some((p) => c.selector.startsWith(`${p} `))) continue;
      if (c.smoothOk !== null && c.smoothOk.length >= 40) continue;
      problems.push(`${ship}: ${c.selector} draws it smooth with no reason recorded`);
    }
  }
  return problems;
}

describe("the art the app ships is built from art/masters by scripts/build-art.ts", () => {
  test("every raster the stylesheets draw is in the manifest, with the bytes the script wrote from the master it names", () => {
    const css = files(join(REPO, "src/app")).filter((f) => f.endsWith(".css")).map((f) => ({ f, text: readFileSync(f, "utf8") }));
    const drawn = new Set<string>();
    for (const { f, text } of css) for (const m of text.matchAll(/url\(['"]?(\.\/assets\/[^'")]+)['"]?\)/g)) if (RASTER.test(m[1]!)) drawn.add(rel(ASSETS, join(f, "..", m[1]!)));
    expect([...new Set([...drawn, ...STAGE_DRAWN])].sort()).toEqual(manifest.map((e) => e.ship).sort());
    for (const entry of manifest) {
      expect({ ship: entry.ship, sha: sha256(join(ASSETS, entry.ship)) }).toEqual({ ship: entry.ship, sha: entry.shipSha256 });
      expect({ master: entry.master, sha: sha256(join(MASTERS, entry.master)) }).toEqual({ master: entry.master, sha: entry.masterSha256 });
    }
  });

  test("every master is shipped, so none is dropped without anyone deciding to", () => {
    const masters = files(MASTERS).filter((f) => f.endsWith(".png")).map((f) => rel(MASTERS, f)).sort();
    expect([...new Set(manifest.map((e) => e.master))].sort()).toEqual(masters);
  });

  test("no stylesheet names a PNG, so a raster the script did not build cannot be drawn", () => {
    const css = files(join(REPO, "src/app")).filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(css.match(/url\(['"]?[^'")]+\.(png|jpe?g|gif)['"]?\)/g) ?? []).toEqual([]);
  });

  test("a resized file is no larger than its drawn size times the highest pixel ratio, and the upscale check can tell an upscale", () => {
    for (const entry of manifest) {
      if (entry.drawn === undefined) continue;
      const { width, height } = entry.drawn;
      if (width !== undefined) expect({ ship: entry.ship, ok: entry.width <= Math.ceil(width * MAX_DEVICE_PIXEL_RATIO * 1.02) }).toEqual({ ship: entry.ship, ok: true });
      // A companion sheet is three cells wide, so its height is the one drawn.
      if (height !== undefined && width === undefined) expect({ ship: entry.ship, ok: entry.height <= Math.ceil(height * MAX_DEVICE_PIXEL_RATIO * 1.02) }).toEqual({ ship: entry.ship, ok: true });
    }
    const image = (value: (x: number, y: number) => number): Png => ({ width: 4, height: 4, alpha: false, rgba: Uint8Array.from({ length: 64 }, (_, i) => value((i >> 2) % 4, i >> 4)) });
    expect(isIntegerUpscale(image((x, y) => (x >> 1) * 50 + (y >> 1) * 90), 2)).toBe(true);
    expect(isIntegerUpscale(image((x, y) => x * 50 + (y >> 1) * 90), 2)).toBe(false);
  });

  test("no shipped raster is an exact 2x, 3x or 4x upscale of smaller art", async () => {
    const found: string[] = [];
    for (const entry of manifest) {
      const png = await readImage(new URL(`file://${join(ASSETS, entry.ship)}`));
      for (const k of [2, 3, 4]) if (isIntegerUpscale(png, k)) found.push(`${entry.ship} is an exact ${k}x upscale; store it at ${png.width / k}x${png.height / k}`);
    }
    expect(found).toEqual([]);
  }, 120_000);

  test("every shipped pixel is the master's, with a 2x master read at its true resolution", async () => {
    for (const entry of manifest.filter((e) => e.drawn === undefined)) {
      const master = await readImage(new URL(`file://${join(MASTERS, entry.master)}`));
      const shipped = await readImage(new URL(`file://${join(ASSETS, entry.ship)}`));
      const k = entry.undoUpscale ?? 1;
      expect({ ship: entry.ship, width: shipped.width * k, height: shipped.height * k }).toEqual({ ship: entry.ship, width: master.width, height: master.height });
      let differing = 0;
      for (let y = 0; y < shipped.height; y++) for (let x = 0; x < shipped.width; x++) {
        const s = (y * shipped.width + x) * 4, m = ((y * k) * master.width + x * k) * 4;
        if (shipped.rgba[s + 3] !== master.rgba[m + 3]) differing++;
        // The colour under a fully transparent pixel is never drawn.
        else if (master.rgba[m + 3] !== 0 && (shipped.rgba[s] !== master.rgba[m] || shipped.rgba[s + 1] !== master.rgba[m + 1] || shipped.rgba[s + 2] !== master.rgba[m + 2])) differing++;
      }
      expect({ ship: entry.ship, differing }).toEqual({ ship: entry.ship, differing: 0 });
    }
  }, 300_000);

  test("every image stored at half size is drawn pixelated, or smooth with a reason the stylesheet records", () => {
    const stylesheets = files(join(REPO, "src/app")).filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8"));
    const halved = manifest.filter((e) => e.undoUpscale !== undefined).map((e) => e.ship);
    expect(halved.length).toBe(21);
    // The stage draws its layers pixelated in the full room (test/room-scene.test.ts). A file it draws is checked here only
    // where a stylesheet draws it too, as the phone's backdrop draws each room's background.
    expect(unprotectedHalvedImages(stylesheets, halved.filter((ship) => !STAGE_DRAWN.has(ship) || stylesheets.some((css) => css.includes(ship))))).toEqual([]);
    const sample = ".a { --art: url('./assets/x/y.webp'); }\n.b { background: var(--art); }\n";
    expect(unprotectedHalvedImages([sample], ["x/y.webp"])).toEqual(["x/y.webp: .b draws it smooth with no reason recorded"]);
    expect(unprotectedHalvedImages([sample.replace(".b {", ".b { image-rendering: pixelated;")], ["x/y.webp"])).toEqual([]);
    expect(unprotectedHalvedImages([sample.replace(".b {", ".b { image-rendering: pixelated;"), ".b > * { image-rendering: pixelated; }"], ["x/y.webp"])).toEqual([]);
    expect(unprotectedHalvedImages([sample.replace(".b {", "/* smooth-ok: the picture is drawn smaller than its file, where skipping pixels would alias */ .b {")], ["x/y.webp"])).toEqual([]);
    expect(unprotectedHalvedImages([sample.replace(".b {", "/* smooth-ok: fine */ .b {")], ["x/y.webp"])).toHaveLength(1);
    expect(unprotectedHalvedImages([sample.replace(".b {", ".c { background: var(--art); }\n.b {")], ["x/y.webp"])).toHaveLength(2);
  });
});
