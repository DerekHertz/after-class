import { chromium, expect, test } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { resolve } from "node:path";

/**
 * scripts/hosted-preview.ts: the real backend in hosted mode behind a fake Clerk, and the hosted extension built for
 * its origin. The extension is loaded unpacked into Chromium, so the connect page, Chrome's externally_connectable,
 * the worker's exchange and the Origin Chrome puts on the worker's requests are all real. Nothing reaches Clerk.
 */
const APP = "http://127.0.0.1:8774";
const FAKE_CLERK = "http://127.0.0.1:8775";
/** scripts/hosted-preview.ts builds it there; Playwright runs from the repository root, as the screenshot paths assume. */
const EXTENSION = resolve("dist/hosted-preview-extension");
const SHOTS = "test-results/connect-extension";

async function viaFakeClerk(target: Page | BrowserContext): Promise<void> {
  await target.route("https://clerk.afterclass.test/**", async (route) => {
    const url = new URL(route.request().url());
    const res = await fetch(`${FAKE_CLERK}${url.pathname}${url.search}`);
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
}

async function signIn(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in to After Class" })).toBeVisible();
  await page.getByRole("button", { name: "Continue with Google" }).click();
}

const capture = (captureId: string) => ({
  captureId,
  facts: [
    { kind: "control", action: "start", reason: "user", clientSeq: 0, wallMs: 1000 },
    { kind: "source", videoId: "dQw4w9WgXcQ", title: "Connected lecture", channelName: "Prof", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", durationS: 600, clientSeq: 1, wallMs: 1001 },
  ],
});

/** What the extension's worker does with its stored token, run inside the real worker, so Chrome sets the request's Origin. */
const ingestFromWorker = (worker: Worker, body: unknown) =>
  worker.evaluate(async ([app, payload]) => {
    const stored = (await chrome.storage.local.get("connection")).connection as { token: string };
    const res = await fetch(`${app}/ingest`, { method: "POST", headers: { Authorization: `Bearer ${stored.token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return res.status;
  }, [APP, body] as const);

test("a signed-out friend opens the connect page, signs in, connects, and the extension's own requests are accepted until the browser is revoked", async ({ browserName }, info) => {
  test.skip(browserName !== "chromium" || info.project.name !== "desktop", "one real Chromium run is enough; the narrow layout is covered by the not-installed test");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  try {
    await viaFakeClerk(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 420 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await popup.screenshot({ path: `${SHOTS}/popup-not-connected.png` });
    const opened = context.waitForEvent("page");
    await popup.getByRole("button", { name: "Connect", exact: true }).click();
    const page = await opened;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 860 });
    await expect(page).toHaveURL(`${APP}/app/connect-extension`);
    // A tab the extension opens stayed blank under the fake Clerk's routing (likely loaded before the route attached); loading it again fixes that.
    await page.reload();
    expect(await page.locator('meta[name="afterclass-extension-id"]').getAttribute("content")).toBe(extensionId);
    await page.screenshot({ path: `${SHOTS}/signed-out.png` });
    await signIn(page);
    const connect = page.getByRole("button", { name: "Connect this browser's extension" });
    await expect(connect).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/connect.png` });
    await connect.click();
    await expect(page.getByText("This browser's extension is connected.")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/connected.png` });

    const stored = await worker.evaluate(async () => ({ local: await chrome.storage.local.get("connection"), sync: await chrome.storage.sync.get(null) }));
    expect((stored.local.connection as { token: string }).token).toMatch(/^acd_/);
    expect(stored.sync).toEqual({});
    expect(await ingestFromWorker(worker, capture("cap_bbbbbbbbbbbbbbbbbbbbbbbbbb"))).toBe(200);

    await popup.reload();
    await expect(popup.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);

    await page.goto(`${APP}/app/usage`);
    const list = page.locator(".connected-browsers");
    await expect(list.getByText("Chrome on Linux")).toBeVisible();
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/connected-browsers.png`, fullPage: true });
    await list.getByRole("button", { name: "Revoke" }).click();
    await expect(list.getByText("No browser is connected.")).toBeVisible();
    expect(await ingestFromWorker(worker, capture("cap_cccccccccccccccccccccccccc"))).toBe(401);

    // The worker empties a refused token on its own 401; this sets the state that leaves, to show the popup's Reconnect.
    await worker.evaluate(async () => {
      const { connection } = await chrome.storage.local.get("connection");
      await chrome.storage.local.set({ connection: { ...(connection as object), token: null } });
    });
    await popup.reload();
    await expect(popup.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await popup.screenshot({ path: `${SHOTS}/popup-reconnect.png` });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("without the extension, Connect says it is not installed and links to the store", async ({ page }, info) => {
  await viaFakeClerk(page);
  await page.goto(`${APP}/app/connect-extension`);
  await signIn(page);
  await page.getByRole("button", { name: "Connect this browser's extension" }).click();
  await expect(page.getByText("The After Class extension is not installed in this browser.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Get it from the Chrome Web Store" })).toHaveAttribute("href", /^https:\/\/chromewebstore\.google\.com\/detail\/[a-p]{32}$/);
  await page.screenshot({ path: `${SHOTS}/not-installed-${info.project.name}.png` });
});
