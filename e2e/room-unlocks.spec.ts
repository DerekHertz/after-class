import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE } from "../src/app/appearance";
import type { SceneId } from "../src/app/appearance";
import type { Rect } from "../src/app/room/layout";
import { deriveProgress } from "../src/app/room/progress";
import { createFixture } from "../scripts/ui-preview/fixtures";

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

/** Opens the bar's menu if it is shut, then presses `name` in it. */
async function inMenu(page: Page, name: string) {
  const toggle = page.getByRole("button", { name: "Menu", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await page.getByRole("button", { name, exact: true }).click();
}

test.describe("the Your room panel", () => {
  test("its lines are the saved record's counts, each saying what it counts", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the copy is the same at every size");
    const progress = deriveProgress((await createFixture("review").api.record({})).observations);
    await openRoom(page, "last-desk");
    await inMenu(page, "Your room");
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
      test("opens from the bar's menu, closes with Escape or Close and, open, stays clear of Your thinking", async ({ page }, info) => {
        test.skip(info.project.name !== "desktop", "each test sets its own window");
        await openRoom(page, "study-bench");
        const toggle = page.getByRole("button", { name: "Menu", exact: true });
        const panel = page.getByRole("region", { name: "Your room" });
        await expect(panel).toBeHidden();
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await page.getByRole("button", { name: "Your room", exact: true }).click();
        await expect(panel).toBeVisible();
        const open = await rectOf(page.locator(".room-progress"));
        // A full room floats the panel under the bar, inside the window and clear of Your thinking.
        if (size.width >= 900) {
          expect(open.top + open.height).toBeLessThanOrEqual(size.height);
          expect(overlaps(open, await rectOf(page.locator('.front-row-area[data-area="desk"]')))).toBe(false);
        }
        await panel.getByRole("button", { name: "Close" }).click();
        await expect(panel).toBeHidden();
        await expect(toggle).toBeFocused();
        await inMenu(page, "Your room");
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
      });
    });
  }

  test("nothing in it moves under reduced motion", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "the window does not change it");
    const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
    await openRoom(page, "projection-booth");
    await inMenu(page, "Your room");
    const moving = await page.locator(".room-progress, .room-progress *").evaluateAll((nodes) => nodes.flatMap((node) => {
      const style = getComputedStyle(node);
      const timed = style.transitionDuration.split(",").some((d) => parseFloat(d) > 0) || style.animationName !== "none";
      return timed ? [node.className || node.tagName] : [];
    }));
    expect(moving).toEqual([]);
    await page.close();
  });
});

test.describe("the Your room panel follows the saved record", () => {
  async function correctFirstObservation(page: Page, settled: (dialog: Locator) => Locator = (dialog) => dialog.getByText("Status: After help").first()) {
    await inMenu(page, "Saved notes");
    const dialog = page.getByRole("dialog", { name: "Saved notes" });
    await expect(dialog.getByRole("heading", { name: "My notebook" })).toBeVisible();
    const row = dialog.locator("li.record-observation").filter({ hasText: "Status: Independent" }).first();
    await row.getByText("Change status").click();
    const select = row.getByRole("combobox", { name: /Change status for/ });
    await expect(select).toBeEnabled();
    await select.selectOption({ label: "After help" });
    await expect(settled(dialog)).toBeVisible();
    await dialog.getByRole("button", { name: "Close notebook" }).click();
  }
  const understood = (page: Page) => page.locator('.room-progress-body [data-count="understood"] dd');

  test("a correction in Saved notes changes the counts without leaving the review", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the counts are the same at every size");
    await openRoom(page, "last-desk");
    await inMenu(page, "Your room");
    const before = Number(await understood(page).innerText());
    expect(before).toBeGreaterThan(0);
    await inMenu(page, "Your room");
    await correctFirstObservation(page);
    await inMenu(page, "Your room");
    await expect(understood(page)).toHaveText(String(before - 1));
  });

  test("while a correction's read is out, the panel shows the last counts as updating, never as current", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the copy is the same at every size");
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "last-desk" } });
    await page.goto("/?scenario=review-record-slow&clean=1");
    await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();
    const panel = page.getByRole("region", { name: "Your room" });
    await inMenu(page, "Your room");
    const before = Number(await understood(page).innerText());
    await inMenu(page, "Your room");
    await correctFirstObservation(page, (dialog) => dialog.getByRole("heading", { name: "My notebook" }));
    await inMenu(page, "Your room");
    await expect(panel.getByRole("status")).toHaveText("Updating from your saved reviews. These counts were read before your latest change.");
    await expect(panel).not.toContainText("Counted from your saved reviews.");
    await expect(understood(page)).toHaveText(String(before));
    await page.screenshot({ path: "test-results/226-panel-refreshing.png" });
    await page.locator(".fixture-toolbar").getByRole("button", { name: "Finish pending fixture operation", includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(panel).toContainText("Counted from your saved reviews.");
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect(understood(page)).toHaveText(String(before - 1));
  });

  test("a record that cannot be read again says its counts may be out of date and reads again on Retry", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the copy is the same at every size");
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "last-desk" } });
    await page.goto("/?scenario=review-record-stale&clean=1");
    await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();
    await inMenu(page, "Your room");
    const before = Number(await understood(page).innerText());
    await inMenu(page, "Your room");
    await correctFirstObservation(page, (dialog) => dialog.getByRole("alert").first());
    const panel = page.getByRole("region", { name: "Your room" });
    await inMenu(page, "Your room");
    await expect(panel.getByRole("alert")).toContainText("These counts may be out of date");
    await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.screenshot({ path: "test-results/226-panel-stale.png" });
    await panel.getByRole("button", { name: "Retry" }).click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(understood(page)).toHaveText(String(before - 1));
  });
});
