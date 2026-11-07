import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPANIONS } from "../src/app/appearance";
import type { CompanionId } from "../src/app/appearance";
import { COMPANION_SPRITES, CompanionDrawing, POSES, companionPose } from "../src/app/companion";
import { pixel, readPng } from "./png";

const ids = Object.keys(COMPANIONS) as CompanionId[];
const sheet = (id: CompanionId) => readPng(new URL(`../src/app/assets/companions-v3/${id}.png`, import.meta.url));

describe("companion poses", () => {
  test("a reaction picks its own pose, and no reaction is the idle pose", () => {
    expect(POSES).toEqual(["idle", "draw", "read"]);
    expect(companionPose(undefined)).toBe("idle");
    expect(companionPose("draw")).toBe("draw");
    expect(companionPose("read")).toBe("read");
  });

  test("the drawing shows the reacting pose's column at one cell's aspect", () => {
    const html = renderToStaticMarkup(<CompanionDrawing id="pip" gesture="read" sequence={3} />);
    expect(html).toContain('data-pose="read"');
    expect(html).toContain("--pose:2");
    expect(html).toContain("--cell-aspect:724 / 724");
    expect(renderToStaticMarkup(<CompanionDrawing id="pip" />)).toContain("--pose:0");
  });
});

describe("every companion sheet is three whole, transparent, registered poses", () => {
  for (const id of ids) {
    test(id, () => {
      const png = sheet(id);
      const { cell } = COMPANION_SPRITES[id];
      expect({ width: png.width, height: png.height, alpha: png.alpha }).toEqual({ width: cell.width * 3, height: cell.height, alpha: true });
      const bottoms: number[] = [];
      for (const column of POSES.keys()) {
        const x0 = column * cell.width;
        let left = Infinity, right = -1, top = Infinity, bottom = -1, opaque = 0;
        for (let y = 0; y < cell.height; y += 2) for (let x = x0; x < x0 + cell.width; x += 2) {
          if (pixel(png, x, y)[3] > 16) { opaque++; left = Math.min(left, x - x0); right = Math.max(right, x - x0); top = Math.min(top, y); bottom = Math.max(bottom, y); }
        }
        // A real mascot fills part of the cell, and no part of it touches the cell edge, so no pose bleeds into the next.
        expect(opaque / ((cell.width * cell.height) / 4)).toBeGreaterThan(0.1);
        expect(left).toBeGreaterThan(8);
        expect(right).toBeLessThan(cell.width - 8);
        expect(top).toBeGreaterThan(8);
        expect(bottom).toBeLessThan(cell.height - 8);
        bottoms.push(bottom);
      }
      // Poses stand on the same baseline, so switching pose does not make the companion jump.
      expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(cell.height * 0.03);
    });
  }
});
