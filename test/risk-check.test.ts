import { expect, test } from "bun:test";
import { sizeReview } from "../scripts/risk-check";

test("docs, readme and ordinary tests are light", () => {
  expect(sizeReview(["docs/plans/mvp-completion.md", "README.md", "test/segmentation.test.ts"]).tier).toBe("light");
});

test("any source file is full", () => {
  const v = sizeReview(["docs/a.md", "src/backend/db.ts"]);
  expect(v).toEqual({ tier: "full", hits: ["src/backend/db.ts"] });
});

test("flow models and the rules and fakes tests are full", () => {
  expect(sizeReview(["docs/flows/model/Record.tla"]).tier).toBe("full");
  expect(sizeReview(["test/rules.test.ts"]).tier).toBe("full");
  expect(sizeReview(["test/fakes.ts"]).tier).toBe("full");
});

test("dependency, agent-config and unknown paths are full", () => {
  for (const f of ["package.json", "bun.lock", "bunfig.toml", "CLAUDE.md", ".claude/x.md", "weird/new.ts"]) {
    expect(sizeReview([f]).tier).toBe("full");
  }
});

test("an empty diff is light", () => {
  expect(sizeReview([]).tier).toBe("light");
});
