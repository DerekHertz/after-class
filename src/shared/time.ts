/**
 * Media time. Every evidence reference is in seconds of one source's media
 * timeline, never wall clock (flow A: "Pause/seek/speed/replay update
 * media-time intervals; never wall-clock").
 *
 * `Material` is the unit everything downstream reasons about: watched media
 * intervals per source. Chunks own Material, review scopes freeze it, and a
 * claim is admitted to a scope when the scope's Material covers its evidence.
 */
import type { SourceId } from "./ids";

declare const MediaBrand: unique symbol;
export type MediaSeconds = number & { readonly [MediaBrand]: true };

export function media(s: number): MediaSeconds {
  if (!Number.isFinite(s) || s < 0) throw new RangeError(`media: expected finite seconds >= 0, got ${s}`);
  return s as MediaSeconds;
}

/** Half-open [start, end). Invariant: start < end. */
export type Interval = { readonly start: MediaSeconds; readonly end: MediaSeconds };

export function interval(start: number, end: number): Interval {
  if (!(end > start)) throw new RangeError(`interval: end ${end} must exceed start ${start}`);
  return { start: media(start), end: media(end) };
}

/** Anything with a start and end in media seconds, such as a span or transcript segment. */
export type Span = { readonly start: number; readonly end: number };

function length(i: Span): number {
  return i.end - i.start;
}

/** No point lies inside. True for `end <= start` and for NaN bounds, which is why `interval()` rejects them. */
export function isEmpty(i: Span): boolean {
  return !(i.end > i.start);
}

/** Half-open: a point at `start` is inside, a point at `end` is not. */
export function contains(i: Span, point: number): boolean {
  return i.start <= point && point < i.end;
}

/** Half-open: spans that only abut (`a.end === b.start`) do not overlap. Symmetric. Meaningful for non-empty spans. */
export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** The part of `a` inside `b`, or null when the two share no point. */
export function clip(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start: start as MediaSeconds, end: end as MediaSeconds } : null;
}

/**
 * Immutable, sorted, disjoint, non-adjacent intervals on one source timeline.
 * Built only through `IntervalSet.of`, which normalises, so no caller can break
 * the invariant. Empty or inverted inputs are dropped.
 */
export class IntervalSet {
  private constructor(private readonly parts: readonly Interval[]) {}

  static readonly empty: IntervalSet = new IntervalSet([]);

  static of(intervals: Iterable<Interval>): IntervalSet {
    const sorted = [...intervals].filter((i) => !isEmpty(i)).sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const i of sorted) {
      const last = merged[merged.length - 1];
      if (last && i.start <= last.end) {
        if (i.end > last.end) merged[merged.length - 1] = { start: last.start, end: i.end };
      } else {
        merged.push(i);
      }
    }
    return merged.length === 0 ? IntervalSet.empty : new IntervalSet(merged);
  }

  intervals(): readonly Interval[] {
    return this.parts;
  }

  isEmpty(): boolean {
    return this.parts.length === 0;
  }

  union(other: IntervalSet): IntervalSet {
    return IntervalSet.of([...this.parts, ...other.parts]);
  }

  intersect(other: IntervalSet): IntervalSet {
    const out: Interval[] = [];
    let a = 0;
    let b = 0;
    while (a < this.parts.length && b < other.parts.length) {
      const x = this.parts[a]!;
      const y = other.parts[b]!;
      const shared = clip(x, y);
      if (shared) out.push(shared);
      if (x.end < y.end) a++;
      else b++;
    }
    return IntervalSet.of(out);
  }

  subtract(other: IntervalSet): IntervalSet {
    const out: Interval[] = [];
    let b = 0;
    for (const x of this.parts) {
      let cursor: number = x.start;
      while (b < other.parts.length && other.parts[b]!.end <= cursor) b++;
      let k = b;
      while (k < other.parts.length && other.parts[k]!.start < x.end) {
        const y = other.parts[k]!;
        if (y.start > cursor) out.push({ start: cursor as MediaSeconds, end: y.start });
        cursor = Math.max(cursor, y.end);
        k++;
      }
      if (cursor < x.end) out.push({ start: cursor as MediaSeconds, end: x.end });
    }
    return IntervalSet.of(out);
  }

  /** True when every point of `i` is inside this set. */
  covers(i: Interval): boolean {
    if (isEmpty(i)) return false;
    return this.parts.some((p) => p.start <= i.start && i.end <= p.end);
  }

  /** Fraction of `i` inside this set, 0..1. */
  overlapFraction(i: Interval): number {
    if (isEmpty(i)) return 0;
    return this.intersect(IntervalSet.of([i])).duration() / length(i);
  }

  duration(): number {
    return this.parts.reduce((sum, p) => sum + length(p), 0);
  }

  equals(other: IntervalSet): boolean {
    if (this.parts.length !== other.parts.length) return false;
    return this.parts.every((p, k) => p.start === other.parts[k]!.start && p.end === other.parts[k]!.end);
  }
}

/** Watched intervals across sources. A missing key means nothing watched there; empty sets are never stored. */
export type Material = ReadonlyMap<SourceId, IntervalSet>;

function normalized(entries: Iterable<readonly [SourceId, IntervalSet]>): Material {
  const out = new Map<SourceId, IntervalSet>();
  for (const [source, set] of entries) {
    const merged = (out.get(source) ?? IntervalSet.empty).union(set);
    if (merged.isEmpty()) out.delete(source);
    else out.set(source, merged);
  }
  return out;
}

export const Material = {
  empty: new Map() as Material,

  of(entries: Iterable<readonly [SourceId, Iterable<Interval>]>): Material {
    return normalized([...entries].map(([s, is]) => [s, IntervalSet.of(is)] as const));
  },

  sources(m: Material): readonly SourceId[] {
    return [...m.keys()].sort();
  },

  get(m: Material, sourceId: SourceId): IntervalSet {
    return m.get(sourceId) ?? IntervalSet.empty;
  },

  isEmpty(m: Material): boolean {
    return m.size === 0;
  },

  union(a: Material, b: Material): Material {
    return normalized([...a, ...b]);
  },

  intersect(a: Material, b: Material): Material {
    return normalized([...a].map(([s, set]) => [s, set.intersect(Material.get(b, s))] as const));
  },

  subtract(a: Material, b: Material): Material {
    return normalized([...a].map(([s, set]) => [s, set.subtract(Material.get(b, s))] as const));
  },

  /** A source-located reference lies wholly inside the material. */
  covers(m: Material, sourceId: SourceId, i: Interval): boolean {
    return Material.get(m, sourceId).covers(i);
  },

  /** Every point of `inner` lies inside `outer`. */
  contains(outer: Material, inner: Material): boolean {
    return Material.isEmpty(Material.subtract(inner, outer));
  },

  duration(m: Material): number {
    let sum = 0;
    for (const set of m.values()) sum += set.duration();
    return sum;
  },

  equals(a: Material, b: Material): boolean {
    if (a.size !== b.size) return false;
    for (const [s, set] of a) {
      const other = b.get(s);
      if (!other || !set.equals(other)) return false;
    }
    return true;
  },

  /** Canonical JSON form for hashing into IDs: sources sorted, intervals as [start, end]. */
  canonical(m: Material): [string, [number, number][]][] {
    return Material.sources(m).map((s) => [s, Material.get(m, s).intervals().map((i): [number, number] => [i.start, i.end])]);
  },

  /** Inverse of `canonical`, for rows read back from SQLite. */
  fromCanonical(rows: readonly (readonly [string, readonly (readonly [number, number])[]])[]): Material {
    return Material.of(rows.map(([s, is]) => [s as SourceId, is.map(([a, b]) => ({ start: media(a), end: media(b) }))] as const));
  },
};
