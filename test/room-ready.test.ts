import { expect, test } from "bun:test";
import { layoutRoom } from "../src/app/room/layout";
import { readyDraws } from "../src/app/room/paint";
import type { PictureState } from "../src/app/room/paint";
import { buildScene } from "../src/app/room/scene";

const draws = buildScene("study-bench", layoutRoom("study-bench", { width: 1920, height: 1080 }, "full"), 12_345).draws;
const all = (settled: PictureState) => () => settled;

test("the room paints once its plate has decoded", () => {
  expect(readyDraws(draws, all("decoded"))).toEqual(draws);
});

test("the room waits while its plate is still loading", () => {
  expect(readyDraws(draws, all("pending"))).toBe("waiting");
});

test("a plate that failed to load is a settled failure, not a wait", () => {
  expect(readyDraws(draws, all("failed"))).toBe("failed");
});
