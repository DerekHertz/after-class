/**
 * `bun run scripts/build-app.ts` (M3). Bundles the review app (src/app/index.html and what it imports) into
 * dist/app/ for `http.ts` to serve under /app/. `publicPath` is /app/ so asset URLs stay absolute and still
 * resolve when the SPA fallback answers a deep link such as /app/capture/<id>.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * Bun inlines every CSS `url()` target of 128 KiB or less as a base64 `data:` URI and has no option to stop it. A
 * stylesheet is render-blocking, so those fonts and art plates (1 MB of base64 at the time of writing) arrived before
 * anything painted and were fetched again on every visit. `externalizeDataUrls` moves each one above INLINE_LIMIT back
 * out to its own content-hashed file, named after its source file, which the browser fetches in parallel and caches.
 */
export const INLINE_LIMIT = 2048;
const DATA_URL = /url\((["']?)data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)\1\)/g;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/svg+xml": "svg", "font/ttf": "ttf" };

/**
 * The fonts the signed-out screen draws with. A font file is only requested once text that uses it is on the page, which
 * is after the script has run, so index.html preloads these two and they download beside the script, not after it. Their
 * @font-face rules say `font-display: block`, so the screen waits for the file the few milliseconds it takes instead of
 * drawing in a fallback face and then jumping.
 */
const FIRST_SCREEN_FONTS = ["pixelify-sans", "dm-sans-400"];

function sourceNames(dir: string, names = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceNames(path, names);
    else if (Object.values(EXTENSIONS).includes(extname(path).slice(1))) names.set(sha256(readFileSync(path)), basename(path, extname(path)));
  }
  return names;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function externalizeDataUrls(css: string, out: string, names: Map<string, string>, emitted: string[]): string {
  return css.replace(DATA_URL, (whole, _quote, mime: string, base64: string) => {
    if (base64.length <= INLINE_LIMIT) return whole;
    const extension = EXTENSIONS[mime];
    if (extension === undefined) throw new Error(`the review app's CSS inlines a ${mime} file, and build-app.ts does not know its extension`);
    const bytes = Buffer.from(base64, "base64");
    const hash = sha256(bytes);
    const file = `${names.get(hash) ?? mime.split("/")[0]}-${hash.slice(0, 8)}.${extension}`;
    writeFileSync(join(out, file), bytes);
    emitted.push(file);
    return `url("/app/${file}")`;
  });
}

export async function buildApp(outDir: string): Promise<void> {
  const out = resolve(ROOT, outDir);
  rmSync(out, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/app/index.html")],
    outdir: out,
    target: "browser",
    publicPath: "/app/",
    minify: true,
    throw: false,
  });
  if (!result.success) throw new Error(`build of the review app failed:\n${result.logs.map(String).join("\n")}`);
  const names = sourceNames(join(ROOT, "src/app/assets"));
  const emitted: string[] = [];
  for (const output of result.outputs.filter((o) => o.path.endsWith(".css"))) {
    writeFileSync(output.path, externalizeDataUrls(readFileSync(output.path, "utf8"), out, names, emitted));
  }
  const preloads = FIRST_SCREEN_FONTS.map((stem) => {
    const file = emitted.find((f) => f.startsWith(`${stem}-`) && f.endsWith(".ttf"));
    if (file === undefined) throw new Error(`the first-screen font ${stem} is not in the review app's CSS`);
    return `<link rel="preload" href="/app/${file}" as="font" type="font/ttf" crossorigin>`;
  });
  const page = join(out, "index.html");
  writeFileSync(page, readFileSync(page, "utf8").replace("</head>", () => `${preloads.join("")}</head>`));
  const licenses: [string, string][] = [
    ["Feather icons", "src/app/assets/icons-v2/LICENSE"],
    ["Young Serif", "src/app/assets/fonts-v2/young-serif-OFL.txt"],
    ["DM Sans", "src/app/assets/fonts-v2/dm-sans-OFL.txt"],
    ["Pixelify Sans", "src/app/assets/fonts-v2/OFL-PixelifySans.txt"],
  ];
  const notices = licenses.map(([name, path]) => `${name}\n\n${readFileSync(join(ROOT, path), "utf8")}`).join("\n\n");
  writeFileSync(join(out, "asset-notices.txt"), notices);
  console.log(`built the review app into ${out}`);
}

if (import.meta.main) await buildApp("dist/app");
