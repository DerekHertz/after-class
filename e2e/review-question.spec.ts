import { expect, test } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, SCENES } from "../src/app/appearance";

const question = "What would have to change for either thread to continue?";

for (const scene of Object.keys(SCENES)) {
  test(`a long tutor reply opens with its question in view on the board in ${scene}`, async ({ page }, info) => {
    test.skip(info.project.name === "narrow", "the phone layout scrolls the page, not the board");
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene },
    });
    await page.goto("/?scenario=long-reply&clean=1");
    const board = page.locator('.front-row-area[data-area="board"]');
    await expect(board).toContainText(question);
    expect(await board.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect.poll(() => board.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    const inside = await page.evaluate(() => {
      const area = document.querySelector('.front-row-area[data-area="board"]')!;
      const last = area.querySelector(".current-exchange .line:last-child p")!;
      const range = document.createRange();
      range.selectNodeContents(last);
      const lines = [...range.getClientRects()];
      const end = lines[lines.length - 1]!;
      const box = area.getBoundingClientRect();
      return { top: end.top >= box.top, bottom: end.bottom <= box.bottom };
    });
    expect(inside).toEqual({ top: true, bottom: true });
  });
}

test("a reply shorter than the board leaves the board where it is", async ({ page }, info) => {
  test.skip(info.project.name === "narrow", "the phone layout scrolls the page, not the board");
  await page.goto("/?scenario=review&clean=1");
  const board = page.locator('.front-row-area[data-area="board"]');
  await expect(board).toContainText(question);
  await page.waitForTimeout(300);
  expect(await board.evaluate(node => node.scrollTop)).toBe(0);
});

test("the loading notice is written in the board's ink", async ({ page }) => {
  await page.goto("/?scenario=review&clean=1&loading=1");
  const heading = page.getByRole("heading", { name: "Review", level: 1 });
  await expect(heading).toBeVisible();
  const colors = await page.evaluate(() => {
    const ink = (css: string) => {
      const probe = document.createElement("span");
      probe.style.color = css;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    const loading = document.querySelector(".review-loading")!;
    return {
      heading: getComputedStyle(loading.querySelector("h1")!).color,
      text: getComputedStyle(loading.querySelector(".muted")!).color,
      boardInk: ink(getComputedStyle(document.querySelector(".scene-shell")!).getPropertyValue("--fr-board-ink")),
      boardInkSoft: ink(getComputedStyle(document.querySelector(".scene-shell")!).getPropertyValue("--fr-board-ink-soft")),
    };
  });
  expect(colors.heading).toBe(colors.boardInk);
  expect(colors.text).toBe(colors.boardInkSoft);
});
