/**
 * Flow C, 2026-11-18: after Review now or Wait, the review starts on its own once a prepared chunk has a supported claim. The backend
 * starts it from the stored ask, whichever tab or the extension asked. A lecture page that waited for it opens it, in every state the
 * options can be in, and never after the learner has left the page.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const calls = async (page: Page): Promise<string[]> =>
  ((await page.getByRole("complementary", { name: "Preview fixtures" }).locator("pre").textContent()) ?? "").split("\n");

test("an ask made elsewhere reaches a lecture page nobody asked on, which opens the review the backend started", async ({ page }) => {
  await page.goto("/?scenario=capture-unasked");
  await expect(page.getByRole("heading", { name: "Not prepared yet" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Preparing your lecture. The review starts when a section is ready." })).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/review\/rvw_/, { timeout: 15_000 });
  expect(await calls(page)).not.toContain("review.start");
  expect(await calls(page)).not.toContain("invite.review_now");
});

test("an ask reaches a lecture page that had nothing to review, which shows Processing and then opens the review", async ({ page }) => {
  await page.goto("/?scenario=capture-empty-asked");
  await expect(page.getByRole("heading", { name: "Nothing to review yet" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Preparing your lecture. The review starts when a section is ready." })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Nothing to review yet" })).toBeHidden();
  await expect(page).toHaveURL(/\/review\/rvw_/, { timeout: 15_000 });
  expect(await calls(page)).not.toContain("review.start");
});

test("leaving the lecture page before the asked review starts never opens it", async ({ page }) => {
  await page.goto("/?scenario=capture-leave");
  await page.getByRole("button", { name: "Review now" }).click();
  await expect.poll(() => calls(page)).toContain("invite.review_now");
  await page.getByRole("navigation", { name: "Capture navigation" }).getByRole("link", { name: "My notebook" }).click();
  await expect(page).toHaveURL(/\/record/);
  // The fixture answers the read 1.5 s after the ask, with the review started; wait past it.
  await page.waitForTimeout(2500);
  await expect(page).toHaveURL(/\/record/);
  expect(await calls(page)).not.toContain("review.start");
});
