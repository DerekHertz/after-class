/**
 * `bun run build:art` turns the masters in art/masters into the lossless WebP files the review app ships from
 * src/app/assets, and writes art/manifest.json, which test/art.test.ts reads to keep the two in step.
 *
 * Masters stay PNG, exactly as they were drawn or generated. What ships is lossless WebP, so every pixel the learner sees
 * is the master's, at the size it is drawn:
 *
 * - A master that is an exact integer upscale of smaller art (the front-row-v2 layers were generated at 2x) is stored at
 *   its true resolution. The CSS draws these layers `image-rendering: pixelated`, which takes the same colour from the
 *   small file as from the doubled one.
 * - Art drawn much smaller than it was made is resized once, with a high-quality filter, to its largest drawn size times a
 *   device pixel ratio of 3. See DRAWN below.
 * - Everything else is re-encoded as it is.
 *
 * Regenerated art goes into art/masters and through this script. It refuses a master it cannot place in a rule, so
 * no raster ships by accident, and test/art.test.ts fails when a shipped file is an upscale or larger than it is drawn.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const MASTERS = join(REPO, "art/masters");
const SHIPPED = join(REPO, "src/app/assets");
const MANIFEST = join(REPO, "art/manifest.json");

/** Pixels the art needs per CSS pixel on the sharpest display it is sized for. */
export const MAX_DEVICE_PIXEL_RATIO = 3;

/** One companion sheet is three equal cells. These cell heights are what each of its two sizes ships at. */
export const COMPANION_CELL = { large: 724, small: 362 } as const;

export type ArtOutput = {
  /** Path under src/app/assets. */
  readonly ship: string;
  /** Divide the master's size by this whole number, because the master is that exact upscale of smaller art. */
  readonly undoUpscale?: number;
  /** Resize to this width, keeping the master's aspect ratio. */
  readonly width?: number;
  /** The largest CSS size the file is drawn at, when it is far smaller than the master. A shipped file may be up to MAX_DEVICE_PIXEL_RATIO times that. */
  readonly drawn?: { readonly width?: number; readonly height?: number };
};

const webp = (master: string, suffix = "") => master.replace(/\.png$/, `${suffix}.webp`);

/** Where each master goes. A master no rule names fails the build. */
export function outputsFor(master: string, size: { readonly width: number; readonly height: number }): ArtOutput[] {
  if (master.startsWith("front-row-v2/")) return [{ ship: webp(master), undoUpscale: 2 }];
  // The bell is drawn at most 30 CSS px wide (reference.css), in a square.
  if (master === "scenes-v2/bell.png") return [{ ship: webp(master), width: 30 * MAX_DEVICE_PIXEL_RATIO, drawn: { width: 30, height: 38 } }];
  if (master.startsWith("companions-v3/")) {
    const cell = size.height;
    if (cell !== COMPANION_CELL.large) throw new Error(`${master} has cells ${cell} px tall; build-art.ts and hd-companion.css expect ${COMPANION_CELL.large}`);
    // The small sheet serves every place a companion is drawn at 120 CSS px or less (scene.css, front-row.css phone layout).
    return [{ ship: webp(master) }, { ship: webp(master, "-small"), width: Math.round((size.width * COMPANION_CELL.small) / COMPANION_CELL.large), drawn: { height: 120 } }];
  }
  if (master.startsWith("front-row/") || master.startsWith("room-objects/")) return [{ ship: webp(master) }];
  throw new Error(`art/masters/${master} has no rule in scripts/build-art.ts. Say how it is drawn, so it ships at that size.`);
}

export type ArtEntry = { readonly master: string; readonly masterSha256: string; readonly ship: string; readonly shipSha256: string; readonly width: number; readonly height: number; readonly undoUpscale?: number; readonly drawn?: ArtOutput["drawn"] };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function listMasters(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listMasters(join(dir, e.name)) : e.name.endsWith(".png") ? [join(dir, e.name)] : []));
}

async function encode(masterBytes: Uint8Array, out: ArtOutput, size: { width: number; height: number }): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const scale = out.undoUpscale ?? 1;
  let width = size.width / scale, height = size.height / scale;
  if (out.width !== undefined) { height = Math.round((size.height * out.width) / size.width); width = out.width; }
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`${out.ship}: ${size.width}x${size.height} does not divide by ${scale}`);
  let image = new Bun.Image(masterBytes);
  if (scale > 1) {
    const small = await new Bun.Image(masterBytes).resize(width, height, { filter: "nearest", fit: "fill" }).png().bytes();
    const again = await new Bun.Image(small).resize(size.width, size.height, { filter: "nearest", fit: "fill" }).png().bytes();
    const original = await new Bun.Image(masterBytes).png().bytes();
    if (sha256(again) !== sha256(original)) throw new Error(`${out.ship}: the master is not an exact ${scale}x upscale, so it cannot be stored at 1x without changing a pixel`);
    image = new Bun.Image(small);
  } else if (out.width !== undefined) image = image.resize(width, height, { filter: "lanczos3", fit: "fill" });
  return { bytes: await image.webp({ lossless: true }).bytes(), width, height };
}

export async function buildArt(): Promise<ArtEntry[]> {
  const entries: ArtEntry[] = [];
  for (const path of listMasters(MASTERS).sort()) {
    const master = relative(MASTERS, path).split("\\").join("/");
    const bytes = readFileSync(path);
    const size = await new Bun.Image(bytes).metadata();
    for (const out of outputsFor(master, size)) {
      const made = await encode(bytes, out, size);
      const target = join(SHIPPED, out.ship);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, made.bytes);
      entries.push({ master, masterSha256: sha256(bytes), ship: out.ship, shipSha256: sha256(made.bytes), width: made.width, height: made.height, ...(out.undoUpscale === undefined ? {} : { undoUpscale: out.undoUpscale }), ...(out.drawn === undefined ? {} : { drawn: out.drawn }) });
    }
  }
  writeFileSync(MANIFEST, `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

if (import.meta.main) {
  const entries = await buildArt();
  console.log(`wrote ${entries.length} files to src/app/assets and art/manifest.json`);
}
