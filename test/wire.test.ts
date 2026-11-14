import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { randomId, stableId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { createApi } from "../src/app/api";
import type { AppApi } from "../src/app/api";
import {
  captureResponsez, encodeMaterial as appEncodeMaterial, evidenceBundlez, recordViewz, reviewOptionsz, reviewViewz, saveResultz, startResultz,
  turnEventz, usageSummaryz,
} from "../src/app/decode";
import {
  BadRequest, ROUTES, decodeMaterial, encodeMaterial, matchRoute, parseIngestBatch, routeUrl, parseLinkDecisionRequest, parseObservationOverrideRequest, parseStartReviewRequest, parseTurnRequest,
} from "../src/shared/wire";

const captureId = randomId("cap");
const dev = stableId("dev", "wire");
const base = (clientSeq: number) => ({ clientSeq, wallMs: 1_700_000_000_000 + clientSeq });
const span = { kind: "span", videoId: "QgWz_s7uugE", start: 10, end: 15, rate: 1, tabVisible: true, wallDurationMs: 5000 };
const frame = {
  kind: "frame", videoId: "QgWz_s7uugE", frameId: "f1", mediaS: 12, width: 1280, height: 720,
  trigger: "change_settled", diff: 14.2, jpegBase64: "/9j/4AAQ",
};

describe("parseIngestBatch", () => {
  test("stamps every fact with the branded capture id", () => {
    const parsed = parseIngestBatch({
      captureId,
      facts: [
        { ...base(0), kind: "control", action: "start", reason: "user" },
        { ...base(1), ...span },
        { ...base(2), ...frame },
        { ...base(3), kind: "ad", videoId: "QgWz_s7uugE", atContentS: 15, wallDurationMs: 6000, signals: ["duration_mismatch"] },
      ],
    });
    expect(parsed.captureId).toBe(captureId);
    expect(parsed.facts.map((f) => [f.captureId, f.kind])).toEqual([
      [captureId, "control"], [captureId, "span"], [captureId, "frame"], [captureId, "ad"],
    ]);
  });

  test.each([
    ["a span that does not move forward", { ...base(0), ...span, end: 10 }],
    ["negative media time", { ...base(0), ...span, start: -1 }],
    ["a frame over the 1280 px capture cap", { ...base(0), ...frame, width: 1568 }],
    ["a frame under Jev's 280 px floor", { ...base(0), ...frame, height: 200 }],
    ["an ad with no detection signal", { ...base(0), kind: "ad", videoId: "QgWz_s7uugE", atContentS: 1, wallDurationMs: 1, signals: [] }],
    ["an unknown fact kind", { ...base(0), kind: "telemetry" }],
    ["a malformed video id", { ...base(0), ...span, videoId: "nope" }],
  ])("rejects %s", (_, fact) => {
    expect(() => parseIngestBatch({ captureId, facts: [fact] })).toThrow(BadRequest);
  });

  test("rejects a capture id that is not a cap_ id, and oversized batches", () => {
    expect(() => parseIngestBatch({ captureId: randomId("rvw"), facts: [] })).toThrow(BadRequest);
    const many = Array.from({ length: 501 }, (_, k) => ({ ...base(k), ...span }));
    expect(() => parseIngestBatch({ captureId, facts: many })).toThrow(BadRequest);
  });
});

describe("app requests", () => {
  test("a turn carries an app-minted turn id and a learner act", () => {
    const turnId = randomId("turn");
    expect(parseTurnRequest({ turnId, act: { kind: "answer", text: " rows times columns ", modality: "speech" } })).toEqual({
      turnId, act: { kind: "answer", text: "rows times columns", modality: "speech" },
    });
    expect(parseTurnRequest({ turnId, act: { kind: "detour_wait" } }).act.kind).toBe("detour_wait");
    expect(() => parseTurnRequest({ turnId: randomId("rvw"), act: { kind: "skip" } })).toThrow(BadRequest);
    expect(() => parseTurnRequest({ turnId, act: { kind: "answer", text: "   ", modality: "text" } })).toThrow(BadRequest);
  });

  test("a review start carries an app-minted review id", () => {
    const reviewId = randomId("rvw");
    expect(parseStartReviewRequest({ reviewId, choice: "stop_early" })).toEqual({ reviewId, choice: "stop_early" });
    expect(() => parseStartReviewRequest({ reviewId: "rvw_1", choice: "prepared_only" })).toThrow(BadRequest);
  });

  test("the learner can never record 'disputed' themselves", () => {
    expect(() => parseObservationOverrideRequest({ status: "disputed" })).toThrow(BadRequest);
    expect(parseLinkDecisionRequest({ decision: { corrected: "part_of" } }).decision).toEqual({ corrected: "part_of" });
  });
});

describe("Material wire form", () => {
  const a = stableId("src", "yt", "QgWz_s7uugE");
  const b = stableId("src", "yt", "dQw4w9WgXcQ");
  const two = Material.of([[a, [interval(0, 120), interval(300, 420)]], [b, [interval(10.5, 20.25)]]]);

  test("a two-source Material survives encode, a JSON round trip, decode", () => {
    const encoded = encodeMaterial(two);
    expect(JSON.parse(encoded)).toEqual(Material.canonical(two));
    const viaJson = JSON.stringify(JSON.parse(encoded));
    expect(Material.equals(decodeMaterial(viaJson), two)).toBe(true);
    expect(encodeMaterial(decodeMaterial(encoded))).toBe(encoded);
  });

  test("an empty Material round-trips and a malformed one is a BadRequest", () => {
    expect(Material.isEmpty(decodeMaterial(encodeMaterial(Material.empty)))).toBe(true);
    expect(() => decodeMaterial("not json")).toThrow(BadRequest);
    expect(() => decodeMaterial(JSON.stringify([["src_x", [[0, 1]]]]))).toThrow(BadRequest);
    expect(() => decodeMaterial(JSON.stringify([[a, [[-1, 1]]]]))).toThrow(BadRequest);
  });
});

// ───────────────────────────── Route table ──────────────────────────────────

const rvw = randomId("rvw");
const cap = captureId;
const src = stableId("src", "yt", "QgWz_s7uugE");
const crv = stableId("crv", "chunk-1");
const clm = stableId("clm", "claim-1");
const thr = stableId("thr", "thread-1");
const ev1 = stableId("ev", "passage-1");
const ev2 = stableId("ev", "frame-1");
const cpt = stableId("cpt", "concept-1");
const obs = stableId("obs", "obs-1");
const lnk = stableId("lnk", "link-1");
const nte = stableId("note", "note-1");
const trn = stableId("turn", "t1");

const gap = { sourceId: src, interval: { start: 120, end: 180 }, channel: "frames", reason: "hidden_tab" };
const frozenScope = {
  chunkRevisions: [crv], material: [[src, [[0, 120], [300, 420]]]], claimsAtStart: [clm], partial: [{ kind: "capture_gap", gap }], frozenAtSeq: 7,
};
const observationJson = {
  id: obs, reviewId: rvw, threadId: thr, claimIds: [clm], conceptIds: [cpt], proposed: "partial", status: "partial", clampedFrom: null,
  dispute: { kind: "none" }, corrections: [],
  facts: { threadId: thr, firstSubstantiveAnswerSeq: 2, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [trn], helpTurns: [] },
};
const captureView = {
  captureId: cap, status: { state: "capturing" }, sources: [{ id: src, videoId: "QgWz_s7uugE", title: "Clocks", url: "https://www.youtube.com/watch?v=QgWz_s7uugE", channelName: "Lectures", durationS: 3600 }],
  currentSourceId: src, transcript: "available", health: [{ channel: "frames", health: "ok", detail: "" }], watchedSeconds: 120,
};
const reviewJson = {
  reviewId: rvw, captureId: cap, topics: [{ id: cpt, label: "Clocks", summary: "Ordering events." }], scope: frozenScope,
  state: {
    reviewId: rvw, phase: "active", mainQuestions: 1, quickChecks: 0, fuzzy: [], openThread: thr, lastLearnerAct: null, detour: { kind: "none" }, openDispute: null,
    corrections: [], activeSeconds: 30, softTargetS: 600, softTargetOffered: false, wrapUpRequested: false,
  },
  turns: [
    { id: stableId("turn", "tutor1"), reviewId: rvw, seq: 1, atMs: 1000, threadId: thr, actor: "tutor", move: { kind: "ask_main", threadId: thr, claimIds: [clm] }, say: "What does a clock give you?" },
    { id: trn, reviewId: rvw, seq: 2, atMs: 2000, threadId: thr, actor: "learner", act: { kind: "answer", text: "An ordering.", modality: "speech" } },
  ],
  owesMove: false,
  observations: [observationJson],
  saved: "unsaved",
};
const recordJson = {
  notes: [{ id: nte, reviewId: rvw, conceptId: cpt, generated: [{ author: "tutor", text: "Clocks order events.", turnId: trn, evidence: [ev1] }], userEdit: null, evidence: [ev1] }],
  observations: [observationJson],
  links: [{ id: lnk, from: cpt, to: stableId("cpt", "concept-2"), type: "prerequisite_of", evidence: [ev1], rationale: "needed first", decision: "suggested" }],
  unavailableEvidence: [{ kind: "deleted", id: ev2, deletedAtMs: 1_700_000_000_000 }],
};
const bundleJson = {
  material: frozenScope.material,
  passages: [{ kind: "passage", id: ev1, sourceId: src, transcriptRevId: stableId("trv", "t"), interval: { start: 5, end: 9 }, text: "Hello.", origin: "panel" }],
  frames: [{ kind: "frame", id: ev2, sourceId: src, mediaS: 12, width: 1280, height: 720, teaching: "kept" }],
  gaps: [gap],
  ads: [{ sourceId: src, atContentS: 60, wallDurationMs: 15000, signals: ["dom_class"] }],
};
const topicDiagramJson = {
  topicId: cpt, label: "Clocks", claimIds: [clm], frame: { id: ev2, mediaS: 12, sourceId: src, videoId: "QgWz_s7uugE", title: "Locks" },
  summary: { state: "ready", title: "What does a clock give you?", lines: [{ text: "Clock A reads 5, clock B reads 2.", evidence: [ev1, ev2] }] },
};
const readyScope = { chunkRevisions: [crv], supportedClaims: 4, topics: [{ id: cpt, label: "Clocks", summary: "" }], material: [[src, [[0, 120]]]], partial: [] };

type Fixture = {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly request?: unknown;
  readonly response?: unknown;
  /** The decoder W9 ships in src/app/decode.ts, where one exists; the ROUTES schema must agree with it. */
  readonly app?: { parse(raw: unknown): unknown };
};

type RouteName = keyof typeof ROUTES;

const fixtures: Record<RouteName, Fixture> = {
  ingest: {
    request: { captureId: cap, facts: [{ ...base(0), kind: "control", action: "start", reason: "user" }, { ...base(1), ...span }] },
    response: { ackedThroughSeq: 1, invite: { state: "none" }, capture: captureView, reviewAppUrl: "http://127.0.0.1:4317/app/" },
  },
  lectures: { response: { lectures: [{ captureId: cap, sourceTitles: ["Locks"], videos: 1, watchedSeconds: 30, status: { state: "stopped" }, reviews: [{ reviewId: rvw, startedMs: 5, phase: "ended", saved: "unsaved", mainQuestions: 0 }] }] } },
  captureView: { params: { captureId: cap }, response: { capture: captureView, invite: { state: "invited", atChunk: crv } }, app: captureResponsez },
  answerInvite: { params: { captureId: cap }, request: { answer: "later" }, response: { state: "later" } },
  reviewOptions: { params: { captureId: cap }, response: { kind: "ready", scope: readyScope }, app: reviewOptionsz },
  startReview: { params: { captureId: cap }, request: { reviewId: rvw, choice: "prepared_only" }, response: { kind: "started", reviewId: rvw, scope: frozenScope }, app: startResultz },
  sendTurn: { params: { reviewId: rvw }, request: { turnId: trn, act: { kind: "answer", text: "An ordering.", modality: "speech" } }, response: { type: "learner_turn_stored", turnId: trn }, app: turnEventz },
  review: { params: { reviewId: rvw }, response: reviewJson, app: reviewViewz },
  save: { params: { reviewId: rvw }, response: { kind: "saved", notes: 1, observations: 1, links: 0 }, app: saveResultz },
  leaveReview: { params: { reviewId: rvw } },
  diagrams: { params: { reviewId: rvw }, response: { topics: [topicDiagramJson] } },
  requestDiagram: { params: { reviewId: rvw, topicId: cpt }, response: topicDiagramJson },
  record: { query: { reviewId: rvw }, response: recordJson, app: recordViewz },
  usage: { response: { byKind: { unknown: { calls: 3, usd: null } }, byPurpose: { boundary: { calls: 3, errors: 0, unknownCost: 3 } } }, app: usageSummaryz },
  evidence: { query: { captureId: cap }, response: bundleJson, app: evidenceBundlez },
  frameImage: { params: { evidenceId: ev2 } },
  editNote: { params: { noteId: nte }, request: { text: "my words" } },
  deleteNote: { params: { noteId: nte } },
  decideLink: { params: { linkId: lnk }, request: { decision: { corrected: "part_of" } } },
  resolveDispute: { params: { observationId: obs }, request: { outcome: "it_was_my_gap" } },
  overrideObservation: { params: { observationId: obs }, request: { status: "after_help" } },
  deleteEvidence: { request: { evidenceIds: [ev1, ev2] } },
  retryPreparation: { params: { captureId: cap } },
  voiceStatus: { response: { available: true } },
  speak: { request: { text: "What did the lecturer say about ordering?" } },
  createConnectCode: { request: { label: "Chrome on Windows" }, response: { code: "acc_code", expiresMs: 1_700_000_120_000 } },
  exchangeConnectCode: { request: { code: "acc_code" }, response: { token: "acd_token", userId: stableId("usr", "wire") } },
  devices: { response: { devices: [{ id: dev, label: "Chrome on Windows", createdMs: 1_700_000_000_000, lastUsedMs: null }] } },
  revokeDevice: { params: { deviceId: dev } },
};

const names = Object.keys(ROUTES) as RouteName[];

describe("ROUTES", () => {
  test("has a fixture for every route and no extra", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...names].sort());
  });

  test.each(names)("%s: request round-trips, response parses, URL matches back to the route", (name) => {
    const route = ROUTES[name];
    const fx = fixtures[name];
    if (fx.request !== undefined) {
      expect(route.request).not.toBeNull();
      const once = route.request!.parse(fx.request);
      expect(route.request!.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
    } else {
      expect(route.request).toBeNull();
    }
    if (route.reply.kind === "json" || route.reply.kind === "ndjson") {
      const schema = route.reply.kind === "json" ? route.reply.schema : route.reply.event;
      expect(schema.parse(fx.response)).toEqual(fx.app === undefined ? fx.response : fx.app.parse(fx.response));
    } else {
      expect(fx.response).toBeUndefined();
    }
    const url = routeUrl(route, fx.params ?? {});
    expect(matchRoute(route.method, url)).toEqual({ name, params: fx.params ?? {} });
    if (fx.query !== undefined) {
      expect(route.query).not.toBeNull();
      expect(route.query!.safeParse(fx.query).success).toBe(true);
    }
  });

  test("path parameters are percent-encoded and decoded back", () => {
    const url = routeUrl(ROUTES.review, { reviewId: "a/b c" });
    expect(url).toBe("/reviews/a%2Fb%20c");
    expect(matchRoute("GET", url)).toEqual({ name: "review", params: { reviewId: "a/b c" } });
    expect(matchRoute("DELETE", "/reviews/x")).toBeNull();
    expect(matchRoute("GET", "/nowhere")).toBeNull();
  });

  test("the evidence query takes exactly one of material, ids, captureId", () => {
    const q = ROUTES.evidence.query!;
    const material = Material.of([[src, [interval(0, 60)]]]);
    const byMaterial = q.parse({ material: encodeMaterial(material) }) as { material: Material };
    expect(Material.equals(byMaterial.material, material)).toBe(true);
    expect(q.parse({ ids: `${ev1},${ev2}` })).toEqual({ ids: [ev1, ev2] });
    expect(q.parse({ captureId: cap })).toEqual({ captureId: cap });
    expect(q.safeParse({}).success).toBe(false);
    expect(q.safeParse({ captureId: cap, ids: ev1 }).success).toBe(false);
    expect(q.safeParse({ ids: "nope" }).success).toBe(false);
    expect(q.safeParse({ material: "not json" }).success).toBe(false);
  });

  test("the record query takes an optional review id", () => {
    expect(ROUTES.record.query!.parse({})).toEqual({});
    expect(ROUTES.record.query!.safeParse({ reviewId: "nope" }).success).toBe(false);
  });

  test("a response that does not match its schema is refused", () => {
    const save = ROUTES.save.reply;
    expect(save.kind === "json" && save.schema.safeParse({ kind: "saved" }).success).toBe(false);
    const ingest = ROUTES.ingest.reply;
    expect(ingest.kind === "json" && ingest.schema.safeParse({ ...(fixtures.ingest.response as object), ackedThroughSeq: -2 }).success).toBe(false);
  });

  test("clientSeq starts at 0, and an ack of -1 means nothing stored yet", () => {
    const ingest = ROUTES.ingest.reply;
    expect(ingest.kind === "json" && ingest.schema.safeParse({ ...(fixtures.ingest.response as object), ackedThroughSeq: -1 }).success).toBe(true);
    expect(() => parseIngestBatch({ captureId, facts: [{ ...base(-1), ...span }] })).toThrow(BadRequest);
    expect(parseIngestBatch({ captureId, facts: [{ ...base(0), ...span }] }).facts[0]!.clientSeq).toBe(0);
  });
});

describe("both clients stay inside ROUTES", () => {
  const appCalls: Record<RouteName, ((api: AppApi) => Promise<unknown>) | null> = {
    ingest: null,
    retryPreparation: (a) => a.retryPreparation(cap),
    lectures: (a) => a.lectures(),
    captureView: (a) => a.captureView(cap),
    answerInvite: (a) => a.answerInvite(cap, "later"),
    reviewOptions: (a) => a.reviewOptions(cap),
    startReview: (a) => a.startReview(cap, "prepared_only", rvw),
    sendTurn: async (a) => {
      for await (const ev of a.sendTurn(rvw, trn, { kind: "skip" })) void ev;
    },
    review: (a) => a.review(rvw),
    save: (a) => a.save(rvw),
    leaveReview: (a) => a.leaveReview(rvw),
    diagrams: (a) => a.diagrams(rvw),
    requestDiagram: (a) => a.requestDiagram(rvw, cpt),
    record: (a) => a.record({ reviewId: rvw }),
    usage: (a) => a.usage(),
    evidence: (a) => a.evidence({ ids: [ev1, ev2] }),
    frameImage: (a) => a.frameImage(ev2),
    editNote: (a) => a.editNote(nte, "my words"),
    deleteNote: (a) => a.deleteNote(nte),
    decideLink: (a) => a.decideLink(lnk, "accepted"),
    resolveDispute: (a) => a.resolveDispute(obs, "learner_was_right"),
    overrideObservation: (a) => a.overrideObservation(obs, "partial"),
    deleteEvidence: (a) => a.deleteEvidence([ev1]),
    voiceStatus: (a) => a.voiceAvailable(),
    speak: (a) => a.speech("What did the lecturer say about ordering?"),
    createConnectCode: (a) => a.createConnectCode("Chrome on Windows"),
    exchangeConnectCode: null,
    devices: (a) => a.devices(),
    revokeDevice: (a) => a.revokeDevice(dev),
  };

  test("every createApi method calls a ROUTES route with a body its request schema accepts, and reads the fixture response", async () => {
    for (const name of names) {
      const call = appCalls[name];
      if (call === null) continue;
      const seen: { method: string; url: string; body: unknown }[] = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        seen.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        const hit = matchRoute(method, url.split("?")[0]!);
        const reply = hit === null ? undefined : ROUTES[hit.name].reply;
        const response = hit === null ? undefined : fixtures[hit.name].response;
        if (reply?.kind === "ndjson") return new Response(`${JSON.stringify(response)}\n${JSON.stringify({ type: "turn_complete", turnId: trn })}\n`);
        if (reply?.kind === "jpeg" || reply?.kind === "audio") return new Response(new Blob(["x"]));
        if (reply?.kind === "json") return new Response(JSON.stringify(response));
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      await call(createApi("tok", { fetch: fetchFn }));
      expect(seen, name).toHaveLength(1);
      const c = seen[0]!;
      const hit = matchRoute(c.method, c.url.split("?")[0]!);
      expect(hit, `${name}: ${c.method} ${c.url} is not in ROUTES`).not.toBeNull();
      expect(hit!.name).toBe(name);
      const route = ROUTES[name];
      if (route.request !== null) expect(route.request.safeParse(c.body).success).toBe(true);
      else expect(c.body).toBeUndefined();
      const qs = c.url.split("?")[1];
      if (qs !== undefined) expect(route.query!.safeParse(Object.fromEntries(new URLSearchParams(qs))).success).toBe(true);
    }
  });

  test("every backendFetch in the extension worker names a ROUTES route", () => {
    const text = readFileSync(new URL("../src/extension/worker/service-worker.ts", import.meta.url), "utf8");
    const calls = [...text.matchAll(/backendFetch\(\s*"(GET|POST|PATCH|DELETE)"\s*,\s*[`"]([^`"]+)[`"]/g)].map((m) => [m[1]!, m[2]!.replace(/\$\{[^}]+\}/g, cap)] as const);
    const hits = calls.map(([method, path]) => {
      const hit = matchRoute(method, path);
      expect(hit, `${method} ${path} is not in ROUTES`).not.toBeNull();
      return hit!.name;
    });
    expect([...new Set(hits)].sort()).toEqual(["answerInvite", "exchangeConnectCode", "ingest", "usage"]);
  });

  test("the extension reads the invite state back from the invite answer", () => {
    const reply = ROUTES.answerInvite.reply;
    expect(reply.kind === "json" && reply.schema.parse({ state: "waiting" })).toEqual({ state: "waiting" });
  });
});

describe("encodeMaterial agrees with the app's own encoder", () => {
  test("same string, so the app's evidence query decodes on the backend", () => {
    const m = Material.of([[src, [interval(0, 60)]], [stableId("src", "yt", "dQw4w9WgXcQ"), [interval(5, 6)]]]);
    expect(encodeMaterial(m)).toBe(appEncodeMaterial(m));
  });
});
