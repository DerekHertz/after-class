/**
 * Pure evidence derivations (W3). Importable only by evidence/ and test/.
 */
import type { SourceId } from "../../shared/ids";
import type { AdRecord, CaptureFact, Gap, Passage, TranscriptSegment } from "../../shared/domain";
import type { Material } from "../../shared/time";

type SpanFact = Extract<CaptureFact, { kind: "span" }>;

/**
 * R2: "Ad time never becomes evidence."
 * Defence in depth against an extension ad-detection race. A span is
 * implausible, and adds no material, when:
 *   end > sourceDurationS + 1                                   (ad media or the wrong video)
 *   (end - start) > rate * wallDurationMs / 1000 * 1.25 + 1.5   (media grew faster than wall time)
 * Implausible spans are reported as `implausible_span` gaps, never silently dropped.
 */
export function spanPlausible(span: SpanFact, sourceDurationS: number | null): boolean {
  throw new Error("not implemented");
}

/**
 * Fold control + span facts into watched material.
 * R1: "Evidence only comes from intervals I actually watched while capture was on."
 * A span counts only inside an active control period of this capture (double
 * gate: the extension also stops emitting when paused) and only if spanPlausible.
 * R2: "Ad time never becomes evidence."
 * Reads only `span` facts; `ad` facts are a different kind and can't reach here.
 */
export function watchedMaterial(facts: readonly CaptureFact[], sourceDurationS: (sourceId: SourceId) => number | null): Material {
  throw new Error("not implemented");
}

/**
 * The ONLY constructor of Passage.
 * R1: "Evidence only comes from intervals I actually watched while capture was on."
 * Strict (SYNTHESIS open question 4): a segment is a passage iff watched covers
 * it wholly. A partly watched segment becomes a `partially_watched_segment` gap.
 */
export function clipToWatched(
  sourceId: SourceId, transcriptRevId: Passage["transcriptRevId"], origin: Passage["origin"],
  segments: readonly TranscriptSegment[], watched: Material,
): { readonly passages: Passage[]; readonly partial: Gap[] } {
  throw new Error("not implemented");
}

/**
 * Gaps for a source: watched intervals with no transcript (no_transcript /
 * transcript_declined), with tabVisible=false (hidden_tab, frames channel),
 * with no frame sample for > 3 s while visible (frame_stall), channel
 * failures, implausible spans.
 */
export function deriveGaps(facts: readonly CaptureFact[], watched: Material): Gap[] {
  throw new Error("not implemented");
}

export function deriveAds(facts: readonly CaptureFact[]): AdRecord[] {
  throw new Error("not implemented");
}
