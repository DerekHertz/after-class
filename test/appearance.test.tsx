import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { APPEARANCE_KEY, COMPANIONS, DEFAULT_APPEARANCE, SCENES, parseAppearance, persistAppearance, readAppearance } from "../src/app/appearance";
import { CompanionDrawing } from "../src/app/companion";
import { SceneShell } from "../src/app/scene";

describe("local appearance preferences", () => {
  test("invalid JSON, missing records, arrays and primitive values recover to defaults", () => {
    for (const raw of [null, "{", "null", "[]", "42", '"mote"']) expect(parseAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
  });
  test("room and companion are independent, with per-field recovery", () => {
    for (const scene of Object.keys(SCENES) as (keyof typeof SCENES)[]) for (const companion of Object.keys(COMPANIONS) as (keyof typeof COMPANIONS)[]) {
      expect(parseAppearance(JSON.stringify({ scene, companion, visible: false, motion: "reduced" }))).toEqual({ scene, companion, visible: false, motion: "reduced" });
    }
    expect(parseAppearance('{"scene":"__proto__","companion":"lumi","visible":"no","motion":"anything"}')).toEqual({ ...DEFAULT_APPEARANCE, companion: "lumi" });
    expect(parseAppearance('{"scene":"study-bench","companion":"constructor"}')).toEqual({ ...DEFAULT_APPEARANCE, scene: "study-bench" });
  });
  test("storage denial leaves an in-memory appearance usable", () => {
    const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
    expect(readAppearance(denied)).toEqual(DEFAULT_APPEARANCE);
    expect(persistAppearance(denied, DEFAULT_APPEARANCE)).toBe(false);
    expect(persistAppearance(null, DEFAULT_APPEARANCE)).toBe(false);
    let record = "";
    expect(persistAppearance({ setItem(key, value) { expect(key).toBe(APPEARANCE_KEY); record = value; } }, { ...DEFAULT_APPEARANCE, companion: "yun" })).toBe(true);
    expect(readAppearance({ getItem() { return record; } }).companion).toBe("yun");
  });
  test("every companion is a separate scalable transparent illustration", () => {
    for (const id of Object.keys(COMPANIONS) as (keyof typeof COMPANIONS)[]) {
      const html = renderToStaticMarkup(<CompanionDrawing id={id} />);
      expect(html).toContain('<svg');
      expect(html).not.toContain('<image');
    }
  });
  test("appearance controls are separate from the stable workspace", () => {
    const html = renderToStaticMarkup(<SceneShell><main><textarea aria-label="Draft" defaultValue="Still thinking" /></main></SceneShell>);
    expect(html).toContain("Still thinking");
    expect(html).toContain("Show companion");
    expect(html).toContain("Reduce motion");
    for (const s of Object.values(SCENES)) expect(html).toContain(s.name);
    for (const c of Object.values(COMPANIONS)) expect(html).toContain(c.name);
  });
});
