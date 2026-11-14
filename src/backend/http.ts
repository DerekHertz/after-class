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
 * POST /captures/:id/retry-preparation. M7b adds the record view and its edits, evidence lookup, frame images and
 * evidence deletion, so every `ROUTES` entry is mounted; one whose module is not passed to `serve` answers 501.
 *
 * Accepted limit: the token is in the HTML of GET /app/, so any local process or user that can reach 127.0.0.1:<port>
 * can read it, even though the token file is 0600. The checks above stop web pages and DNS rebinding, not local code.
 * Not yet: GET /events (SSE), GET /trace/captures/:id, GET /memo/:key.
 *
 * Hosted mode (`ServeOptions.hosted`) replaces all three checks. There is no Host check. Origin, when a browser sends
 * one, must be exactly the public origin or the pinned extension; with none, Sec-Fetch-Site must not be cross-site or
 * same-site, as above. Each `ROUTES` entry names the bearer tokens it accepts (`Route.bearer`), and `HostedAuth.userFor`
 * turns a token into the caller's user and says whether it was a session token or a device token; a token of a kind the
 * route does not accept is 401. A device token is accepted only from the pinned extension's Origin. The user's modules
 * (`modulesFor`) serve the request. The connect-code exchange takes no bearer, because the code in its body is the
 * credential, and is served only to the pinned extension. GET /health answers anyone. GET /app/* needs no token and no
 * Origin check, because sign-in returns to it as a cross-site navigation and the page holds no secret: it loads ClerkJS
 * instead of carrying the pairing token, and names the pinned extension so the connect page can reach it. GET /
 * redirects to /app/.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { parseId } from "../shared/ids";
import type { IdKind } from "../shared/ids";
import type { CaptureId, ConceptId, DeviceId, EvidenceId, LinkId, NoteId, ObservationId, ReviewId, SourceId, TurnId, UserId } from "../shared/ids";
import type { EvidenceBundle, Frame, FrozenScope, Passage, ReviewOptions, ReviewSaveState, ReviewView, ScopePreview, StartResult, TurnEvent } from "../shared/domain";
import { Material } from "../shared/time";
import type { Interval } from "../shared/time";
import {
  BadRequest, ROUTES, matchRoute, parseConnectCodeRequest, parseDisputeResolutionRequest, parseEvidenceDeleteRequest, parseExchangeRequest, parseIngestBatch,
  parseInviteAnswerRequest, parseLinkDecisionRequest, parseNoteEditRequest, parseObservationOverrideRequest, parseSpeakRequest, parseStartReviewRequest,
  parseTurnRequest,
} from "../shared/wire";
import type { Bearer, RouteName } from "../shared/wire";
import { LOCAL_USER } from "./db";
import type { Devices } from "./devices";
import type { EvidenceStore, EvidenceStoreWithProbe } from "./evidence";
import type { Preparation } from "./preparation";
import type { Reviews } from "./review";
import type { KeepAlive } from "./review/keepalive";
import type { LearningRecord } from "./record";
import type { Segmentation } from "./segmentation";
import type { Ledger } from "./providers/ledger";
import type { Memo } from "./providers/memo";
import type { Voice } from "./providers/elevenlabs";
import type { Diagrams } from "./diagram";

export type Modules = {
  readonly evidence: EvidenceStore;
  readonly segmentation: Segmentation;
  readonly preparation: Preparation;
  readonly reviews: Reviews;
  readonly record: LearningRecord;
  readonly ledger: Ledger;
  readonly memo: Memo;
  readonly voice: Voice;
  readonly diagrams: Diagrams;
};

export type AuthConfig = { readonly port: number; readonly extensionId: string; readonly token: string };

/** Hosted mode: who may call, and how a bearer token becomes a user. */
export type HostedAuth = {
  /** Scheme, host and port the app is served from, e.g. https://afterclass.example. Origin must match it exactly. */
  readonly publicOrigin: string;
  /** "" refuses every extension origin. */
  readonly extensionId: string;
  /** The ClerkJS script the app page loads, and the publishable key it is loaded with. */
  readonly clerk: { readonly scriptUrl: string; readonly publishableKey: string };
  /** The user a bearer token names and which kind of token it is, or null when the token does not verify. */
  readonly userFor: (token: string) => Promise<Caller | null>;
  /** Connect codes, device tokens and their revocation. */
  readonly devices: Devices;
};

export type Caller = { readonly userId: UserId; readonly bearer: Bearer };

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

/**
 * One user's modules. main.ts passes every module. `record`, `preparation` and `segmentation` stay optional so a test can
 * serve a subset: a route that needs a missing one answers 501, and a review's `saved` reads "unsaved".
 */
export type ServedModules = Pick<Modules, "ledger" | "reviews"> & { readonly evidence: EvidenceStore & Pick<EvidenceStoreWithProbe, "watchedMaterial"> }
  & Partial<Pick<Modules, "record" | "preparation" | "segmentation" | "voice" | "diagrams">>
  & { readonly keepAlive?: Pick<KeepAlive, "leave"> };

/** Local mode serves one user's `modules` behind the pairing token. Hosted mode serves each signed-in user their own. */
export type ServeOptions = ServeCommon & (
  | {
    readonly modules: ServedModules;
    /** `port` 0 binds a free port (tests); the Host check then uses the bound port. */
    readonly auth: AuthConfig;
  }
  | { readonly hosted: HostedAuth; readonly port: number; readonly modulesFor: (userId: UserId) => ServedModules }
);

type ServeCommon = {
  /** Directory holding the bundled review app (scripts/build-app.ts writes dist/app). */
  readonly appDir: string;
  /** Largest request body the server reads; Bun answers 413 beyond it. Defaults to `MAX_BODY_BYTES`. */
  readonly maxBodyBytes?: number;
  /** How long a turn stream may run before it ends with `turn_failed` (retryable). Defaults to `TURN_DEADLINE_MS`; tests shorten it. */
  readonly turnDeadlineMs?: number;
  /** Address to bind. Defaults to 127.0.0.1. A container binds 0.0.0.0 so the load balancer can reach it. */
  readonly hostname?: string;
  /**
   * True lets GET /health skip the Host check, because a load balancer's health check carries the task's address as Host.
   * Every other route keeps the localhost Host check, so a request through the load balancer's name is still a 403.
   */
  readonly healthAnyHost?: boolean;
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
  captureId: "cap", reviewId: "rvw", topicId: "cpt", evidenceId: "ev", noteId: "note", linkId: "lnk", observationId: "obs", deviceId: "dev",
} as const satisfies Record<string, IdKind>;

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...extra } });
}

const failure = (status: number, error: string, extra?: Record<string, string>) => json(status, { error }, extra);

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TOKEN_META = /<meta\s+name="afterclass-token"[^>]*>/i;

function injectToken(html: string, token: string): string {
  const tag = `<meta name="afterclass-token" content="${escapeAttr(token)}">`;
  if (TOKEN_META.test(html)) return html.replace(TOKEN_META, () => tag);
  return html.replace(/<\/head>/i, () => `${tag}</head>`);
}

/**
 * The hosted page: no token tag at all, ClerkJS loaded the way Clerk documents it, keyed by the script's attribute, and
 * the pinned extension's id, which the connect page sends the connect code to.
 */
function injectClerk(html: string, hosted: Pick<HostedAuth, "clerk" | "extensionId">): string {
  const { clerk } = hosted;
  const extension = `<meta name="afterclass-extension-id" content="${escapeAttr(hosted.extensionId)}">`;
  const tag = `<script async crossorigin="anonymous" data-clerk-publishable-key="${escapeAttr(clerk.publishableKey)}" src="${escapeAttr(clerk.scriptUrl)}"></script>`;
  return html.replace(TOKEN_META, "").replace(/<\/head>/i, () => `${extension}${tag}</head>`);
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

function serveApp(req: Request, rest: string, opts: ServeOptions, page: (html: string) => string): Response {
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
    html = page(readFileSync(indexPath, "utf8"));
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

function preflight(req: Request, gate: Gate): Response {
  const verdict = gate.origin(req.headers);
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

const wirePreview = (p: ScopePreview) => ({ ...p, material: Material.canonical(p.material) });
const wireOptions = (o: ReviewOptions) =>
  o.kind === "ready" ? { ...o, scope: wirePreview(o.scope) } : o.kind === "processing" ? { ...o, readyNow: o.readyNow && wirePreview(o.readyNow) } : o;

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

/** What the record holds for a review: its persisted save state and its observations. Without a record, nothing is saved. */
function savedOf(record: LearningRecord | undefined, reviewId: ReviewId): { readonly saved: ReviewSaveState; readonly observations: ReviewView["observations"] } {
  if (!record) return { saved: "unsaved", observations: [] };
  return { saved: record.saveState(reviewId), observations: record.view({ reviewId }).observations };
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

/** A turn stream is cut off after this long; the turn itself carries on and its resend replays it. */
export const TURN_DEADLINE_MS = 5 * 60 * 1000;

/** The turn each review is running, with how many streams are on it (the same turnId may join), so a second turn waits. */
type InFlight = Map<ReviewId, { readonly turnId: TurnId; streams: number }>;

type TurnGuard = { readonly inFlight: InFlight; readonly deadlineMs: number };

/**
 * One JSON object per line. The stream ends after the module's last event; if the module throws, the learner's turn is
 * already stored, so the client is told to resend it (R15). A client that disconnects does not end the turn: the rest
 * of it is drained so the tutor turn is committed once, and a resend then replays it instead of calling the model again.
 * After `deadlineMs` the stream says `turn_failed` (retryable) and closes, and the rest is drained the same way.
 * `release` runs once, when the module has finished, so the review stays held for as long as the turn really runs.
 */
function ndjson(events: AsyncIterable<TurnEvent>, cors: Record<string, string>, deadlineMs: number, release: () => void): Response {
  const it = events[Symbol.asyncIterator]();
  const wire = ROUTES.sendTurn.reply;
  const line = (e: TurnEvent) => encoder.encode(`${JSON.stringify(wire.kind === "ndjson" ? wire.event.parse(e) : e)}\n`);
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    clearTimeout(timer);
    release();
  };
  const drain = async () => {
    abandoned = true;
    try {
      while (!(await it.next()).done);
    } catch {
      // the turn failed with nobody listening; the client's resend will say so
    } finally {
      finish();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        if (abandoned) return;
        controller.enqueue(line({ type: "turn_failed", error: "the tutor took too long; send the turn again", retryable: true }));
        controller.close();
        void drain();
      }, deadlineMs);
    },
    async pull(controller) {
      try {
        const next = await it.next();
        if (abandoned) return;
        if (next.done) {
          finish();
          controller.close();
        } else controller.enqueue(line(next.value));
      } catch {
        if (abandoned) return;
        finish();
        controller.enqueue(line({ type: "turn_failed", error: "internal error", retryable: true }));
        controller.close();
      }
    },
    cancel: () => (abandoned ? undefined : drain()),
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...cors } });
}

async function mounted(name: string, matched: { readonly params: Record<string, string> }, req: Request, modules: ServedModules, appOrigin: string, cors: Record<string, string>, guard: TurnGuard): Promise<Response | null> {
  const { evidence, reviews, record, preparation, segmentation, voice, diagrams, keepAlive } = modules;
  const captureId = matched.params.captureId as CaptureId | undefined;
  const reviewId = matched.params.reviewId as ReviewId | undefined;
  const noteId = matched.params.noteId as NoteId | undefined;
  const linkId = matched.params.linkId as LinkId | undefined;
  const observationId = matched.params.observationId as ObservationId | undefined;
  try {
    // Another user's capture answers as one this caller cannot see. An id nobody has ingested keeps its empty view.
    if (captureId !== undefined && evidence.capturedByAnotherUser(captureId)) return failure(404, "unknown capture", cors);
    switch (name) {
      case "ingest": {
        const raw = await readJson(req);
        assertNoForeignFacts(raw);
        const batch = parseIngestBatch(raw);
        if (evidence.capturedByAnotherUser(batch.captureId)) return failure(404, "unknown capture", cors);
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
            reviewAppUrl: `${appOrigin}/app/capture/${batch.captureId}`,
          },
          cors,
        );
      }
      case "lectures": {
        const lectures = evidence.captures().map((id) => {
          const c = evidence.captureView(id);
          const reviewList = reviews.list(id).map(({ reviewId: rid, startedMs }) => {
            const v = reviews.view(rid);
            const saved: ReviewSaveState = record ? record.saveState(rid) : "unsaved";
            return { reviewId: rid, startedMs, phase: v.state.phase, saved, mainQuestions: v.state.mainQuestions };
          });
          return { captureId: id, sourceTitles: c.sources.map((s) => s.title), videos: c.sources.length, watchedSeconds: c.watchedSeconds, status: c.status, reviews: reviewList };
        });
        return reply("lectures", { lectures }, cors);
      }
      case "captureView":
        return reply("captureView", { capture: evidence.captureView(captureId!), invite: reviews.invite(captureId!) }, cors);
      case "answerInvite": {
        const { answer } = parseInviteAnswerRequest(await readJson(req));
        return reply("answerInvite", reviews.answerInvite(captureId!, answer), cors);
      }
      case "reviewOptions":
        return replyWire("reviewOptions", wireOptions(reviews.options(captureId!)), cors);
      case "startReview": {
        const body = parseStartReviewRequest(await readJson(req));
        if (reviews.heldByAnotherUser(body.reviewId)) return failure(404, "unknown review", cors);
        const existing = reviewOf(reviews, body.reviewId);
        if (existing && existing.captureId !== captureId) return failure(409, "that review belongs to another capture", cors);
        return replyWire("startReview", wireStart(reviews.start(captureId!, body.choice, body.reviewId)), cors);
      }
      case "sendTurn": {
        const { turnId, act } = parseTurnRequest(await readJson(req));
        if (!reviewOf(reviews, reviewId!)) return failure(404, "unknown review", cors);
        const running = guard.inFlight.get(reviewId!);
        if (running && running.turnId !== turnId) return failure(409, "another turn on this review is still running", cors);
        const held = running ?? { turnId, streams: 0 };
        held.streams += 1;
        guard.inFlight.set(reviewId!, held);
        const release = () => {
          if (--held.streams === 0 && guard.inFlight.get(reviewId!) === held) guard.inFlight.delete(reviewId!);
        };
        return ndjson(reviews.turn(reviewId!, turnId, act), cors, guard.deadlineMs, release);
      }
      case "review": {
        const view = reviewOf(reviews, reviewId!);
        if (!view) return failure(404, "unknown review", cors);
        const { saved, observations } = savedOf(record, reviewId!);
        return replyWire("review", { ...view, scope: wireScope(view.scope), observations: [...view.observations, ...observations], saved }, cors);
      }
      case "save": {
        if (!record) return null;
        const toSave = reviewOf(reviews, reviewId!);
        if (!toSave) return failure(404, "unknown review", cors);
        if (toSave.state.phase !== "ended") return failure(409, "the review has not ended, so it cannot be saved", cors);
        return reply("save", await record.save(reviewId!), cors);
      }
      case "leaveReview": {
        // Nothing is kept warm without a keep-alive (the CLI backend, replay), so leaving is then a no-op 204.
        if (!reviewOf(reviews, reviewId!)) return failure(404, "unknown review", cors);
        keepAlive?.leave(reviewId!);
        return noContent(cors);
      }
      case "diagrams": {
        if (!diagrams) return null;
        const topics = diagrams.list(reviewId!);
        if (topics === null) return failure(404, "unknown review", cors);
        return reply("diagrams", { topics }, cors);
      }
      case "requestDiagram": {
        if (!diagrams) return null;
        const started = diagrams.request(reviewId!, matched.params.topicId as ConceptId);
        if (started === null) return failure(404, "unknown review or topic", cors);
        return reply("requestDiagram", started.diagram, cors);
      }
      case "retryPreparation": {
        if (!preparation || !segmentation) return null;
        // Chunks are per user: a capture only another user holds answers as unknown. A capture nobody holds stays a no-op 204.
        if (segmentation.heldByAnotherUser(captureId!)) return failure(404, "unknown capture", cors);
        const stuck = segmentation.current(captureId!).filter((rev) => {
          const prep = preparation.prep(rev.id);
          return !prep.finished || prep.supportedCount === 0;
        });
        if (stuck.length > 0) preparation.retry(captureId!, stuck.map((rev) => rev.id));
        return noContent(cors);
      }
      case "record": {
        if (!record) return null;
        const { reviewId: only } = parseQuery("record", new URL(req.url)) as { reviewId?: ReviewId };
        if (only !== undefined && reviews.heldByAnotherUser(only)) return failure(404, "unknown review", cors);
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
        if ("captureId" in q && evidence.capturedByAnotherUser(q.captureId)) return failure(404, "unknown capture", cors);
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
        if (evidence.heldByAnotherUser(evidenceIds)) return failure(404, "unknown evidence", cors);
        evidence.deleteByUser(evidenceIds, crypto.randomUUID());
        return noContent(cors);
      }
      case "voiceStatus":
        return replyWire("voiceStatus", { available: voice?.available === true }, cors);
      case "speak": {
        const { text } = parseSpeakRequest(await readJson(req));
        if (voice === undefined || !voice.available) return failure(503, "voice unavailable", cors);
        const result = await voice.speak(text, req.signal);
        if (result.kind === "failed") return failure(result.status, result.status === 504 ? "voice timed out" : "voice failed", cors);
        return new Response(result.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...cors } });
      }
      default:
        return null;
    }
  } catch (e) {
    if (e instanceof BadRequest) return failure(400, e.message, cors);
    throw e;
  }
}

const DEVICE_ROUTES: ReadonlySet<RouteName> = new Set(["createConnectCode", "exchangeConnectCode", "devices", "revokeDevice"]);

/**
 * The connected-browser routes. `userId` is the signed-in caller, or null for the exchange, whose code names the user.
 * A device id the caller does not hold, another user's included, is 404 and changes nothing.
 */
async function deviceRoute(name: RouteName, matched: { readonly params: Record<string, string> }, req: Request, devices: Devices, userId: UserId | null, cors: Record<string, string>): Promise<Response> {
  try {
    if (name === "exchangeConnectCode") {
      const result = devices.exchange(parseExchangeRequest(await readJson(req)).code);
      if (result.kind === "limited") return failure(429, "too many connect attempts; try again shortly", { ...cors, "Retry-After": String(result.retryAfterS) });
      if (result.kind === "refused") return failure(401, "that connect code is not valid; press Connect again", cors);
      return reply("exchangeConnectCode", { token: result.token, userId: result.userId }, cors);
    }
    if (userId === null) return failure(401, "unauthorized", cors);
    switch (name) {
      case "createConnectCode":
        return reply("createConnectCode", devices.createCode(userId, parseConnectCodeRequest(await readJson(req)).label), cors);
      case "devices":
        return reply("devices", { devices: devices.list(userId) }, cors);
      case "revokeDevice":
        return devices.revoke(userId, matched.params.deviceId as DeviceId) ? noContent(cors) : failure(404, "unknown device", cors);
      default:
        return failure(501, "not implemented", cors);
    }
  } catch (e) {
    if (e instanceof BadRequest) return failure(400, e.message, cors);
    throw e;
  }
}

type Allowed = { readonly ok: true; readonly origin: Origin };

/** Who a routed request is for. Null only on a route that takes no bearer (the exchange), where the request body names the user. */
type Served = { readonly userId: UserId; readonly modules: ServedModules } | null;

/** What differs between local and hosted mode. Everything else in `handle` is shared. */
type Gate = {
  /** The Origin (and, locally, Host) check alone: preflight and unrouted paths. */
  origin(headers: Headers): Allowed | Denied;
  /** The full check for a `ROUTES` entry, and the user it names with that user's modules. */
  caller(headers: Headers, route: RouteName): Promise<(Allowed & { readonly served: Served }) | Denied>;
  health(headers: Headers): Allowed | Denied;
  app(headers: Headers): Allowed | Denied;
  /** Where GET / redirects; null answers it like any unrouted path. */
  readonly home: string | null;
  page(html: string): string;
  readonly appOrigin: string;
  /** Null locally, where the device routes answer 501. */
  readonly devices: Devices | null;
};

const allowAll = (): Allowed => ({ ok: true, origin: "none" });

function localGate(auth: AuthConfig, modules: ServedModules, healthAnyHost: boolean): Gate {
  const originOnly = (h: Headers) => authorize(h, auth, { requireToken: false });
  const served: Served = { userId: LOCAL_USER, modules };
  return {
    origin: originOnly,
    async caller(h) {
      const v = authorize(h, auth);
      return v.ok ? { ...v, served } : v;
    },
    health: healthAnyHost ? allowAll : originOnly,
    app: originOnly,
    home: null,
    page: (html) => injectToken(html, auth.token),
    appOrigin: `http://127.0.0.1:${auth.port}`,
    devices: null,
  };
}

/** Pure over request headers; unit-tested. A browser's Origin must be the public origin or the pinned extension. */
export function hostedOrigin(headers: Headers, hosted: Pick<HostedAuth, "publicOrigin" | "extensionId">): Allowed | Denied {
  const origin = headers.get("origin");
  if (origin === null) {
    const site = headers.get("sec-fetch-site");
    return site === "cross-site" || site === "same-site" ? { ok: false, status: 403 } : { ok: true, origin: "none" };
  }
  if (origin === hosted.publicOrigin) return { ok: true, origin: "review_app" };
  if (hosted.extensionId !== "" && origin === `chrome-extension://${hosted.extensionId}`) return { ok: true, origin: "extension" };
  return { ok: false, status: 403 };
}

/**
 * Pure over the route and the verified caller: whether hosted mode serves it. The token's kind must be one the route
 * accepts, and a device token must come from the pinned extension, so a web page that got hold of one cannot use it.
 */
export function bearerAllowed(route: RouteName, caller: Caller, origin: Origin): boolean {
  return ROUTES[route].bearer.includes(caller.bearer) && (caller.bearer !== "device" || origin === "extension");
}

function hostedGate(hosted: HostedAuth, modulesFor: (userId: UserId) => ServedModules): Gate {
  const originOnly = (h: Headers) => hostedOrigin(h, hosted);
  return {
    origin: originOnly,
    async caller(h, route) {
      const v = originOnly(h);
      if (!v.ok) return v;
      // The exchange's credential is the code in its body; only the extension trades one, so the app page cannot mint a device token.
      if (ROUTES[route].bearer.length === 0) return v.origin === "extension" ? { ...v, served: null } : { ok: false, status: 403 };
      const token = /^Bearer (.+)$/i.exec(h.get("authorization") ?? "")?.[1];
      const caller = token === undefined ? null : await hosted.userFor(token);
      if (caller === null || !bearerAllowed(route, caller, v.origin)) return { ok: false, status: 401 };
      return { ...v, served: { userId: caller.userId, modules: modulesFor(caller.userId) } };
    },
    health: allowAll,
    app: allowAll,
    home: "/app/",
    page: (html) => injectClerk(html, hosted),
    appOrigin: hosted.publicOrigin,
    devices: hosted.devices,
  };
}

async function handle(req: Request, opts: ServeOptions, gate: Gate, guard: TurnGuard): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return preflight(req, gate);

  if (req.method === "GET" && path === "/health") {
    const v = gate.health(req.headers);
    return v.ok ? json(200, { ok: true }) : failure(v.status, "forbidden");
  }

  if (path === "/app" || path.startsWith("/app/")) {
    const v = gate.app(req.headers);
    return v.ok ? serveApp(req, path.slice("/app/".length), opts, gate.page) : failure(v.status, "forbidden");
  }

  if (gate.home !== null && req.method === "GET" && path === "/") return new Response(null, { status: 302, headers: { Location: gate.home, ...SECURITY_HEADERS } });

  // Bun normalises `..` out of req.url before we see it, so a traversal aimed past /app/ arrives as an unrouted path;
  // answering 404 before the token check keeps it a 404 (and reveals nothing: ROUTES is public).
  const matched = matchRoute(req.method, path);
  if (matched === null) {
    const v = gate.origin(req.headers);
    return v.ok ? failure(404, "not found", corsHeaders(req.headers.get("origin"), v.origin)) : failure(v.status, "forbidden");
  }
  const v = await gate.caller(req.headers, matched.name);
  if (!v.ok) return failure(v.status, v.status === 401 ? "unauthorized" : "forbidden");
  const cors = corsHeaders(req.headers.get("origin"), v.origin);
  for (const [name, value] of Object.entries(matched.params)) {
    const kind = (PARAM_KIND as Record<string, IdKind>)[name];
    if (kind === undefined || parseId(kind, value) === null) return failure(400, `invalid ${name}`, cors);
  }

  if (DEVICE_ROUTES.has(matched.name)) {
    return gate.devices === null ? failure(501, "not implemented", cors) : deviceRoute(matched.name, matched, req, gate.devices, v.served?.userId ?? null, cors);
  }
  if (v.served === null) return failure(401, "unauthorized", cors);
  if (matched.name === "usage") return json(200, v.served.modules.ledger.summary(), cors);
  return (await mounted(matched.name, matched, req, v.served.modules, gate.appOrigin, cors, guard)) ?? failure(501, "not implemented", cors);
}

export function serve(opts: ServeOptions): Bun.Server<undefined> {
  const guard: TurnGuard = { inFlight: new Map(), deadlineMs: opts.turnDeadlineMs ?? TURN_DEADLINE_MS };
  let gate: Gate | undefined;
  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: "hosted" in opts ? opts.port : opts.auth.port,
    // A tutor turn can be silent for a long while before its first word; Bun's default of 10 s would cut the stream.
    idleTimeout: 255,
    maxRequestBodySize: opts.maxBodyBytes ?? MAX_BODY_BYTES,
    async fetch(req) {
      try {
        return await handle(req, opts, gate!, guard);
      } catch {
        return failure(500, "internal error");
      }
    },
  });
  // The local Host check names the bound port, which is known only now (port 0 in tests).
  gate = "hosted" in opts
    ? hostedGate(opts.hosted, opts.modulesFor)
    : localGate({ ...opts.auth, port: server.port as number }, opts.modules, opts.healthAnyHost === true);
  return server;
}
