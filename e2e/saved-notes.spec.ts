import { expect, test } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, SCENES } from "../src/app/appearance";

for (const scene of Object.keys(SCENES)) {
  test(`Saved notes: edit, scroll, cancel and restore focus in ${scene}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene, motion: "reduced" },
    });
    await page.goto("/?scenario=review&clean=1");
    const opener = page.getByRole("button", { name: "Saved notes", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Saved notes" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "My notebook" })).toBeVisible();
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);

    const close = dialog.getByRole("button", { name: "Close notebook" });
    await close.focus();
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);

    await dialog.getByRole("button", { name: /Edit your note on/ }).first().click();
    const note = "A saved explanation that is long enough to scroll. ".repeat(100);
    await dialog.getByRole("textbox", { name: "Your edit", exact: true }).fill(note);
    await dialog.getByRole("button", { name: "Save edit", exact: true }).click();
    await expect(dialog.getByText(note, { exact: false })).toBeVisible();
    const paper = dialog.locator(".notebook-page");
    expect(await paper.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await paper.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => paper.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(close).toBeInViewport();
    expect(await paper.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(dialog.getByText(note, { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: /Edit your note on/ }).first().click();
    await dialog.getByRole("textbox", { name: "Your edit", exact: true }).fill("Discard this draft");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog.getByText(note, { exact: false })).toBeVisible();
    await close.click();
    await expect(opener).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test("failed notebook load retries without a request loop", async ({ page }) => {
  await page.goto("/?scenario=record-error");
  await expect(page.getByRole("alert")).toContainText("Fixture notebook could not load");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: /Edit your note on/ }).first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const ledger = page.getByRole("complementary", { name: "Preview fixtures" });
  await ledger.getByText("Request ledger", { exact: true }).click();
  await expect.poll(async () => (await ledger.locator("pre").innerText()).split("record.read").length - 1).toBe(2);
});

test("source evidence retries once and renders a loaded frame", async ({ page }) => {
  await page.goto("/?scenario=evidence-error");
  await page.getByRole("button", { name: /^Open source/ }).click();
  const dialog = page.getByRole("dialog", { name: /Lecture evidence/ });
  await expect(dialog.getByRole("alert")).toContainText("Fixture evidence request failed");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("img", { name: "Lecture frame" })).toBeVisible();
  await expect.poll(() => dialog.getByRole("img", { name: "Lecture frame" }).evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
  await page.keyboard.press("Escape");
  const ledger = page.getByRole("complementary", { name: "Preview fixtures" });
  await ledger.getByText("Request ledger", { exact: true }).click();
  await expect.poll(async () => (await ledger.locator("pre").innerText()).split("evidence.read").length - 1).toBe(2);
});
