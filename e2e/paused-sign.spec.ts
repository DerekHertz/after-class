import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

/**
 * The paused sign in a real Chromium page. The browser is the point: a closed shadow root, `isTrusted`, keyboard
 * activation and focus have no stand-in in a unit test. The sign's source has no imports, so `bun build` turns it
 * into a module that runs in the page as it is; the page here is a stand-in for the player, not youtube.com.
 */
const SIGN = execFileSync("bun", ["build", "src/extension/content/paused-sign.ts", "--target=browser", "--format=esm"], { encoding: "utf8" });

const PAGE = `<body style="margin:0;background:#0f0f0f"><div style="height:56px"></div>
<div id="movie_player" tabindex="-1" style="position:relative;aspect-ratio:16/9;width:100%;max-width:1280px;background:#224"></div><h2 style="color:#eee">Lecture</h2></body>`;

async function open(page: Page, recheckMs = 20): Promise<void> {
  await page.setContent(PAGE);
  await page.addScriptTag({ type: "module", content: `${SIGN}\nwindow.createPausedSign = createPausedSign;` });
  await page.waitForFunction(() => "createPausedSign" in window);
  await page.evaluate(
    (ms) => {
      const w = window as unknown as Record<string, unknown>;
      w.resumed = 0;
      w.keys = 0;
      const player = () => document.querySelector<HTMLElement>("#movie_player");
      w.sign = (w.createPausedSign as Function)(() => document, player, ms);
      w.show = () => (w.sign as { show(f: () => void): void }).show(() => (w.resumed as number)++);
      document.addEventListener("keydown", () => (w.keys as number)++);
      player()!.addEventListener("keydown", () => (w.keys as number)++);
    },
    recheckMs,
  );
}

const count = (page: Page) => page.locator("#afterclass-paused-sign").count();
const run = (page: Page, fn: string) => page.evaluate(`(() => { const w = window; ${fn} })()`);
const resumed = (page: Page) => page.evaluate(() => (window as unknown as { resumed: number }).resumed);

test("page script cannot reach the sign's buttons or press Resume", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    // What a page that got in first would do: hold the shadow root the sign builds.
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      (window as unknown as { leaked: ShadowRoot }).leaked = root;
      return root;
    };
  });
  await run(page, "w.show()");
  expect(await page.evaluate(() => document.querySelector("#afterclass-paused-sign")!.shadowRoot)).toBeNull();
  await run(page, 'w.leaked.querySelector(".resume").click(); w.leaked.querySelector(".resume").dispatchEvent(new MouseEvent("click", { bubbles: true }));');
  expect(await resumed(page)).toBe(0);
  await run(page, 'w.leaked.querySelector(".hide").click();');
  expect(await count(page)).toBe(1);
  const box = await page.evaluate(() => {
    const r = (window as unknown as { leaked: ShadowRoot }).leaked.querySelector(".resume")!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  expect(await resumed(page)).toBe(1);
});

test("replacing the player puts the sign into the new one, and only while it is wanted", async ({ page }) => {
  await open(page);
  await run(page, "w.show()");
  await run(page, 'const old = document.querySelector("#movie_player"); const fresh = old.cloneNode(false); old.replaceWith(fresh);');
  await expect.poll(() => page.evaluate(() => document.querySelector("#movie_player #afterclass-paused-sign") !== null)).toBe(true);
  expect(await count(page)).toBe(1);
  await run(page, "w.sign.remove(); const fresh = document.querySelector('#movie_player').cloneNode(false); document.querySelector('#movie_player').replaceWith(fresh);");
  await page.waitForTimeout(100);
  expect(await count(page)).toBe(0);
});

test("Hide lasts through leaving the page and coming back, and clears when the pause ends", async ({ page }) => {
  await open(page);
  await run(page, "w.show()");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  expect(await count(page)).toBe(0);
  await run(page, "w.show()");
  expect(await count(page)).toBe(0);
  await run(page, "w.sign.remove(); w.show()");
  expect(await count(page)).toBe(0);
  await run(page, "w.sign.reset(); w.show()");
  expect(await count(page)).toBe(1);
});

test("keys on the sign stay off the page, buttons still activate from the keyboard, and focus returns to the player", async ({ page }) => {
  await open(page);
  await run(page, "w.show()");
  await page.keyboard.press("Tab");
  await run(page, "w.keys = 0");
  await page.keyboard.press("k");
  await page.keyboard.press("ArrowRight");
  expect(await page.evaluate(() => (window as unknown as { keys: number }).keys)).toBe(0);
  await page.keyboard.press("Enter");
  expect(await resumed(page)).toBe(1);
  await page.keyboard.press("Space");
  expect(await resumed(page)).toBe(2);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  expect(await count(page)).toBe(0);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("movie_player");
});
