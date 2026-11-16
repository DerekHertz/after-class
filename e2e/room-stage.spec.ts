import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, SCENES } from "../src/app/appearance";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import { ROOM_ART_PREFIX } from "../src/shared/room-art";
import { decodePng } from "../test/png";

const scenes = Object.keys(SCENES) as SceneId[];

/** Opens the review in `scene`. The companion is hidden, so these tests see the room's layers alone; e2e/companion-stage.spec.ts covers it. */
async function openRoom(page: Page, scene: SceneId) {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene, visible: false } });
  await page.goto("/?scenario=review&clean=1");
  await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();
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

/** The room's plate as one CSS-drawn picture at the place the layout gives it, for the reference rendering. */
function cssPlate(scene: SceneId, window: { width: number; height: number }) {
  const layout = layoutRoom(scene, window, "full");
  if (layout.composition !== "full") throw new Error("a desktop window lays out the full room");
  return { name: `${ROOM_ART_PREFIX[scene]}-wide`, rect: layout.plate };
}

for (const scene of scenes) {
  for (const size of [{ width: 1440, height: 900 }, { width: 2000, height: 1100 }]) {
    test(`in ${scene} at ${size.width}x${size.height} the canvas draws the plate where and as CSS draws it`, async ({ page }, info) => {
      test.skip(info.project.name === "narrow", "a phone draws the backdrop, not the plate");
      await page.setViewportSize(size);
      await openRoom(page, scene);
      await page.addStyleTag({ content: "body * { visibility: hidden !important } .front-row-canvas { visibility: visible !important } .scene-shell::before { display: none !important }" });
      const decode = async () => decodePng(await page.screenshot(), "screenshot");
      const canvas = await decode();
      const plate = cssPlate(scene, size);
      const urls = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.endsWith(".webp")));
      const url = urls.find((u) => new RegExp(`/${plate.name}-[a-z0-9]{8}\\.webp$`).test(u))!;
      await page.evaluate(({ rect, url }) => {
        document.querySelector<HTMLElement>(".front-row-canvas")!.style.display = "none";
        const div = document.createElement("div");
        div.style.cssText = `position: fixed; box-sizing: border-box; visibility: visible !important; z-index: 99; left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; height: ${rect.height}px; background: url(${url}) no-repeat 0 0 / 100% 100%`;
        document.body.append(div);
        const image = new Image();
        image.src = url;
        return image.decode();
      }, { ...plate, url });
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const css = await decode();
      // The plate file is twice the plate's pixels and both paths shrink it smoothly. In Chrome they draw the same pixels,
      // and the same plate one device pixel out of place differs by 3.5 levels on average, so the limits catch a shift.
      let total = 0;
      let far = 0;
      for (let i = 0; i < css.rgba.length; i += 4) {
        const d = Math.max(...[0, 1, 2].map((c) => Math.abs(css.rgba[i + c]! - canvas.rgba[i + c]!)));
        total += d;
        if (d > 32) far++;
      }
      const pixels = css.width * css.height;
      expect({ scene, size, mean: total / pixels < MEAN_LIMIT, far: far / pixels < FAR_LIMIT }).toEqual({ scene, size, mean: true, far: true });
    });
  }
}

const MEAN_LIMIT = 0.5;
const FAR_LIMIT = 0.001;

test("the room's words wait for its plate, and a plate that fails does not hold them", async ({ page }, info) => {
  test.skip(info.project.name === "narrow", "a phone shows its words over the page's own backdrop");
  let release = () => {};
  const held = new Promise<void>((done) => { release = done; });
  await page.route(/\/harbor-wide-[a-z0-9]{8}\.webp$/, async (route) => { await held; await route.continue(); });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "study-bench" } });
  await page.goto("/?scenario=review&clean=1");
  const board = page.locator('.front-row-area[data-area="board"]');
  await expect(board).toContainText("What would have to change");
  await page.waitForTimeout(300);
  expect(await board.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
  release();
  await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();
  expect(await board.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
});

for (const [unusable, init] of [
  ["has no 2D context", () => { HTMLCanvasElement.prototype.getContext = () => null; }],
  ["cannot observe its size", () => { delete (window as { ResizeObserver?: unknown }).ResizeObserver; }],
] as const) {
  test(`a canvas that ${unusable} shows the room's words over the page's backdrop`, async ({ page }, info) => {
    test.skip(info.project.name === "narrow", "a phone shows its words over the page's own backdrop");
    await page.addInitScript(init);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "study-bench" } });
    await page.goto("/?scenario=review&clean=1");
    const board = page.locator('.front-row-area[data-area="board"]');
    await expect(board).toContainText("What would have to change");
    await expect.poll(() => board.evaluate((node) => getComputedStyle(node).opacity), { timeout: 3000 }).toBe("1");
    expect(await page.locator(".scene-shell").evaluate((node) => getComputedStyle(node, "::before").content)).not.toBe("none");
  });
}

test("the setup's words wait for the room's pictures too", async ({ page }, info) => {
  test.skip(info.project.name === "narrow", "a phone shows its words over the page's own backdrop");
  let release = () => {};
  const held = new Promise<void>((done) => { release = done; });
  await page.route(/\/harbor-wide-[a-z0-9]{8}\.webp$/, async (route) => { await held; await route.continue(); });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "study-bench" } });
  await page.goto("/?scenario=fuzzy-checklist&clean=1");
  const sections = page.locator(".setup-choices, .setup-start");
  await expect(page.locator(".setup-choices")).toContainText("Choose a starting point");
  await page.waitForTimeout(300);
  const opacities = () => sections.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).opacity));
  expect(await opacities()).toEqual(["0", "0"]);
  release();
  await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();
  expect(await opacities()).toEqual(["1", "1"]);
});

test("without a device-pixel box to observe, the stage still follows a change of pixel ratio alone", async ({ page }, info) => {
  test.skip(info.project.name === "narrow", "one window size is enough");
  // Safari observes only CSS boxes, which a move to a screen of another pixel ratio leaves the same size. Chrome's device
  // emulation changes the ratio without firing media query changes, so the test fires them for the queries that flipped.
  await page.addInitScript(() => {
    const observe = ResizeObserver.prototype.observe;
    ResizeObserver.prototype.observe = function (this: ResizeObserver, target: Element, options?: ResizeObserverOptions) {
      if (options?.box === "device-pixel-content-box") throw new TypeError("device-pixel-content-box is not a valid box");
      return observe.call(this, target, options);
    };
    const queries: { list: MediaQueryList; matched: boolean }[] = [];
    const match = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => { const list = match(query); queries.push({ list, matched: list.matches }); return list; };
    (window as unknown as { flipMedia: () => void }).flipMedia = () => {
      for (const query of queries.splice(0)) if (query.list.matches !== query.matched) query.list.dispatchEvent(new Event("change"));
    };
  });
  await openRoom(page, "last-desk");
  const { width, height } = info.project.use.viewport!;
  const store = () => page.locator(".front-row-canvas").evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height, devicePixelRatio]);
  expect(await store()).toEqual([width, height, 1]);
  const cdp = await page.context().newCDPSession(page);
  for (const ratio of [2, 1]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: ratio, mobile: false });
    await page.evaluate(() => (window as unknown as { flipMedia: () => void }).flipMedia());
    await expect.poll(store).toEqual([width * ratio, height * ratio, ratio]);
  }
});

test("a room the learner moved on from does not repaint the stage when its pictures arrive", async ({ page }, info) => {
  test.skip(info.project.name === "narrow", "the picker sits in the same place on both");
  let release = () => {};
  const held = new Promise<void>((done) => { release = done; });
  await page.route(/\/harbor-[a-z-]+-[a-z0-9]{8}\.webp$/, async (route) => { await held; await route.continue(); });
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    (window as unknown as { paints: number }).paints = 0;
    CanvasRenderingContext2D.prototype.clearRect = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof clear>) {
      (window as unknown as { paints: number }).paints++;
      return clear.apply(this, args);
    } as typeof clear;
  });
  await openRoom(page, "last-desk");
  const paints = () => page.evaluate(() => (window as unknown as { paints: number }).paints);
  const settled = async () => {
    let last = -1;
    await expect.poll(async () => { const now = await paints(); const still = now === last; last = now; return still; }, { intervals: [400] }).toBe(true);
    return last;
  };
  await page.getByText("Room & companion").click();
  await page.getByRole("button", { name: /Harbor Study Terrace/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /Lantern Canal Film Club/ }).click();
  const before = await settled();
  release();
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType("resource").filter((e) => /\/harbor-[a-z-]+-[a-z0-9]{8}\.webp$/.test(e.name)).length)).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(await paints()).toBe(before);
});

test("a room whose plate fails to load still shows its question and answer controls over the backdrop", async ({ page }, info) => {
  test.skip(info.project.name === "narrow", "the phone layout draws its backdrop without the plate");
  await page.route(/\/[a-z]+-wide-[a-z0-9]{8}\.webp$/, (route) => route.fulfill({ status: 404 }));
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "projection-booth", visible: false } });
  await page.goto("/?scenario=review&clean=1");
  await expect(page.locator(".front-row-canvas[data-stage=off]")).toBeAttached();
  await expect(page.locator(".front-row-heading")).toBeVisible();
  await expect(page.getByRole("button", { name: "Share my thinking" })).toBeVisible();
  // The canal's board carries navy ink, so it needs its cream fill behind it rather than the dark backdrop.
  const fill = await page.locator('.front-row-area[data-area="board"]').evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(fill).toBe("rgb(251, 225, 197)");
});
