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

test("directories named rules or fakes under test/ are full", () => {
  expect(sizeReview(["test/rules/x.ts"]).tier).toBe("full");
  expect(sizeReview(["test/fakes/x.ts"]).tier).toBe("full");
});

test("an empty diff is light", () => {
  expect(sizeReview([]).tier).toBe("light");
});

test("a rename out of src is seen: the CLI lists both paths", async () => {
  const dir = await Bun.$`mktemp -d`.text();
  const run = (cmd: string) => Bun.$`sh -c ${cmd}`.cwd(dir.trim()).quiet();
  await run("git init -q . && git config user.email a@b.c && git config user.name t && mkdir src && echo 'export const x = 1;' > src/x.ts && git add . && git commit -qm a");
  await run("git mv src/x.ts note.md && git commit -qam b");
  const script = new URL("../scripts/risk-check.ts", import.meta.url).pathname;
  const out = await Bun.$`bun run ${script} HEAD~1...HEAD`.cwd(dir.trim()).nothrow().quiet();
  expect(out.exitCode).toBe(1);
  expect(out.stdout.toString()).toContain("src/x.ts");
});
