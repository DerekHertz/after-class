/**
 * `bun run build:ext` (W2). Bun.build per entry (content, main-world, worker,
 * popup, options), target "browser", minify off (inspectable), sourcemap linked.
 * Copies manifest.json, the popup/options HTML, their stylesheet and its bundled
 * font and licence to dist/extension/. Fails if
 * any entry's bundle graph contains src/backend/ or a node:/bun: import.
 *
 * Content scripts must be classic scripts (iife). The worker, popup and options
 * are modules, which also lets the popup and options pages use top-level await.
 *
 * AFTERCLASS_EXT_OUT=<dir> also copies the finished build there, for loading
 * unpacked from Windows Chrome (it does not load extensions reliably from \\wsl$).
 *
 * AFTERCLASS_EXT_BACKEND=<origin> makes a hosted build for that backend, such as
 * https://useafterclass.com: the manifest's host permission and externally_connectable
 * name that origin instead of 127.0.0.1:4317, and the extension connects through the
 * web app instead of taking a pasted pairing token (src/extension/worker/backend.ts).
 * Unset, the build is the local one, unchanged.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "src/extension");

const ENTRIES: readonly { readonly out: string; readonly entry: string; readonly format: "iife" | "esm" }[] = [
  { out: "content.js", entry: "content/content-entry.ts", format: "iife" },
  { out: "main-world.js", entry: "content/main-world.ts", format: "iife" },
  { out: "worker.js", entry: "worker/service-worker.ts", format: "esm" },
  { out: "popup.js", entry: "popup/popup-main.ts", format: "esm" },
  { out: "options.js", entry: "popup/options.ts", format: "esm" },
];

const STATIC_FILES: readonly { readonly from: string; readonly to: string }[] = [
  { from: "manifest.json", to: "manifest.json" },
  { from: "popup/popup.html", to: "popup.html" },
  { from: "popup/options.html", to: "options.html" },
  { from: "popup/stationery.css", to: "stationery.css" },
  { from: "../app/assets/fonts-v2/pixelify-sans.ttf", to: "fonts/pixelify-sans.ttf" },
  { from: "../app/assets/fonts-v2/OFL-PixelifySans.txt", to: "fonts/OFL-PixelifySans.txt" },
];

const keepExtensionOnly: Bun.BunPlugin = {
  name: "extension-boundary",
  setup(build) {
    build.onResolve({ filter: /^(node|bun):/ }, (args) => {
      throw new Error(`${args.importer} imports ${args.path}: extension code must run in the browser`);
    });
    build.onLoad({ filter: /[\\/]src[\\/]backend[\\/]/ }, (args) => {
      throw new Error(`${args.path} is backend code and must not be bundled into the extension`);
    });
  },
};

/** The manifest's file references must all exist in the output. */
export function manifestFiles(manifest: unknown): string[] {
  const m = manifest as {
    background?: { service_worker?: string };
    action?: { default_popup?: string };
    options_page?: string;
    content_scripts?: { js?: string[] }[];
  };
  return [m.background?.service_worker, m.action?.default_popup, m.options_page, ...(m.content_scripts ?? []).flatMap((c) => c.js ?? [])].filter((f): f is string => typeof f === "string");
}

/** The test-only autostart variant: its own name and folder, so it is never mistaken for the product build. `hostedOrigin`: a hosted build for that origin. */
export type BuildOptions = { readonly testAutostart?: boolean; readonly hostedOrigin?: string | null };

const LOCAL_HOST_PERMISSION = "http://127.0.0.1:4317/*";

/** AFTERCLASS_EXT_BACKEND: unset or empty is a local build; set, a bare https origin, or http to a loopback host for tests. */
export function hostedOriginFrom(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AFTERCLASS_EXT_BACKEND must be an origin such as https://useafterclass.com, got "${value}"`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.origin !== value || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new Error(`AFTERCLASS_EXT_BACKEND must be a bare https origin such as https://useafterclass.com, got "${value}"`);
  }
  return url.origin;
}

type Manifest = Record<string, unknown> & { name: string; host_permissions: string[] };

/** A hosted build reaches its backend instead of the local one, and only that backend's pages may hand it a connect code. */
export function hostedManifest(manifest: Manifest, origin: string): Manifest {
  return {
    ...manifest,
    host_permissions: manifest.host_permissions.map((p) => (p === LOCAL_HOST_PERMISSION ? `${origin}/*` : p)),
    externally_connectable: { matches: [`${origin}/*`] },
  };
}

export async function buildExtension(outDir: string, options: BuildOptions = {}): Promise<void> {
  const testAutostart = options.testAutostart === true;
  const hostedOrigin = options.hostedOrigin ?? null;
  const out = resolve(ROOT, outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const { out: name, entry, format } of ENTRIES) {
    const result = await Bun.build({
      entrypoints: [join(SRC, entry)],
      outdir: out,
      naming: name,
      target: "browser",
      format,
      minify: false,
      sourcemap: "linked",
      plugins: [keepExtensionOnly],
      define: { __AFTERCLASS_TEST_AUTOSTART__: String(testAutostart), __AFTERCLASS_HOSTED_ORIGIN__: JSON.stringify(hostedOrigin) },
      throw: false,
    });
    if (!result.success) throw new Error(`build of ${entry} failed:\n${result.logs.map(String).join("\n")}`);
  }

  for (const { from, to } of STATIC_FILES) cpSync(join(SRC, from), join(out, to));
  if (testAutostart || hostedOrigin !== null) {
    let manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;
    if (testAutostart) manifest.name = "After Class (TEST autostart)";
    if (hostedOrigin !== null) manifest = hostedManifest(manifest, hostedOrigin);
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

  const missing = manifestFiles(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).filter((f) => !existsSync(join(out, f)));
  if (missing.length > 0) throw new Error(`manifest references files that were not built: ${missing.join(", ")}`);

  console.log(`built ${readdirSync(out).filter((f) => !f.endsWith(".map")).join(", ")} into ${out}`);

  const copyTo = process.env.AFTERCLASS_EXT_OUT;
  if (copyTo) copyBuild(out, resolve(copyTo));
}

/** Replaces a previous build at `dest`. Refuses a non-empty directory that is not one, so a mistyped path cannot be wiped. */
export function copyBuild(from: string, dest: string): void {
  if (existsSync(dest) && readdirSync(dest).length > 0 && !existsSync(join(dest, "manifest.json"))) {
    throw new Error(`AFTERCLASS_EXT_OUT ${dest} is not empty and holds no manifest.json; refusing to overwrite it`);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(from, dest, { recursive: true });
  writeFileSync(join(dest, ".afterclass-build"), `${new Date().toISOString()}\n`);
  console.log(`copied the build to ${dest}`);
}

if (import.meta.main) {
  const testAutostart = process.env.AFTERCLASS_TEST_AUTOSTART === "1";
  const hostedOrigin = hostedOriginFrom(process.env.AFTERCLASS_EXT_BACKEND);
  await buildExtension(testAutostart ? "dist/extension-test-autostart" : "dist/extension", { testAutostart, hostedOrigin });
}
