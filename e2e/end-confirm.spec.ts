import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const controls = ['.front-row-bar .front-row-title', '.front-row-bar .review-phase', '.front-row-bar button:not([data-action^="end-"])'];

const finishButton = (page: Page) => page.locator('.front-row-bar button[data-action="end"]');
const pauseButton = (page: Page) => page.locator('.front-row-bar button[data-action="pause"]');
// The confirm is a native modal dialog: `:modal` only matches one opened with showModal().
const modal = (page: Page) => page.locator("dialog:modal");
const confirmDialog = (page: Page) => page.getByRole("alertdialog", { name: "Finish and save this review?" });

/** Opens the bar's menu, which holds Pause and Finish & save, if it is shut. */
async function openMenu(page: Page) {
  const toggle = page.getByRole("button", { name: "Menu", exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

async function open(page: Page) {
  await page.goto("/?scenario=review&clean=1");
  await openMenu(page);
  await expect(finishButton(page)).toBeVisible();
  await finishButton(page).click();
  await expect(confirmDialog(page)).toBeVisible();
}

const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-action") ?? document.activeElement?.tagName ?? null);

const center = async (locator: Locator) => {
  const b = (await locator.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test("opening the finish confirm leaves every header control where it was", async ({ page }) => {
  await page.goto("/?scenario=review&clean=1");
  await openMenu(page);
  const finish = finishButton(page);
  await expect(finish).toBeVisible();
  const boxes = () => page.evaluate((selectors) => selectors.flatMap(s => [...document.querySelectorAll(s)].map(e => {
    const r = e.getBoundingClientRect();
    return [e.textContent, r.x, r.y, r.width, r.height];
  })), controls);
  const before = await boxes();
  await finish.click();
  const confirm = confirmDialog(page);
  await expect(confirm).toBeVisible();
  expect(await boxes()).toEqual(before);
  await confirm.getByRole("button", { name: "Keep reviewing" }).click();
  await expect(confirm).toBeHidden();
  expect(await boxes()).toEqual(before);
});

test("the confirm is a modal dialog: the background is inert and focus stays inside", async ({ page }) => {
  await open(page);
  const dialog = modal(page);
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toHaveAttribute("aria-labelledby", /.+/);
  // Nothing behind the dialog can take focus, however many times the learner tabs. The document itself may
  // (focus can step out to the browser), which is not a control behind the dialog.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => { const a = document.activeElement; return a === null || a === document.body || a.closest("dialog") !== null; })).toBe(true);
  }
  // A click on a control behind the dialog does not reach it: it closes the dialog and Pause stays unpressed.
  await page.mouse.click(...Object.values(await center(pauseButton(page))) as [number, number]);
  await expect(confirmDialog(page)).toBeHidden();
  await expect(pauseButton(page)).toBeVisible();
  await expect(page.locator('.front-row-bar button[data-action="resume"]')).toHaveCount(0);
});

for (const size of [{ width: 320, height: 225 }, { width: 1440, height: 225 }, { width: 390, height: 844 }]) {
  test(`the confirm stays on screen at ${size.width}x${size.height}, with its buttons reachable and uncovered`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page);
    const box = (await confirmDialog(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    for (const name of ["Finish & save", "Keep reviewing"]) {
      const button = confirmDialog(page).getByRole("button", { name });
      await button.scrollIntoViewIfNeeded();
      const b = (await button.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(size.height);
      // Nothing sits on top of the button: the element at its center is the button itself.
      const c = await center(button);
      const hit = await button.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), c);
      expect(hit).toBe(true);
    }
  });
}

test("opening the confirm moves focus to Keep reviewing and describes the dialog", async ({ page }) => {
  await open(page);
  expect(await focused(page)).toBe("end-cancel");
  const finish = finishButton(page);
  const dialog = confirmDialog(page);
  const id = await dialog.getAttribute("id");
  expect(id).toBeTruthy();
  await expect(finish).toHaveAttribute("aria-controls", id!);
  await expect(finish).toHaveAttribute("aria-expanded", "true");
  await expect(dialog).toHaveAccessibleDescription(/The conversation ends and can't be continued/);
});

test("Keep reviewing returns focus to Finish", async ({ page }) => {
  await open(page);
  await confirmDialog(page).getByRole("button", { name: "Keep reviewing" }).click();
  await expect(confirmDialog(page)).toBeHidden();
  expect(await focused(page)).toBe("end");
  await expect(finishButton(page)).toHaveAttribute("aria-expanded", "false");
});

test("Escape closes the confirm and returns focus to Finish", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toBeHidden();
  expect(await focused(page)).toBe("end");
  await expect(finishButton(page)).toHaveAttribute("aria-expanded", "false");
});

test("a click on the backdrop closes the confirm and returns focus to Finish", async ({ page }) => {
  await open(page);
  await page.mouse.click(2, page.viewportSize()!.height - 2);
  await expect(confirmDialog(page)).toBeHidden();
  expect(await focused(page)).toBe("end");
});

test("a click inside the confirm does not close it", async ({ page }) => {
  await open(page);
  await confirmDialog(page).locator("#" + (await confirmDialog(page).getAttribute("id")) + "-text").click();
  await expect(confirmDialog(page)).toBeVisible();
});

test("the confirm works the same while the review is paused", async ({ page }) => {
  await page.goto("/?scenario=review&clean=1");
  await openMenu(page);
  await pauseButton(page).click();
  await openMenu(page);
  await expect(page.locator('.front-row-bar button[data-action="resume"]')).toBeVisible();
  await finishButton(page).click();
  await expect(confirmDialog(page)).toBeVisible();
  expect(await focused(page)).toBe("end-cancel");
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toBeHidden();
  expect(await focused(page)).toBe("end");
  await expect(page.locator('.front-row-bar button[data-action="resume"]')).toBeVisible();
});
