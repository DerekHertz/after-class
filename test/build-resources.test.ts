import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packagedResources } from "./build-resources";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(href = "styles/main.css") {
  const dir = mkdtempSync(join(tmpdir(), "afterclass-resources-"));
  directories.push(dir);
  mkdirSync(join(dir, "styles"));
  mkdirSync(join(dir, "fonts"));
  writeFileSync(join(dir, "popup.html"), `<link href='${href}'>`);
  writeFileSync(join(dir, "styles/main.css"), `@import './other.css'; @font-face { src: url('../fonts/pixel.ttf?v=1'); }`);
  writeFileSync(join(dir, "styles/other.css"), `@import url('./main.css');`);
  writeFileSync(join(dir, "fonts/pixel.ttf"), "fixture font");
  return dir;
}
describe("packaged resource references", () => {
  test("resolves nested CSS and fonts relative to their owner and terminates import cycles", () => {
    expect([...packagedResources(fixture(), ["popup.html"])].sort()).toEqual([
      "fonts/pixel.ttf", "popup.html", "styles/main.css", "styles/other.css",
    ]);
  });
  test.each(["https://example.com/a.css", "//example.com/a.css", "data:text/css,body{}", "../outside.css", "%2e%2e/outside.css"])("rejects a non-packaged reference: %s", (href) => {
    expect(() => packagedResources(fixture(href), ["popup.html"])).toThrow();
  });
  test("rejects missing resources", () => {
    expect(() => packagedResources(fixture("missing.css"), ["popup.html"])).toThrow();
  });
  test("rejects a symlink to another directory", () => {
    const dir = fixture("outside.css");
    const outside = fixture();
    symlinkSync(join(outside, "styles/main.css"), join(dir, "outside.css"));
    expect(() => packagedResources(dir, ["popup.html"])).toThrow(/symlink/);
  });
});
