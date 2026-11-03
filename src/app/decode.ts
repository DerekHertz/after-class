/**
 * Response decoding for the review app. wire.ts defines request bodies and the
 * tutor event type but no response schemas, so the app parses every backend
 * response here, once, at the boundary. Past this file nothing is `unknown`.
 *
 * JSON form of the domain types is the domain type itself, with one exception:
 * a `Material` (a Map of IntervalSets) is written as `Material.canonical` rows,
 * `[sourceId, [[start, end], ...]][]`, because a Map cannot survive JSON.
 */
import { z } from "zod";
import type {
  CaptureView, Claim, ClaimDraft, DetourState, EvidenceBundle, Frame, FrozenScope, InviteState,
  Note, Observation, Passage, RecordView, ReviewOptions, ReviewView, SaveResult, Seq, StartResult, Turn, TurnEvent, TutorMove, UsageSummary,
} from "../shared/domain";
import { parseId } from "../shared/ids";
import type { Id, IdKind } from "../shared/ids";
import { Material, media } from "../shared/time";
import { learnerAct } from "../shared/wire";

const idz = <K extends IdKind>(kind: K) =>
  z
    .string()
    .refine((s) => parseId(kind, s) !== null, `expected a ${kind}_ id`)
    .transform((s) => s as Id<K>);

const seqz = z.number().int().nonnegative().transform((n) => n as Seq);
const mediaz = z.number().nonnegative().transform(media);
const intervalz = z.object({ start: mediaz, end: mediaz });
const nonEmpty = <T extends z.ZodType>(item: T) => z.tuple([item], item);

export const materialz = z
  .array(z.tuple([idz("src"), z.array(z.tuple([z.number().nonnegative(), z.number().nonnegative()]))]))
  .transform((rows) => Material.fromCanonical(rows));

export function encodeMaterial(m: Material): string {
  return JSON.stringify(Material.canonical(m));
}

const verdict = z.enum(["yes", "no", "uncertain"]);
const channel = z.enum(["transcript", "frames", "playback"]);
const adSignal = z.enum(["dom_class", "duration_mismatch"]);

// ───────────────────────────── Evidence ─────────────────────────────────────

const gapz = z.object({
  sourceId: idz("src"),
  interval: intervalz,
  channel,
  reason: z.enum([
    "no_transcript", "transcript_declined", "hidden_tab", "frame_stall", "channel_failed", "capture_paused",
    "partially_watched_segment", "implausible_span",
  ]),
});

// The brand exists to stop the backend hand-building passages; the app only
// receives passages the backend already clipped to watched time (R1).
const passagez = z
  .object({
    kind: z.literal("passage"), id: idz("ev"), sourceId: idz("src"), transcriptRevId: idz("trv"), interval: intervalz,
    text: z.string(), origin: z.enum(["panel", "caption_intercept", "asr"]),
  })
  .transform((p) => p as unknown as Passage);

const framez = z
  .object({
    kind: z.literal("frame"), id: idz("ev"), sourceId: idz("src"), mediaS: mediaz, width: z.number(), height: z.number(),
    teaching: z.enum(["kept", "dropped", "uncertain", "unjudged"]),
  })
  .transform((f) => f as unknown as Frame);

const adz = z.object({ sourceId: idz("src"), atContentS: mediaz, wallDurationMs: z.number(), signals: nonEmpty(adSignal) });
const deletedz = z.object({ kind: z.literal("deleted"), id: idz("ev"), deletedAtMs: z.number() });

export const evidenceBundlez = z.object({
  material: materialz,
  passages: z.array(passagez),
  frames: z.array(framez),
  gaps: z.array(gapz),
  ads: z.array(adz),
}) satisfies z.ZodType<EvidenceBundle>;

// ───────────────────────────── Capture ──────────────────────────────────────

const inviteStatez: z.ZodType<InviteState> = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("invited"), atChunk: idz("crv") }),
  z.object({ state: z.literal("later") }),
  z.object({ state: z.literal("waiting") }),
]);

const captureViewz = z.object({
  captureId: idz("cap"),
  status: z.discriminatedUnion("state", [
    z.object({ state: z.literal("capturing") }),
    z.object({ state: z.literal("paused"), reason: z.enum(["user", "left_watch_page", "returned_to_watch_page", "tab_closed"]) }),
    z.object({ state: z.literal("stopped") }),
  ]),
  sources: z.array(
    z.object({ id: idz("src"), videoId: z.string(), title: z.string(), url: z.string(), channelName: z.string(), durationS: z.number().nullable() }),
  ),
  currentSourceId: idz("src").nullable(),
  transcript: z.enum(["available", "unavailable_offer_asr", "gap_accepted", "asr_running", "unknown"]),
  health: z.array(z.object({ channel, health: z.enum(["ok", "failed", "stalled", "unknown"]), detail: z.string() })),
  watchedSeconds: z.number(),
}) satisfies z.ZodType<CaptureView>;

export const captureResponsez = z.object({ capture: captureViewz, invite: inviteStatez });
export type CaptureResponse = z.output<typeof captureResponsez>;

// ───────────────────────────── Claims and options ───────────────────────────

const claimDraftz = z.object({
  text: z.string(), evidence: nonEmpty(idz("ev")), visualDependent: z.boolean(), assumptions: z.array(z.string()),
}) satisfies z.ZodType<ClaimDraft>;

const checkz = z.object({
  verdict, p: z.number().nullable(), reason: z.enum(["jev", "invalid_refs", "error"]), memoKey: idz("key"), atSeq: seqz,
});

const claimz = z.object({
  id: idz("clm"),
  sourceChunkId: idz("chk"),
  conceptId: idz("cpt"),
  original: claimDraftz,
  originalCheck: checkz.nullable(),
  revision: claimDraftz.nullable(),
  revisionCheck: checkz.nullable(),
  status: z.enum(["awaiting_check", "awaiting_revision", "awaiting_recheck", "supported_by_check", "unverified", "dropped"]),
}) satisfies z.ZodType<Claim>;

const partialReasonz = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("capture_gap"), gap: gapz }),
  z.object({ kind: z.literal("stopped_early"), droppedClaims: z.number() }),
  z.object({ kind: z.literal("unverified_claims"), count: z.number() }),
  z.object({ kind: z.literal("chunks_still_preparing"), count: z.number() }),
]);

const scopePreviewz = z.object({ chunkRevisions: nonEmpty(idz("crv")), supportedClaims: z.number(), partial: z.array(partialReasonz) });

const nothingToReviewz = z.object({
  kind: z.literal("nothing_to_review"),
  gaps: z.array(gapz),
  unverified: z.array(claimz),
  rewatch: z.array(z.object({ sourceId: idz("src"), interval: intervalz })),
});

export const reviewOptionsz = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), scope: scopePreviewz }),
  z.object({ kind: z.literal("processing"), readyNow: scopePreviewz.nullable(), pendingChunks: z.number(), estimateS: z.number().nullable() }),
  nothingToReviewz,
]) satisfies z.ZodType<ReviewOptions>;

const frozenScopez = z.object({
  chunkRevisions: nonEmpty(idz("crv")),
  material: materialz,
  claimsAtStart: nonEmpty(idz("clm")),
  partial: z.array(partialReasonz),
  frozenAtSeq: seqz,
}) satisfies z.ZodType<FrozenScope>;

export const startResultz = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), reviewId: idz("rvw"), scope: frozenScopez }),
  nothingToReviewz,
]) satisfies z.ZodType<StartResult>;

// ───────────────────────────── Review ───────────────────────────────────────

const evidenceIds = z.array(idz("ev"));

const tutorMovez: z.ZodType<TutorMove> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ask_main"), threadId: idz("thr"), claimIds: nonEmpty(idz("clm")) }),
  z.object({ kind: z.literal("ask_followup"), threadId: idz("thr") }),
  z.object({ kind: z.literal("diagnose"), threadId: idz("thr"), hypothesis: z.string(), evidence: evidenceIds }),
  z.object({ kind: z.literal("hint"), threadId: idz("thr") }),
  z.object({ kind: z.literal("explain"), threadId: idz("thr"), evidence: evidenceIds }),
  z.object({ kind: z.literal("propose_detour"), topic: z.string(), reason: z.string(), needsResource: idz("res").nullable() }),
  z.object({ kind: z.literal("detour_step") }),
  z.object({ kind: z.literal("answer_dispute"), threadId: idz("thr"), evidence: evidenceIds, settled: z.boolean() }),
  z.object({ kind: z.literal("disclose_correction"), correctionId: z.string(), threadIds: z.array(idz("thr")), evidence: evidenceIds }),
  z.object({ kind: z.literal("close_thread"), threadId: idz("thr") }),
  z.object({ kind: z.literal("wrap_up") }),
]);

const codeNoticez = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("soft_target_reached"), elapsedS: z.number() }),
  z.object({ kind: z.literal("correction_pending"), correctionId: z.string(), affectedClaims: z.array(idz("clm")) }),
  z.object({ kind: z.literal("resource_ready"), resourceId: idz("res") }),
]);

const turnBase = { id: idz("turn"), reviewId: idz("rvw"), seq: seqz, atMs: z.number() };

const learnerTurnz = z.object({ ...turnBase, actor: z.literal("learner"), threadId: idz("thr").nullable(), act: learnerAct });

const turnz = z.discriminatedUnion("actor", [
  learnerTurnz,
  z.object({ ...turnBase, actor: z.literal("tutor"), threadId: idz("thr").nullable(), move: tutorMovez, say: z.string() }),
  z.object({ ...turnBase, actor: z.literal("code"), threadId: z.null(), notice: codeNoticez }),
]) satisfies z.ZodType<Turn>;

const detourz: z.ZodType<DetourState> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("proposed"), turnId: idz("turn"), topic: z.string(), needsResource: idz("res").nullable() }),
  z.object({ kind: z.literal("awaiting_resource"), resourceId: idz("res"), topic: z.string() }),
  z.object({ kind: z.literal("active"), topic: z.string(), acceptedTurnId: idz("turn") }),
]);

const reviewStatez = z.object({
  reviewId: idz("rvw"),
  phase: z.enum(["active", "paused", "ended"]),
  mainQuestions: z.number(),
  openThread: idz("thr").nullable(),
  lastLearnerAct: learnerTurnz.nullable(),
  detour: detourz,
  openDispute: idz("thr").nullable(),
  corrections: z.array(z.object({ id: z.string(), claimId: idz("clm"), change: z.enum(["withdrawn", "text_changed", "new_in_scope"]), disclosed: z.boolean() })),
  activeSeconds: z.number(),
  softTargetS: z.number(),
  softTargetOffered: z.boolean(),
  wrapUpRequested: z.boolean(),
});

const observationStatus = z.enum(["independent", "partial", "after_help", "unresolved", "not_assessed"]);

const observationz = z.object({
  id: idz("obs"),
  reviewId: idz("rvw"),
  threadId: idz("thr"),
  claimIds: nonEmpty(idz("clm")),
  conceptIds: z.array(idz("cpt")),
  proposed: observationStatus,
  status: z.union([observationStatus, z.literal("disputed")]),
  clampedFrom: observationStatus.nullable(),
  dispute: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("open"), turnId: idz("turn") }),
    z.object({ kind: z.literal("unsettled") }),
    z.object({ kind: z.literal("resolved_by_learner"), outcome: z.enum(["learner_was_right", "it_was_my_gap"]) }),
  ]),
  corrections: z.array(z.string()),
  facts: z.object({
    threadId: idz("thr"),
    firstSubstantiveAnswerSeq: seqz.nullable(),
    firstHelpSeq: seqz.nullable(),
    endedBySkip: z.boolean(),
    saidDontKnowOnly: z.boolean(),
    learnerTurns: z.array(idz("turn")),
    helpTurns: z.array(idz("turn")),
  }),
}) satisfies z.ZodType<Observation>;

export const reviewViewz = z.object({
  reviewId: idz("rvw"),
  captureId: idz("cap"),
  scope: frozenScopez,
  state: reviewStatez,
  turns: z.array(turnz),
  observations: z.array(observationz),
  saved: z.enum(["unsaved", "saved", "save_pending"]),
}) satisfies z.ZodType<ReviewView>;

export const turnEventz = z.discriminatedUnion("type", [
  z.object({ type: z.literal("learner_turn_stored"), turnId: idz("turn") }),
  z.object({ type: z.literal("move"), turnId: idz("turn"), move: tutorMovez }),
  z.object({ type: z.literal("say_delta"), text: z.string() }),
  z.object({ type: z.literal("sentence"), text: z.string() }),
  z.object({ type: z.literal("turn_complete"), turnId: idz("turn") }),
  z.object({ type: z.literal("turn_failed"), error: z.string(), retryable: z.boolean() }),
]) satisfies z.ZodType<TurnEvent>;

// ───────────────────────────── Record, save, usage ──────────────────────────

const authorz = z.enum(["learner", "tutor", "source"]);
const linkTypez = z.enum(["prerequisite_of", "part_of", "example_of", "contrasts_with", "related_to"]);

const notez = z.object({
  id: idz("note"),
  reviewId: idz("rvw"),
  conceptId: idz("cpt"),
  generated: z.array(z.object({ author: authorz, text: z.string(), turnId: idz("turn").nullable(), evidence: evidenceIds })),
  userEdit: z.string().nullable(),
  evidence: evidenceIds,
}) satisfies z.ZodType<Note>;

export const recordViewz = z.object({
  notes: z.array(notez),
  observations: z.array(observationz),
  links: z.array(
    z.object({
      id: idz("lnk"),
      from: idz("cpt"),
      to: idz("cpt"),
      type: linkTypez,
      evidence: evidenceIds,
      rationale: z.string(),
      decision: z.union([z.enum(["suggested", "accepted", "rejected"]), z.object({ corrected: linkTypez })]),
    }),
  ),
  unavailableEvidence: z.array(deletedz),
}) satisfies z.ZodType<RecordView>;

export const saveResultz = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), notes: z.number(), observations: z.number(), links: z.number() }),
  z.object({ kind: z.literal("save_failed"), error: z.string(), retryable: z.literal(true) }),
]) satisfies z.ZodType<SaveResult>;

const COST_KINDS = ["measured", "notional", "estimated", "unknown"] as const;
const PURPOSES = ["boundary", "frame_change", "claim_check", "interpretation", "claim_revision", "resource_search", "tutor_turn", "wrap_up"] as const;

/** A kind with no calls may be omitted by the backend; it decodes as zero calls and no amount, never as $0. */
export const usageSummaryz = z
  .object({
    byKind: z.partialRecord(z.enum(COST_KINDS), z.object({ calls: z.number(), usd: z.number().nullable() })),
    byPurpose: z.partialRecord(z.enum(PURPOSES), z.object({ calls: z.number(), errors: z.number(), unknownCost: z.number() })),
  })
  .transform(
    (s): UsageSummary => ({
      byKind: Object.fromEntries(COST_KINDS.map((k) => [k, s.byKind[k] ?? { calls: 0, usd: null }])) as UsageSummary["byKind"],
      byPurpose: Object.fromEntries(PURPOSES.map((p) => [p, s.byPurpose[p] ?? { calls: 0, errors: 0, unknownCost: 0 }])) as UsageSummary["byPurpose"],
    }),
  );
