// scripts/build-extension.ts -- `bun run build:ext`. Bun.build per entry (content, caption-hook, background, popup, options),
// target 'browser', format 'esm' (iife for content scripts: they are not modules), minify off (inspectable), sourcemap 'linked'.
// Copies manifest.json + popup.html + options.html to dist/extension/. Fails the build if the bundle graph of ANY extension entry contains
// a module under src/backend/ or a node:/bun: import (test/architecture.test.ts asserts the same statically).
export async function buildExtension(outDir: string): Promise<void> {
  throw new Error("not implemented");
}
