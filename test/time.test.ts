import { describe, expect, test } from "bun:test";
import type { SourceId } from "../src/shared/ids";
import { clip, contains, interval, IntervalSet, isEmpty, Material, media, overlaps } from "../src/shared/time";
import type { Interval } from "../src/shared/time";

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELLS = 40;
const CELL = 0.5;

/** Endpoints on a 0.5 s grid, so a set is exactly its set of grid cells. */
function gridSet(rand: () => number): IntervalSet {
  const n = Math.floor(rand() * 6);
  const parts: Interval[] = [];
  for (let k = 0; k < n; k++) {
    const a = Math.floor(rand() * CELLS);
    const b = a + 1 + Math.floor(rand() * 8);
    parts.push(interval(a * CELL, Math.min(b, CELLS) * CELL));
  }
  return IntervalSet.of(parts);
}

function cells(s: IntervalSet): Set<number> {
  const out = new Set<number>();
  for (const i of s.intervals()) for (let k = Math.round(i.start / CELL); k < Math.round(i.end / CELL); k++) out.add(k);
  return out;
}

function cellsOf(i: Interval): Set<number> {
  return cells(IntervalSet.of([i]));
}

const sameCells = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));

function expectNormalised(s: IntervalSet): void {
  const parts = s.intervals();
  parts.forEach((p, k) => {
    expect(p.end).toBeGreaterThan(p.start);
    if (k > 0) expect(p.start).toBeGreaterThan(parts[k - 1]!.end);
  });
}

const RUNS = 500;

describe("IntervalSet against a grid model", () => {
  test("of normalises: sorted, disjoint, non-adjacent, idempotent", () => {
    const rand = prng(1);
    for (let r = 0; r < RUNS; r++) {
      const s = gridSet(rand);
      expectNormalised(s);
      expect(IntervalSet.of(s.intervals()).equals(s)).toBe(true);
    }
  });

  test("union, intersect, subtract match set algebra on cells", () => {
    const rand = prng(2);
    for (let r = 0; r < RUNS; r++) {
      const a = gridSet(rand);
      const b = gridSet(rand);
      const ca = cells(a);
      const cb = cells(b);
      for (const [got, want] of [
        [a.union(b), new Set([...ca, ...cb])],
        [a.intersect(b), new Set([...ca].filter((x) => cb.has(x)))],
        [a.subtract(b), new Set([...ca].filter((x) => !cb.has(x)))],
      ] as const) {
        expectNormalised(got);
        expect(sameCells(cells(got), want)).toBe(true);
      }
    }
  });

  test("duration, covers, overlapFraction and equals agree with cells", () => {
    const rand = prng(3);
    for (let r = 0; r < RUNS; r++) {
      const a = gridSet(rand);
      const b = gridSet(rand);
      const ca = cells(a);
      expect(a.duration()).toBeCloseTo(ca.size * CELL, 9);
      expect(a.equals(b)).toBe(sameCells(ca, cells(b)));
      const start = Math.floor(rand() * CELLS);
      const probe = interval(start * CELL, (start + 1 + Math.floor(rand() * 6)) * CELL);
      const cp = [...cellsOf(probe)];
      expect(a.covers(probe)).toBe(cp.every((x) => ca.has(x)));
      expect(a.overlapFraction(probe)).toBeCloseTo(cp.filter((x) => ca.has(x)).length / cp.length, 9);
    }
  });

  test("subtract and intersect partition a set exactly, with arbitrary float endpoints", () => {
    const rand = prng(4);
    const floatSet = () =>
      IntervalSet.of(
        Array.from({ length: Math.floor(rand() * 6) }, () => {
          const a = rand() * 100;
          return interval(a, a + 0.001 + rand() * 20);
        }),
      );
    for (let r = 0; r < RUNS; r++) {
      const a = floatSet();
      const b = floatSet();
      expect(a.subtract(b).union(a.intersect(b)).equals(a)).toBe(true);
      expect(a.subtract(b).intersect(b).isEmpty()).toBe(true);
      expect(a.union(b).equals(b.union(a))).toBe(true);
      expect(a.intersect(b).equals(b.intersect(a))).toBe(true);
    }
  });

  test("touching intervals merge and empty inputs vanish", () => {
    const s = IntervalSet.of([interval(5, 10), interval(0, 5), { start: media(20), end: media(20) }]);
    expect(s.intervals()).toEqual([interval(0, 10)]);
    expect(IntervalSet.of([]).isEmpty()).toBe(true);
  });

  test("constructors reject impossible media time", () => {
    expect(() => media(-1)).toThrow();
    expect(() => media(Number.NaN)).toThrow();
    expect(() => interval(3, 3)).toThrow();
  });
});

describe("Material", () => {
  const s1 = "src_aaaaaaaaaaaaaaaaaaaaaaaaaa" as SourceId;
  const s2 = "src_bbbbbbbbbbbbbbbbbbbbbbbbbb" as SourceId;

  function gridMaterial(rand: () => number): Material {
    return Material.of([
      [s1, gridSet(rand).intervals()],
      [s2, gridSet(rand).intervals()],
    ]);
  }

  test("operations act per source and never store an empty source", () => {
    const rand = prng(5);
    for (let r = 0; r < RUNS; r++) {
      const a = gridMaterial(rand);
      const b = gridMaterial(rand);
      for (const m of [a, b, Material.union(a, b), Material.intersect(a, b), Material.subtract(a, b)]) {
        for (const set of m.values()) expect(set.isEmpty()).toBe(false);
      }
      for (const s of [s1, s2]) {
        expect(Material.get(Material.union(a, b), s).equals(Material.get(a, s).union(Material.get(b, s)))).toBe(true);
        expect(Material.get(Material.subtract(a, b), s).equals(Material.get(a, s).subtract(Material.get(b, s)))).toBe(true);
      }
      expect(Material.contains(Material.union(a, b), a)).toBe(true);
      expect(Material.contains(a, Material.intersect(a, b))).toBe(true);
      expect(Material.contains(a, b)).toBe(Material.isEmpty(Material.subtract(b, a)));
      expect(Material.duration(Material.union(a, b))).toBeCloseTo(
        Material.duration(a) + Material.duration(b) - Material.duration(Material.intersect(a, b)),
        9,
      );
    }
  });

  test("canonical form is order-independent and round-trips", () => {
    const rand = prng(6);
    for (let r = 0; r < RUNS; r++) {
      const a = gridMaterial(rand);
      const reversed = Material.of([...a].reverse().map(([s, set]) => [s, set.intervals()] as const));
      expect(JSON.stringify(Material.canonical(reversed))).toBe(JSON.stringify(Material.canonical(a)));
      expect(Material.equals(Material.fromCanonical(Material.canonical(a)), a)).toBe(true);
    }
  });

  test("covers checks the named source only", () => {
    const m = Material.of([[s1, [interval(0, 10)]]]);
    expect(Material.covers(m, s1, interval(2, 8))).toBe(true);
    expect(Material.covers(m, s2, interval(2, 8))).toBe(false);
    expect(Material.covers(m, s1, interval(8, 12))).toBe(false);
  });
});

describe("half-open interval helpers", () => {
  const CASES = 2000;
  const grid = (rand: () => number): Interval => {
    const a = Math.floor(rand() * 20);
    return interval(a * CELL, (a + 1 + Math.floor(rand() * 8)) * CELL);
  };

  test("an interval contains its start and not its end", () => {
    const rand = prng(11);
    for (let r = 0; r < CASES; r++) {
      const i = grid(rand);
      expect(contains(i, i.start)).toBe(true);
      expect(contains(i, i.end)).toBe(false);
      expect(contains(i, (i.start + i.end) / 2)).toBe(true);
      expect(contains(i, i.start - CELL)).toBe(false);
      expect(contains(i, i.end + CELL)).toBe(false);
    }
  });

  test("overlap is symmetric, reflexive for non-empty intervals, and false for abutting ones", () => {
    const rand = prng(12);
    for (let r = 0; r < CASES; r++) {
      const a = grid(rand);
      const b = grid(rand);
      expect(overlaps(a, b)).toBe(overlaps(b, a));
      expect(overlaps(a, a)).toBe(true);
      const next = interval(a.end, a.end + (1 + Math.floor(rand() * 5)) * CELL);
      expect(overlaps(a, next)).toBe(false);
      expect(overlaps(next, a)).toBe(false);
      expect(overlaps(a, b)).toBe([...cellsOf(a)].some((c) => cellsOf(b).has(c)));
    }
  });

  test("clip is a subset of both inputs and agrees with overlaps", () => {
    const rand = prng(13);
    for (let r = 0; r < CASES; r++) {
      const a = grid(rand);
      const b = grid(rand);
      const c = clip(a, b);
      expect(c !== null).toBe(overlaps(a, b));
      expect(c).toEqual(clip(b, a));
      if (c === null) continue;
      expect(isEmpty(c)).toBe(false);
      expect(c.start >= a.start && c.end <= a.end && c.start >= b.start && c.end <= b.end).toBe(true);
      expect(contains(a, c.start) && contains(b, c.start)).toBe(true);
      expect(contains(c, c.end)).toBe(false);
      expect([...cellsOf(c)].sort()).toEqual([...cellsOf(a)].filter((x) => cellsOf(b).has(x)).sort());
    }
  });

  test("isEmpty is true for zero-length, inverted and NaN spans only", () => {
    expect(isEmpty({ start: 3, end: 3 })).toBe(true);
    expect(isEmpty({ start: 4, end: 3 })).toBe(true);
    expect(isEmpty({ start: 3, end: Number.NaN })).toBe(true);
    expect(isEmpty({ start: 3, end: 3.5 })).toBe(false);
  });
});
