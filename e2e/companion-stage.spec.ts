import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE } from "../src/app/appearance";
import type { Appearance } from "../src/app/appearance";

/** Pip's shipped gesture frames. The spec cannot import room/companion-art.ts, whose pictures only a bundler can load. */
const PAINTED_FRAMES = ["blink", "look-board", "look-mat", "nod", "hop-crouch", "hop-air", "think", "cheer", "talk"];

/** Opens the review with the companion shown, counting the stage's paints (one clear each) and recording each frame it draws. */
async function openRoom(page: Page, appearance: Partial<Appearance> = {}) {
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const w = window as unknown as { paints: number; frames: string[] };
    w.paints = 0;
    w.frames = [];
    CanvasRenderingContext2D.prototype.clearRect = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof clear>) {
      w.paints++;
      queueMicrotask(() => { const frame = this.canvas.dataset.companion; if (frame !== undefined && frame !== w.frames.at(-1)) w.frames.push(frame); });
      return clear.apply(this, args);
    } as typeof clear;
  }, { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "last-desk", companion: "pip", visible: true, ...appearance } });
  await page.goto("/?scenario=review&clean=1");
  await expect(page.locator(".front-row-canvas[data-companion]")).toBeAttached();
}
const paints = (page: Page) => page.evaluate(() => (window as unknown as { paints: number }).paints);
const frames = (page: Page) => page.evaluate(() => (window as unknown as { frames: string[] }).frames.splice(0));
const gesture = (page: Page, name: string) => page.evaluate((name) => (window as unknown as { afterClassGesture: (g: string) => void }).afterClassGesture(name), name);

test.describe("the stage draws the companion", () => {
  test.beforeEach(() => { test.skip(test.info().project.name === "narrow", "a phone shows the companion in the page, not on the stage"); });

  test("in place of the page's sheet, which the browser never fetches", async ({ page }) => {
    await openRoom(page);
    await expect(page.locator(".front-row-buddy .companion-raster")).toBeHidden();
    await page.waitForTimeout(500);
    const sheets = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/pip(-small)?-[a-z0-9]{8}\.webp$/.test(n)));
    expect(sheets).toHaveLength(1);
  });

  test("loads the frames of the companion shown and no other's", async ({ page }) => {
    await openRoom(page);
    const pattern = new RegExp(`/(${PAINTED_FRAMES.join("|")})(-small)?-[a-z0-9]{8}\\.webp$`);
    const loaded = () => page.evaluate((source) => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => new RegExp(source).test(n)).length, pattern.source);
    // Every companion's frames share these names, so a second companion's frames would double the count.
    await expect.poll(loaded).toBe(PAINTED_FRAMES.length);
    await page.waitForTimeout(1000);
    expect(await loaded()).toBe(PAINTED_FRAMES.length);
  });

  test("a reaction plays its gesture's painted frames, then the companion rests", async ({ page }) => {
    await openRoom(page);
    await page.waitForTimeout(1000);
    await frames(page);
    await gesture(page, "nod");
    await page.waitForTimeout(900);
    expect((await frames(page)).filter((f) => f !== "blink").slice(0, 4)).toEqual(["nod", "idle", "nod", "idle"]);
    await gesture(page, "hop");
    await page.waitForTimeout(900);
    expect((await frames(page)).filter((f) => f !== "blink").slice(0, 4)).toEqual(["hop-crouch", "hop-air", "hop-crouch", "idle"]);
  });

  test("Lumi, who has no cheer frame, hops instead", async ({ page }) => {
    await openRoom(page, { companion: "lumi" });
    await page.waitForTimeout(1000);
    await frames(page);
    await gesture(page, "cheer");
    await page.waitForTimeout(900);
    expect((await frames(page)).filter((f) => f !== "blink").slice(0, 3)).toEqual(["hop-crouch", "hop-air", "hop-crouch"]);
  });

  test("at rest it blinks now and then, and the stage paints only when a frame changes", async ({ page }) => {
    await openRoom(page);
    await page.waitForTimeout(500);
    const before = await paints(page);
    await frames(page);
    await page.waitForTimeout(16_000);
    const seen = await frames(page);
    const painted = (await paints(page)) - before;
    // At least two blinks fall in any 16 seconds (one per 5 second window), each a blink and back, a double blink four changes.
    expect(seen.filter((f) => f === "blink").length).toBeGreaterThanOrEqual(2);
    expect(painted).toBeLessThanOrEqual(seen.length + 2);
  });

  for (const [name, setup] of [
    ["the system's reduced motion", { appearance: {}, reducedMotion: "reduce" as const }],
    ["the app's Reduce motion setting", { appearance: { motion: "reduced" as const }, reducedMotion: "no-preference" as const }],
  ] as const) {
    test(`with ${name} a reaction is its instant pose and nothing blinks`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: setup.reducedMotion });
      await openRoom(page, setup.appearance);
      await page.waitForTimeout(500);
      await frames(page);
      await gesture(page, "nod");
      await page.waitForTimeout(1500);
      expect(await frames(page)).toEqual(["nod", "idle"]);
      const settled = await paints(page);
      await page.waitForTimeout(8000);
      expect(await paints(page)).toBe(settled);
    });
  }
});
