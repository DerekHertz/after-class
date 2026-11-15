import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";

const fontSize = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

test.describe("on a large window the room's text grows with the room, and nothing else's does", () => {
  const window = { width: 3440, height: 1440 };
  test.use({ viewport: window });

  test("the room's words and controls scale, its dialogs and the next page do not", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the test sets its own window");
    const layout = layoutRoom("last-desk", window, "full");
    if (layout.composition !== "full") throw new Error("a desktop window lays out the full room");
    expect(layout.type).toBeGreaterThan(1.5);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene: "last-desk" } });
    await page.goto("/?scenario=review&clean=1");
    await expect(page.locator(".front-row-canvas[data-stage=painted]")).toBeAttached();

    const rem = 16 * layout.type;
    expect({
      masthead: await fontSize(page, ".scene-masthead > a"),
      nav: await fontSize(page, ".front-row-bar button"),
      shortcut: await fontSize(page, ".composer-shortcut"),
      object: await fontSize(page, ".front-row-object-tag"),
    }).toEqual({ masthead: expect.closeTo(1.3 * rem, 1), nav: expect.closeTo(rem, 1), shortcut: expect.closeTo(0.9 * rem, 1), object: expect.closeTo(0.95 * rem, 1) });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("16px");

    await page.getByText("Room & companion").click();
    expect(await fontSize(page, ".appearance-options")).toBe(16);
    await page.getByText("Room & companion").click();
    await page.getByRole("button", { name: "Saved notes", exact: true }).click();
    const notes = page.getByRole("dialog", { name: "Saved notes" });
    await expect(notes).toBeVisible();
    expect(await notes.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(16.8);
    await page.keyboard.press("Escape");
    await page.locator('.front-row-object[data-object="source"]').click();
    await expect(page.locator("dialog.room-object[open]")).toBeVisible();
    expect(await fontSize(page, "dialog.room-object[open]")).toBe(16.8);
    await page.keyboard.press("Escape");
    await page.locator('[data-action="end"]').click();
    await expect(page.locator(".end-confirm[open]")).toBeVisible();
    expect(await fontSize(page, ".end-confirm-body > span:not(.visually-hidden)")).toBe(15.2);
    await page.keyboard.press("Escape");

    await page.locator(".scene-masthead > a").click();
    await expect(page.locator(".front-row-scene")).toHaveCount(0);
    expect(await page.evaluate(() => [document.documentElement.getAttribute("style") ?? "", getComputedStyle(document.documentElement).fontSize])).toEqual(["", "16px"]);
    expect(await fontSize(page, ".scene-masthead > a")).toBe(20.8);
  });
});
