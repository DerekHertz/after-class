import { resolve, join, extname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist/ui-preview");
mkdirSync(out, { recursive: true });
const result = await Bun.build({ entrypoints: [join(import.meta.dir, "ui-preview/index.html")], outdir: out, target: "browser", publicPath: "/", throw: false });
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
writeFileSync(join(out, "preview-build.json"), JSON.stringify({ fixture: true, builtAt: new Date().toISOString() }));
if (!process.argv.includes("--build-only")) {
  const port = Number(process.env.AFTERCLASS_PREVIEW_PORT ?? 8770);
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const filePath = resolve(out, `.${path}`);
      if (filePath !== out && !filePath.startsWith(`${out}/`)) return new Response("Not found", { status: 404 });
      const file = Bun.file(filePath);
      if (extname(path) && await file.exists()) return new Response(file);
      if (extname(path)) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(join(out, "index.html")));
    },
  });
  console.log(`Deterministic UI fixtures only. No providers. http://127.0.0.1:${server.port}`);
}
