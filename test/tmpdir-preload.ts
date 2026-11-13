import { afterAll } from "bun:test";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Every test that opens SQLite under the temp dir pays an fsync, which is slow on WSL's disk.
// A tmpfs-backed directory removes that cost. Skipped when a developer set TMPDIR on purpose or
// /dev/shm is missing (macOS) or not writable. `bun test` never emits the process exit event,
// so the cleanup rides on afterAll, which a preload runs once after every test file.
const SHM = "/dev/shm";

function memoryBackedTmp(): string | null {
  if (process.env.TMPDIR) return null;
  try {
    accessSync(SHM, constants.W_OK);
    return mkdtempSync(join(SHM, "afterclass-test-"));
  } catch {
    return null;
  }
}

const dir = memoryBackedTmp();
if (dir) {
  process.env.TMPDIR = dir;
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
