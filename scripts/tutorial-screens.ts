import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Walks the companion's tutorial in the UI preview and saves a screenshot of every step.
 * Start the preview first (`bun run scripts/preview-ui.ts`), then `bun run scripts/tutorial-screens.ts [outDir] [width] [height]`.
 */
const base = process.env.AFTERCLASS_PREVIEW_URL ?? `http://127.0.0.1:${process.env.AFTERCLASS_PREVIEW_PORT ?? 8770}`;
const [out = "docs/trail/tutorial-screens", width = "1280", height = "800"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const places = [
  { name: "home-connect", query: "scenario=home-empty&account=1" },
  { name: "home-capture", query: "scenario=home-connected&account=1" },
  { name: "capture", query: "scenario=capture-ready" },
  { name: "checklist", query: "scenario=fuzzy-checklist" },
  { name: "question", query: "scenario=review" },
  { name: "notebook", query: "scenario=record" },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, reducedMotion: "reduce" });
let n = 1;
for (const place of places) {
  await page.goto(`${base}/?${place.query}&tutorial=1&clean=1`);
  const bubble = page.getByRole("dialog", { name: /^Tutorial from/ });
  await bubble.waitFor({ timeout: 15_000 });
  for (let step = 1; ; step++) {
    await page.waitForTimeout(600);
    const file = `${out}/${String(n++).padStart(2, "0")}-${place.name}-${step}.jpg`;
    await page.screenshot({ path: file, type: "jpeg", quality: 85 });
    console.log(file, await bubble.locator(".tutorial-text").innerText());
    const next = bubble.getByRole("button", { name: /^(Next|Got it)$/ });
    const label = await next.innerText();
    await next.click();
    if (label === "Got it") break;
  }
}
await browser.close();
