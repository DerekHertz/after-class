/**
 * Flow C, 2026-11-18: after Review now or Wait, the review starts on its own once a prepared chunk has a supported claim. The lecture page
 * starts it from the stored ask, whichever tab or the extension asked, and never after the learner has left the page.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const calls = async (page: Page): Promise<string[]> =>
  ((await page.getByRole("complementary", { name: "Preview fixtures" }).locator("pre").textContent()) ?? "").split("\n");

test("an ask made elsewhere reaches a lecture page nobody asked on, which starts the asked review", async ({ page }) => {
  await page.goto("/?scenario=capture-unasked");
  await expect(page.getByRole("heading", { name: "Not prepared yet" })).toBeVisible();
  await expect(page).toHaveURL(/\/review\/rvw_/, { timeout: 15_000 });
  expect((await calls(page)).filter((c) => c === "review.start")).toHaveLength(1);
  expect(await calls(page)).not.toContain("invite.review_now");
});

test("leaving the lecture page while its first section is read never starts a review", async ({ page }) => {
  await page.goto("/?scenario=capture-leave");
  await page.getByRole("button", { name: "Review now" }).click();
  await expect.poll(() => calls(page)).toContain("invite.review_now");
  await page.getByRole("navigation", { name: "Capture navigation" }).getByRole("link", { name: "My notebook" }).click();
  await expect(page).toHaveURL(/\/record/);
  // The fixture answers the read 1.5 s after the ask; wait past it.
  await page.waitForTimeout(2500);
  await expect(page).toHaveURL(/\/record/);
  expect(await calls(page)).not.toContain("review.start");
});
