import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh directory under the current temp root, removed after the test that called this.
 * Call it from a test body or from a helper a test body calls. A call from a describe body or a
 * beforeAll hook would remove the directory after the first test, not after the file.
 * `tmpdir()` is read here and not at import, so the preload's TMPDIR is honoured.
 */
export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
