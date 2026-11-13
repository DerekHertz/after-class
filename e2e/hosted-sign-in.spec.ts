import { expect, test } from "@playwright/test";

/** scripts/hosted-preview.ts: the real backend in hosted mode, and a fake Clerk that this spec routes the Clerk host to. */
const APP = "http://127.0.0.1:8774";
const FAKE_CLERK = "http://127.0.0.1:8775";

test("hosted sign-in: signed out shows the sign-in screen, signing in shows the account's lectures and a sign-out control", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://clerk.afterclass.test/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await page.request.fetch(`${FAKE_CLERK}${url.pathname}${url.search}`) });
  });

  const html = await (await page.request.get(`${APP}/app/`)).text();
  expect(html).not.toContain("afterclass-token");

  await page.goto(`${APP}/`);
  await expect(page).toHaveURL(`${APP}/app/`);
  await expect(page.getByRole("heading", { name: "Sign in to After Class" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await page.screenshot({ path: `test-results/hosted-sign-in/signed-out-${info.project.name}.png` });

  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByText("Locks - Operating Systems").first()).toBeVisible();
  await page.screenshot({ path: `test-results/hosted-sign-in/signed-in-${info.project.name}.png` });

  // An unsent answer in the account's database, written by hand because the seeded lecture has no review to answer in.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("afterclass-app.user_preview", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("unsent_turns", { keyPath: "turnId" });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("unsent_turns", "readwrite");
      tx.objectStore("unsent_turns").put({ turnId: "turn_unsent", reviewId: "rvw_unsent", act: { kind: "answer", text: "my unsent answer", modality: "text" }, createdAtMs: 1 });
      tx.oncomplete = () => (open.result.close(), resolve());
      tx.onerror = () => reject(tx.error);
    };
  }));
  const accountDatabases = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("afterclass-app.")));
  expect(await accountDatabases()).toEqual(["afterclass-app.user_preview"]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to After Class" })).toBeVisible();
  await expect.poll(accountDatabases).toEqual([]);
  expect(errors).toEqual([]);
});

test("the sign-out control stays inside the window and clear of the review's navigation", async ({ page }, info) => {
  await page.goto("/?scenario=review&clean=1&account=1");
  const signOut = page.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible();
  await expect(page.locator(".front-row-bar")).toBeVisible();
  const box = (await signOut.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const overlaps = await page.evaluate(() => {
    const rects = (selector: string) => [...document.querySelectorAll(selector)].map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0);
    const chips = rects(".scene-masthead > a, .appearance-picker > summary, .scene-masthead > .sign-out");
    const bar = rects(".front-row-bar > *");
    return chips.flatMap((c) => bar.filter((r) => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top)).length;
  });
  expect(overlaps).toBe(0);
  await page.screenshot({ path: `test-results/hosted-sign-in/review-signed-in-${info.project.name}.png` });
});
