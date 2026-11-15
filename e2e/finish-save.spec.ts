import { expect, test } from "@playwright/test";

/** scripts/finish-save-preview.ts: the real backend with fake model calls. The tutor's closing line takes 3 s and the summary call 5 s. */
const CONTROL = "http://127.0.0.1:8777";
const CLOSING_MS = 3000;
const SUMMARY_MS = 5000;

test("Finish & save shows the closing line while the summary is written, then the saved review, in about the summary's time (#234)", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { reviewId, origin } = (await (await request.post(`${CONTROL}/new`, { timeout: 30_000 })).json()) as { reviewId: string; origin: string };
  await page.goto(`${origin}/app/review/${reviewId}`);

  await page.locator('.front-row-bar button[data-action="end"]').click();
  const confirm = page.getByRole("alertdialog", { name: "Finish and save this review?" });
  await expect(confirm).toBeVisible();
  const clicked = Date.now();
  await confirm.getByRole("button", { name: "Finish & save" }).click();

  const closing = page.getByText("That is the end of this review.", { exact: false });
  const saving = page.getByText("Saving this review to your notebook...");
  const saved = page.getByRole("heading", { name: "Review saved" });

  await expect(closing.first()).toBeVisible({ timeout: 10_000 });
  await expect(saved).toHaveCount(0);
  await expect(saving).toBeVisible({ timeout: 10_000 });
  await expect(saved).toHaveCount(0);

  await expect(saved).toBeVisible({ timeout: 15_000 });
  const elapsed = Date.now() - clicked;
  await expect(saving).toHaveCount(0);
  await expect(page.getByText("Retry save")).toHaveCount(0);

  // Serial, the closing line and the summary take 8 s (9.2 s measured before the change, with the page's own reads). The summary starts with the closing line,
  // so the wait is the longer of the two (5.5 to 6.2 s measured).
  expect(elapsed, "click to Review saved, in ms").toBeLessThan(CLOSING_MS + SUMMARY_MS - 500);
  expect(elapsed).toBeGreaterThanOrEqual(SUMMARY_MS - 500);

  const calls = (await (await request.get(`${CONTROL}/calls?reviewId=${reviewId}`)).json()) as { closingMs: number; summaryMs: number };
  expect(Math.abs(calls.summaryMs - calls.closingMs), "the summary call began with the closing line, in ms").toBeLessThan(1000);
  expect(errors).toEqual([]);
});
