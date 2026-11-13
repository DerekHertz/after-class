/**
 * Review app client (W9). Same origin as the backend. Locally the pairing token is
 * injected into the served HTML; hosted, each request asks the Clerk session for a
 * fresh token, since a session token lives about a minute.
 *
 *   const opts = await api.reviewOptions(captureId);
 *   const start = await api.startReview(captureId, "prepared_only", randomId("rvw"));
 *   for await (const ev of api.sendTurn(reviewId, randomId("turn"), { kind: "answer", text, modality: "speech" })) {
 *     if (ev.type === "sentence") speak(ev.text);          // the tutor stops when Web Speech onspeechstart fires
 *   }
 *   const saved = await api.save(reviewId);                 // save_failed → show pending + Retry (same call)
 *
 * IDs are minted here, once per user act, and kept with unsent turns in
 * IndexedDB until the backend echoes `learner_turn_stored`, so a resend is the
 * same request (R15 for turns, not only for the final save).
 */
import { z } from "zod";
import type { CaptureId, ConceptId, EvidenceId, LinkId, NoteId, ObservationId, ReviewId, TurnId } from "../shared/ids";
import type {
  EvidenceBundle, InviteAnswer, LearnerAct, TopicDiagram, LinkDecision, ObservationStatus, RecordView, ReviewOptions, ReviewView, SaveResult, StartChoice,
  StartResult, UsageSummary,
} from "../shared/domain";
import type { Material } from "../shared/time";
import type { LecturesResponse, TutorStreamEvent } from "../shared/wire";
import { ROUTES, diagramsResponse, lecturesResponse, parseStartReviewRequest, topicDiagramResponse, parseTurnRequest, routeUrl, voiceStatusResponse } from "../shared/wire";
import {
  captureResponsez, encodeMaterial, evidenceBundlez, recordViewz, reviewOptionsz, reviewViewz, saveResultz, startResultz, usageSummaryz,
} from "./decode";
import type { CaptureResponse } from "./decode";
import { tutorEvents } from "./ndjson";

export type Api = {
  reviewOptions(captureId: CaptureId): Promise<ReviewOptions>;
  startReview(captureId: CaptureId, choice: StartChoice, reviewId: ReviewId): Promise<StartResult>;
  sendTurn(reviewId: ReviewId, turnId: TurnId, act: LearnerAct): AsyncIterable<TutorStreamEvent>;
  review(reviewId: ReviewId): Promise<ReviewView>;
  save(reviewId: ReviewId): Promise<SaveResult>;
  record(filter: { readonly reviewId?: ReviewId }): Promise<RecordView>;
  usage(): Promise<UsageSummary>;
};

export type EvidenceQuery =
  | { readonly material: Material }
  | { readonly ids: readonly EvidenceId[] }
  | { readonly captureId: CaptureId };

/** The frozen `Api` plus the routes the inspectors and record editing need. */
export type AppApi = Api & {
  lectures(): Promise<LecturesResponse>;
  captureView(captureId: CaptureId): Promise<CaptureResponse>;
  answerInvite(captureId: CaptureId, answer: InviteAnswer): Promise<void>;
  evidence(query: EvidenceQuery): Promise<EvidenceBundle>;
  frameImage(id: EvidenceId): Promise<Blob>;
  editNote(id: NoteId, text: string): Promise<void>;
  deleteNote(id: NoteId): Promise<void>;
  decideLink(id: LinkId, decision: LinkDecision): Promise<void>;
  resolveDispute(id: ObservationId, outcome: "learner_was_right" | "it_was_my_gap"): Promise<void>;
  overrideObservation(id: ObservationId, status: ObservationStatus): Promise<void>;
  deleteEvidence(ids: readonly EvidenceId[]): Promise<void>;
  /** Frame and summary state of every topic in the review. Makes no model call. */
  diagrams(reviewId: ReviewId): Promise<readonly TopicDiagram[]>;
  /** Starts the topic summary (or retries a failed one); answers with where it stands. Poll `diagrams` for the result. */
  requestDiagram(reviewId: ReviewId, topicId: ConceptId): Promise<TopicDiagram>;
  /** Re-queues the capture's unfinished chunks and those with no supported claim. */
  retryPreparation(captureId: CaptureId): Promise<void>;
  /** Whether the backend can speak tutor sentences with ElevenLabs (false in replay mode or without a key). */
  voiceAvailable(): Promise<boolean>;
  /** One tutor sentence as audio/mpeg. `signal` cancels the request, which cancels the upstream call. */
  speech(text: string, signal?: AbortSignal): Promise<Blob>;
};

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    /** 0 means no response arrived (offline, backend down). */
    readonly status: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

export type ApiOptions = { readonly baseUrl?: string; readonly fetch?: typeof fetch };

/** The bearer token: the pairing token, or a function that returns the current session token for each request. */
export type Credential = string | (() => Promise<string>);

export function createApi(credential: Credential, options: ApiOptions = {}): AppApi {
  const token = typeof credential === "string" ? () => Promise.resolve(credential) : credential;
  const base = options.baseUrl ?? "";
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const enc = encodeURIComponent;

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${await token()}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      res = await doFetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : "network error", 0);
    }
    if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
    return res;
  }

  async function call<S extends z.ZodType>(schema: S, method: string, path: string, body?: unknown): Promise<z.output<S>> {
    const res = await send(method, path, body);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(`${method} ${path}: response was not JSON`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError(`${method} ${path}: unexpected response. ${z.prettifyError(parsed.error)}`, res.status);
    return parsed.data;
  }

  const command = async (method: string, path: string, body?: unknown): Promise<void> => {
    await send(method, path, body);
  };

  async function speech(text: string, signal?: AbortSignal): Promise<Blob> {
    const body = ROUTES.speak.request!.parse({ text });
    let res: Response;
    try {
      const headers = { authorization: `Bearer ${await token()}`, "content-type": "application/json" };
      res = await doFetch(`${base}${ROUTES.speak.path}`, { method: ROUTES.speak.method, headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : "network error", 0);
    }
    if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
    return res.blob();
  }

  async function* sendTurn(reviewId: ReviewId, turnId: TurnId, act: LearnerAct): AsyncGenerator<TutorStreamEvent> {
    const request = parseTurnRequest({ turnId, act });
    const res = await send("POST", `/reviews/${enc(reviewId)}/turns`, request);
    if (res.body === null) throw new ApiError("turn response had no body", res.status);
    yield* tutorEvents(res.body);
  }

  return {
    reviewOptions: (captureId) => call(reviewOptionsz, "GET", `/captures/${enc(captureId)}/review-options`),
    startReview: (captureId, choice, reviewId) =>
      call(startResultz, "POST", `/captures/${enc(captureId)}/reviews`, parseStartReviewRequest({ reviewId, choice })),
    sendTurn,
    review: (reviewId) => call(reviewViewz, "GET", `/reviews/${enc(reviewId)}`),
    save: (reviewId) => call(saveResultz, "POST", `/reviews/${enc(reviewId)}/save`),
    record: (filter) => call(recordViewz, "GET", filter.reviewId === undefined ? "/record" : `/record?reviewId=${enc(filter.reviewId)}`),
    usage: () => call(usageSummaryz, "GET", "/usage"),
    lectures: () => call(lecturesResponse, ROUTES.lectures.method, ROUTES.lectures.path),
    captureView: (captureId) => call(captureResponsez, "GET", `/captures/${enc(captureId)}`),
    answerInvite: (captureId, answer) => command("POST", `/captures/${enc(captureId)}/invite`, { answer }),
    evidence: (query) => call(evidenceBundlez, "GET", `/evidence?${evidenceParams(query)}`),
    frameImage: async (id) => (await send("GET", `/frames/${enc(id)}`)).blob(),
    editNote: (id, text) => command("PATCH", `/record/notes/${enc(id)}`, { text }),
    deleteNote: (id) => command("DELETE", `/record/notes/${enc(id)}`),
    decideLink: (id, decision) => command("POST", `/record/links/${enc(id)}`, { decision }),
    resolveDispute: (id, outcome) => command("POST", `/record/observations/${enc(id)}/dispute-resolution`, { outcome }),
    overrideObservation: (id, status) => command("POST", `/record/observations/${enc(id)}/override`, { status }),
    retryPreparation: (captureId) => command(ROUTES.retryPreparation.method, routeUrl(ROUTES.retryPreparation, { captureId })),
    diagrams: async (reviewId) => (await call(diagramsResponse, ROUTES.diagrams.method, routeUrl(ROUTES.diagrams, { reviewId }))).topics,
    requestDiagram: (reviewId, topicId) => call(topicDiagramResponse, ROUTES.requestDiagram.method, routeUrl(ROUTES.requestDiagram, { reviewId, topicId })),
    voiceAvailable: async () => (await call(voiceStatusResponse, ROUTES.voiceStatus.method, ROUTES.voiceStatus.path)).available,
    speech,
    deleteEvidence: (ids) => command("POST", "/record/evidence/delete", { evidenceIds: ids }),
  };
}

export function evidenceParams(query: EvidenceQuery): string {
  if ("material" in query) return `material=${encodeURIComponent(encodeMaterial(query.material))}`;
  if ("ids" in query) return `ids=${query.ids.map(encodeURIComponent).join(",")}`;
  return `captureId=${encodeURIComponent(query.captureId)}`;
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
  } catch {
    // not JSON; fall through to the status line
  }
  return text.trim() !== "" ? text.trim().slice(0, 300) : `${res.status} ${res.statusText}`;
}
