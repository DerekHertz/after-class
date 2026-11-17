/**
 * The answer box on the desk mat must be readable in every room: its typed text, its placeholder and the main button
 * beside it each meet WCAG AA (4.5 to 1). The Lantern Canal Film Club has a navy mat, so it is the room most likely to slip.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FRONT_ROW_ROOMS } from "../src/app/room/rooms";

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
const mix = (a: Rgb, b: Rgb, aShare: number): Rgb => [0, 1, 2].map((i) => a[i]! * aShare + b[i]! * (1 - aShare)) as unknown as Rgb;
const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (c: Rgb) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const ratio = (a: Rgb, b: Rgb) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

const css = readFileSync(new URL("../src/app/front-row.css", import.meta.url), "utf8");
/** The share of the field's ink in the placeholder, read from the stylesheet so this test follows it. */
const placeholderShare = Number(/textarea::placeholder \{ color: color-mix\(in srgb, var\(--fr-field-ink\) (\d+)%, var\(--fr-field\)\)/.exec(css)?.[1]) / 100;
/** The share of the accent in the disabled main button's background. */
const disabledShare = Number(/\.primary-action:disabled \{[^}]*background: color-mix\(in srgb, var\(--fr-accent\) (\d+)%, var\(--fr-field\)\)/.exec(css)?.[1]) / 100;

describe("the answer box on the mat meets WCAG AA in every room", () => {
  test("the stylesheet's placeholder and disabled-button mixes were found", () => {
    expect(placeholderShare).toBeGreaterThan(0);
    expect(disabledShare).toBeGreaterThan(0);
  });

  for (const [id, room] of Object.entries(FRONT_ROW_ROOMS)) {
    const { field, fieldInk, accent, accentInk, quiet, quietInk } = room.palette;
    test(`${id}: typed text, placeholder, buttons and the mat's own text`, () => {
      expect(ratio(rgb(fieldInk), rgb(field))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(mix(rgb(fieldInk), rgb(field), placeholderShare), rgb(field))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(rgb(accentInk), rgb(accent))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(rgb(quietInk), rgb(quiet))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(rgb(room.mat.ink), rgb(room.mat.fill))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(rgb(room.mat.inkSoft), rgb(room.mat.fill))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(rgb(fieldInk), mix(rgb(accent), rgb(field), disabledShare))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
