/**
 * `bun run scripts/build-app.ts` (M3). Bundles the review app (src/app/index.html and what it imports) into
 * dist/app/ for `http.ts` to serve under /app/. `publicPath` is /app/ so asset URLs stay absolute and still
 * resolve when the SPA fallback answers a deep link such as /app/capture/<id>.
 */
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export async function buildApp(outDir: string): Promise<void> {
  const out = resolve(ROOT, outDir);
  rmSync(out, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/app/index.html")],
    outdir: out,
    target: "browser",
    publicPath: "/app/",
    minify: false,
    throw: false,
  });
  if (!result.success) throw new Error(`build of the review app failed:\n${result.logs.map(String).join("\n")}`);
  console.log(`built the review app into ${out}`);
}

if (import.meta.main) await buildApp("dist/app");
