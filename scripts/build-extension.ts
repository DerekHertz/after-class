/**
 * `bun run build:ext` (W2). Bun.build per entry (content, main-world, worker,
 * popup, options), target "browser", minify off (inspectable), sourcemap linked.
 * Copies manifest.json and the popup/options HTML to dist/extension/. Fails if
 * any entry's bundle graph contains src/backend/ or a node:/bun: import.
 *
 * Content scripts must be classic scripts (iife). The worker, popup and options
 * are modules, which also lets the popup and options pages use top-level await.
 *
 * AFTERCLASS_EXT_OUT=<dir> also copies the finished build there, for loading
 * unpacked from Windows Chrome (it does not load extensions reliably from \\wsl$).
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

export async function buildExtension(outDir: string): Promise<void> {
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
      throw: false,
    });
    if (!result.success) throw new Error(`build of ${entry} failed:\n${result.logs.map(String).join("\n")}`);
  }

  for (const { from, to } of STATIC_FILES) cpSync(join(SRC, from), join(out, to));

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

if (import.meta.main) await buildExtension("dist/extension");
