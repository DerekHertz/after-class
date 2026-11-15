import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INLINE_LIMIT, buildApp, bundledPackages } from "../scripts/build-app";
import { FRONT_ROW_ROOMS } from "../src/app/room/rooms";
import { parseAppearance } from "../src/app/appearance";
import { FULL_ROOM_QUERY, ROOM_ART_PREFIX } from "../src/shared/room-art";
import type { RoomArtTable } from "../src/shared/room-art";
import { HASHED_APP_FILE } from "../src/backend/http";
import { tmpDir } from "./tmp";

describe("the review app bundle", () => {
  // Every test here only reads the bundle, so one build serves them all. A build per call made the
  // garbage-room test alone run 32 builds and overrun bun's 5 s timeout on a loaded machine.
  // tmpDir() cleans up after each test, so the shared build gets its own directory, removed after the block.
  let bundle: { out: string; files: string[]; css: string; js: string };
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "afterclass-build-app-"));
    await buildApp(out);
    const files = readdirSync(out);
    const read = (suffix: string) => readFileSync(join(out, files.find((f) => f.endsWith(suffix))!), "utf8");
    bundle = { out, files, css: read(".css"), js: read(".js") };
  }, 30_000);
  afterAll(() => {
    if (bundle) rmSync(bundle.out, { recursive: true, force: true });
  });
  const built = () => bundle;

  test("the JavaScript is minified", () => {
    // roomStyle is a top-level function in src/app/front-row.tsx. Only an unminified bundle still carries its name.
    expect(built().js).not.toContain("roomStyle");
  });

  test("the stylesheet inlines no font or art as a data: URI", () => {
    const { css } = built();
    const sizes = [...css.matchAll(/url\((["']?)data:[^;]+;base64,([A-Za-z0-9+/=]+)\1\)/g)].map((m) => m[2]!.length);
    expect(sizes.filter((n) => n > INLINE_LIMIT)).toEqual([]);
    expect(css.length).toBeLessThan(200_000);
  });

  test("every font and plate the stylesheet names is a file in the bundle", () => {
    const { out, css } = built();
    const urls = [...css.matchAll(/url\(["']?(\/app\/[^"')]+)["']?\)/g)].map((m) => m[1]!.slice("/app/".length));
    expect(urls.filter((u) => u.endsWith(".ttf")).length).toBeGreaterThanOrEqual(6);
    expect(urls.filter((u) => /^pixelify-sans-[a-z0-9]{8}\.ttf$/.test(u))).toHaveLength(1);
    expect(urls.filter((u) => !existsSync(join(out, u)))).toEqual([]);
  });

  test("every stylesheet and script the page loads is a file in the bundle", () => {
    const { out } = built();
    const page = readFileSync(join(out, "index.html"), "utf8");
    const loaded = [...page.matchAll(/<(?:link rel="stylesheet"|script)[^>]* (?:href|src)="\/app\/([^"]+)"/g)].map((m) => m[1]!);
    expect(loaded.map((f) => f.split(".").pop()).sort()).toEqual(["css", "js"]);
    expect(loaded.filter((f) => !existsSync(join(out, f)))).toEqual([]);
  });

  test("the signed-out screen's two fonts are preloaded by the page and hidden, not swapped, until they arrive", () => {
    const { out, css } = built();
    const page = readFileSync(join(out, "index.html"), "utf8");
    const preloaded = [...page.matchAll(/<link rel="preload" href="\/app\/([^"]+\.ttf)" as="font" type="font\/ttf" crossorigin>/g)].map((m) => m[1]!);
    expect(preloaded.map((f) => f.replace(/-[a-z0-9]{8}\.ttf$/, ""))).toEqual(["pixelify-sans", "dm-sans-400"]);
    for (const file of preloaded) {
      expect(existsSync(join(out, file))).toBe(true);
      const face = css.match(new RegExp(`@font-face\\{[^}]*${file}[^}]*\\}`))?.[0];
      expect(face).toContain("font-display:block");
    }
  });

  describe("the room art the page names", () => {
    /** The page's own script, run against a page that has the saved room and the address given. */
    function preloaded(saved: string | null, pathname: string, full = true): { table: RoomArtTable; hrefs: string[] } {
      const { out } = built();
      const page = readFileSync(join(out, "index.html"), "utf8");
      const json = page.match(/<script type="application\/json" id="room-art">(.*?)<\/script>/)![1]!;
      const script = page.match(/<script>(.*?)<\/script>/)![1]!;
      const links: { rel?: string; as?: string; href?: string }[] = [];
      const document = { getElementById: () => ({ textContent: json }), createElement: () => ({}), head: { appendChild: (l: object) => links.push(l) } };
      const matchMedia = (query: string) => { expect(query).toBe(FULL_ROOM_QUERY); return { matches: full }; };
      new Function("document", "localStorage", "location", "matchMedia", script)(document, { getItem: () => saved }, { pathname }, matchMedia);
      expect(links.every((l) => l.rel === "preload" && l.as === "image")).toBe(true);
      return { table: JSON.parse(json) as RoomArtTable, hrefs: links.map((l) => l.href!) };
    }

    test("every file in the table is in the bundle, each room's review starts with its background, and every extra a room draws is in it", () => {
      const { out } = built();
      const { table } = preloaded(null, "/app/");
      const urls = [...Object.values(table.rooms).flatMap((r) => [r.plate, ...r.layers, ...r.compact]), ...table.shared];
      expect(urls.filter((u) => !existsSync(join(out, u.slice("/app/".length))))).toEqual([]);
      for (const [scene, prefix] of Object.entries(ROOM_ART_PREFIX)) {
        const room = table.rooms[scene]!;
        expect(room.layers[0]).toMatch(new RegExp(`^/app/${prefix}-background-[a-z0-9]{8}\\.webp$`));
        expect(room.compact).toEqual([room.layers[0]!]);
        expect(room.plate).toMatch(new RegExp(`^/app/${scene}-[a-z0-9]{8}\\.webp$`));
        for (const extra of FRONT_ROW_ROOMS[scene as keyof typeof FRONT_ROW_ROOMS].extras) expect(room.layers.some((u) => u.startsWith(`/app/${prefix}-${extra.name}-`))).toBe(true);
      }
    });

    test("a page that is not a review preloads the saved room's plate, and a review preloads that room's layers, background first", () => {
      const harbor = JSON.stringify({ scene: "study-bench" });
      const home = preloaded(harbor, "/app/");
      expect(home.hrefs).toEqual([home.table.rooms["study-bench"]!.plate]);
      const review = preloaded(harbor, "/app/review/rvw_abc");
      expect(review.hrefs).toEqual([...review.table.rooms["study-bench"]!.layers]);
      expect(preloaded(harbor, "/app/reviews").hrefs).toEqual([home.table.rooms["study-bench"]!.plate]);
    });

    test("a phone or a short window, whose layout draws only the background, preloads only that", () => {
      const harbor = JSON.stringify({ scene: "study-bench" });
      const compact = preloaded(harbor, "/app/review/rvw_abc", false);
      expect(compact.hrefs).toEqual([...compact.table.rooms["study-bench"]!.compact]);
      expect(compact.hrefs).toHaveLength(1);
      expect(preloaded(harbor, "/app/", false).hrefs).toEqual([compact.table.rooms["study-bench"]!.plate]);
    });

    test("with no saved room, or one the app would not accept, the default room's art is preloaded", () => {
      const garbage = [null, "not json", "null", "[]", "5", "{}", JSON.stringify({ scene: "attic" }), JSON.stringify({ scene: "constructor" }), JSON.stringify({ scene: "__proto__" }),
        JSON.stringify({ scene: "toString" }), JSON.stringify({ scene: "hasOwnProperty" }), JSON.stringify({ scene: ["study-bench"] }), JSON.stringify({ scene: { toString: "study-bench" } }), JSON.stringify({ scene: 7 }), JSON.stringify({ scene: null }), '{"__proto__":{"scene":"study-bench"}}'];
      for (const saved of garbage) {
        const { table, hrefs } = preloaded(saved, "/app/");
        expect({ saved, hrefs }).toEqual({ saved, hrefs: [table.rooms["last-desk"]!.plate] });
        const review = preloaded(saved, "/app/review/rvw_abc");
        expect({ saved, hrefs: review.hrefs }).toEqual({ saved, hrefs: [...table.rooms["last-desk"]!.layers] });
        expect(review.hrefs.every((h) => h.startsWith("/app/"))).toBe(true);
        expect({ saved, scene: parseAppearance(saved).scene }).toEqual({ saved, scene: "last-desk" });
      }
    });
  });

  test("every file but the page and the notices carries a content hash in its name, so a long cache lifetime is safe", () => {
    const { files } = built();
    expect(files.filter((f) => f !== "index.html" && f !== "asset-notices.txt" && !/-[a-z0-9]{8}\.[a-z]+$/.test(f))).toEqual([]);
  });

  test("bundledPackages names each npm package once, scoped ones included", () => {
    expect(bundledPackages(["/r/node_modules/react/index.js", "/r/node_modules/react/cjs/a.js", "/r/node_modules/@scope/pkg/x.js", "/r/src/app/main.tsx"])).toEqual(["@scope/pkg", "react"]);
  });

  test("the shipped notices credit Meshy for the companion frames under CC BY 4.0, beside the font, icon and bundled package licenses", () => {
    const { out } = built();
    const notices = readFileSync(join(out, "asset-notices.txt"), "utf8");
    for (const name of ["Feather icons", "Young Serif", "DM Sans", "Pixelify Sans", "Companion animation frames", "react", "react-dom", "scheduler", "zod"]) expect(notices).toContain(`${name}\n\n`);
    expect(notices).toContain("Credit: Meshy (https://www.meshy.ai)");
    expect(notices).toContain("https://creativecommons.org/licenses/by/4.0/");
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
      renameSync(join(art, "harbor-lamp.webp"), join(art, "harbor-light.webp"));
      const css = join(root, "src/app/front-row.css");
      writeFileSync(css, readFileSync(css, "utf8").replace("harbor-lamp.webp", "harbor-light.webp"));
    }],
    ["an image too large to inline is renamed with the same bytes", (root) => {
      const art = join(root, "src/app/assets/companions-v3");
      renameSync(join(art, "pip.webp"), join(art, "pip-large.webp"));
      const css = join(root, "src/app/hd-companion.css");
      writeFileSync(css, readFileSync(css, "utf8").replace("companions-v3/pip.webp", "companions-v3/pip-large.webp"));
    }],
    ["an image the stylesheet inlines changes its bytes", (root) => appendFileSync(join(root, "src/app/assets/front-row-v2/harbor-lamp.webp"), "\0")],
    ["an image too large to inline changes its bytes", (root) => appendFileSync(join(root, "src/app/assets/companions-v3/pip.webp"), "\0")],
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
