import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, SCENES } from "../src/app/appearance";
import type { Appearance, SceneId } from "../src/app/appearance";
import { AMBIENT_FPS } from "../src/app/room/ambient";

const scenes = Object.keys(SCENES) as SceneId[];
type Counts = { specks: number; drawImage: number; clears: number; transforms: number; moved: number };

/** Counts what the stage draws, and every call that could rotate, scale or shift what it draws next. */
async function watchCanvas(page: Page) {
  await page.addInitScript(() => {
    const counts = { specks: 0, drawImage: 0, clears: 0, transforms: 0, moved: 0 };
    (window as unknown as { counts: typeof counts }).counts = counts;
    const proto = CanvasRenderingContext2D.prototype;
    const fill = proto.fillRect;
    proto.fillRect = function (this: CanvasRenderingContext2D, ...a: Parameters<typeof fill>) { counts.specks++; return fill.apply(this, a); };
    const clear = proto.clearRect;
    proto.clearRect = function (this: CanvasRenderingContext2D, ...a: Parameters<typeof clear>) { counts.clears++; return clear.apply(this, a); };
    const draw = proto.drawImage;
    proto.drawImage = function (this: CanvasRenderingContext2D, ...a: Parameters<typeof draw>) { counts.drawImage++; return draw.apply(this, a as never); } as typeof draw;
    for (const name of ["rotate", "scale", "translate", "transform", "resetTransform"] as const) {
      const original = proto[name] as (...a: unknown[]) => void;
      (proto as unknown as Record<string, unknown>)[name] = function (this: CanvasRenderingContext2D, ...a: unknown[]) { counts.transforms++; return original.apply(this, a); };
    }
    const set = proto.setTransform;
    proto.setTransform = function (this: CanvasRenderingContext2D, ...a: unknown[]) {
      const [x, y, z, w, e, f] = a as number[];
      if (!(x === 1 && y === 0 && z === 0 && w === 1 && e === 0 && f === 0)) counts.moved++;
      return (set as (...a: unknown[]) => void).apply(this, a);
    } as typeof set;
  });
}
const counts = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { counts: Counts }).counts }));

async function openRoom(page: Page, scene: SceneId, appearance: Partial<Appearance> = {}) {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene, ...appearance } });
  await page.goto("/?scenario=review&clean=1");
  await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();
}

const setHidden = (page: Page, hidden: boolean) => page.evaluate((hidden) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}, hidden);

/** Gives the stage's canvas no size, or its own again, as a layout that collapses its box would. */
const setCanvasSize = (page: Page, shown: boolean) => page.evaluate((shown) => {
  document.getElementById("no-size")?.remove();
  if (shown) return;
  const style = document.createElement("style");
  style.id = "no-size";
  style.textContent = ".front-row-canvas { width: 0 !important; height: 0 !important; }";
  document.head.append(style);
}, shown);

test.describe("with motion on", () => {
  test.use({ reducedMotion: "no-preference" });
  // The narrow project's 320 px window is a phone composition, which stays still (see "on a phone").
  test.beforeEach(async ({ page: _page }, info) => { test.skip(info.project.name === "narrow", "a phone-width window does not move"); });

  for (const scene of scenes) {
    test(`${scene} keeps drawing specks, and never rotates, scales or shifts the painted art`, async ({ page }) => {
      await watchCanvas(page);
      await openRoom(page, scene);
      const first = await counts(page);
      await page.waitForTimeout(1500);
      const later = await counts(page);
      expect(later.specks).toBeGreaterThan(first.specks);
      expect(later.drawImage).toBeGreaterThan(first.drawImage);
      expect(later.transforms).toBe(0);
      expect(later.moved).toBe(0);
    });
  }

  test("each step copies the room's still art in at most one picture per run between live draws", async ({ page }) => {
    await watchCanvas(page);
    for (const scene of scenes) {
      await openRoom(page, scene);
      await page.waitForTimeout(300);
      const first = await counts(page);
      await page.waitForTimeout(1000);
      const later = await counts(page);
      const steps = later.clears - first.clears;
      expect(steps).toBeGreaterThan(5);
      // The rooms' painted layers fall into at most four runs between their depths of specks, and the companion is one more
      // picture. Painted picture by picture, a step would make some thirty drawImage calls, nine for each nine-slice.
      expect((later.drawImage - first.drawImage) / steps).toBeLessThanOrEqual(5);
    }
  });

  test("the stage asks for one frame per step, even when a frame comes right after its timer", async ({ page }) => {
    // A vsync can land just after the stage's timer fires. Running every frame callback at once makes that the rule, so a
    // timer that fires before its step would paint the old step and ask for another frame.
    await page.addInitScript(() => {
      const frames: number[] = [];
      (window as unknown as { frames: number[] }).frames = frames;
      window.requestAnimationFrame = (callback) => {
        frames.push(performance.now());
        return window.setTimeout(() => callback(performance.now()), 0);
      };
    });
    // The companion stays hidden: its blinks may change the room between two steps.
    await openRoom(page, "last-desk", { visible: false });
    await page.waitForTimeout(2000);
    const steps = await page.evaluate((fps) => (window as unknown as { frames: number[] }).frames.map((at) => Math.floor((at / 1000) * fps)), AMBIENT_FPS);
    const moving = steps.slice(2);
    expect(moving.length).toBeGreaterThan(15);
    expect(new Set(moving).size).toBe(moving.length);
  });

  test("a hidden tab draws nothing, and shows the room moving again when it returns", async ({ page }) => {
    await watchCanvas(page);
    await openRoom(page, "last-desk");
    await setHidden(page, true);
    await page.waitForTimeout(300);
    const hidden = await counts(page);
    await page.waitForTimeout(1000);
    expect(await counts(page)).toEqual(hidden);
    await setHidden(page, false);
    await expect.poll(async () => (await counts(page)).specks).toBeGreaterThan(hidden.specks);
  });

  test("a hidden tab holds no offscreen pixels, and builds them again when it returns", async ({ page }) => {
    await page.addInitScript(() => {
      const made: HTMLCanvasElement[] = [];
      const create = document.createElement.bind(document);
      document.createElement = ((name: string, options?: ElementCreationOptions) => {
        const element = create(name, options);
        if (element instanceof HTMLCanvasElement) made.push(element);
        return element;
      }) as typeof document.createElement;
      (window as unknown as { offscreen: () => number }).offscreen = () => made.filter((c) => !c.isConnected).reduce((sum, c) => sum + c.width * c.height, 0);
      // A hidden tab runs no animation frames until it shows again, as browsers do.
      const held: FrameRequestCallback[] = [];
      const frame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => (document.hidden ? held.push(callback) : frame(callback));
      document.addEventListener("visibilitychange", () => { if (!document.hidden) for (const callback of held.splice(0)) frame(callback); });
    });
    const offscreen = () => page.evaluate(() => (window as unknown as { offscreen: () => number }).offscreen());
    await openRoom(page, "last-desk");
    await expect.poll(offscreen).toBeGreaterThan(1440 * 900);
    await setHidden(page, true);
    expect(await offscreen()).toBe(0);
    await page.waitForTimeout(500);
    expect(await offscreen()).toBe(0);
    await setHidden(page, false);
    await expect.poll(offscreen).toBeGreaterThan(1440 * 900);
  });

  test("a stage with no size holds no offscreen pixels, and builds them again when it has one", async ({ page }) => {
    await page.addInitScript(() => {
      const made: HTMLCanvasElement[] = [];
      const create = document.createElement.bind(document);
      document.createElement = ((name: string, options?: ElementCreationOptions) => {
        const element = create(name, options);
        if (element instanceof HTMLCanvasElement) made.push(element);
        return element;
      }) as typeof document.createElement;
      (window as unknown as { offscreen: () => number }).offscreen = () => made.filter((c) => !c.isConnected).reduce((sum, c) => sum + c.width * c.height, 0);
    });
    const offscreen = () => page.evaluate(() => (window as unknown as { offscreen: () => number }).offscreen());
    await openRoom(page, "last-desk");
    await expect.poll(offscreen).toBeGreaterThan(1440 * 900);
    await setCanvasSize(page, false);
    await expect.poll(() => page.locator(".front-row-canvas").evaluate((c: HTMLCanvasElement) => c.width)).toBe(0);
    expect(await offscreen()).toBe(0);
    await page.waitForTimeout(500);
    expect(await offscreen()).toBe(0);
    await setCanvasSize(page, true);
    await expect.poll(offscreen).toBeGreaterThan(1440 * 900);
  });

  test("a stage that has no size and then its old size shows the whole room", async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    await page.addInitScript(({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
      window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
      const canvas = () => document.querySelector<HTMLCanvasElement>(".front-row-canvas")!;
      const pixels = () => { const c = canvas(); return new Uint32Array(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.buffer); };
      (window as unknown as { differing: () => number }).differing = () => {
        const stepped = pixels();
        canvas().dispatchEvent(new Event("contextrestored"));
        const whole = pixels();
        let differing = 0;
        for (let i = 0; i < whole.length; i++) if (stepped[i] !== whole[i]) differing++;
        return differing;
      };
    }, { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "last-desk", motion: "system" } });
    await page.goto("/?scenario=review&clean=1");
    await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();
    await page.clock.runFor(1000);
    await setCanvasSize(page, false);
    await expect(page.locator(".front-row-canvas")).toHaveJSProperty("width", 0);
    await page.clock.runFor(10);
    await setCanvasSize(page, true);
    await expect(page.locator(".front-row-canvas")).toHaveJSProperty("width", 1440);
    expect(await page.evaluate(() => (window as unknown as { differing: () => number }).differing())).toBe(0);
  });

  test("the app's Reduce motion setting keeps the room still", async ({ page }) => {
    await watchCanvas(page);
    await openRoom(page, "projection-booth", { motion: "reduced" });
    const first = await counts(page);
    expect(first.drawImage).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    expect(await counts(page)).toEqual(first);
    expect(first.specks).toBe(0);
  });

  test("a system reduced-motion preference chosen while the room moves stops it", async ({ page }) => {
    await watchCanvas(page);
    await openRoom(page, "study-bench");
    await expect.poll(async () => (await counts(page)).specks).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(400);
    const still = await counts(page);
    await page.waitForTimeout(1000);
    expect(await counts(page)).toEqual(still);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(async () => (await counts(page)).specks).toBeGreaterThan(still.specks);
  });
});

test.describe("on a phone", () => {
  test.use({ reducedMotion: "no-preference", viewport: { width: 390, height: 844 } });
  test("the room is still by default", async ({ page }) => {
    await watchCanvas(page);
    await openRoom(page, "last-desk");
    const first = await counts(page);
    await page.waitForTimeout(1000);
    expect(await counts(page)).toEqual(first);
    expect(first.specks).toBe(0);
  });
});

test("the system's reduced-motion preference keeps every room still", async ({ page }) => {
  await watchCanvas(page);
  for (const scene of scenes) {
    await openRoom(page, scene);
    const first = await counts(page);
    await page.waitForTimeout(600);
    expect(await counts(page)).toEqual(first);
    expect(first.specks).toBe(0);
  }
});
