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
  test("the flow doc lists R1 to R18", () => {
    expect([...RULES.keys()]).toEqual(Array.from({ length: 18 }, (_, k) => `R${k + 1}`));
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
