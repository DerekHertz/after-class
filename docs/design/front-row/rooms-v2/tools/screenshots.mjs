// Screenshots every frame of preview.html into screenshots/. Run from the repo root: bun docs/design/front-row/rooms-v2/tools/screenshots.mjs [room]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const only = process.argv[2];
mkdirSync(join(root, "screenshots"), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2700, height: 1400 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(root, "preview.html")).href);
await page.evaluate(() => document.fonts.ready);
for (const id of await page.$$eval("figure", (figures) => figures.map((f) => f.id))) {
  if (only && !id.startsWith(only)) continue;
  // Only the frame being captured is laid out, which keeps each capture fast. The frame itself is unchanged.
  const hide = await page.addStyleTag({ content: `figure:not(#${id}) { display: none; }` });
  await page.locator(`#${id} .frame`).screenshot({ path: join(root, "screenshots", `${id}.png`) });
  await hide.evaluate((style) => style.remove());
  console.log(id);
}
await browser.close();
