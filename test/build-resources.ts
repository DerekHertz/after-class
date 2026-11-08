import { readFileSync, realpathSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Follow page and stylesheet references using the same base URLs as a browser. */
export function packagedResources(directory: string, pages: readonly string[]): ReadonlySet<string> {
  const root = realpathSync(directory);
  const files = new Set<string>();
  function visit(url: URL): void {
    if (url.protocol !== "file:" || url.host !== "") throw new Error(`Non-local resource: ${url.href}`);
    const file = fileURLToPath(url);
    if (!file.startsWith(root + sep)) throw new Error(`Resource escapes build: ${url.href}`);
    const actual = realpathSync(file);
    if (!actual.startsWith(root + sep)) throw new Error(`Resource escapes build through a symlink: ${url.href}`);
    const name = relative(root, actual);
    if (files.has(name)) return;
    files.add(name);
    const extension = extname(actual);
    if (extension !== ".html" && extension !== ".css") return;
    const content = readFileSync(actual, "utf8");
    const pattern = extension === ".html"
      ? /(?:href|src)\s*=\s*["']([^"']+)["']/g
      : /(?:url\(\s*["']?([^'"\s)]+)["']?\s*\)|@import\s+["']([^"']+)["'])/g;
    for (const match of content.matchAll(pattern)) {
      const target = match[1] ?? match[2];
      if (target !== undefined) visit(new URL(target, url));
    }
  }
  for (const page of pages) visit(pathToFileURL(resolve(root, page)));
  return files;
}
