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

test("a page an older popup opened with a bare #asked, on a lecture whose review ended, shows nothing to review and opens no old review", async ({ page }) => {
  await page.goto("/?scenario=capture-reviewed#asked");
  await expect(page.getByRole("heading", { name: "Nothing to review yet" })).toBeVisible();
  // Past two more reads of the options.
  await page.waitForTimeout(7000);
  await expect(page).not.toHaveURL(/\/review\/rvw_/);
  await expect(page.getByRole("heading", { name: "Nothing to review yet" })).toBeVisible();
});

test("Wait on a lecture that stops with every claim unverified ends in nothing to review, not Processing", async ({ page }) => {
  await page.goto("/?scenario=capture-exhausted");
  await page.getByRole("button", { name: "Wait" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Preparing your lecture. The review starts when a section is ready." })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Nothing to review yet" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Preparing your lecture")).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/review\/rvw_/);
});

test("a waiting page whose asked review another tab already ended shows the lecture and opens nothing", async ({ page }) => {
  await page.goto("/?scenario=capture-ended-ask#asked=1");
  await expect(page.getByRole("heading", { name: "Nothing to review yet" })).toBeVisible();
  // Past two more reads of the options.
  await page.waitForTimeout(7000);
  await expect(page).not.toHaveURL(/\/review\/rvw_/);
  await expect(page.getByRole("heading", { name: "Nothing to review yet" })).toBeVisible();
});

test("an asked review the day's review limit refuses shows the refusal, not Processing", async ({ page }) => {
  await page.goto("/?scenario=capture-limit");
  await page.getByRole("button", { name: "Wait" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Preparing your lecture. The review starts when a section is ready." })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("alert").filter({ hasText: "You have started a lot of reviews today that never reached a question from the tutor." })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Preparing your lecture")).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/review\/rvw_/);
});

test("Review now when another tab already started the lecture's review opens that review", async ({ page }) => {
  await page.goto("/?scenario=capture-joined");
  await page.getByRole("button", { name: "Review now" }).click();
  await expect(page).toHaveURL(/\/review\/rvw_/, { timeout: 10_000 });
  expect(await calls(page)).not.toContain("review.start");
});

test("a lecture nobody asked for invents no time estimate", async ({ page }) => {
  await page.goto("/?scenario=capture-unasked");
  await expect(page.getByText("Either one prepares this lecture.")).toBeVisible();
  await expect(page.getByText(/minute/)).toHaveCount(0);
});
