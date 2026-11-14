import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { INLINE_LIMIT, buildApp } from "../scripts/build-app";
import { tmpDir } from "./tmp";

async function built() {
  const out = tmpDir("afterclass-build-app-");
  await buildApp(out);
  const files = readdirSync(out);
  const read = (suffix: string) => readFileSync(join(out, files.find((f) => f.endsWith(suffix))!), "utf8");
  return { out, files, css: read(".css"), js: read(".js") };
}

describe("the review app bundle", () => {
  test("the JavaScript is minified", async () => {
    // roomStyle is a top-level function in src/app/front-row.tsx. Only an unminified bundle still carries its name.
    expect((await built()).js).not.toContain("roomStyle");
  });

  test("the stylesheet inlines no font or art as a data: URI", async () => {
    const { css } = await built();
    const sizes = [...css.matchAll(/url\((["']?)data:[^;]+;base64,([A-Za-z0-9+/=]+)\1\)/g)].map((m) => m[2]!.length);
    expect(sizes.filter((n) => n > INLINE_LIMIT)).toEqual([]);
    expect(css.length).toBeLessThan(200_000);
  });

  test("every font and plate the stylesheet names is a file in the bundle", async () => {
    const { out, css } = await built();
    const urls = [...css.matchAll(/url\(["']?(\/app\/[^"')]+)["']?\)/g)].map((m) => m[1]!.slice("/app/".length));
    expect(urls.filter((u) => u.endsWith(".ttf")).length).toBeGreaterThanOrEqual(6);
    expect(urls.filter((u) => /^pixelify-sans-[a-z0-9]{8}\.ttf$/.test(u))).toHaveLength(1);
    expect(urls.filter((u) => !existsSync(join(out, u)))).toEqual([]);
  });

  test("the signed-out screen's two fonts are preloaded by the page and hidden, not swapped, until they arrive", async () => {
    const { out, css } = await built();
    const page = readFileSync(join(out, "index.html"), "utf8");
    const preloaded = [...page.matchAll(/<link rel="preload" href="\/app\/([^"]+\.ttf)" as="font" type="font\/ttf" crossorigin>/g)].map((m) => m[1]!);
    expect(preloaded.map((f) => f.replace(/-[a-z0-9]{8}\.ttf$/, ""))).toEqual(["pixelify-sans", "dm-sans-400"]);
    for (const file of preloaded) {
      expect(existsSync(join(out, file))).toBe(true);
      const face = css.match(new RegExp(`@font-face\\{[^}]*${file}[^}]*\\}`))?.[0];
      expect(face).toContain("font-display:block");
    }
  });

  test("every file but the page and the notices carries a content hash in its name, so a long cache lifetime is safe", async () => {
    const { files } = await built();
    expect(files.filter((f) => f !== "index.html" && f !== "asset-notices.txt" && !/-[a-z0-9]{8}\.[a-z]+$/.test(f))).toEqual([]);
  });
});
