/**
 * Derek's rules. The quote check runs now; each rule's behaviour test is a
 * todo naming its enforcing mechanism and owner workstream. Owners replace a
 * todo with the real test (FakeTask only, no live calls). [TLC] rules also stay
 * checked by docs/flows/model/*.tla.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const RULES = new Map(
  [...readFileSync(join(ROOT, "docs/flows/after-class.md"), "utf8").matchAll(/^- (R\d+) `\[(?:test|TLC)\]` (.+)$/gm)].map((m) => [m[1]!, m[2]!]),
);

describe("Derek's rules are quoted verbatim", () => {
  test("the flow doc lists R1 to R19", () => {
    expect([...RULES.keys()]).toEqual(Array.from({ length: 19 }, (_, k) => `R${k + 1}`));
  });

  test("every `Rn: \"…\"` quote in src/ matches the flow doc exactly, and every rule is quoted", () => {
    const quoted = new Set<string>();
    const mismatches: string[] = [];
    for (const path of new Glob("src/**/*.{ts,tsx}").scanSync(ROOT)) {
      const text = readFileSync(join(ROOT, path), "utf8").replace(/\n\s*(\*|--|\/\/)\s*/g, " ");
      for (const m of text.matchAll(/\b(R\d+): "([^"]+)"/g)) {
        quoted.add(m[1]!);
        if (RULES.get(m[1]!) !== m[2]) mismatches.push(`${path}: ${m[1]} "${m[2]}"`);
      }
    }
    expect(mismatches).toEqual([]);
    expect([...RULES.keys()].filter((r) => !quoted.has(r))).toEqual([]);
  });
});

describe("Derek's rules", () => {
  test.todo("R3 a header with a non-assessable claim id is rejected before any word streams; assessable() returns null unless supported_by_check (W8: validateMove; W6: assessable)");
  test.todo("R6 options() is ready with resource search pending or failed (W7)");
  test.todo("R8 a hit stored after the stop-early Seq leaves the claim dropped; an outdated input key is never selected; save never writes note_edits (W6, W8)");
  test.todo("R15 save twice ⇒ identical row counts and IDs; a resent turn or start with the same app-minted id inserts nothing (W8, W7)");
});

describe("the diagram lines and R19 are in the flow doc byte for byte (Derek: \"Approve as written\", 2026-11-06)", () => {
  const doc = readFileSync(join(ROOT, "docs/flows/after-class.md"), "utf8");
  const SHOW = [
    `[user]  Ask "show me the diagram" on a topic, any time in the review.`,
    `[code]  Show the frame that topic's claims cite (or, if none, the frame captured`,
    `        during its cited passages), with its time and a link to that moment.`,
    `[agent] Add a short state-change summary: what changes, in order, with concrete`,
    `        values first; each line cites the passage or frame it comes from.`,
  ].join("\n");
  const PAGE = [
    `[code]  After a review is saved, one illustrated page per topic it covered: the`,
    `        tutor's question, the frame, the state-change summary, my answer, and`,
    `        its status.`,
  ].join("\n");

  test("the show-me-the-diagram lines follow the answer line in section D", () => {
    expect(doc).toContain(`[user] Speak/type an answer, skip, "I don't know", hint, explain-it, pause, end.\n${SHOW}\n[agent] Up to 3 main questions;`);
  });

  test("the illustrated page line sits just before the record's inspect line", () => {
    expect(doc).toContain(`${PAGE}\n[user] Inspect, edit, accept/correct links, revisit, delete.`);
  });

  test("R19 follows R18 and reads exactly as approved", () => {
    expect(doc).toContain("- R18 `[test]` A quick check I pass only shows the topic looks fine; it's never recorded as understood the way a main question is.\n- R19 `[test]` Every line of a diagram summary cites something I watched; a line without a citation is never shown.\n");
    expect(RULES.get("R19")).toBe("Every line of a diagram summary cites something I watched; a line without a citation is never shown.");
    expect(doc).toContain("approved by Derek as written on 2026-11-06. R19 likewise on 2026-11-06. Quote verbatim.");
  });

  test("the amendment note quotes Derek's request and his reply", () => {
    expect(doc).toContain(`Amendment (2026-11-06), Derek: "diagrams, stuff that like I can use to explore and kind of pick apart the topics. And this should be interpretable, like concise diagrams that kind of describe the state."`);
    expect(doc).toContain(`Derek replied "Approve as written".`);
  });
});
