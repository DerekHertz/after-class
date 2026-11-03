/**
 * Bun.serve shell (W10, composition phase). Thin: authorize → match a `ROUTES` entry → call one module method →
 * serialize. No business logic here.
 *
 * The backend is reachable from every web page in the browser, so "localhost" is not trusted (SYNTHESIS graft 5).
 * `authorize` requires all of:
 *   1. Host is exactly 127.0.0.1:<port> or localhost:<port>        (blocks DNS rebinding)
 *   2. Origin absent (curl, tests, same-origin GET) or in { chrome-extension://<pinned id>, the app origin }
 *   3. Authorization: Bearer <pairing token> (~/.config/afterclass/pairing-token, 0600,
 *      pasted once into the extension options; the review app gets it in its served HTML)
 * CORS preflight is answered only for allow-listed origins; never `*`.
 *
 * Mounted (M3): GET /health (Host and Origin only), GET /usage, GET /app/* (the bundle from scripts/build-app.ts,
 * Host and Origin only, because a navigation cannot carry a header; the token rides in the HTML's
 * <meta name="afterclass-token">). M4 adds POST /ingest, GET /captures/:id and POST /captures/:id/invite. M7a adds the
 * review routes: review options, start review, send turn (an NDJSON stream), get review, save, and
 * POST /captures/:id/retry-preparation (not yet in `ROUTES`). Every other `ROUTES` entry (the record view and edits,
 * evidence lookup, frame images) answers 501 until M7b mounts it.
 *
 * Accepted limit: the token is in the HTML of GET /app/, so any local process or user that can reach 127.0.0.1:<port>
 * can read it, even though the token file is 0600. The checks above stop web pages and DNS rebinding, not local code.
 * Not yet: GET /events (SSE), GET /trace/captures/:id, GET /memo/:key.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { parseId } from "../shared/ids";
import type { IdKind } from "../shared/ids";
import type { CaptureId, EvidenceId, LinkId, NoteId, ObservationId, ReviewId, SourceId } from "../shared/ids";
import type { EvidenceBundle, Frame, FrozenScope, Passage, ReviewSaveState, ReviewView, StartResult, TurnEvent } from "../shared/domain";
import { Material } from "../shared/time";
import type { Interval } from "../shared/time";
import {
  BadRequest, ROUTES, matchRoute, parseDisputeResolutionRequest, parseEvidenceDeleteRequest, parseIngestBatch, parseInviteAnswerRequest,
  parseLinkDecisionRequest, parseNoteEditRequest, parseObservationOverrideRequest, parseStartReviewRequest, parseTurnRequest,
} from "../shared/wire";
import type { EvidenceStore, EvidenceStoreWithProbe } from "./evidence";
import type { Preparation } from "./preparation";
import type { Reviews } from "./review";
import type { LearningRecord } from "./record";
import type { Segmentation } from "./segmentation";
import type { Ledger } from "./providers/ledger";
import type { Memo } from "./providers/memo";

export type Modules = {
  readonly evidence: EvidenceStore;
  readonly segmentation: Segmentation;
  readonly preparation: Preparation;
  readonly reviews: Reviews;
  readonly record: LearningRecord;
  readonly ledger: Ledger;
  readonly memo: Memo;
};

export type AuthConfig = { readonly port: number; readonly extensionId: string; readonly token: string };

type Origin = "extension" | "review_app" | "none";
type Denied = { readonly ok: false; readonly status: 401 | 403 };

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Both sides are hashed first so the comparison is constant-time whatever the lengths. */
function tokenMatches(header: string | null, token: string): boolean {
  const presented = /^Bearer (.+)$/i.exec(header ?? "")?.[1];
  const same = timingSafeEqual(digest(presented ?? ""), digest(token));
  return presented !== undefined && token !== "" && same;
}

/** Pure over request headers; unit-tested. A bad Host or Origin is 403 and is reported before a bad token (401). */
export function authorize(headers: Headers, expected: AuthConfig, opts: { readonly requireToken?: boolean } = {}): { readonly ok: true; readonly origin: Origin } | Denied {
  const { port, extensionId, token } = expected;
  const host = headers.get("host")?.toLowerCase() ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { ok: false, status: 403 };

  const origin = headers.get("origin");
  let kind: Origin = "none";
  if (origin === null) {
    const site = headers.get("sec-fetch-site");
    if (site === "cross-site" || site === "same-site") return { ok: false, status: 403 };
  } else if (origin === `chrome-extension://${extensionId}`) kind = "extension";
  else if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) kind = "review_app";
  else return { ok: false, status: 403 };

  if (opts.requireToken !== false && !tokenMatches(headers.get("authorization"), token)) return { ok: false, status: 401 };
  return { ok: true, origin: kind };
}

export type ServeOptions = {
  /**
   * `record`, `preparation` and `segmentation` are optional until main.ts passes them: a route that needs one answers
   * 501 without it, and a review's `saved` reads "unsaved". M7b widens this to every module.
   */
  readonly modules: Pick<Modules, "ledger" | "reviews"> & { readonly evidence: EvidenceStore & Pick<EvidenceStoreWithProbe, "watchedMaterial"> }
    & Partial<Pick<Modules, "record" | "preparation" | "segmentation">>;
  /** `port` 0 binds a free port (tests); the Host check then uses the bound port. */
  readonly auth: AuthConfig;
  /** Directory holding the bundled review app (scripts/build-app.ts writes dist/app). */
  readonly appDir: string;
  /** Largest request body the server reads; Bun answers 413 beyond it. Defaults to `MAX_BODY_BYTES`. */
  readonly maxBodyBytes?: number;
};

export const DEFAULT_PORT = 4317;

/**
 * 16 MiB. The extension caps a batch at 8 MiB (`BATCH_MAX_BYTES`) but always sends at least one fact, and the wire
 * schema allows a single frame fact of 8 MiB of base64; 16 MiB holds either with 2x margin for JSON overhead. A full
 * 500-fact batch of small facts is well under 1 MiB. Bun's default (128 MiB) would let any local process make the
 * backend buffer a hundred megabytes before the token is even checked.
 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Path parameter name → id kind, so `matchRoute` (which does not validate) never hands a raw string to a module. */
const PARAM_KIND = {
  captureId: "cap", reviewId: "rvw", evidenceId: "ev", noteId: "note", linkId: "lnk", observationId: "obs",
} as const satisfies Record<string, IdKind>;

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...extra } });
}

const failure = (status: number, error: string, extra?: Record<string, string>) => json(status, { error }, extra);

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function injectToken(html: string, token: string): string {
  const tag = `<meta name="afterclass-token" content="${escapeAttr(token)}">`;
  const meta = /<meta\s+name="afterclass-token"[^>]*>/i;
  if (meta.test(html)) return html.replace(meta, () => tag);
  return html.replace(/<\/head>/i, () => `${tag}</head>`);
}

type AppTarget = { readonly kind: "file"; readonly path: string } | { readonly kind: "index" } | { readonly kind: "missing" };

/**
 * Maps the part of the URL after /app/ to a file under `root`. The path is decoded once; anything that could still
 * mean "elsewhere" after that (a `..` or empty segment, NUL, backslash, a leftover `%` from double encoding) is
 * refused outright, and the real path must stay inside the real root, which also stops a symlink out.
 */
function resolveApp(root: string, rest: string): AppTarget {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return { kind: "missing" };
  }
  if (decoded === "") return { kind: "index" };
  const segments = decoded.split("/");
  const trailingSlash = segments.at(-1) === "";
  if (trailingSlash) segments.pop();
  if (segments.some((s) => s === "" || s === "." || s === ".." || /[\0\\%]/.test(s))) return { kind: "missing" };

  let real: string;
  try {
    real = realpathSync(join(root, ...segments));
  } catch {
    return segments.at(-1)!.includes(".") ? { kind: "missing" } : { kind: "index" };
  }
  if (real !== root && !real.startsWith(root + sep)) return { kind: "missing" };
  return statSync(real).isFile() ? { kind: "file", path: real } : { kind: "index" };
}

function serveApp(req: Request, rest: string, opts: ServeOptions, token: string): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return failure(405, "method not allowed", { Allow: "GET, HEAD" });
  let root: string;
  try {
    root = realpathSync(opts.appDir);
  } catch {
    return failure(503, "the review app is not built; run scripts/build-app.ts");
  }
  const target = resolveApp(root, rest);
  if (target.kind === "missing") return failure(404, "not found");

  const indexPath = join(root, "index.html");
  const path = target.kind === "index" ? indexPath : target.path;
  if (path !== indexPath) {
    const file = Bun.file(path);
    return new Response(file, { headers: { "Content-Type": file.type, ...SECURITY_HEADERS } });
  }
  let html: string;
  try {
    html = injectToken(readFileSync(indexPath, "utf8"), token);
  } catch {
    return failure(503, "the review app is not built; run scripts/build-app.ts");
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      ...SECURITY_HEADERS,
    },
  });
}

function corsHeaders(origin: string | null, allowed: Origin): Record<string, string> {
  return allowed !== "none" && origin !== null ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

function preflight(req: Request, auth: AuthConfig): Response {
  const verdict = authorize(req.headers, auth, { requireToken: false });
  const origin = req.headers.get("origin");
  if (!verdict.ok || verdict.origin === "none" || origin === null) return failure(403, "forbidden");
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

/** Reads a JSON body; a body that is not JSON is the caller's fault (400), not ours. */
async function readJson(req: Request): Promise<unknown> {
  try {
    return JSON.parse(await req.text());
  } catch {
    throw new BadRequest("body is not JSON");
  }
}

/**
 * The wire schema carries one captureId per batch and strips any per-fact captureId, so a fact aimed at another
 * capture would otherwise be silently re-labelled into this one. Refuse the whole batch before anything is stored.
 */
function assertNoForeignFacts(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const { captureId, facts } = raw as { captureId?: unknown; facts?: unknown };
  if (!Array.isArray(facts)) return;
  for (const f of facts) {
    if (typeof f === "object" && f !== null && "captureId" in f && (f as { captureId: unknown }).captureId !== captureId) {
      throw new BadRequest("a fact belongs to a different capture than the batch");
    }
  }
}

/** Parses a response through its `ROUTES` schema, so a module that drifts from the wire contract is a 500, never a bad reply. */
const reply = (name: keyof typeof ROUTES, body: unknown, cors: Record<string, string>): Response => {
  const r = ROUTES[name].reply;
  return json(200, r.kind === "json" ? r.schema.parse(body) : body, cors);
};

/** A `Material` is a Map and would cross JSON as `{}`; the wire carries `Material.canonical` rows. */
const wireScope = (scope: FrozenScope) => ({ ...scope, material: Material.canonical(scope.material) });

const wireStart = (r: StartResult) => (r.kind === "started" ? { ...r, scope: wireScope(r.scope) } : r);

/** Validates a response already in wire form against its `ROUTES` schema, then sends it as it is (the schema's output would decode Material back into a Map). */
function replyWire(name: keyof typeof ROUTES, wire: unknown, cors: Record<string, string>): Response {
  const r = ROUTES[name].reply;
  if (r.kind === "json") r.schema.parse(wire);
  return json(200, wire, cors);
}

/** The view of a review, or null when there is no such review; any other failure is the module's and propagates. */
function reviewOf(reviews: Reviews, reviewId: ReviewId): ReviewView | null {
  try {
    return reviews.view(reviewId);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unknown review")) return null;
    throw e;
  }
}

/**
 * The record keeps no save state to ask, so `saved` is: a saved record exists for the review (notes, observations or
 * links), or this process saw the save succeed; failing that, "save_pending" if this process saw it fail.
 */
function savedOf(record: LearningRecord | undefined, outcomes: Map<ReviewId, ReviewSaveState>, reviewId: ReviewId): { readonly saved: ReviewSaveState; readonly observations: ReviewView["observations"] } {
  if (!record) return { saved: "unsaved", observations: [] };
  const rec = record.view({ reviewId });
  const exists = rec.notes.length + rec.observations.length + rec.links.length > 0;
  const seen = outcomes.get(reviewId);
  return { saved: exists || seen === "saved" ? "saved" : (seen ?? "unsaved"), observations: rec.observations };
}

const noContent = (cors: Record<string, string>) => new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });

/** Validates the query string against a route's schema; a repeated key is ambiguous, so it is refused too. */
function parseQuery(name: keyof typeof ROUTES, url: URL): any {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) throw new BadRequest("a query key is repeated");
  const parsed = ROUTES[name].query?.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed?.success) throw new BadRequest("invalid query");
  return parsed.data;
}

/** The wire form of a bundle: `Material` as canonical rows. */
const wireBundle = (b: EvidenceBundle) => ({ ...b, material: Material.canonical(b.material) });

/**
 * `ids` has no material of its own, so the one sent back is what the passages found cover. Ids that are unknown or
 * deleted by the user are left out; the record's `unavailableEvidence` is what tells the learner a citation is gone.
 */
function evidenceByIds(evidence: EvidenceStore, ids: readonly EvidenceId[]): EvidenceBundle {
  const passages: Passage[] = [];
  const frames: Frame[] = [];
  const covered = new Map<SourceId, Interval[]>();
  for (const e of evidence.get(ids).values()) {
    if (e.kind === "passage") {
      passages.push(e);
      covered.set(e.sourceId, [...(covered.get(e.sourceId) ?? []), e.interval]);
    } else if (e.kind === "frame") frames.push(e);
  }
  return { material: Material.of(covered), passages, frames, gaps: [], ads: [] };
}

const encoder = new TextEncoder();

/**
 * One JSON object per line. The stream ends after the module's last event; if the module throws, the learner's turn is
 * already stored, so the client is told to resend it (R15). A client that disconnects does not end the turn: the rest
 * of it is drained so the tutor turn is committed once, and a resend then replays it instead of calling the model again.
 */
function ndjson(events: AsyncIterable<TurnEvent>, cors: Record<string, string>): Response {
  const it = events[Symbol.asyncIterator]();
  const wire = ROUTES.sendTurn.reply;
  const line = (e: TurnEvent) => encoder.encode(`${JSON.stringify(wire.kind === "ndjson" ? wire.event.parse(e) : e)}\n`);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await it.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(line(next.value));
      } catch {
        if (cancelled) return;
        controller.enqueue(line({ type: "turn_failed", error: "internal error", retryable: true }));
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      try {
        while (!(await it.next()).done);
      } catch {
        // the turn failed with nobody listening; the client's resend will say so
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...cors } });
}

/** `POST /captures/:captureId/retry-preparation`. Not in `ROUTES` yet: wire.ts is frozen for this PR. */
function matchLocal(method: string, pathname: string): { readonly name: string; readonly params: Record<string, string> } | null {
  const m = method === "POST" ? /^\/captures\/([^/]+)\/retry-preparation$/.exec(pathname) : null;
  if (!m) return null;
  try {
    return { name: "retryPreparation", params: { captureId: decodeURIComponent(m[1]!) } };
  } catch {
    return null;
  }
}

async function mounted(name: string, matched: { readonly params: Record<string, string> }, req: Request, opts: ServeOptions, port: number, cors: Record<string, string>, outcomes: Map<ReviewId, ReviewSaveState>): Promise<Response | null> {
  const { evidence, reviews, record, preparation, segmentation } = opts.modules;
  const captureId = matched.params.captureId as CaptureId | undefined;
  const reviewId = matched.params.reviewId as ReviewId | undefined;
  const noteId = matched.params.noteId as NoteId | undefined;
  const linkId = matched.params.linkId as LinkId | undefined;
  const observationId = matched.params.observationId as ObservationId | undefined;
  try {
    switch (name) {
      case "ingest": {
        const raw = await readJson(req);
        assertNoForeignFacts(raw);
        const batch = parseIngestBatch(raw);
        let ackedThroughSeq: number;
        try {
          ({ ackedThroughSeq } = evidence.ingest(batch));
        } catch (e) {
          // evidence checks every fact before it stores any, so this refusal leaves nothing behind.
          if (e instanceof RangeError) throw new BadRequest(e.message);
          throw e;
        }
        return reply(
          "ingest",
          {
            ackedThroughSeq,
            invite: reviews.invite(batch.captureId),
            capture: evidence.captureView(batch.captureId),
            reviewAppUrl: `http://127.0.0.1:${port}/app/capture/${batch.captureId}`,
          },
          cors,
        );
      }
      case "captureView":
        return reply("captureView", { capture: evidence.captureView(captureId!), invite: reviews.invite(captureId!) }, cors);
      case "answerInvite": {
        const { answer } = parseInviteAnswerRequest(await readJson(req));
        return reply("answerInvite", reviews.answerInvite(captureId!, answer), cors);
      }
      case "reviewOptions":
        return reply("reviewOptions", reviews.options(captureId!), cors);
      case "startReview": {
        const body = parseStartReviewRequest(await readJson(req));
        const existing = reviewOf(reviews, body.reviewId);
        if (existing && existing.captureId !== captureId) return failure(409, "that review belongs to another capture", cors);
        return replyWire("startReview", wireStart(reviews.start(captureId!, body.choice, body.reviewId)), cors);
      }
      case "sendTurn": {
        const { turnId, act } = parseTurnRequest(await readJson(req));
        if (!reviewOf(reviews, reviewId!)) return failure(404, "unknown review", cors);
        return ndjson(reviews.turn(reviewId!, turnId, act), cors);
      }
      case "review": {
        const view = reviewOf(reviews, reviewId!);
        if (!view) return failure(404, "unknown review", cors);
        const { saved, observations } = savedOf(record, outcomes, reviewId!);
        return replyWire("review", { ...view, scope: wireScope(view.scope), observations: [...view.observations, ...observations], saved }, cors);
      }
      case "save": {
        if (!record) return null;
        if (!reviewOf(reviews, reviewId!)) return failure(404, "unknown review", cors);
        const result = await record.save(reviewId!);
        outcomes.set(reviewId!, result.kind === "saved" ? "saved" : "save_pending");
        return reply("save", result, cors);
      }
      case "retryPreparation": {
        if (!preparation || !segmentation) return null;
        const stuck = segmentation.current(captureId!).filter((rev) => {
          const prep = preparation.prep(rev.id);
          return !prep.finished || prep.supportedCount === 0;
        });
        if (stuck.length > 0) preparation.retry(captureId!, stuck.map((rev) => rev.id));
        return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
      }
      case "record": {
        if (!record) return null;
        const { reviewId: only } = parseQuery("record", new URL(req.url)) as { reviewId?: ReviewId };
        return reply("record", record.view(only === undefined ? {} : { reviewId: only }), cors);
      }
      case "editNote": {
        if (!record) return null;
        const { text } = parseNoteEditRequest(await readJson(req));
        if (!record.view({}).notes.some((n) => n.id === noteId)) return failure(404, "unknown note", cors);
        record.editNote(noteId!, text);
        return noContent(cors);
      }
      case "deleteNote": {
        if (!record) return null;
        if (!record.view({}).notes.some((n) => n.id === noteId)) return failure(404, "unknown note", cors);
        record.deleteNote(noteId!);
        return noContent(cors);
      }
      case "decideLink": {
        if (!record) return null;
        const { decision } = parseLinkDecisionRequest(await readJson(req));
        if (!record.view({}).links.some((l) => l.id === linkId)) return failure(404, "unknown link", cors);
        record.decideLink(linkId!, decision);
        return noContent(cors);
      }
      case "resolveDispute": {
        if (!record) return null;
        const { outcome } = parseDisputeResolutionRequest(await readJson(req));
        if (!record.view({}).observations.some((o) => o.id === observationId)) return failure(404, "unknown observation", cors);
        record.resolveDispute(observationId!, outcome);
        return noContent(cors);
      }
      case "overrideObservation": {
        if (!record) return null;
        const { status } = parseObservationOverrideRequest(await readJson(req));
        if (!record.view({}).observations.some((o) => o.id === observationId)) return failure(404, "unknown observation", cors);
        record.overrideObservation(observationId!, status);
        return noContent(cors);
      }
      case "evidence": {
        const q = parseQuery("evidence", new URL(req.url)) as { material: Material } | { ids: EvidenceId[] } | { captureId: CaptureId };
        const bundle =
          "material" in q ? evidence.bundle(q.material)
          : "ids" in q ? evidenceByIds(evidence, q.ids)
          : evidence.bundle(evidence.watchedMaterial(q.captureId));
        return replyWire("evidence", wireBundle(bundle), cors);
      }
      case "frameImage": {
        const bytes = evidence.frameBytes(matched.params.evidenceId as EvidenceId);
        if (bytes === null) return failure(404, "unknown frame", cors);
        return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...cors } });
      }
      case "deleteEvidence": {
        const { evidenceIds } = parseEvidenceDeleteRequest(await readJson(req));
        evidence.deleteByUser(evidenceIds, crypto.randomUUID());
        return noContent(cors);
      }
      default:
        return null;
    }
  } catch (e) {
    if (e instanceof BadRequest) return failure(400, e.message, cors);
    throw e;
  }
}

async function handle(req: Request, opts: ServeOptions, auth: AuthConfig, outcomes: Map<ReviewId, ReviewSaveState>): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return preflight(req, auth);

  if (req.method === "GET" && path === "/health") {
    const v = authorize(req.headers, auth, { requireToken: false });
    return v.ok ? json(200, { ok: true }) : failure(v.status, "forbidden");
  }

  if (path === "/app" || path.startsWith("/app/")) {
    const v = authorize(req.headers, auth, { requireToken: false });
    return v.ok ? serveApp(req, path.slice("/app/".length), opts, auth.token) : failure(v.status, "forbidden");
  }

  // Bun normalises `..` out of req.url before we see it, so a traversal aimed past /app/ arrives as an unrouted path;
  // answering 404 before the token check keeps it a 404 (and reveals nothing: ROUTES is public).
  const matched = matchRoute(req.method, path) ?? matchLocal(req.method, path);
  const v = authorize(req.headers, auth, { requireToken: matched !== null });
  if (!v.ok) return failure(v.status, v.status === 401 ? "unauthorized" : "forbidden");
  const cors = corsHeaders(req.headers.get("origin"), v.origin);
  if (matched === null) return failure(404, "not found", cors);
  for (const [name, value] of Object.entries(matched.params)) {
    const kind = (PARAM_KIND as Record<string, IdKind>)[name];
    if (kind === undefined || parseId(kind, value) === null) return failure(400, `invalid ${name}`, cors);
  }

  if (matched.name === "usage") return json(200, opts.modules.ledger.summary(), cors);
  return (await mounted(matched.name, matched, req, opts, auth.port, cors, outcomes)) ?? failure(501, "not implemented", cors);
}

export function serve(opts: ServeOptions): Bun.Server<undefined> {
  let auth = opts.auth;
  const outcomes = new Map<ReviewId, ReviewSaveState>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.auth.port,
    // A tutor turn can be silent for a long while before its first word; Bun's default of 10 s would cut the stream.
    idleTimeout: 255,
    maxRequestBodySize: opts.maxBodyBytes ?? MAX_BODY_BYTES,
    async fetch(req) {
      try {
        return await handle(req, opts, auth, outcomes);
      } catch {
        return failure(500, "internal error");
      }
    },
  });
  auth = { ...opts.auth, port: server.port as number };
  return server;
}
