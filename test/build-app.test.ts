import { describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { INLINE_LIMIT, buildApp } from "../scripts/build-app";
import { HASHED_APP_FILE } from "../src/backend/http";
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

  test("every stylesheet and script the page loads is a file in the bundle", async () => {
    const { out } = await built();
    const page = readFileSync(join(out, "index.html"), "utf8");
    const loaded = [...page.matchAll(/<(?:link rel="stylesheet"|script)[^>]* (?:href|src)="\/app\/([^"]+)"/g)].map((m) => m[1]!);
    expect(loaded.map((f) => f.split(".").pop()).sort()).toEqual(["css", "js"]);
    expect(loaded.filter((f) => !existsSync(join(out, f)))).toEqual([]);
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

describe("a file name the server caches for a year", () => {
  const REPO = resolve(import.meta.dir, "..");

  /** A copy of the app's sources that a test can edit, built into a fresh directory each time. */
  function workspace() {
    const root = tmpDir("afterclass-build-app-src-");
    for (const dir of ["src/app", "src/shared"]) cpSync(join(REPO, dir), join(root, dir), { recursive: true });
    for (const file of ["package.json", "tsconfig.json"]) cpSync(join(REPO, file), join(root, file));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    let builds = 0;
    const build = async () => {
      const out = join(root, `dist-${builds++}`);
      await buildApp(out, root);
      return new Map(readdirSync(out).filter((f) => HASHED_APP_FILE.test(f)).map((f) => [f, readFileSync(join(out, f))]));
    };
    return { root, build };
  }

  /** A browser holding a file from release A asks for that name again in release B, so a name must never stand for two different files. */
  const edits: [string, (root: string) => void][] = [
    ["an image is renamed with the same bytes", (root) => {
      const art = join(root, "src/app/assets/front-row-v2");
      renameSync(join(art, "harbor-lamp.png"), join(art, "harbor-light.png"));
      const css = join(root, "src/app/front-row.css");
      writeFileSync(css, readFileSync(css, "utf8").replace("harbor-lamp.png", "harbor-light.png"));
    }],
    ["an image too large to inline is renamed with the same bytes", (root) => {
      const art = join(root, "src/app/assets/scenes-v2");
      renameSync(join(art, "bell.png"), join(art, "chime.png"));
      const css = join(root, "src/app/reference.css");
      writeFileSync(css, readFileSync(css, "utf8").replace("bell.png", "chime.png"));
    }],
    ["an image the stylesheet inlines changes its bytes", (root) => appendFileSync(join(root, "src/app/assets/front-row-v2/harbor-lamp.png"), "\0")],
    ["an image too large to inline changes its bytes", (root) => appendFileSync(join(root, "src/app/assets/scenes-v2/bell.png"), "\0")],
    ["a stylesheet rule changes", (root) => appendFileSync(join(root, "src/app/completion.css"), "\n.release-probe { order: 7; }\n")],
    ["the script changes", (root) => appendFileSync(join(root, "src/app/main.tsx"), "\nconsole.info('release-probe');\n")],
  ];

  for (const [name, edit] of edits) {
    test(`keeps its bytes across releases when ${name}`, async () => {
      const { root, build } = workspace();
      const before = await build();
      edit(root);
      const after = await build();
      expect([...after.keys()].filter((f) => !before.has(f)).length).toBeGreaterThan(0);
      const clashes = [...before.keys()].filter((f) => after.has(f) && !before.get(f)!.equals(after.get(f)!));
      expect(clashes).toEqual([]);
    });
  }
});
