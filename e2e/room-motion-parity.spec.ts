import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, SCENES } from "../src/app/appearance";
import type { SceneId } from "../src/app/appearance";

const scenes = Object.keys(SCENES) as SceneId[];
/** An unlocked object's shipped picture. The bundle drops the room's folder, and a room fetches only its own open slots. */
const unlockPicture = /\/[1-6]-[a-z0-9]{8}\.webp$/;

type Step = { readonly wrong: number; readonly missed: number; readonly repainted: number; readonly total: number; readonly at: string | null; readonly frame: string; readonly unlocks: number };

/**
 * Before each step the spec fills the stage with a colour the room never paints. After the step every pixel the stage
 * painted must match a whole repaint at the same time, every pixel the whole repaint changed must have been painted, and
 * the step must leave most of the room alone.
 */
test.describe("a moving room's steps match a whole repaint", () => {
  test.use({ reducedMotion: "no-preference" });
  test.beforeEach(({ page: _page }, info) => { test.skip(info.project.name === "narrow", "a phone-width window does not move"); });

  // Chrome's emulated ratio sets devicePixelRatio, which sizes the backing store and every draw. It reports the observed
  // device box at one pixel per CSS pixel, so the stage's use of an exact box from a real screen is not exercised here.
  for (const dpr of [1, 1.5, 2]) {
    test.describe(`at ${dpr}x`, () => {
      test.use({ deviceScaleFactor: dpr });

      for (const scene of scenes) {
        test(`in ${scene}, through blinks, a hop with a missing frame and ambient life`, async ({ page }) => {
          test.setTimeout(120_000);
          // The hop's airborne frame never loads, so the stage draws the sheet's idle pose in its place.
          let missing = 0;
          await page.route(/\/hop-air(-small)?-[a-z0-9]{8}\.webp$/, (route) => { missing++; return route.abort(); });
          const steps = await runSteps(page, scene, dpr);
          const bad = steps.flatMap((s, i) => (s.wrong + s.missed > 0 ? [`step ${i} (${s.frame}): ${s.wrong} wrong, ${s.missed} missed, first at ${s.at}`] : []));
          expect(bad).toEqual([]);
          const frames = new Set(steps.map((s) => s.frame));
          expect(frames).toContain("blink");
          expect(frames).toContain("hop-crouch");
          expect(steps.filter((s) => s.repainted > 0).length).toBeGreaterThan(50);
          expect(missing).toBeGreaterThan(0);
          // The rail room's window light is the largest live draw. When its alpha steps, the step repaints about 13 percent.
          expect(Math.max(...steps.map((s) => s.repainted / s.total))).toBeLessThan(0.25);
        });
      }
    });
  }
});

/**
 * Opens `scene` moving at `dpr` in the preview's `scenario`, then steps the clock 72 times and checks each step against a whole
 * repaint. The "room-grown" scenario opens every slot (scripts/ui-preview/fixtures.ts). `before` runs ahead of the step it names and says how many unlock pictures it let through.
 */
async function runSteps(page: Page, scene: SceneId, dpr: number, scenario = "review", before: Record<number, () => Promise<number>> = {}): Promise<Step[]> {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.addInitScript(({ key, value, unlock }) => {
    localStorage.setItem(key, JSON.stringify(value));
    let seed = 0x2545f491;
    const decode = HTMLImageElement.prototype.decode;
    const counter = window as unknown as { unlocksDecoded: number };
    counter.unlocksDecoded = 0;
    HTMLImageElement.prototype.decode = function () {
      return decode.call(this).then(() => { if (new RegExp(unlock).test(new URL(this.src).pathname)) counter.unlocksDecoded++; });
    };
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    // Frame callbacks run as soon as the stage's timer asks for one, so the clock alone decides each step.
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
    const sentinel = 0xffff00ff;
    const canvas = () => document.querySelector<HTMLCanvasElement>(".front-row-canvas")!;
    const pixels = () => { const c = canvas(); return new Uint32Array(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.buffer); };
    const repaintWhole = () => { canvas().dispatchEvent(new Event("contextrestored")); return pixels(); };
    let before = new Uint32Array(0);
    const fill = () => {
      const context = canvas().getContext("2d")!;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "copy";
      context.fillStyle = "#ff00ff";
      context.fillRect(0, 0, canvas().width, canvas().height);
      context.restore();
    };
    const w = window as unknown as { startSteps: () => number; checkStep: () => Step };
    w.startSteps = () => { before = repaintWhole(); fill(); return canvas().width; };
    w.checkStep = () => {
      const stepped = pixels();
      const whole = repaintWhole();
      let wrong = 0, missed = 0, repainted = 0, at: string | null = null;
      for (let i = 0; i < whole.length; i++) {
        const painted = stepped[i] !== sentinel;
        if (painted) repainted++;
        const bad = painted ? stepped[i] !== whole[i] : whole[i] !== before[i];
        if (!bad) continue;
        if (painted) wrong++;
        else missed++;
        at ??= `${i % canvas().width},${Math.floor(i / canvas().width)}`;
      }
      before = whole;
      fill();
      return { wrong, missed, repainted, total: whole.length, at, frame: canvas().dataset.companion ?? "none", unlocks: counter.unlocksDecoded };
    };
  }, { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene, companion: "pip", visible: true, motion: "system" }, unlock: unlockPicture.source });
  await page.goto(`/?scenario=${scenario}&clean=1`);
  await expect(page.locator(".front-row-canvas[data-stage=painted][data-companion]")).toBeAttached();
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as unknown as { startSteps: () => number }).startSteps())).toBe(Math.round(1440 * dpr));

  const steps: Step[] = [];
  for (let i = 0; i < 72; i++) {
    if (i === 24) await page.evaluate(() => (window as unknown as { afterClassGesture: (g: string) => void }).afterClassGesture("hop"));
    const decodes = await page.evaluate(() => (window as unknown as { unlocksDecoded: number }).unlocksDecoded);
    await before[i]?.();
    // The stage repaints as a picture decodes, outside the clock, so the step waits for the decode it let through.
    if (before[i] !== undefined) await expect.poll(() => page.evaluate(() => (window as unknown as { unlocksDecoded: number }).unlocksDecoded)).toBeGreaterThan(decodes);
    await page.clock.runFor(i % 6 === 5 && (i < 24 || i > 36) ? 500 : 84);
    steps.push(await page.evaluate(() => (window as unknown as { checkStep: () => Step }).checkStep()));
  }
  return steps;
}
