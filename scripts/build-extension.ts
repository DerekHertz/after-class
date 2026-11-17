/**
 * `bun run build:ext` (W2). Bun.build per entry (content, main-world, worker,
 * popup, options), target "browser", minify off (inspectable), sourcemap linked.
 * The built manifest's version is package.json's, so the extension and the app release together. The source
 * manifest's "0.0.0" is never shipped.
 *
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
 *
 * A hosted build also carries the public key in src/extension/hosted-key.txt as the manifest's `key`, so Chrome gives
 * it the same id, HOSTED_EXTENSION_ID, on every machine that loads it. The server allows only that id, through the
 * beta's `extension_id` Terraform variable. The private key is kept outside the repo and is needed only to pack a .crx.
 *
 * AFTERCLASS_EXT_STORE=1, with AFTERCLASS_EXT_BACKEND, makes the Chrome Web Store build: the hosted build without the
 * manifest `key` (the store refuses a first upload that has one and assigns its own id), without .map files or
 * sourcemap comments, and zipped to dist/after-class-extension-<manifest version>.zip with the system `zip`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  ...[16, 32, 48, 128].map((n) => ({ from: `icons/icon-${n}.png`, to: `icons/icon-${n}.png` })),
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
export type BuildOptions = { readonly testAutostart?: boolean; readonly hostedOrigin?: string | null; readonly store?: boolean };

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

/** The app's release version from package.json. The extension ships with the same version as the app it talks to. */
export const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

/** Chrome takes one to four dot-separated integers from 0 to 65535, so a version such as "1.2.3-beta" is refused here, not by the store. */
export function extensionVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4 || !parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535)) {
    throw new Error(`package.json version "${version}" is not a Chrome extension version: one to four dot-separated integers from 0 to 65535`);
  }
  return version;
}

type Manifest = Record<string, unknown> & { name: string; host_permissions: string[] };

/** The hosted build's public key, base64 DER, as Chrome reads a manifest `key`. */
export const HOSTED_KEY = readFileSync(join(SRC, "hosted-key.txt"), "utf8").trim();

/** Chrome's extension id for a manifest key: the first 128 bits of its SHA-256, each hex digit written as a to p. */
export function extensionIdFromKey(key: string): string {
  const hex = new Bun.CryptoHasher("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
}

export const HOSTED_EXTENSION_ID = extensionIdFromKey(HOSTED_KEY);

/** A hosted build reaches its backend instead of the local one, and only that backend's pages may hand it a connect code. */
export function hostedManifest(manifest: Manifest, origin: string, options: { readonly withKey?: boolean } = {}): Manifest {
  const hosted: Manifest = {
    ...manifest,
    host_permissions: manifest.host_permissions.map((p) => (p === LOCAL_HOST_PERMISSION ? `${origin}/*` : p)),
    externally_connectable: { matches: [`${origin}/*`] },
    key: HOSTED_KEY,
  };
  if (options.withKey === false) delete hosted.key;
  return hosted;
}

/** AFTERCLASS_EXT_STORE: "1" is a store build, unset or empty is not. It needs a hosted origin. */
export function storeFrom(value: string | undefined, hostedOrigin: string | null): boolean {
  if (value === undefined || value === "") return false;
  if (value !== "1") throw new Error(`AFTERCLASS_EXT_STORE must be 1 or unset, got "${value}"`);
  if (hostedOrigin === null) throw new Error("AFTERCLASS_EXT_STORE=1 needs AFTERCLASS_EXT_BACKEND, such as https://useafterclass.com");
  return true;
}

/** Strips sourcemap comments from the built scripts and deletes the .map files, so the store package ships neither. */
function stripSourcemaps(out: string): void {
  for (const f of readdirSync(out)) {
    if (f.endsWith(".map")) rmSync(join(out, f));
    else if (f.endsWith(".js")) {
      const text = readFileSync(join(out, f), "utf8");
      writeFileSync(join(out, f), text.replace(/^\/\/# sourceMappingURL=.*\n?/gm, ""));
    }
  }
}

/** Zips the build's contents (manifest.json at the zip's root) to `zipPath` with the system `zip`. */
export async function zipBuild(dir: string, zipPath: string): Promise<void> {
  if (Bun.which("zip") === null) throw new Error("the store build needs the `zip` command, which is not installed. Install it (for example `sudo apt install zip`) and run the build again");
  rmSync(zipPath, { force: true });
  const proc = Bun.spawn(["zip", "-q", "-r", "-X", zipPath, "."], { cwd: dir, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`zip failed to write ${zipPath}`);
}

export async function buildExtension(outDir: string, options: BuildOptions = {}): Promise<void> {
  const testAutostart = options.testAutostart === true;
  const hostedOrigin = options.hostedOrigin ?? null;
  const store = options.store === true;
  if (store && hostedOrigin === null) throw new Error("a store build needs a hosted origin");
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
  {
    let manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;
    manifest.version = extensionVersion(PACKAGE_VERSION);
    if (testAutostart) manifest.name = "After Class (TEST autostart)";
    if (hostedOrigin !== null) manifest = hostedManifest(manifest, hostedOrigin, { withKey: !store });
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

  const missing = manifestFiles(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).filter((f) => !existsSync(join(out, f)));
  if (missing.length > 0) throw new Error(`manifest references files that were not built: ${missing.join(", ")}`);

  if (store) stripSourcemaps(out);

  console.log(`built ${readdirSync(out).filter((f) => !f.endsWith(".map")).join(", ")} into ${out}`);
  if (store) {
    const version = (JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { version: string }).version;
    const zipPath = join(dirname(out), `after-class-extension-${version}.zip`);
    await zipBuild(out, zipPath);
    console.log(`store build for ${hostedOrigin}, no manifest key; the store assigns the id. Upload ${zipPath}`);
  } else if (hostedOrigin !== null) console.log(`hosted build for ${hostedOrigin}, extension id ${HOSTED_EXTENSION_ID}`);

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
  const store = storeFrom(process.env.AFTERCLASS_EXT_STORE, hostedOrigin);
  await buildExtension(testAutostart ? "dist/extension-test-autostart" : "dist/extension", { testAutostart, hostedOrigin, store });
}
