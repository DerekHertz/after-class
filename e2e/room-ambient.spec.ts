import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, SCENES } from "../src/app/appearance";
import type { Appearance, SceneId } from "../src/app/appearance";

const scenes = Object.keys(SCENES) as SceneId[];
type Counts = { specks: number; drawImage: number; transforms: number; moved: number };

/** Counts what the stage draws, and every call that could rotate, scale or shift what it draws next. */
async function watchCanvas(page: Page) {
  await page.addInitScript(() => {
    const counts = { specks: 0, drawImage: 0, transforms: 0, moved: 0 };
    (window as unknown as { counts: typeof counts }).counts = counts;
    const proto = CanvasRenderingContext2D.prototype;
    const fill = proto.fillRect;
    proto.fillRect = function (this: CanvasRenderingContext2D, ...a: Parameters<typeof fill>) { counts.specks++; return fill.apply(this, a); };
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
