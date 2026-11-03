// core/coverage.ts -- R1 and R2 as pure functions. backend/store/capture.ts calls these inside the ingest transaction.
import type { CaptureEventBody, TranscriptSegment } from "../domain/capture";
import type { Interval, IntervalSet, MediaMs, WallMs } from "../domain/time";

export type SpanBody = Extract<CaptureEventBody, { type: "watched_span" }>;

export interface SpanRow {
  readonly body: SpanBody;
  readonly firstSeenWall: WallMs;
  readonly lastSeenWall: WallMs;
}

/**
 * Per-actor state, merge at read: spans are never merged in storage. Coverage is the union of
 * all PLAUSIBLE span rows for the source, recomputed on read (hundreds of rows, microseconds).
 *
 * pseudocode:
 *   good = spans.filter(s => spanPlausible(s, sourceDuration))
 *   return normalize(good.map(s => ({ start: s.start, end: s.end })))
 */
export function watchedCoverage(spans: readonly SpanRow[], sourceDuration: MediaMs): IntervalSet {
  throw new Error("not implemented");
}

/**
 * Defense in depth for R2 against an extension bug (ad detection race).
 * Rejects spans that cannot be real watching:
 *   - end > sourceDuration + 1s            (ad media or wrong video: durations differ)
 *   - (end - start) > rate * (lastSeen - firstSeen) * 1.25 + 1500ms
 *                                          (cannot watch 60 s of media in 5 s of wall time)
 * Implausible spans are kept in `quarantined_spans` for diagnostics but add no coverage.
 */
export function spanPlausible(s: SpanRow, sourceDuration: MediaMs): boolean {
  throw new Error("not implemented");
}

export interface CoveredSegment {
  readonly segment: TranscriptSegment;
  readonly watchedRatio: number;
}

/**
 * R1: caption text becomes evidence only where the learner actually watched.
 *   keep segment iff overlapRatio(segment, watched) >= MIN_WATCHED_RATIO (default 0.5)
 * The track itself (all segments) stays in `transcript_tracks` as "available", never as evidence.
 * Ads need no subtraction: an ad contributes no watched interval (content time does not advance),
 * so R2 holds because coverage is the ONLY gate. Test: property over arbitrary event streams that
 * every materialized evidence interval is a subset of the union of watched_span intervals.
 */
export function selectCoveredSegments(
  segments: readonly TranscriptSegment[],
  watched: IntervalSet,
  minRatio?: number,
): readonly CoveredSegment[] {
  throw new Error("not implemented");
}

/** A frame is evidence only if its media instant lies inside watched coverage. */
export function frameIsCovered(at: MediaMs, watched: IntervalSet): boolean {
  throw new Error("not implemented");
}

export interface SourceGaps {
  readonly transcriptGaps: IntervalSet; // watched but no caption evidence: an explicit gap, never invented text
  readonly frameGaps: IntervalSet;      // watched but frames stalled (hidden tab etc.); logged, not invented
}

/**
 * Honest partial-coverage report shown with any chunk/review.
 *   transcriptGaps = watched MINUS union(transcript evidence intervals)   (+ explicit 'gap' events)
 *   frameGaps      = union of 'gap' events on channel 'frames' INTERSECT watched
 * Unwatched time is neither: it is simply not in scope (R1).
 */
export function gapsOf(
  watched: IntervalSet,
  transcriptEvidence: readonly Interval[],
  frameGapEvents: readonly Interval[],
): SourceGaps {
  throw new Error("not implemented");
}
