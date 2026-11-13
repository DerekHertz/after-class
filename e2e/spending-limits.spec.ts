import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const USED_UP = "This month's AI allowance is used up. It resets on December 1.";
const NOT_ENOUGH_LEFT = "Not enough of this month's AI allowance is left for another AI step. It resets on December 1.";

/** AFTERCLASS_SCREENSHOTS=<dir> keeps a full-page picture of each state for review. */
async function keep(page: Page, name: string, project: string) {
  const dir = process.env.AFTERCLASS_SCREENSHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${project}.png`, fullPage: true });
}

async function sendHeldTurn(page: Page, scenario: string) {
  await page.goto(`/?scenario=${scenario}&clean=1`);
  await page.getByLabel("Your thinking").fill("One thread could release its lock first.");
  await page.getByRole("button", { name: "Share my thinking" }).click();
}

test("a tutor turn held with money left says not enough is left, fits on the board and offers no retry", async ({ page }, info) => {
  await sendHeldTurn(page, "held-turn");
  const note = page.getByText(NOT_ENOUGH_LEFT);
  await expect(note).toBeVisible();
  await expect(page.getByText(USED_UP)).toHaveCount(0);
  const board = page.locator('.front-row-area[data-area="board"]');
  const fits = await board.evaluate((el) => el.scrollHeight <= el.clientHeight);
  expect(fits, "the board shows the held note without scrolling").toBe(true);
  const [noteBox, boardBox] = [await note.boundingBox(), await board.boundingBox()];
  expect(noteBox!.y + noteBox!.height, "the held note ends inside the board").toBeLessThanOrEqual(boardBox!.y + boardBox!.height);
  await expect(page.getByText("The tutor's reply did not finish.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await keep(page, "held-turn", info.project.name);
});

test("a tutor turn held once the allowance is spent says it is used up", async ({ page }, info) => {
  await sendHeldTurn(page, "held-turn-used-up");
  await expect(page.getByText(USED_UP)).toBeVisible();
  await expect(page.getByText(NOT_ENOUGH_LEFT)).toHaveCount(0);
  await keep(page, "held-turn-used-up", info.project.name);
});

test("preparation held by the budget says so on the lecture page", async ({ page }, info) => {
  await page.goto("/?scenario=capture-held&clean=1");
  await expect(page.getByRole("heading", { name: "Some topics are ready" })).toBeVisible();
  await expect(page.getByText(NOT_ENOUGH_LEFT)).toBeVisible();
  await keep(page, "capture-held", info.project.name);
});

test("the usage page shows this month's use against the allowance, and says used up only once it is", async ({ page }, info) => {
  await page.goto("/?scenario=usage&clean=1");
  await expect(page.getByText("$1.37 of your $5.00 AI allowance used this month. It resets on December 1.")).toBeVisible();
  await expect(page.getByText(USED_UP)).toHaveCount(0);
  await expect(page.getByRole("table").first()).toBeVisible();
  await keep(page, "usage", info.project.name);
  await page.goto("/?scenario=usage-held&clean=1");
  await expect(page.getByText("$4.79 of your $5.00 AI allowance used this month. It resets on December 1.")).toBeVisible();
  await expect(page.getByText(NOT_ENOUGH_LEFT)).toBeVisible();
  await expect(page.getByText(USED_UP)).toHaveCount(0);
  await keep(page, "usage-held", info.project.name);
});

test("hosted, a learner's usage page shows only the allowance, not the developer tables", async ({ page }, info) => {
  await page.goto("/?scenario=usage-held&clean=1&account=1");
  await expect(page.getByText("$4.79 of your $5.00 AI allowance used this month. It resets on December 1.")).toBeVisible();
  await expect(page.getByText(NOT_ENOUGH_LEFT)).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await keep(page, "usage-hosted", info.project.name);
});
