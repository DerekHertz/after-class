import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const USED_UP = "This month's AI allowance is used up. It resets on December 1.";

/** AFTERCLASS_SCREENSHOTS=<dir> keeps a full-page picture of each state for review. */
async function keep(page: Page, name: string, project: string) {
  const dir = process.env.AFTERCLASS_SCREENSHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${project}.png`, fullPage: true });
}

test("a tutor turn held by the budget says so in plain words and offers no retry", async ({ page }, info) => {
  await page.goto("/?scenario=held-turn&clean=1");
  await page.getByLabel("Your thinking").fill("One thread could release its lock first.");
  await page.getByRole("button", { name: "Share my thinking" }).click();
  await expect(page.getByText(USED_UP)).toBeVisible();
  await expect(page.getByText("The tutor's reply did not finish.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await keep(page, "held-turn", info.project.name);
});

test("preparation held by the budget says so on the lecture page", async ({ page }, info) => {
  await page.goto("/?scenario=capture-held&clean=1");
  await expect(page.getByRole("heading", { name: "Some topics are ready" })).toBeVisible();
  await expect(page.getByText(USED_UP)).toBeVisible();
  await keep(page, "capture-held", info.project.name);
});

test("the usage page shows this month's use against the allowance", async ({ page }, info) => {
  await page.goto("/?scenario=usage&clean=1");
  await expect(page.getByText("$1.37 of your $5.00 AI allowance used this month. It resets on December 1.")).toBeVisible();
  await expect(page.getByText(USED_UP)).toHaveCount(0);
  await keep(page, "usage", info.project.name);
  await page.goto("/?scenario=usage-held&clean=1");
  await expect(page.getByText("$4.79 of your $5.00 AI allowance used this month. It resets on December 1.")).toBeVisible();
  await expect(page.getByText(USED_UP)).toBeVisible();
  await keep(page, "usage-held", info.project.name);
});
