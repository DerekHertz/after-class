import { expect, test } from "@playwright/test";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, SCENES } from "../src/app/appearance";

const windows = [{ width: 1440, height: 900 }, { width: 1470, height: 1270 }, { width: 1920, height: 1080 }];

type Box = { left: number; top: number; right: number; bottom: number };
const within = (inner: Box, outer: Box) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const scene of Object.keys(SCENES)) {
  for (const size of windows) {
    test(`in ${scene} at ${size.width}x${size.height} the board text and Your thinking lie on their art and clear the navigation`, async ({ page }, info) => {
      test.skip(info.project.name === "narrow", "the phone layout stacks flat surfaces");
      await page.setViewportSize(size);
      await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: APPEARANCE_KEY, value: { ...DEFAULT_APPEARANCE, scene } });
      await page.goto("/?scenario=review&clean=1");
      await expect(page.locator('.front-row-area[data-area="board"]')).toContainText("What would have to change");
      await page.evaluate(() => document.fonts.ready);
      const boxes = await page.evaluate(() => {
        const box = (node: Element): Box => {
          const r = node.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        const one = (selector: string) => box(document.querySelector(selector)!);
        const navigation = [...document.querySelectorAll(".scene-masthead > *, .front-row-bar > *, .front-row-bar .review-navigation > *")].map(box).filter((b) => b.right > b.left && b.bottom > b.top);
        return {
          boardArt: one('.front-row-art [data-layer="board"]'), boardText: one('.front-row-area[data-area="board"]'),
          heading: one(".front-row-heading"), showDiagram: one(".front-row-heading .show-diagram"), question: one(".current-exchange .line[data-question]"),
          overflow: (({ scrollHeight, clientHeight }) => scrollHeight - clientHeight)(document.querySelector('.front-row-area[data-area="board"]')!),
          matArt: one('.front-row-art [data-layer="mat"]'), deskText: one('.front-row-area[data-area="desk"]'), field: one(".composer textarea"),
          buddy: one(".front-row-buddy"), notebook: one('.front-row-object[data-object="history"]'), folio: one('.front-row-object[data-object="source"]'),
          desk: one('.front-row-art [data-layer="desk"]'), navigation, window: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
        };
      });
      expect(boxes.navigation.length).toBeGreaterThan(3);
      expect(within(boxes.boardText, boxes.boardArt)).toBe(true);
      expect(boxes.overflow).toBeLessThanOrEqual(1);
      for (const part of [boxes.heading, boxes.showDiagram, boxes.question]) expect(within(part, boxes.boardText)).toBe(true);
      expect(within(boxes.deskText, boxes.matArt)).toBe(true);
      expect(within(boxes.field, boxes.deskText)).toBe(true);
      for (const [name, b] of Object.entries({ boardText: boxes.boardText, field: boxes.field, buddy: boxes.buddy, notebook: boxes.notebook, folio: boxes.folio })) {
        expect({ name, inWindow: within(b, boxes.window) }).toEqual({ name, inWindow: true });
        for (const nav of boxes.navigation) expect({ name, hitsNavigation: overlaps(b, nav) }).toEqual({ name, hitsNavigation: false });
      }
      expect(overlaps(boxes.boardText, boxes.deskText)).toBe(false);
      for (const side of [boxes.buddy, boxes.notebook, boxes.folio]) expect(overlaps(side, boxes.matArt)).toBe(false);
    });
  }
}
