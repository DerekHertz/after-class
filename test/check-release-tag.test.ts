import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { releaseTagProblem } from "../scripts/check-release-tag";

const SCRIPT = resolve(import.meta.dir, "../scripts/check-release-tag.ts");
const version = (JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;

describe("check-release-tag", () => {
  test("a tag equal to v plus the package version passes", () => {
    expect(releaseTagProblem("v0.1.0", "0.1.0")).toBeNull();
    expect(releaseTagProblem("v1.20.3", "1.20.3")).toBeNull();
  });

  test("a tag for another version, or not shaped v<major>.<minor>.<patch>, fails", () => {
    for (const [tag, pkg] of [
      ["v0.1.1", "0.1.0"],
      ["v0.1.0", undefined],
      ["0.1.0", "0.1.0"],
      ["v0.1", "0.1"],
      ["v0.1.0-rc.1", "0.1.0-rc.1"],
      ["v01.1.0", "01.1.0"],
      ["v0.1.0;rm", "0.1.0;rm"],
    ] as const) {
      expect(releaseTagProblem(tag, pkg)).not.toBeNull();
    }
  });

  test("the script exits 0 for this package's own tag and 1 for any other", () => {
    expect(Bun.spawnSync(["bun", SCRIPT, `v${version}`]).exitCode).toBe(0);
    const wrong = Bun.spawnSync(["bun", SCRIPT, "v99.0.0"]);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr.toString()).toContain("does not match package.json");
  });
});
