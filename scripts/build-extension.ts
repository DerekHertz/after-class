/**
 * `bun run build:ext` (W2). Bun.build per entry (content, main-world, worker,
 * popup, options), target "browser", minify off (inspectable), sourcemap linked.
 * Copies manifest.json and the popup/options HTML to dist/extension/. Fails if
 * any entry's bundle graph contains src/backend/ or a node:/bun: import.
 */
export async function buildExtension(outDir: string): Promise<void> {
  throw new Error("not implemented");
}

if (import.meta.main) await buildExtension("dist/extension");
