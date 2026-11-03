// domain/capture.ts -- what the extension observes, as an append-only event log.
//
// The extension is the ONLY writer of these events; the backend appends them verbatim
// (dedupe on (captureId, seq)) and derives every view from them. So capture state,
// watched coverage, gaps and ad breaks are folds over this log -- never a second copy.
//
// Deliberately absent: any event that says "this text is evidence". Evidence is
// computed by the store from (transcript track  INTERSECT  watched spans  MINUS  ads),
// see core/coverage.ts. The extension cannot assert evidence, only observations.
import { z } from "zod";
import {
  AdBreakId, CaptureId, FrameSha, GapId, SourceId, SpanId,
} from "./ids";
import { MediaMs, WallMs } from "./time";

export const TranscriptProvenance = z.enum([
  "youtube_panel",             // primary
  "youtube_caption_intercept", // fallback: timedtext response seen by the page
  "machine_transcription",     // opt-in audio fallback (flow A)
]);
export type TranscriptProvenance = z.infer<typeof TranscriptProvenance>;

export const TranscriptSegment = z.object({
  start: MediaMs,
  end: MediaMs,
  text: z.string().min(1),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const SourceDescriptor = z.object({
  sourceId: SourceId,
  videoId: z.string(),
  url: z.string().url(),
  title: z.string(),
  duration: MediaMs,
  /** playlist context etc.; opaque to the pipeline */
  meta: z.record(z.string(), z.string()).default({}),
});
export type SourceDescriptor = z.infer<typeof SourceDescriptor>;

export const GapReason = z.enum([
  "tab_hidden",        // frames stall; captions fine (flow A)
  "canvas_blocked",
  "decode_stalled",
  "no_captions",
  "panel_unavailable",
  "channel_error",
  "user_declined_transcription",
]);
export type GapReason = z.infer<typeof GapReason>;

export const CaptureBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_started"), tabId: z.number().int() }),

  /** Capture control. `cause` distinguishes the auto-pause on leaving /watch from a user pause. */
  z.object({
    type: z.literal("control"),
    action: z.enum(["pause", "resume", "stop"]),
    cause: z.enum(["user", "left_watch_page", "tab_closed", "extension_reload"]),
  }),

  /** New video in the same tab/session -> new source, same capture (flow A). */
  z.object({ type: z.literal("source_attached"), source: SourceDescriptor }),

  /**
   * One watched span of MEDIA time. Re-sent with the same spanId as `end` grows
   * (heartbeat) and once more with open=false when playback breaks (pause, seek,
   * ad, hide-stall, navigation). Ingest takes max(end) -> idempotent, order-tolerant.
   */
  z.object({
    type: z.literal("watched_span"),
    spanId: SpanId,
    sourceId: SourceId,
    start: MediaMs,
    end: MediaMs,
    rate: z.number().positive(),
    open: z.boolean(),
  }),

  /**
   * An ad interrupted content at media position `at` (zero content duration).
   * Logged as an ad -- NOT a gap (flow A) -- and structurally can never become evidence (R2):
   * no watched_span is ever emitted while ad-showing, and ad position carries no interval.
   */
  z.object({
    type: z.literal("ad_break"),
    breakId: AdBreakId,
    sourceId: SourceId,
    at: MediaMs,
    state: z.enum(["started", "ended"]),
  }),

  /** A channel failed for a media interval; other channels' evidence is kept. */
  z.object({
    type: z.literal("gap"),
    gapId: GapId,
    sourceId: SourceId,
    channel: z.enum(["transcript", "frames", "audio"]),
    start: MediaMs,
    end: MediaMs,
    reason: GapReason,
  }),

  /** The whole caption track as observed. "Available", not "evidence": see header comment. */
  z.object({
    type: z.literal("transcript_track"),
    sourceId: SourceId,
    provenance: TranscriptProvenance,
    /** hash of normalized segments; part of EvidenceId so a changed track never aliases old evidence */
    revision: z.string(),
    segments: z.array(TranscriptSegment),
  }),

  /** Captions unusable -> offer opt-in transcription; the choice is itself an event. */
  z.object({
    type: z.literal("transcript_unusable"),
    sourceId: SourceId,
    why: z.enum(["missing", "empty", "panel_unavailable", "unaligned"]),
  }),
  z.object({
    type: z.literal("transcription_choice"),
    sourceId: SourceId,
    choice: z.enum(["accept", "continue_with_gap"]),
  }),

  /** Frame bytes were already PUT to /api/frames/:sha; this event adds media-time meaning. */
  z.object({
    type: z.literal("frame_candidate"),
    sha: FrameSha,
    sourceId: SourceId,
    at: MediaMs,
    width: z.number().int(),
    height: z.number().int(),
    /** pixel-diff score vs the last kept frame in [0,1]; extension's sampler decided this was worth sending */
    diff: z.number().min(0).max(1),
  }),
]);

export const CaptureEvent = z.object({
  captureId: CaptureId,
  /** Monotonic per capture, allocated by the extension; (captureId, seq) is the idempotency key. */
  seq: z.number().int().nonnegative(),
  /** audit only. WallMs cannot be used where MediaMs is required. */
  wall: WallMs,
  body: CaptureBody,
});
export type CaptureEvent = z.infer<typeof CaptureEvent>;
export type CaptureEventBody = z.infer<typeof CaptureBody>;

/** What the extension UI shows (flow A "show source, caption status, frame health"). Derived on the backend. */
export type ChannelHealth = "ok" | "degraded" | "gap" | "unavailable";
export interface CaptureView {
  readonly captureId: CaptureId;
  readonly state: "starting" | "capturing" | "paused" | "stopped" | "failed";
  readonly pausedBy?: "user" | "left_watch_page";
  readonly sources: readonly {
    readonly source: SourceDescriptor;
    readonly transcript: ChannelHealth;
    readonly frames: ChannelHealth;
    readonly adPlaying: boolean;
    readonly offerTranscription: boolean;
  }[];
  readonly lastSeq: number;
}
