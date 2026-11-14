/**
 * `bun run scripts/build-app.ts` (M3). Bundles the review app (src/app/index.html and what it imports) into
 * dist/app/ for `http.ts` to serve under /app/. `publicPath` is /app/ so asset URLs stay absolute and still
 * resolve when the SPA fallback answers a deep link such as /app/capture/<id>.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { APPEARANCE_STORAGE_KEY, DEFAULT_ROOM, ROOM_ART_PREFIX, ROOM_LAYER_ORDER, SHARED_ROOM_ART } from "../src/shared/room-art";
import type { RoomArtTable } from "../src/shared/room-art";

const REPO = resolve(import.meta.dir, "..");

/**
 * Bun inlines every CSS `url()` target of 128 KiB or less as a base64 `data:` URI and has no option to stop it. A
 * stylesheet is render-blocking, so those fonts and art plates (1 MB of base64 at the time of writing) arrived before
 * anything painted and were fetched again on every visit. `externalizeDataUrls` moves each one above INLINE_LIMIT back
 * out to its own content-hashed file, named after its source file, which the browser fetches in parallel and caches.
 */
export const INLINE_LIMIT = 2048;
const DATA_URL = /url\((["']?)data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)\1\)/g;
const EXTENSIONS: Record<string, string> = { "image/webp": "webp", "image/svg+xml": "svg", "font/ttf": "ttf" };

/**
 * The fonts the signed-out screen draws with. A font file is only requested once text that uses it is on the page, which
 * is after the script has run, so index.html preloads these two and they download beside the script, not after it. Their
 * @font-face rules say `font-display: block`, so the screen waits for the file the few milliseconds it takes instead of
 * drawing in a fallback face and then jumping.
 */
const FIRST_SCREEN_FONTS = ["pixelify-sans", "dm-sans-400"];

/**
 * The art a room needs, as bundle URLs, found by name: Bun and `externalizeDataUrls` both emit `<source name>-<8 hash chars>.<ext>`.
 * The page carries it as JSON, for the script below and for src/app/art-prefetch.ts. `emitted` is every file in the bundle.
 */
export function roomArtTable(emitted: readonly string[], layerNames: readonly string[]): RoomArtTable {
  const url = (stem: string): string => {
    const file = emitted.filter((f) => new RegExp(`^${stem}-[a-z0-9]{8}\\.webp$`).test(f));
    if (file.length !== 1) throw new Error(`the review app's CSS must draw ${stem}.webp exactly once in the bundle; found ${file.length}`);
    return `/app/${file[0]}`;
  };
  const rooms: Record<string, { plate: string; layers: string[] }> = {};
  for (const [scene, prefix] of Object.entries(ROOM_ART_PREFIX)) {
    const own = layerNames.filter((n) => n.startsWith(`${prefix}-`));
    const first = ROOM_LAYER_ORDER.map((layer) => `${prefix}-${layer}`);
    for (const stem of first) if (!own.includes(stem)) throw new Error(`${scene} has no ${stem} in assets/front-row-v2`);
    rooms[scene] = { plate: url(scene), layers: [...first, ...own.filter((n) => !first.includes(n)).sort()].map(url) };
  }
  return { rooms, shared: SHARED_ROOM_ART.map(url) };
}

/**
 * Runs while the page is still being parsed, before the stylesheet and the script, and so before the app can say which room
 * the learner is in. It reads their saved room, the way parseAppearance does, and asks for the art that the first screen is
 * about to draw: the review's layers on a review page, the room's plate everywhere else. A page nothing has saved a room for
 * gets the default room's.
 */
function preloadScript(): string {
  return `(function(){try{var t=JSON.parse(document.getElementById("room-art").textContent),s;try{s=JSON.parse(localStorage.getItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)})).scene}catch(e){}var r=t.rooms[s]||t.rooms[${JSON.stringify(DEFAULT_ROOM)}];var u=/^\\/app\\/review(\\/|$)/.test(location.pathname)?r.layers:[r.plate];for(var i=0;i<u.length;i++){var l=document.createElement("link");l.rel="preload";l.as="image";l.href=u[i];document.head.appendChild(l)}}catch(e){}})()`;
}

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

/**
 * A cached file must never be paired with a newer release, so each immutable name is a function of the file's final bytes.
 * Bun names the stylesheet by a hash of what it read, and `externalizeDataUrls` then rewrites it (the extracted names depend
 * on source basenames Bun's hash does not see). `buildApp` therefore renames each stylesheet by the hash of its rewritten
 * bytes. Nothing else is written after Bun hashes it: index.html and the notices keep a fixed name and are served no-cache.
 */
export async function buildApp(outDir: string, root = REPO): Promise<void> {
  const out = resolve(root, outDir);
  rmSync(out, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(root, "src/app/index.html")],
    outdir: out,
    target: "browser",
    publicPath: "/app/",
    minify: true,
    throw: false,
  });
  if (!result.success) throw new Error(`build of the review app failed:\n${result.logs.map(String).join("\n")}`);
  const names = sourceNames(join(root, "src/app/assets"));
  const emitted: string[] = [];
  const stylesheets = new Map<string, string>();
  for (const output of result.outputs.filter((o) => o.path.endsWith(".css"))) {
    const css = Buffer.from(externalizeDataUrls(readFileSync(output.path, "utf8"), out, names, emitted));
    const file = basename(output.path).replace(/-[a-z0-9]{8}\.css$/, `-${sha256(css).slice(0, 8)}.css`);
    rmSync(output.path);
    writeFileSync(join(out, file), css);
    stylesheets.set(basename(output.path), file);
  }
  const page = join(out, "index.html");
  let html = readFileSync(page, "utf8");
  for (const [bunName, file] of stylesheets) {
    for (const script of result.outputs.filter((o) => o.path.endsWith(".js"))) {
      if (readFileSync(script.path, "utf8").includes(bunName)) throw new Error(`${basename(script.path)} names the stylesheet ${bunName}, and build-app.ts would have to rehash the script after renaming it`);
    }
    html = html.replaceAll(bunName, file);
  }
  const preloads = FIRST_SCREEN_FONTS.map((stem) => {
    const file = emitted.find((f) => f.startsWith(`${stem}-`) && f.endsWith(".ttf"));
    if (file === undefined) throw new Error(`the first-screen font ${stem} is not in the review app's CSS`);
    return `<link rel="preload" href="/app/${file}" as="font" type="font/ttf" crossorigin>`;
  });
  const layers = readdirSync(join(root, "src/app/assets/front-row-v2")).map((f) => basename(f, extname(f)));
  const table = JSON.stringify(roomArtTable(readdirSync(out), layers)).replaceAll("<", "\\u003c");
  const artTags = `<script type="application/json" id="room-art">${table}</script><script>${preloadScript()}</script>`;
  html = html.replace('<link rel="stylesheet"', () => `${artTags}<link rel="stylesheet"`);
  if (!html.includes('id="room-art"')) throw new Error("build-app.ts could not find the stylesheet link to place the room art ahead of");
  writeFileSync(page, html.replace("</head>", () => `${preloads.join("")}</head>`));
  const licenses: [string, string][] = [
    ["Feather icons", "src/app/assets/icons-v2/LICENSE"],
    ["Young Serif", "src/app/assets/fonts-v2/young-serif-OFL.txt"],
    ["DM Sans", "src/app/assets/fonts-v2/dm-sans-OFL.txt"],
    ["Pixelify Sans", "src/app/assets/fonts-v2/OFL-PixelifySans.txt"],
  ];
  const notices = licenses.map(([name, path]) => `${name}\n\n${readFileSync(join(root, path), "utf8")}`).join("\n\n");
  writeFileSync(join(out, "asset-notices.txt"), notices);
  console.log(`built the review app into ${out}`);
}

if (import.meta.main) await buildApp("dist/app");
