/**
 * Media time. Every evidence reference is in seconds of a specific source's
 * media timeline, never wall clock (flow A: "Pause/seek/speed/replay update
 * media-time intervals; never wall-clock").
 *
 * `Material` is the unit everything downstream reasons about: the set of
 * watched media intervals, per source. Chunks own Material, review scopes
 * freeze Material, claims are admitted to a scope by Material containment.
 */
import type { SourceId } from "./ids";

declare const MediaBrand: unique symbol;
/** Seconds on one source's media timeline. Only `media()` mints it. */
export type MediaSeconds = number & { readonly [MediaBrand]: true };

export function media(s: number): MediaSeconds {
  // TODO: reject NaN/negative/Infinity.
  throw new Error("not implemented");
}

/** Half-open [start, end). Invariant: start < end. */
export type Interval = { readonly start: MediaSeconds; readonly end: MediaSeconds };

/**
 * Immutable, sorted, disjoint, non-adjacent intervals on ONE source timeline.
 * Construct only via `IntervalSet.of` (normalises) so the invariant cannot be
 * broken by a caller.
 */
export class IntervalSet {
  private constructor(private readonly parts: readonly Interval[]) {}
  static readonly empty: IntervalSet = new IntervalSet([]);
  static of(intervals: Iterable<Interval>): IntervalSet {
    throw new Error("not implemented");
  }
  intervals(): readonly Interval[] {
    return this.parts;
  }
  union(other: IntervalSet): IntervalSet {
    throw new Error("not implemented");
  }
  intersect(other: IntervalSet): IntervalSet {
    throw new Error("not implemented");
  }
  subtract(other: IntervalSet): IntervalSet {
    throw new Error("not implemented");
  }
  /** True when every point of `i` is inside this set. */
  covers(i: Interval): boolean {
    throw new Error("not implemented");
  }
  /** Fraction of `i` inside this set, 0..1. */
  overlapFraction(i: Interval): number {
    throw new Error("not implemented");
  }
  duration(): number {
    throw new Error("not implemented");
  }
  equals(other: IntervalSet): boolean {
    throw new Error("not implemented");
  }
  isEmpty(): boolean {
    return this.parts.length === 0;
  }
}

/** Watched intervals across sources. Missing key = nothing watched there. */
export type Material = ReadonlyMap<SourceId, IntervalSet>;

export const Material = {
  empty: new Map() as Material,
  union(a: Material, b: Material): Material {
    throw new Error("not implemented");
  },
  subtract(a: Material, b: Material): Material {
    throw new Error("not implemented");
  },
  /** A source-located reference lies wholly inside the material. */
  covers(m: Material, sourceId: SourceId, i: Interval): boolean {
    throw new Error("not implemented");
  },
  duration(m: Material): number {
    throw new Error("not implemented");
  },
  equals(a: Material, b: Material): boolean {
    throw new Error("not implemented");
  },
  /** Canonical JSON for hashing into IDs. */
  canonical(m: Material): readonly [string, readonly [number, number][]][] {
    throw new Error("not implemented");
  },
};
