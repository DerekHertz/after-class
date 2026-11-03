// api/contract.ts -- the ONE list of backend operations. Server, typed client (extension SW + review app) and Engine are all
// derived from it:
//   server   : generic HTTP plumbing over `routes` (parse req with zod, call handler, map errors) -- no per-route code
//   client   : createClient(routes) -- typed `api.review.turn({...})` calls; no hand-written fetch
//   engine   : `Engine = Handlers<typeof routes>`; forgetting to implement a route is a compile error
// Requests are untrusted -> real zod. Responses come from our own code -> typed with z.custom<T>() (no double definition of views).
import { z } from "zod";
import { CaptureEvent } from "../domain/capture";
import { CaptureId, ChunkId, EvidenceId, FrameSha, LinkId, NoteId, ObservationId, ReviewId, TurnId } from "../domain/ids";
import { LearnerTurnKind } from "../domain/review";
import type { CaptureView } from "../domain/capture";
import type { EvidenceRef } from "../domain/evidence";
import type { SaveState, LearningRecordDraft } from "../domain/record";
import type { PrepView, ChunkInspectView, ReviewStartView, ReviewView, TutorStreamEvent, RecordView, UsageView } from "./views";

type Kind = "rpc" | "stream" | "bytes_in" | "bytes_out";
export interface Route<Req extends z.ZodType, Res extends z.ZodType, K extends Kind> {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** `:name` segments are merged into the request object before parsing */
  readonly path: string;
  readonly req: Req;
  readonly res: Res;
  readonly kind: K;
}
const route = <Req extends z.ZodType, Res extends z.ZodType, K extends Kind = "rpc">(
  method: Route<Req, Res, K>["method"], path: string, req: Req, res: Res, kind?: K,
): Route<Req, Res, K> => ({ method, path, req, res, kind: (kind ?? "rpc") as K });
const out = <T>() => z.custom<T>();

export const IngestAck = z.object({
  ackedThrough: z.number().int(),
  needBytes: z.array(FrameSha),
  rejected: z.array(z.object({ seq: z.number().int(), reason: z.string() })),
});
export type IngestAck = z.infer<typeof IngestAck>;

export const routes = {
  // ---- extension -> backend ------------------------------------------------------
  "capture.ingest": route("POST", "/api/capture/events", z.object({ events: z.array(CaptureEvent).max(500) }), IngestAck),
  "capture.putFrame": route("PUT", "/api/frames/:sha", z.object({ sha: FrameSha, bytes: z.instanceof(Uint8Array) }), z.object({ result: z.enum(["stored", "exists"]) }), "bytes_in"),
  "capture.view": route("GET", "/api/capture/:captureId", z.object({ captureId: CaptureId }), out<CaptureView>()),

  // ---- preparation and invitations -----------------------------------------------
  "prep.status": route("GET", "/api/capture/:captureId/prep", z.object({ captureId: CaptureId }), out<PrepView>()),
  "prep.choose": route("POST", "/api/capture/:captureId/invite", z.object({ captureId: CaptureId, choice: z.enum(["later", "wait"]) }), out<PrepView>()),
  "prep.retry": route("POST", "/api/chunks/:chunkId/retry", z.object({ chunkId: ChunkId }), out<PrepView>()),
  "prep.inspectChunk": route("GET", "/api/chunks/:chunkId", z.object({ chunkId: ChunkId }), out<ChunkInspectView>()),

  // ---- review ----------------------------------------------------------------------
  /**
   * mode 'now'        : "Review now", ALWAYS available (not gated by invite state): freeze scope from what is prepared.
   * mode 'stop_early' : cancel pending jobs in scope (R8-fenced), keep finished claims, then freeze from what is prepared.
   * reviewId is allocated by the caller => a retried POST is the same review (idempotent).
   */
  "review.begin": route("POST", "/api/capture/:captureId/reviews", z.object({ captureId: CaptureId, reviewId: ReviewId, mode: z.enum(["now", "stop_early"]) }), out<ReviewStartView>()),
  "review.get": route("GET", "/api/reviews/:reviewId", z.object({ reviewId: ReviewId }), out<ReviewView>()),
  /** Stores the learner turn (idempotent on turnId), then streams the tutor's response and any phase/save changes. */
  "review.turn": route("POST", "/api/reviews/:reviewId/turns",
    z.object({ reviewId: ReviewId, turnId: TurnId, kind: LearnerTurnKind, text: z.string().max(20_000), viaSpeech: z.boolean() }),
    out<TutorStreamEvent>(), "stream"),
  "review.retrySave": route("POST", "/api/reviews/:reviewId/save", z.object({ reviewId: ReviewId }), out<SaveState>()),
  "review.pendingSaves": route("GET", "/api/pending-saves", z.object({}), out<readonly { reviewId: ReviewId; draft: LearningRecordDraft; lastError: string }[]>()),

  // ---- learning record -----------------------------------------------------------------
  "record.get": route("GET", "/api/capture/:captureId/record", z.object({ captureId: CaptureId }), out<RecordView>()),
  "record.editNote": route("PUT", "/api/notes/:noteId", z.object({ noteId: NoteId, userText: z.string().nullable() }), out<RecordView>()),
  "record.deleteNote": route("DELETE", "/api/notes/:noteId", z.object({ noteId: NoteId }), out<RecordView>()),
  "record.setLink": route("POST", "/api/links/:linkId", z.object({ linkId: LinkId, status: z.enum(["accepted", "corrected"]) }), out<RecordView>()),
  "record.resolveDispute": route("POST", "/api/observations/:observationId/dispute",
    z.object({ observationId: ObservationId, as: z.enum(["learner_gap", "not_a_gap", "source_corrected"]) }), out<RecordView>()),

  // ---- evidence --------------------------------------------------------------------------
  "evidence.get": route("POST", "/api/evidence/get", z.object({ ids: z.array(EvidenceId).max(200) }), out<readonly EvidenceRef[]>()),
  "evidence.frame": route("GET", "/api/frames/:sha", z.object({ sha: FrameSha }), z.custom<Uint8Array>(), "bytes_out"),
  /** Explicit user intent only; the retention sweeper has no route and cannot reach cited evidence (R16). */
  "evidence.delete": route("POST", "/api/evidence/delete", z.object({ ids: z.array(EvidenceId).min(1), iUnderstandCitedNotesWillShowDeleted: z.literal(true) }), z.object({ deleted: z.number().int() })),

  // ---- cost ----------------------------------------------------------------------------------
  "usage.summary": route("GET", "/api/usage", z.object({ captureId: CaptureId.optional(), reviewId: ReviewId.optional() }), out<UsageView>()),

  // ---- live push for extension popup / review banner (health, invites, processing) --------------
  "events.subscribe": route("GET", "/api/capture/:captureId/events", z.object({ captureId: CaptureId }),
    out<{ readonly tag: "capture_view"; readonly view: CaptureView } | { readonly tag: "prep_view"; readonly view: PrepView }>(), "stream"),
} as const;

export type Routes = typeof routes;
export type ReqOf<K extends keyof Routes> = z.infer<Routes[K]["req"]>;
export type ResOf<K extends keyof Routes> = z.infer<Routes[K]["res"]>;

export interface RequestCtx { readonly signal: AbortSignal; readonly origin: "extension" | "review_app" }

/** Handler shape derived from the table; `stream` routes return an async iterable (SSE), others a promise. */
export type Handlers = {
  [K in keyof Routes]: (req: ReqOf<K>, ctx: RequestCtx) =>
    Routes[K]["kind"] extends "stream" ? AsyncIterable<ResOf<K>> : Promise<ResOf<K>>;
};

/** The whole backend, as the tests and the replay sample see it. */
export interface Engine extends Handlers {
  /** test/replay helper: resolves when no boundary stage runs, no jobs are queued/running */
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** Typed client: `const api = createClient(base, token, fetch); await api["review.begin"]({ ... })`. */
export type Client = { [K in keyof Routes]: (req: ReqOf<K>, signal?: AbortSignal) =>
  Routes[K]["kind"] extends "stream" ? AsyncIterable<ResOf<K>> : Promise<ResOf<K>> };
export function createClient(baseUrl: string, token: string, fetcher: typeof fetch): Client {
  throw new Error("not implemented");
}
