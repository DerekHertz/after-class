import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const controls = ['.front-row-bar .front-row-title', '.front-row-bar .review-phase', '.front-row-bar button:not([data-action^="end-"])'];

const finishButton = (page: Page) => page.locator('.front-row-bar button[data-action="end"]');
const confirmPanel = (page: Page) => page.getByRole("alertdialog", { name: "Finish and save this review?" });

async function open(page: Page) {
  await page.goto("/?scenario=review&clean=1");
  await expect(finishButton(page)).toBeVisible();
  await finishButton(page).click();
  await expect(confirmPanel(page)).toBeVisible();
}

const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-action") ?? document.activeElement?.tagName ?? null);

test("opening the finish confirm leaves every header control where it was", async ({ page }) => {
  await page.goto("/?scenario=review&clean=1");
  const finish = finishButton(page);
  await expect(finish).toBeVisible();
  const boxes = () => page.evaluate((selectors) => selectors.flatMap(s => [...document.querySelectorAll(s)].map(e => {
    const r = e.getBoundingClientRect();
    return [e.textContent, r.x, r.y, r.width, r.height];
  })), controls);
  const before = await boxes();
  await finish.click();
  const confirm = confirmPanel(page);
  await expect(confirm).toBeVisible();
  expect(await boxes()).toEqual(before);
  const panel = (await confirm.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width);
  await confirm.getByRole("button", { name: "Keep reviewing" }).click();
  await expect(confirm).toBeHidden();
  expect(await boxes()).toEqual(before);
});

for (const size of [{ width: 320, height: 225 }, { width: 1440, height: 225 }, { width: 640, height: 450 }]) {
  test(`the confirm stays on screen at ${size.width}x${size.height} and scrolls inside itself`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page);
    const box = (await confirmPanel(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    for (const name of ["Finish & save", "Keep reviewing"]) {
      const button = confirmPanel(page).getByRole("button", { name });
      await button.scrollIntoViewIfNeeded();
      const b = (await button.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(size.height);
    }
  });
}

test("opening the confirm moves focus to Keep reviewing and links the panel to its text", async ({ page }) => {
  await open(page);
  expect(await focused(page)).toBe("end-cancel");
  const finish = finishButton(page);
  const panel = confirmPanel(page);
  const id = await panel.getAttribute("id");
  expect(id).toBeTruthy();
  await expect(finish).toHaveAttribute("aria-controls", id!);
  await expect(finish).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toHaveAccessibleDescription(/The conversation ends and can't be continued/);
});

test("Keep reviewing returns focus to Finish", async ({ page }) => {
  await open(page);
  await confirmPanel(page).getByRole("button", { name: "Keep reviewing" }).click();
  await expect(confirmPanel(page)).toBeHidden();
  expect(await focused(page)).toBe("end");
});

test("Escape dismisses the confirm and returns focus to Finish", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Escape");
  await expect(confirmPanel(page)).toBeHidden();
  expect(await focused(page)).toBe("end");
  await expect(finishButton(page)).toHaveAttribute("aria-expanded", "false");
});

test("a click outside the confirm dismisses it", async ({ page }) => {
  await open(page);
  await page.mouse.click(2, page.viewportSize()!.height - 2);
  await expect(confirmPanel(page)).toBeHidden();
  expect(await focused(page)).toBe("end");
});

test("a click inside the confirm does not dismiss it", async ({ page }) => {
  await open(page);
  await confirmPanel(page).locator("#" + (await confirmPanel(page).getAttribute("id")) + "-text").click();
  await expect(confirmPanel(page)).toBeVisible();
});

test("the confirm works the same while the review is paused", async ({ page }) => {
  await page.goto("/?scenario=review&clean=1");
  await page.locator('.front-row-bar button[data-action="pause"]').click();
  await expect(page.locator('.front-row-bar button[data-action="resume"]')).toBeVisible();
  await finishButton(page).click();
  await expect(confirmPanel(page)).toBeVisible();
  expect(await focused(page)).toBe("end-cancel");
  await page.keyboard.press("Escape");
  await expect(confirmPanel(page)).toBeHidden();
  expect(await focused(page)).toBe("end");
  await expect(page.locator('.front-row-bar button[data-action="resume"]')).toBeVisible();
});
