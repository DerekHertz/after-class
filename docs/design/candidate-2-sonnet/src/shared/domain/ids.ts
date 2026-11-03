// domain/ids.ts -- branded identifiers. THE ONLY place a string becomes an ID.
//
// Every ID is a zod brand, so the same declaration gives (a) a compile-time
// distinct type and (b) the parser used at HTTP / SQLite / CLI boundaries.
// Inside the app, IDs are never cast; they come from a parser or from the
// deterministic minting functions in backend/ids.ts.
//
// Two kinds of ID:
//   natural   -- derived from content, so re-derivation yields the same value
//                (EvidenceId, ContentKey, ClaimId, NoteId, ObservationId, JobKey).
//                This is what makes R15 (retry never duplicates) a property of
//                the ID scheme instead of a check in the save path.
//   allocated -- random UUIDs for things with no content identity
//                (CaptureId, ReviewId, TurnId, SpanId). Created by whoever
//                originates the thing (extension or review app) BEFORE sending,
//                so a retried request carries the same ID.
import { z } from "zod";

const id = <B extends string>() => z.string().min(1).max(200).brand<B>();

export const CaptureId = id<"CaptureId">();
export type CaptureId = z.infer<typeof CaptureId>;
/** `yt:<videoId>`; stable across sessions so rewatch finds its cache. */
export const SourceId = id<"SourceId">();
export type SourceId = z.infer<typeof SourceId>;
export const SpanId = id<"SpanId">();
export type SpanId = z.infer<typeof SpanId>;
export const AdBreakId = id<"AdBreakId">();
export type AdBreakId = z.infer<typeof AdBreakId>;
export const GapId = id<"GapId">();
export type GapId = z.infer<typeof GapId>;
/** natural: hash(sourceId, kind, trackRevision | frameSha, interval) */
export const EvidenceId = id<"EvidenceId">();
export type EvidenceId = z.infer<typeof EvidenceId>;
/** sha256 hex of the frame bytes; frame files are content-addressed. */
export const FrameSha = z.string().regex(/^[0-9a-f]{64}$/).brand<"FrameSha">();
export type FrameSha = z.infer<typeof FrameSha>;
/** Identity of a chunk slot in a capture (ordinal). Revisions of it get new ContentKeys. */
export const ChunkId = id<"ChunkId">();
export type ChunkId = z.infer<typeof ChunkId>;
/** natural: hash(ordered evidence ids + their text hashes + processing version). Content-addressed prep. */
export const ContentKey = id<"ContentKey">();
export type ContentKey = z.infer<typeof ContentKey>;
export const WindowId = id<"WindowId">();
export type WindowId = z.infer<typeof WindowId>;
export const JudgmentId = id<"JudgmentId">();
export type JudgmentId = z.infer<typeof JudgmentId>;
/** natural: hash(contentKey, ordinal) */
export const ClaimId = id<"ClaimId">();
export type ClaimId = z.infer<typeof ClaimId>;
/** A ClaimId whose claim passed the evidence check. Minted ONLY by core/claimMachine.asSupported. */
export type SupportedClaimId = ClaimId & z.$brand<"Supported">;
export const JobId = id<"JobId">();
export type JobId = z.infer<typeof JobId>;
/** natural: hash(kind, target, inputs, processingVersion) -> UNIQUE; enqueue is INSERT OR IGNORE. */
export const JobKey = id<"JobKey">();
export type JobKey = z.infer<typeof JobKey>;
export const ReviewId = id<"ReviewId">();
export type ReviewId = z.infer<typeof ReviewId>;
/** Allocated by the review app for learner turns (retry-safe); by the backend for tutor turns. */
export const TurnId = id<"TurnId">();
export type TurnId = z.infer<typeof TurnId>;
/** natural: hash(reviewId, ordinal of main question) */
export const QuestionId = id<"QuestionId">();
export type QuestionId = z.infer<typeof QuestionId>;
/** natural: hash(reviewId, subject) -- R15. */
export const ObservationId = id<"ObservationId">();
export type ObservationId = z.infer<typeof ObservationId>;
export const NoteId = id<"NoteId">();
export type NoteId = z.infer<typeof NoteId>;
export const LinkId = id<"LinkId">();
export type LinkId = z.infer<typeof LinkId>;
export const ConceptId = id<"ConceptId">();
export type ConceptId = z.infer<typeof ConceptId>;
export const ResourceId = id<"ResourceId">();
export type ResourceId = z.infer<typeof ResourceId>;
export const UsageId = id<"UsageId">();
export type UsageId = z.infer<typeof UsageId>;

/** Non-empty array: used wherever "zero" must be unrepresentable (R10). */
export type NonEmpty<T> = readonly [T, ...T[]];
export const nonEmpty = <T extends z.ZodType>(t: T) => z.array(t).nonempty();
