// core/intervals.ts -- IntervalSet algebra on media time. Pure; every function is property-testable.
import type { Interval, IntervalSet, MediaMs } from "../domain/time";

/**
 * sort by start; sweep, merging when next.start <= cur.end (touching merges: [0,5)+[5,9) = [0,9)).
 * Drops empty intervals. Idempotent: normalize(normalize(x)) equals normalize(x).
 */
export function normalize(xs: readonly Interval[]): IntervalSet {
  throw new Error("not implemented");
}

export function union(a: IntervalSet, b: IntervalSet): IntervalSet {
  throw new Error("not implemented"); // normalize([...a, ...b])
}

/** two-pointer sweep over both sorted lists; O(|a|+|b|) */
export function intersect(a: IntervalSet, b: IntervalSet): IntervalSet {
  throw new Error("not implemented");
}

/** a minus b, via sweep. Used for gaps = [0,duration) minus watched. */
export function subtract(a: IntervalSet, b: IntervalSet): IntervalSet {
  throw new Error("not implemented");
}

export function measure(a: IntervalSet): number {
  throw new Error("not implemented"); // sum(end - start), ms
}

/** |segment INTERSECT set| / |segment|; the watchedRatio of a caption segment. */
export function overlapRatio(segment: Interval, set: IntervalSet): number {
  throw new Error("not implemented");
}

export function contains(set: IntervalSet, at: MediaMs): boolean {
  throw new Error("not implemented"); // binary search on start
}
