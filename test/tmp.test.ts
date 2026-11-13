import { describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { tmpDir } from "./tmp";

describe("tmpDir", () => {
  const made: string[] = [];

  test("creates a distinct, writable directory per call under the temp root with the prefix", () => {
    const a = tmpDir("afterclass-tmp-test-");
    const b = tmpDir("afterclass-tmp-test-");
    made.push(a, b);
    expect(a).not.toBe(b);
    for (const d of [a, b]) {
      expect(statSync(d).isDirectory()).toBe(true);
      expect(dirname(d)).toBe(tmpdir());
      expect(basename(d).startsWith("afterclass-tmp-test-")).toBe(true);
    }
    writeFileSync(join(a, "f.txt"), "x");
  });

  test("the directories of the previous test are gone, files and all", () => {
    expect(made).toHaveLength(2);
    for (const d of made) expect(existsSync(d)).toBe(false);
  });

  test("reads the temp root when called, not when imported", () => {
    const root = tmpDir("afterclass-tmp-root-");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      const inner = tmpDir("afterclass-tmp-inner-");
      expect(dirname(inner)).toBe(root);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});
