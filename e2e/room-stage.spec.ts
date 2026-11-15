import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, SCENES } from "../src/app/appearance";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import type { NineSliceLayer, Rect } from "../src/app/room/layout";
import { FRONT_ROW_ROOMS, ROOM_ART } from "../src/app/room/rooms";
import type { Edges } from "../src/app/room/rooms";
import { ROOM_ART_PREFIX } from "../src/shared/room-art";
import { decodePng } from "../test/png";

const scenes = Object.keys(SCENES) as SceneId[];

async function openRoom(page: Page, scene: SceneId) {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene } });
  await page.goto("/?scenario=review&clean=1");
  await expect(page.locator(".front-row-canvas[data-painted]")).toBeAttached();
}

test.describe("the stage's backing store follows the device pixel ratio", () => {
  for (const dpr of [1, 2]) {
    test.describe(`at ${dpr}x`, () => {
      test.use({ deviceScaleFactor: dpr });
      test("the canvas fills the window behind the room and has one pixel per device pixel", async ({ page }) => {
        await openRoom(page, "last-desk");
        const sizes = async () => page.locator(".front-row-canvas").evaluate((canvas: HTMLCanvasElement) => {
          const r = canvas.getBoundingClientRect();
          return { css: [r.width, r.height], window: [innerWidth, innerHeight], store: [canvas.width, canvas.height], dpr: devicePixelRatio };
        });
        const first = await sizes();
        expect(first.css).toEqual(first.window);
        expect(first.store).toEqual(first.css.map((v) => Math.round(v * dpr)));
        await page.setViewportSize({ width: 1000, height: 700 });
        await expect.poll(sizes).toMatchObject({ store: [1000 * dpr, 700 * dpr] });
      });
    });
  }
});

test("a still room draws once, never while idle, and never while the tab is hidden", async ({ page }, info) => {
  await page.addInitScript(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    (window as unknown as { draws: number }).draws = 0;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof draw>) {
      (window as unknown as { draws: number }).draws++;
      return draw.apply(this, args);
    } as typeof draw;
  });
  await openRoom(page, "study-bench");
  const draws = () => page.evaluate(() => (window as unknown as { draws: number }).draws);
  const painted = await draws();
  expect(painted).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  expect(await draws()).toBe(painted);
  const setHidden = (hidden: boolean) => page.evaluate((hidden) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await setHidden(true);
  const size = info.project.use.viewport!;
  await page.setViewportSize({ width: size.width + 40, height: size.height });
  await page.waitForTimeout(500);
  expect(await draws()).toBe(painted);
  await setHidden(false);
  await expect.poll(draws).toBeGreaterThan(painted);
  const shown = await draws();
  await page.waitForTimeout(1000);
  expect(await draws()).toBe(shown);
});

/**
 * A PNG whose every pixel names its own position, x in red and the low half of green, y in blue and the high half, so a
 * screenshot says which source pixel each device pixel sampled.
 */
function codedPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, body: Uint8Array) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    out.set(body, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    raw[at] = x & 255;
    raw[at + 1] = ((x >> 8) & 15) | (((y >> 8) & 15) << 4);
    raw[at + 2] = y & 255;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

/** Each room layer's file name, as the bundle names it, with the size of the picture it holds. */
function layerSizes(scene: SceneId): Map<string, { width: number; height: number }> {
  const room = FRONT_ROW_ROOMS[scene];
  const prefix = ROOM_ART_PREFIX[scene];
  return new Map([
    [`${prefix}-background`, ROOM_ART.plate],
    [`${prefix}-board`, room.board.art.size], [`${prefix}-desk`, room.desk.art.size], [`${prefix}-mat`, room.mat.art.size],
    ...room.extras.map((e) => [`${prefix}-${e.name}`, { width: e.width, height: e.height }] as const),
  ]);
}

/** The room's layers as front-row.css drew them before the stage, back to front, for the reference rendering. */
function cssLayers(scene: SceneId, window: { width: number; height: number }) {
  const layout = layoutRoom(scene, window, "full");
  if (layout.composition !== "full") throw new Error("a desktop window lays out the full room");
  const room = FRONT_ROW_ROOMS[scene];
  const prefix = ROOM_ART_PREFIX[scene];
  const px = (e: Edges) => `${e.top}px ${e.right}px ${e.bottom}px ${e.left}px`;
  const image = (name: string, rect: Rect, z: number) => ({ name: `${prefix}-${name}`, rect, z, slice: null, border: null });
  const nine = (name: "board" | "desk" | "mat", layer: NineSliceLayer, z: number) => {
    const s = room[name].art.slice;
    return { name: `${prefix}-${name}`, rect: layer.rect, z, slice: `${s.top} ${s.right} ${s.bottom} ${s.left}`, border: px(layer.border) };
  };
  const { background, board, desk, mat, extras } = layout.layers;
  return [image("background", background, 0), nine("board", board, 2), nine("desk", desk, 5), ...extras.map((e) => image(e.name, e.rect, e.z)), nine("mat", mat, 6)];
}

for (const scene of scenes) {
  for (const size of [{ width: 1440, height: 900 }, { width: 1470, height: 1270 }]) {
    test(`in ${scene} at ${size.width}x${size.height} the canvas samples the same art pixels the CSS layers did`, async ({ page }, info) => {
      test.skip(info.project.name === "narrow", "the phone backdrop is drawn smooth, so its pixels do not name a source pixel");
      await page.setViewportSize(size);
      const sizes = layerSizes(scene);
      await page.route(/\/([a-z]+-[a-z-]+)-[a-z0-9]{8}\.webp$/, async (route) => {
        const stem = /\/([a-z]+-[a-z-]+)-[a-z0-9]{8}\.webp$/.exec(route.request().url())![1]!;
        const picture = sizes.get(stem);
        return picture ? route.fulfill({ body: codedPng(picture.width, picture.height), contentType: "image/png" }) : route.continue();
      });
      await openRoom(page, scene);
      await page.addStyleTag({ content: "body * { visibility: hidden !important } .front-row-canvas { visibility: visible !important } .scene-shell::before { display: none !important }" });
      const decode = async () => decodePng(await page.screenshot(), "screenshot");
      const canvas = await decode();
      const urls = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.endsWith(".webp")));
      const layers = cssLayers(scene, size).map((layer) => ({ ...layer, url: urls.find((u) => new RegExp(`/${layer.name}-[a-z0-9]{8}\\.webp$`).test(u))! }));
      await page.evaluate((layers) => {
        document.querySelector<HTMLElement>(".front-row-canvas")!.style.display = "none";
        const host = document.createElement("div");
        host.style.cssText = "position: fixed; inset: 0; visibility: visible !important; z-index: 99";
        for (const { rect, z, slice, border, url } of layers) {
          const div = document.createElement("div");
          div.style.cssText = `position: absolute; box-sizing: border-box; visibility: visible !important; image-rendering: pixelated; left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; height: ${rect.height}px; z-index: ${z}`;
          if (slice === null) div.style.background = `url(${url}) no-repeat 0 0 / 100% 100%`;
          else Object.assign(div.style, { borderStyle: "solid", borderWidth: border, borderImage: `url(${url}) ${slice} fill / ${border} / 0 stretch` });
          host.append(div);
        }
        document.body.append(host);
        return Promise.all(layers.map(({ url }) => { const i = new Image(); i.src = url; return i.decode(); }));
      }, layers);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const css = await decode();
      const at = (png: typeof css, i: number) => [png.rgba[i]! | ((png.rgba[i + 1]! & 15) << 8), png.rgba[i + 2]! | ((png.rgba[i + 1]! >> 4) << 8)];
      let differing = 0;
      let apart = 0;
      for (let i = 0; i < css.rgba.length; i += 4) {
        const [cx, cy] = at(css, i);
        const [sx, sy] = at(canvas, i);
        if (cx === sx && cy === sy) continue;
        differing++;
        if (Math.abs(cx! - sx!) > 1 || Math.abs(cy! - sy!) > 1) apart++;
      }
      // What is left are samples that fall exactly between two source pixels, which Chrome's CSS path and its canvas round
      // either way: 0.41 percent of the window at most across the rooms when this was written.
      expect({ scene, size, apart, share: differing / (css.width * css.height) < 0.006 }).toEqual({ scene, size, apart: 0, share: true });
    });
  }
}
