import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE } from "../src/app/appearance";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import type { Rect } from "../src/app/room/layout";
import { ROOM_IDS, deriveProgress } from "../src/app/room/progress";
import { createFixture } from "../scripts/ui-preview/fixtures";

const scenes = ROOM_IDS as readonly SceneId[];

async function openRoom(page: Page, scene: SceneId) {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene } });
  await page.goto("/?scenario=review&clean=1");
  await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();
}

const rectOf = async (locator: Locator): Promise<Rect> => {
  const box = (await locator.boundingBox())!;
  return { left: box.x, top: box.y, width: box.width, height: box.height };
};
const overlaps = (a: Rect, b: Rect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/** Every control and text area the room lays over its art, measured in the page. */
async function controls(page: Page): Promise<Record<string, Rect>> {
  const named: Record<string, Rect> = {};
  for (const [name, selector] of [
    ["board", '.front-row-area[data-area="board"]'], ["desk", '.front-row-area[data-area="desk"]'],
    ["source", '.front-row-object[data-object="source"]'], ["history", '.front-row-object[data-object="history"]'], ["progress", ".room-progress"],
  ] as const) named[name] = await rectOf(page.locator(selector));
  const chips = page.locator(".front-row-bar button, .front-row-title, .scene-masthead > *");
  for (let i = 0; i < await chips.count(); i++) if (await chips.nth(i).isVisible()) named[`nav-${i}`] = await rectOf(chips.nth(i));
  return named;
}

test.describe("unlock slots keep clear of the room's controls", () => {
  for (const size of [{ width: 1440, height: 900 }, { width: 1000, height: 700 }, { width: 1920, height: 1080 }]) test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    for (const scene of scenes) {
      test(scene, async ({ page }, info) => {
        test.skip(info.project.name !== "desktop", "each test sets its own window");
        await openRoom(page, scene);
        const layout = layoutRoom(scene, size, "full");
        if (layout.composition !== "full") throw new Error("a desktop window lays out the full room");
        const zones = await controls(page);
        const hits = layout.layers.unlocks.flatMap((slot) => Object.entries(zones).filter(([, zone]) => overlaps(slot.rect, zone)).map(([name]) => `${slot.id} on ${name}`));
        expect(hits).toEqual([]);
      });
    }
  });
});

test.describe("the Your room panel", () => {
  test("its lines are the saved record's counts, each saying what it counts", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the copy is the same at every size");
    const progress = deriveProgress((await createFixture("review").api.record({})).observations);
    await openRoom(page, "last-desk");
    await page.getByRole("button", { name: "Your room" }).click();
    const lines = await page.locator(".room-progress-body dl > div").evaluateAll((rows) => rows.map((row) => [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]));
    const say = (label: string) => label[0]!.toUpperCase() + label.slice(1);
    expect(lines).toEqual([
      [say(progress.understood.label), String(progress.understood.value)],
      // Every slot has its picture, so the count toward the next object shows until the room is full.
      ...(progress.toNextUnlock === null ? [] : [[say(progress.toNextUnlock.label), String(progress.toNextUnlock.value)]]),
      [say(progress.reviews.label), String(progress.reviews.value)],
      [say(progress.effort.label), String(progress.effort.value)],
    ]);
  });

  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`at ${size.width}x${size.height}`, () => {
      test.use({ viewport: size });
      test("opens and closes from the keyboard and, open, covers neither the board nor Your thinking", async ({ page }, info) => {
        test.skip(info.project.name !== "desktop", "each test sets its own window");
        await openRoom(page, "study-bench");
        const toggle = page.getByRole("button", { name: "Your room" });
        await page.locator('.front-row-object[data-object="history"]').focus();
        await page.keyboard.press("Tab");
        await expect(toggle).toBeFocused();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator(".room-progress-body")).toBeHidden();
        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        const body = page.locator(".room-progress-body");
        await expect(body).toBeVisible();
        const panel = await rectOf(page.locator(".room-progress"));
        for (const area of ["board", "desk"]) expect({ area, covers: overlaps(panel, await rectOf(page.locator(`.front-row-area[data-area="${area}"]`))) }).toEqual({ area, covers: false });
        if (size.width >= 900) expect(panel.top + panel.height).toBeLessThanOrEqual(size.height);
        await page.keyboard.press("Escape");
        await expect(body).toBeHidden();
        await expect(toggle).toBeFocused();
      });
    });
  }

  test("nothing in it moves under reduced motion", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "the window does not change it");
    const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
    await openRoom(page, "projection-booth");
    await page.getByRole("button", { name: "Your room" }).click();
    const moving = await page.locator(".room-progress, .room-progress *").evaluateAll((nodes) => nodes.flatMap((node) => {
      const style = getComputedStyle(node);
      const timed = style.transitionDuration.split(",").some((d) => parseFloat(d) > 0) || style.animationName !== "none";
      return timed ? [node.className || node.tagName] : [];
    }));
    expect(moving).toEqual([]);
    await page.close();
  });
});
