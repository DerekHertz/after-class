import { describe, expect, test } from "bun:test";
import { diskLine, startDiskWatch } from "../src/backend/evidence/disk-watch";
import type { DiskReading } from "../src/backend/evidence/disk-watch";
import { readVolume } from "../src/backend/evidence/disk-watch";
import { tmpDir } from "./tmp";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("the disk line", () => {
  test("carries free and used mebibytes, the total and the floor, as one JSON object", () => {
    const line = JSON.parse(diskLine({ totalBytes: 20 * GIB, freeBytes: 15 * GIB }, 2 * GIB));
    expect(line).toEqual({ event: "disk", level: "ok", freeMib: 15360, usedMib: 5120, totalMib: 20480, floorMib: 2048 });
  });

  test("says floor once free space is under the ingest floor, and ok at it", () => {
    const at = JSON.parse(diskLine({ totalBytes: 20 * GIB, freeBytes: 2 * GIB }, 2 * GIB));
    const under = JSON.parse(diskLine({ totalBytes: 20 * GIB, freeBytes: 2 * GIB - 1 }, 2 * GIB));
    expect([at.level, under.level]).toEqual(["ok", "floor"]);
  });

  test("reads the real volume under a directory", () => {
    const r = readVolume(tmpDir("disk-watch"))();
    expect(r.totalBytes).toBeGreaterThan(0);
    expect(r.freeBytes).toBeLessThanOrEqual(r.totalBytes);
  });
});

describe("the disk watch", () => {
  const harness = (read: () => DiskReading) => {
    const lines: string[] = [];
    const errors: string[] = [];
    let tick: (() => void) | null = null;
    let stopped = false;
    const stop = startDiskWatch({
      read, minFreeBytes: 2 * GIB, log: (t) => lines.push(t), logError: (t) => errors.push(t),
      every: (_ms, fn) => { tick = fn; return () => { stopped = true; }; },
    });
    return { lines, errors, tick: () => tick!(), stop, stopped: () => stopped };
  };

  test("logs a reading at start and one at every interval", () => {
    let free = 10 * GIB;
    const h = harness(() => ({ totalBytes: 20 * GIB, freeBytes: free }));
    expect(h.lines).toHaveLength(1);
    free = 9 * GIB;
    h.tick();
    expect(h.lines.map((l) => JSON.parse(l).freeMib)).toEqual([10240, 9216]);
  });

  test("an unreadable volume is logged as an error and the watch keeps going", () => {
    let fail = true;
    const h = harness(() => {
      if (fail) throw new Error("ENOENT");
      return { totalBytes: 20 * GIB, freeBytes: 10 * GIB };
    });
    expect(h.errors[0]).toContain("ENOENT");
    fail = false;
    h.tick();
    expect(h.lines).toHaveLength(1);
  });

  test("stopping clears the timer", () => {
    const h = harness(() => ({ totalBytes: GIB, freeBytes: GIB }));
    h.stop();
    expect(h.stopped()).toBe(true);
  });
});
