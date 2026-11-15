import { expect, test } from "@playwright/test";

const controls = ['.front-row-bar .front-row-title', '.front-row-bar .review-phase', '.front-row-bar button:not([data-action^="end-"])'];

test("opening the finish confirm leaves every header control where it was", async ({ page }) => {
  await page.goto("/?scenario=review&clean=1");
  const finish = page.locator('.front-row-bar button[data-action="end"]');
  await expect(finish).toBeVisible();
  const boxes = () => page.evaluate((selectors) => selectors.flatMap(s => [...document.querySelectorAll(s)].map(e => {
    const r = e.getBoundingClientRect();
    return [e.textContent, r.x, r.y, r.width, r.height];
  })), controls);
  const before = await boxes();
  await finish.click();
  const confirm = page.getByRole("alertdialog", { name: "Finish and save this review?" });
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
