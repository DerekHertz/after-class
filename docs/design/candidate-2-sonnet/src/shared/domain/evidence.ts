// domain/evidence.ts -- evidence as the store hands it out. Read-only shapes.
//
// R1/R2 live in the construction path: the ONLY function that creates an Evidence row is
// backend/store/capture.ts `materializeEvidence`, which takes (track segments, watched coverage, ad breaks)
// and emits only the covered, non-ad part. There is no `insertEvidence` in the Store interface.
import { z } from "zod";
import { EvidenceId, FrameSha, SourceId } from "./ids";
import { Interval, MediaMs } from "./time";
import { TranscriptProvenance } from "./capture";

export const TranscriptEvidence = z.object({
  kind: z.literal("transcript"),
  id: EvidenceId,
  sourceId: SourceId,
  interval: Interval,
  text: z.string(),
  provenance: TranscriptProvenance,
  trackRevision: z.string(),
  /** Fraction of the segment's duration that was actually watched; segments under the floor are not materialized. */
  watchedRatio: z.number().min(0).max(1),
  /** Order in which evidence first became available in this capture. Windows are cut over this, not over media time. */
  viewSeq: z.number().int(),
});
export type TranscriptEvidence = z.infer<typeof TranscriptEvidence>;

export const FrameDisposition = z.discriminatedUnion("tag", [
  /** arrived, no judgment yet */
  z.object({ tag: z.literal("candidate") }),
  /** teaching content (Jev yes), or first frame of a source, or Jev uncertain/error -> keep (flow B) */
  z.object({ tag: z.literal("kept"), why: z.enum(["jev_yes", "uncertain", "first_frame"]) }),
  /** duplicate / motion. Bytes stay on disk until retention sweeps them (uncited only, R16). */
  z.object({ tag: z.literal("dropped") }),
]);
export type FrameDisposition = z.infer<typeof FrameDisposition>;

export const FrameEvidence = z.object({
  kind: z.literal("frame"),
  id: EvidenceId,
  sourceId: SourceId,
  at: MediaMs,
  sha: FrameSha,
  width: z.number().int(),
  height: z.number().int(),
  disposition: FrameDisposition,
  viewSeq: z.number().int(),
});
export type FrameEvidence = z.infer<typeof FrameEvidence>;

export type Evidence = TranscriptEvidence | FrameEvidence;

/** A citation whose evidence was deleted by the user: visibly unavailable, never silently retrievable-looking. */
export interface EvidenceTombstone {
  readonly kind: "deleted";
  readonly id: EvidenceId;
  readonly sourceId: SourceId;
  readonly interval: Interval;
  readonly deletedAtWall: number;
}
export type EvidenceRef = Evidence | EvidenceTombstone;

/** Honest coverage report shown with any chunk/review: what was watched, what is missing and why. */
export interface CoverageReport {
  readonly sourceId: SourceId;
  readonly watched: readonly Interval[];
  readonly adBreaksAt: readonly MediaMs[];
  readonly transcriptGaps: readonly Interval[];
  readonly frameGaps: readonly Interval[];
}
