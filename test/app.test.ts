/**
 * Review app (W9): the api client against fixture responses, the NDJSON stream,
 * the pure view logic, and the session controller driven by a fake backend.
 * Nothing here touches a network, a browser or a model.
 */
import { createElement, isValidElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import type { LearnerAct, ReviewView, TurnEvent, UsageSummary } from "../src/shared/domain";
import { stableId, randomId } from "../src/shared/ids";
import type { ReviewId, TurnId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { ApiError, createApi, evidenceParams } from "../src/app/api";
import type { Api } from "../src/app/api";
import { OptionsView, checkAgain } from "../src/app/capture";
import type { AppApi } from "../src/app/api";
import { createReviewController, needsChecklist, needsResume, resumeOnce } from "../src/app/controller";
import { learnerAct } from "../src/shared/wire";
import type { SessionState } from "../src/app/controller";
import {
  availableActions, conversationLines, currentEvidenceIds, estimateText, formatClock, inspectBundle, liveText, noteView, observationRow,
  groupGaps, lectureHeading, optionsScreen, parseRoute, reduceLive, routePath, softTargetPrompt, startLive, toAct, unansweredLearnerTurn, owedLearnerTurn, usageRows,
} from "../src/app/core";
import { evidenceBundlez, reviewOptionsz, reviewViewz } from "../src/app/decode";
import { StreamError, ndjson, tutorEvents } from "../src/app/ndjson";
import { UsageTable } from "../src/app/record";
import { gateSpeaker } from "../src/app/voice";
import { Composer, SaveBanner, TopicChecklist, UndeliveredNote } from "../src/app/review";
import { createSpeechInput, createSynthSpeaker } from "../src/app/speech";
import type { RecognitionLike, Speaker } from "../src/app/speech";
import { BundleInspector, EvidencePane } from "../src/app/ui";
import { createIndexedDbUnsent, createMemoryUnsent } from "../src/app/unsent";

// ───────────────────────────── Fixtures ─────────────────────────────────────

const captureId = randomId("cap");
const reviewId = randomId("rvw");
const src = stableId("src", "yt", "QgWz_s7uugE");
const crv = stableId("crv", "chunk-1");
const clm = stableId("clm", "claim-1");
const thr = stableId("thr", "thread-1");
const ev1 = stableId("ev", "passage-1");
const ev2 = stableId("ev", "frame-1");
const cpt = stableId("cpt", "concept-1");

const canonicalMaterial = [[src, [[0, 120], [300, 420]]]];

const gapJson = { sourceId: src, interval: { start: 120, end: 180 }, channel: "frames", reason: "hidden_tab" };
const claimJson = (status: string) => ({
  id: clm, sourceChunkId: stableId("chk", "c"), conceptId: cpt,
  original: { text: "A clock tick orders events.", evidence: [ev1], visualDependent: false, assumptions: [] },
  originalCheck: null, revision: null, revisionCheck: null, status,
});

const READY = { kind: "ready", scope: { chunkRevisions: [crv], supportedClaims: 4, partial: [] } };

function turnJson(n: number, actor: "learner" | "tutor" | "code", rest: Record<string, unknown>) {
  return { id: actor === "learner" ? stableId("turn", `l${n}`) : stableId("turn", `${actor}${n}`), reviewId, seq: n, atMs: n * 1000, threadId: actor === "code" ? null : thr, actor, ...rest };
}

function reviewJson(overrides: { turns?: unknown[]; phase?: string; saved?: string; detour?: unknown; observations?: unknown[]; owesMove?: boolean } = {}) {
  return {
    reviewId, captureId,
    topics: [{ id: cpt, label: "Logical clocks", summary: "Order events without a shared clock." }, { id: stableId("cpt", "concept-2"), label: "Vector clocks", summary: "" }],
    scope: { chunkRevisions: [crv], material: canonicalMaterial, claimsAtStart: [clm], partial: [{ kind: "capture_gap", gap: gapJson }], frozenAtSeq: 7 },
    state: {
      reviewId, phase: overrides.phase ?? "active", mainQuestions: 1, quickChecks: 0, fuzzy: [], openThread: thr, lastLearnerAct: null,
      detour: overrides.detour ?? { kind: "none" }, openDispute: null, corrections: [], activeSeconds: 30, softTargetS: 600,
      softTargetOffered: false, wrapUpRequested: false,
    },
    turns: overrides.turns ?? [],
    owesMove: overrides.owesMove ?? false,
    observations: overrides.observations ?? [],
    saved: overrides.saved ?? "unsaved",
  };
}

const parsedReview = (o: Parameters<typeof reviewJson>[0] = {}): ReviewView => reviewViewz.parse(reviewJson(o));

const tutorAsk = turnJson(1, "tutor", { move: { kind: "ask_main", threadId: thr, claimIds: [clm] }, say: "What does a logical clock give you?" });
const learnerAnswer = (n = 2) => turnJson(n, "learner", { act: { kind: "answer", text: "An ordering of events.", modality: "speech" } });

/** Every element in a rendered tree, found without a DOM by walking props.children. */
function findElements(node: ReactNode, match: (e: { type: unknown; props: unknown }) => boolean): { type: unknown; props: unknown }[] {
  if (Array.isArray(node)) return node.flatMap((n) => findElements(n, match));
  if (!isValidElement(node)) return [];
  const el = node as { type: unknown; props: { children?: ReactNode } };
  return [...(match(el) ? [el] : []), ...findElements(el.props.children, match)];
}

const enc = new TextEncoder();
const line = (e: TurnEvent) => `${JSON.stringify(e)}\n`;

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

const tid = (s: string) => stableId("turn", s);
const stored = (s: string): TurnEvent => ({ type: "learner_turn_stored", turnId: tid(s) });
const complete = (s: string): TurnEvent => ({ type: "turn_complete", turnId: tid(s) });
const sentence = (text: string): TurnEvent => ({ type: "sentence", text });

// ───────────────────────────── NDJSON ───────────────────────────────────────

describe("NDJSON tutor stream", () => {
  test("reassembles lines and multi-byte characters cut at any byte boundary", async () => {
    const whole = enc.encode(line(stored("a")) + line(sentence("Naïve π is 3.14.")) + line(complete("a")));
    for (const cut of [1, 7, 60, whole.length - 2]) {
      const events = await collect(tutorEvents(streamOf(whole.slice(0, cut), whole.slice(cut))));
      expect(events.map((e) => e.type)).toEqual(["learner_turn_stored", "sentence", "turn_complete"]);
      expect(events[1]).toEqual({ type: "sentence", text: "Naïve π is 3.14." });
    }
  });

  test("a final line without a newline is still delivered, and blank lines are skipped", async () => {
    const values = await collect(ndjson(streamOf('{"a":1}\n\n\r\n{"b":2}')));
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("a stream that ends without a terminal event becomes a retryable failure", async () => {
    const events = await collect(tutorEvents(streamOf(line(stored("a")), line(sentence("Half a")))));
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
  });

  test("a stream cut mid-line is a dropped connection, retryable, not a StreamError", async () => {
    const whole = line(stored("a")) + line(sentence("Half a sentence")) + line(complete("a"));
    const cutAt = whole.indexOf("Half") + 6;
    const events = await collect(tutorEvents(streamOf(whole.slice(0, cutAt))));
    expect(events.map((e) => e.type)).toEqual(["learner_turn_stored", "turn_failed"]);
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
  });

  test("events after turn_complete are never read", async () => {
    const events = await collect(tutorEvents(streamOf(line(complete("a")) + line(sentence("late")))));
    expect(events).toEqual([complete("a")]);
  });

  test("a malformed line or an unknown event is a StreamError, not a silent skip", async () => {
    await expect(collect(tutorEvents(streamOf("not json\n")))).rejects.toBeInstanceOf(StreamError);
    await expect(collect(tutorEvents(streamOf('{"type":"telemetry"}\n')))).rejects.toBeInstanceOf(StreamError);
  });
});

// ───────────────────────────── Api client ───────────────────────────────────

type Call = { readonly url: string; readonly method: string; readonly headers: Headers; readonly body: unknown };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createApi", () => {
  test("sends the bearer token and parses review options of every kind", async () => {
    const bodies = [
      READY,
      { kind: "processing", readyNow: null, pendingChunks: 2, estimateS: null },
      { kind: "nothing_to_review", gaps: [gapJson], unverified: [claimJson("unverified")], rewatch: [{ sourceId: src, interval: { start: 120, end: 180 } }] },
    ];
    const { calls, fetchFn } = fakeFetch(() => json(bodies.shift()));
    const api = createApi("tok", { fetch: fetchFn });
    expect((await api.reviewOptions(captureId)).kind).toBe("ready");
    expect(await api.reviewOptions(captureId)).toMatchObject({ kind: "processing", estimateS: null });
    const none = await api.reviewOptions(captureId);
    expect(none.kind === "nothing_to_review" && none.unverified[0]?.original.text).toBe("A clock tick orders events.");
    expect(calls[0]).toMatchObject({ method: "GET", url: `/captures/${captureId}/review-options` });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  test("revives a Material from its canonical JSON rows", async () => {
    const { fetchFn } = fakeFetch(() => json(reviewJson()));
    const view = await createApi("t", { fetch: fetchFn }).review(reviewId);
    expect(Material.equals(view.scope.material, Material.of([[src, [interval(0, 120), interval(300, 420)]]]))).toBe(true);
    expect(Material.duration(view.scope.material)).toBe(240);
  });

  test("startReview posts the app-minted id and choice", async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ kind: "started", reviewId, scope: reviewJson().scope }));
    const result = await createApi("t", { fetch: fetchFn }).startReview(captureId, "stop_early", reviewId);
    expect(result.kind).toBe("started");
    expect(calls[0]).toMatchObject({ method: "POST", url: `/captures/${captureId}/reviews`, body: { reviewId, choice: "stop_early" } });
  });

  test("retryPreparation posts to the retry-preparation route with no body and accepts 204", async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await createApi("t", { fetch: fetchFn }).retryPreparation(captureId);
    expect(calls[0]).toMatchObject({ method: "POST", url: `/captures/${captureId}/retry-preparation`, body: undefined });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer t");
  });

  test("sendTurn validates the act locally, then streams validated events", async () => {
    const turnId = randomId("turn");
    const { calls, fetchFn } = fakeFetch(() => new Response(streamOf(line({ type: "learner_turn_stored", turnId }), line(sentence("Good.")), line({ type: "turn_complete", turnId }))));
    const api = createApi("t", { fetch: fetchFn });
    const events = await collect(api.sendTurn(reviewId, turnId, { kind: "answer", text: "  padded  ", modality: "text" }));
    expect(events.map((e) => e.type)).toEqual(["learner_turn_stored", "sentence", "turn_complete"]);
    expect(calls[0]!.body).toEqual({ turnId, act: { kind: "answer", text: "padded", modality: "text" } });
    await expect(collect(api.sendTurn(reviewId, turnId, { kind: "answer", text: "   ", modality: "text" }))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("an error status carries the backend's message and says whether a retry makes sense", async () => {
    const { fetchFn } = fakeFetch((c) => (c.url.endsWith("/usage") ? json({ error: "database is locked" }, 503) : json({ error: "no such review" }, 404)));
    const api = createApi("t", { fetch: fetchFn });
    const unavailable = await api.usage().catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(ApiError);
    expect(unavailable).toMatchObject({ message: "database is locked", status: 503, retryable: true });
    const missing = await api.review(reviewId).catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404, retryable: false });
  });

  test("no response at all is status 0 and retryable", async () => {
    const api = createApi("t", { fetch: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch });
    expect(await api.usage().catch((e: unknown) => e)).toMatchObject({ status: 0, retryable: true });
  });

  test("a response that does not match the contract is rejected, not trusted", async () => {
    const { fetchFn } = fakeFetch(() => json({ kind: "ready" }));
    await expect(createApi("t", { fetch: fetchFn }).reviewOptions(captureId)).rejects.toThrow(/unexpected response/);
  });

  test("a usage summary with kinds missing decodes them as zero calls and no amount, never $0", async () => {
    const { fetchFn } = fakeFetch(() => json({ byKind: { unknown: { calls: 3, usd: null } }, byPurpose: { boundary: { calls: 3, errors: 0, unknownCost: 3 } } }));
    const usage = await createApi("t", { fetch: fetchFn }).usage();
    expect(usage.byKind.measured).toEqual({ calls: 0, usd: null });
    expect(usage.byKind.unknown).toEqual({ calls: 3, usd: null });
    expect(usage.byPurpose.tutor_turn).toEqual({ calls: 0, errors: 0, unknownCost: 0 });
  });

  test("record and evidence queries", async () => {
    const material = Material.of([[src, [interval(0, 60)]]]);
    expect(evidenceParams({ captureId })).toBe(`captureId=${captureId}`);
    expect(evidenceParams({ ids: [ev1, ev2] })).toBe(`ids=${ev1},${ev2}`);
    expect(JSON.parse(decodeURIComponent(evidenceParams({ material }).slice("material=".length)))).toEqual([[src, [[0, 60]]]]);
    const { calls, fetchFn } = fakeFetch(() => json({ notes: [], observations: [], links: [], unavailableEvidence: [] }));
    await createApi("t", { fetch: fetchFn }).record({ reviewId });
    expect(calls[0]!.url).toBe(`/record?reviewId=${reviewId}`);
  });

  test("an evidence bundle decodes passages, frames, gaps and ads", () => {
    const bundle = evidenceBundlez.parse({
      material: canonicalMaterial,
      passages: [{ kind: "passage", id: ev1, sourceId: src, transcriptRevId: stableId("trv", "t"), interval: { start: 5, end: 9 }, text: "Hello.", origin: "panel" }],
      frames: [{ kind: "frame", id: ev2, sourceId: src, mediaS: 12, width: 1280, height: 720, teaching: "kept" }],
      gaps: [gapJson],
      ads: [{ sourceId: src, atContentS: 60, wallDurationMs: 15000, signals: ["dom_class"] }],
    });
    expect([bundle.passages.length, bundle.frames.length, bundle.gaps.length, bundle.ads.length]).toEqual([1, 1, 1, 1]);
  });
});

// ───────────────────────────── Pure view logic ──────────────────────────────

describe("review options screens", () => {
  const titles = new Map([[src, "Lamport clocks"]]);

  test("ready offers one start and lists why the review is partial", () => {
    const screen = optionsScreen(
      { kind: "ready", scope: { chunkRevisions: [crv], supportedClaims: 1, partial: [{ kind: "unverified_claims", count: 2 }, { kind: "capture_gap", gap: { sourceId: src, interval: interval(120, 180), channel: "frames", reason: "hidden_tab" } }] } },
      titles,
    );
    expect(screen).toMatchObject({ kind: "ready", supportedClaims: 1, offers: [{ choice: "prepared_only" }] });
    if (screen.kind !== "ready") throw new Error("unreachable");
    expect(screen.partial[0]).toBe("2 claims were not confirmed by the source and will not be used to assess you.");
    expect(screen.partial[1]).toBe("Tab was hidden, so frames stalled in Lamport clocks, 2:00 to 3:00.");
  });

  test("many capture gaps of one kind in one video become one line, in the place the first held", () => {
    const gap = (start: number, end: number, reason: "partially_watched_segment" | "hidden_tab" = "partially_watched_segment") =>
      ({ kind: "capture_gap", gap: { sourceId: src, interval: interval(start, end), channel: "transcript", reason } }) as const;
    const screen = optionsScreen(
      { kind: "ready", scope: { chunkRevisions: [crv], supportedClaims: 1, partial: [gap(0, 2), { kind: "unverified_claims", count: 1 }, gap(10, 13), gap(20, 25), gap(30, 90, "hidden_tab")] } },
      titles,
    );
    if (screen.kind !== "ready") throw new Error("unreachable");
    expect(screen.partial).toEqual([
      "Caption line only partly watched, so not used in Lamport clocks, 3 places, 0:10 in all.",
      "Tab was hidden, so frames stalled in Lamport clocks, 0:30 to 1:30.",
      "1 claim was not confirmed by the source and will not be used to assess you.",
    ]);
    expect(groupGaps([gap(0, 2).gap, gap(5, 6).gap], titles)).toEqual([{ where: "Lamport clocks, 2 places, 0:03 in all", reason: "Caption line only partly watched, so not used", count: 2 }]);
  });

  test("a lecture heading names the shared course instead of every video title", () => {
    expect(lectureHeading([])).toEqual({ title: "Review", detail: null });
    expect(lectureHeading(["Intro - Georgia Tech - AOS"])).toEqual({ title: "Intro - Georgia Tech - AOS", detail: null });
    expect(lectureHeading(["Intro - Georgia Tech - AOS", "GSM Basics - Georgia Tech - AOS", "Conclusion - Georgia Tech - AOS"])).toEqual({ title: "Georgia Tech - AOS", detail: "3 videos" });
    expect(lectureHeading(["Lamport clocks", "Vector clocks"])).toEqual({ title: "Lamport clocks and 1 more", detail: "2 videos" });
  });

  test("processing shows an estimate only when the backend gave a usable one", () => {
    const processing = (estimateS: number | null) => optionsScreen({ kind: "processing", readyNow: null, pendingChunks: 2, estimateS });
    expect(processing(null)).toMatchObject({ estimate: null });
    expect(processing(0)).toMatchObject({ estimate: null });
    expect(processing(Number.NaN)).toMatchObject({ estimate: null });
    expect(processing(45)).toMatchObject({ estimate: "under a minute" });
    expect(processing(300)).toMatchObject({ estimate: "about 5 min" });
    expect(estimateText(-3)).toBeNull();
  });

  test("processing offers a start only when something is ready, and both ways of starting then", () => {
    const none = optionsScreen({ kind: "processing", readyNow: null, pendingChunks: 1, estimateS: null });
    expect(none.kind === "processing" && none.offers).toEqual([]);
    const some = optionsScreen({ kind: "processing", readyNow: { chunkRevisions: [crv], supportedClaims: 3, partial: [{ kind: "chunks_still_preparing", count: 1 }] }, pendingChunks: 1, estimateS: 120 });
    expect(some.kind === "processing" && some.offers.map((o) => o.choice)).toEqual(["prepared_only", "stop_early"]);
  });

  test("nothing to review lists gaps, unverified claims with their status, and a watch link per rewatch interval", () => {
    const options = { kind: "nothing_to_review", gaps: [], unverified: [], rewatch: [{ sourceId: src, interval: interval(120, 180) }] } as const;
    expect(optionsScreen(options, titles, new Map([[src, "QgWz_s7uugE"]]))).toEqual({
      kind: "nothing", gaps: [], unverified: [],
      rewatch: [{ where: "Lamport clocks, 2:00 to 3:00", href: "https://www.youtube.com/watch?v=QgWz_s7uugE&t=120s" }],
    });
    expect(optionsScreen(options, titles)).toMatchObject({ rewatch: [{ where: "Lamport clocks, 2:00 to 3:00", href: null }] });
  });

  const fakeApi = {} as AppApi;
  const view = (o: Parameters<typeof optionsScreen>[0], onRetry: () => void = () => {}, videos = new Map([[src, "QgWz_s7uugE"]])) =>
    createElement(OptionsView, { screen: optionsScreen(o, titles, videos), busy: false, onStart: () => {}, onRetry, api: fakeApi, titles });
  const html = (o: Parameters<typeof optionsScreen>[0]) => renderToStaticMarkup(view(o));
  const nothing = { kind: "nothing_to_review", gaps: [], unverified: [], rewatch: [{ sourceId: src, interval: interval(120, 180) }] } as const;

  test("the rendered screens carry the content", () => {
    expect(html({ kind: "processing", readyNow: null, pendingChunks: 2, estimateS: null })).toContain("No reliable time estimate yet.");
    expect(html({ kind: "processing", readyNow: null, pendingChunks: 2, estimateS: 300 })).toContain("about 5 min");
    expect(html({ kind: "ready", scope: { chunkRevisions: [crv], supportedClaims: 4, partial: [] } })).toContain("Review now");
    expect(html({ kind: "nothing_to_review", gaps: [], unverified: [], rewatch: [] })).toContain("Nothing to review yet");
  });

  test("Flow C: nothing to review offers a retry and each rewatch interval as a link that opens the video at that time", () => {
    const out = html(nothing);
    expect(out).toContain('href="https://www.youtube.com/watch?v=QgWz_s7uugE&amp;t=120s"');
    expect(out).toContain("Lamport clocks, 2:00 to 3:00");
    expect(out).toContain("Check again");
    let retried = 0;
    const button = findElements(OptionsView({ screen: optionsScreen(nothing, titles), busy: false, onStart: () => {}, onRetry: () => retried++, api: fakeApi, titles }), (e) => e.type === "button");
    expect(button.map((b) => (b.props as { children?: unknown }).children)).toEqual(["Check again"]);
    (button[0]!.props as { onClick: () => void }).onClick();
    expect(retried).toBe(1);
  });

  test("Check again asks the backend to retry preparation, then reloads the options; a failed retry is reported and still reloads", async () => {
    const order: string[] = [];
    const api = { retryPreparation: async (id: string) => void order.push(`retry ${id}`) } as unknown as AppApi;
    const errors: (string | null)[] = [];
    await checkAgain(api, captureId, { reload: () => order.push("reload"), onError: (m) => errors.push(m) });
    expect(order).toEqual([`retry ${captureId}`, "reload"]);
    expect(errors).toEqual([null]);

    order.length = 0;
    errors.length = 0;
    const failing = { retryPreparation: async () => { throw new ApiError("backend down", 503); } } as unknown as AppApi;
    await checkAgain(failing, captureId, { reload: () => order.push("reload"), onError: (m) => errors.push(m) });
    expect(order).toEqual(["reload"]);
    expect(errors).toEqual([null, "backend down"]);
  });

  test("an unverified claim shows the evidence it cited, in the evidence pane", () => {
    const o = reviewOptionsz.parse({ kind: "nothing_to_review", gaps: [], unverified: [claimJson("unverified")], rewatch: [] });
    const panes = findElements(OptionsView({ screen: optionsScreen(o, titles), busy: false, onStart: () => {}, onRetry: () => {}, api: fakeApi, titles }), (e) => e.type === EvidencePane);
    expect(panes.map((p) => (p.props as { ids: unknown }).ids)).toEqual([[ev1]]);
    expect(renderToStaticMarkup(view(o))).toContain("Loading evidence...");
  });
});

describe("conversation", () => {
  test("lines label who spoke and what the tutor was doing", () => {
    const turns = reviewViewz.parse(reviewJson({ turns: [tutorAsk, learnerAnswer(), turnJson(3, "code", { notice: { kind: "soft_target_reached", elapsedS: 620 } })] })).turns;
    expect(conversationLines(turns).map((l) => [l.speaker, l.label, l.text])).toEqual([
      ["tutor", "Question", "What does a logical clock give you?"],
      ["you", "You", "An ordering of events."],
      ["system", "Note", "You have been reviewing for 10 min."],
    ]);
  });

  test("the soft-target prompt stands until the learner continues or wraps up, and never blocks answering", () => {
    const notice = turnJson(3, "code", { notice: { kind: "soft_target_reached", elapsedS: 600 } });
    const prompted = parsedReview({ turns: [tutorAsk, notice] });
    expect(softTargetPrompt(prompted.turns)).toEqual({ elapsedS: 600 });
    expect(availableActions(prompted.state, true)).toEqual(expect.arrayContaining(["continue", "wrap_up", "answer", "skip"]));
    const answered = parsedReview({ turns: [tutorAsk, notice, turnJson(4, "learner", { act: { kind: "continue_past_target" } })] });
    expect(softTargetPrompt(answered.turns)).toBeNull();
    expect(softTargetPrompt([])).toBeNull();
  });

  test("a stored learner turn the tutor never answered can be resent; pause and end do not count", () => {
    expect(unansweredLearnerTurn(parsedReview({ turns: [tutorAsk, learnerAnswer()] }).turns)?.id).toBe(stableId("turn", "l2"));
    expect(unansweredLearnerTurn(parsedReview({ turns: [tutorAsk, learnerAnswer(), turnJson(3, "tutor", { move: { kind: "close_thread", threadId: thr }, say: "Thanks." })] }).turns)).toBeNull();
    expect(unansweredLearnerTurn(parsedReview({ turns: [tutorAsk, turnJson(2, "learner", { act: { kind: "pause" } })] }).turns)).toBeNull();
  });

  test("which actions are offered follows the phase and the detour (R11: a detour waits for yes)", () => {
    const state = (o: Parameters<typeof reviewJson>[0]) => parsedReview(o).state;
    expect(availableActions(state({}), false)).toEqual(["answer", "skip", "dont_know", "hint", "explain", "dispute", "pause", "end"]);
    expect(availableActions(state({ phase: "paused" }), false)).toEqual(["resume", "end"]);
    expect(availableActions(state({ phase: "ended" }), false)).toEqual([]);
    const proposed = availableActions(state({ detour: { kind: "proposed", turnId: tid("d"), topic: "Partial orders", needsResource: null } }), false);
    expect(proposed).toEqual(["detour_accept", "detour_decline", "pause", "end"]);
    const waiting = availableActions(state({ detour: { kind: "awaiting_resource", resourceId: stableId("res", "r"), topic: "x" } }), false);
    expect(waiting).toEqual(["detour_wait", "detour_continue", "pause", "end"]);
  });

  test("toAct maps each button to the act the backend expects", () => {
    expect(toAct("answer", "x", "speech")).toEqual({ kind: "answer", text: "x", modality: "speech" });
    expect(toAct("hint", "", "text")).toEqual({ kind: "hint_request" });
    expect(toAct("explain", "", "text")).toEqual({ kind: "explain_request" });
    expect(toAct("detour_continue", "", "text")).toEqual({ kind: "detour_continue_without_resource" });
    expect(toAct("dispute", "that is wrong", "text")).toEqual({ kind: "dispute", text: "that is wrong" });
  });

  test("live text follows deltas, falls back to sentences for a replayed turn, and records failure", () => {
    let live = startLive("t");
    for (const e of [stored("t"), { type: "say_delta", text: "Hel" } as TurnEvent, { type: "say_delta", text: "lo." } as TurnEvent, sentence("Hello."), { type: "move", turnId: tid("t"), move: { kind: "wrap_up" } } as TurnEvent]) live = reduceLive(live, e);
    expect(live).toMatchObject({ stored: true, move: { kind: "wrap_up" }, status: "streaming" });
    expect(liveText(live)).toBe("Hello.");
    const replay = reduceLive(reduceLive(startLive("t"), sentence("One.")), sentence("Two."));
    expect(liveText(replay)).toBe("One. Two.");
    expect(reduceLive(live, { type: "turn_failed", error: "boom", retryable: true })).toMatchObject({ status: "failed", error: "boom", retryable: true });
  });

  test("evidence beside the conversation follows the tutor's move, and a main question shows none", () => {
    const explain = turnJson(3, "tutor", { move: { kind: "explain", threadId: thr, evidence: [ev1, ev2] }, say: "Here is why." });
    expect(currentEvidenceIds(parsedReview({ turns: [tutorAsk, learnerAnswer(), explain] }).turns, null)).toEqual([ev1, ev2]);
    expect(currentEvidenceIds(parsedReview({ turns: [explain, learnerAnswer(4), turnJson(5, "tutor", { move: { kind: "ask_main", threadId: thr, claimIds: [clm] }, say: "Next." })] }).turns, null)).toEqual([]);
    const live = reduceLive(startLive("t"), { type: "move", turnId: tid("t"), move: { kind: "diagnose", threadId: thr, hypothesis: "h", evidence: [ev2] } });
    expect(currentEvidenceIds([], live)).toEqual([ev2]);
  });
});

describe("record view logic", () => {
  const observation = ({ facts, ...o }: Record<string, unknown>) => parsedReview({
    observations: [{
      id: stableId("obs", "o"), reviewId, threadId: thr, claimIds: [clm], conceptIds: [cpt], proposed: "independent", status: "independent",
      clampedFrom: null, dispute: { kind: "none" }, corrections: [],
      facts: { threadId: thr, firstSubstantiveAnswerSeq: null, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [], helpTurns: [], ...(facts as object | undefined) },
      ...o,
    }],
  }).observations[0]!;

  test("a status the clamp lowered explains why in the learner's terms", () => {
    const afterHelp = observationRow(observation({ status: "after_help", clampedFrom: "independent", facts: { firstHelpSeq: 3, firstSubstantiveAnswerSeq: 5 } }));
    expect(afterHelp).toMatchObject({ status: "After help", note: 'The tutor proposed "Independent"; recorded as "After help" because the tutor helped before your answer.' });
    const skipped = observationRow(observation({ status: "not_assessed", clampedFrom: "partial", facts: { endedBySkip: true } }));
    expect(skipped.note).toContain("the question was skipped or left unanswered");
  });

  test("R14: a disputed observation reads as disputed and offers resolution, not as a gap", () => {
    const row = observationRow(observation({ status: "disputed", dispute: { kind: "unsettled" } }));
    expect(row).toMatchObject({ status: "Disputed", disputeOpen: true });
    expect(row.note).toContain("not counted as a learning gap");
    const resolved = observationRow(observation({ status: "unresolved", dispute: { kind: "resolved_by_learner", outcome: "it_was_my_gap" } }));
    expect(resolved).toMatchObject({ disputeOpen: false, note: "You chose to revisit this topic, so it is counted as a learning gap." });
  });

  test("a note keeps learner, tutor and source text apart, and your edit never replaces the generated text", () => {
    const view = noteView({
      id: stableId("note", "n"), reviewId, conceptId: cpt, userEdit: "my wording", evidence: [ev1],
      generated: [
        { author: "learner", text: "I said ordering.", turnId: tid("l2"), evidence: [] },
        { author: "tutor", text: "You were right.", turnId: tid("t3"), evidence: [] },
        { author: "source", text: "Lamport 1978.", turnId: null, evidence: [ev1] },
      ],
    });
    expect(view.segments.map((s) => [s.label, s.text])).toEqual([["You", "I said ordering."], ["Tutor", "You were right."], ["Lecture", "Lamport 1978."]]);
    expect(view.userEdit).toBe("my wording");
  });
});

describe("evidence inspector", () => {
  const bundle = evidenceBundlez.parse({
    material: [[src, [[0, 120], [300, 420]]]],
    passages: [{ kind: "passage", id: ev1, sourceId: src, transcriptRevId: stableId("trv", "t"), interval: { start: 0, end: 60 }, text: "a", origin: "panel" }],
    frames: [
      { kind: "frame", id: ev2, sourceId: src, mediaS: 12, width: 1280, height: 720, teaching: "kept" },
      { kind: "frame", id: stableId("ev", "f2"), sourceId: src, mediaS: 40, width: 1280, height: 720, teaching: "uncertain" },
    ],
    gaps: [{ sourceId: src, interval: { start: 60, end: 120 }, channel: "transcript", reason: "no_transcript" }],
    ads: [{ sourceId: src, atContentS: 200, wallDurationMs: 30000, signals: ["dom_class"] }],
  });
  const titles = new Map([[src, "Lecture 1"]]);

  test("reports watched intervals, evidence counts, gaps and ads", () => {
    const report = inspectBundle(bundle, titles);
    expect(report.watched).toEqual([{ source: "Lecture 1", intervals: ["0:00 to 2:00", "5:00 to 7:00"], seconds: 240 }]);
    expect(report.passages).toBe(1);
    expect(report.frames).toEqual({ total: 2, kept: 1, uncertain: 1 });
    expect(report.gaps).toEqual([{ where: "Lecture 1, 1:00 to 2:00", channel: "transcript", reason: "No captions for this stretch" }]);
    expect(report.ads).toEqual([{ where: "Lecture 1, at 3:20", seconds: 30 }]);
  });

  test("flags watched time that has neither a passage nor a logged gap (capture-probe bar)", () => {
    const report = inspectBundle(bundle, titles);
    expect(report.uncovered).toEqual([{ source: "Lecture 1", interval: "5:00 to 7:00" }]);
    const html = renderToStaticMarkup(createElement(BundleInspector, { report }));
    expect(html).toContain("5:00 to 7:00");
    expect(html).toContain("neither evidence nor a logged gap");
  });
});

describe("usage view", () => {
  const summary = (byKind: Partial<UsageSummary["byKind"]>): UsageSummary => ({
    byKind: { measured: { calls: 0, usd: null }, notional: { calls: 0, usd: null }, estimated: { calls: 0, usd: null }, unknown: { calls: 0, usd: null }, ...byKind },
    byPurpose: {
      boundary: { calls: 3, errors: 1, unknownCost: 3 }, frame_change: { calls: 0, errors: 0, unknownCost: 0 }, claim_check: { calls: 0, errors: 0, unknownCost: 0 },
      interpretation: { calls: 0, errors: 0, unknownCost: 0 }, claim_revision: { calls: 0, errors: 0, unknownCost: 0 }, resource_search: { calls: 0, errors: 0, unknownCost: 0 },
      tutor_turn: { calls: 0, errors: 0, unknownCost: 0 }, wrap_up: { calls: 0, errors: 0, unknownCost: 0 }, diagram_summary: { calls: 0, errors: 0, unknownCost: 0 },
    },
  });

  test("R17: unknown cost shows as unknown, never $0, and kinds are not summed", () => {
    const rows = usageRows(summary({ unknown: { calls: 12, usd: null }, notional: { calls: 2, usd: 0.4321 } }));
    expect(rows).toEqual([
      { kind: "Measured", calls: 0, amount: "none" },
      { kind: "Notional (subscription)", calls: 2, amount: "$0.4321" },
      { kind: "Estimated", calls: 0, amount: "none" },
      { kind: "Unknown", calls: 12, amount: "unknown" },
    ]);
    const html = renderToStaticMarkup(createElement(UsageTable, { summary: summary({ unknown: { calls: 12, usd: null } }) }));
    expect(html).toContain("<td>unknown</td>");
    expect(html).not.toContain("$0");
  });

  test("a small non-zero amount never reads as $0.0000", () => {
    expect(usageRows(summary({ measured: { calls: 1, usd: 0.00002 } }))[0]!.amount).toBe("<$0.0001");
    expect(usageRows(summary({ measured: { calls: 1, usd: 0.0001 } }))[0]!.amount).toBe("$0.0001");
    expect(usageRows(summary({ measured: { calls: 1, usd: 0 } }))[0]!.amount).toBe("$0.0000");
  });

  test("a measured kind that arrives without an amount reads unknown, not zero", () => {
    expect(usageRows(summary({ measured: { calls: 1, usd: null } }))[0]!.amount).toBe("unknown");
    expect(usageRows(summary({ measured: { calls: 1, usd: 12.5 } }))[0]!.amount).toBe("$12.50");
  });
});

describe("routes and clocks", () => {
  test("paths round-trip, with and without the /app prefix", () => {
    expect(parseRoute("/app/review/rvw_x")).toEqual({ page: "review", id: "rvw_x" });
    expect(parseRoute("/app/capture/cap_x")).toEqual({ page: "capture", id: "cap_x" });
    expect(parseRoute("/app/record")).toEqual({ page: "record", reviewId: null });
    expect(parseRoute("/app/record/rvw_x")).toEqual({ page: "record", reviewId: "rvw_x" });
    expect(parseRoute("/app/usage")).toEqual({ page: "usage" });
    expect(parseRoute("/app/")).toEqual({ page: "home" });
    expect(parseRoute("/")).toEqual({ page: "home" });
    expect(parseRoute("/app/review")).toEqual({ page: "home" });
    for (const r of [{ page: "review", id: "rvw_x" }, { page: "record", reviewId: null }, { page: "usage" }] as const) expect(parseRoute(routePath(r))).toEqual(r);
  });

  test("malformed percent-encoding routes to not-found instead of throwing", () => {
    expect(parseRoute("/app/review/%E0%A4%A")).toEqual({ page: "not_found" });
    expect(parseRoute("/app/capture/%")).toEqual({ page: "not_found" });
    expect(routePath({ page: "not_found" })).toBe("/app/");
  });

  test("formatClock", () => {
    expect([formatClock(0), formatClock(75), formatClock(3725), formatClock(-4)]).toEqual(["0:00", "1:15", "1:02:05", "0:00"]);
  });
});

// ───────────────────────────── Speech ───────────────────────────────────────

describe("speech", () => {
  function fakeSynth() {
    const spoken: string[] = [];
    let cancels = 0;
    return {
      synth: { speak: (u: SpeechSynthesisUtterance) => void spoken.push(u.text), cancel: () => void cancels++ },
      spoken,
      cancels: () => cancels,
    };
  }
  const utterance = (text: string) => ({ text }) as SpeechSynthesisUtterance;

  test("the tutor stops when the learner starts speaking, and stays quiet until the next turn", () => {
    const { synth, spoken, cancels } = fakeSynth();
    const speaker = createSynthSpeaker(synth, utterance);
    speaker.beginTurn();
    speaker.speak("First.");
    speaker.stop();
    speaker.speak("Second, from the same turn.");
    expect(spoken).toEqual(["First."]);
    expect(cancels()).toBe(1);
    speaker.beginTurn();
    speaker.speak("Next turn.");
    expect(spoken).toEqual(["First.", "Next turn."]);
  });

  test("blank sentences are not spoken", () => {
    const { synth, spoken } = fakeSynth();
    createSynthSpeaker(synth, utterance).speak("   ");
    expect(spoken).toEqual([]);
  });

  class FakeRecognition implements RecognitionLike {
    static last: FakeRecognition;
    lang = "";
    interimResults = false;
    continuous = true;
    onspeechstart: (() => void) | null = null;
    onresult: RecognitionLike["onresult"] = null;
    onerror: RecognitionLike["onerror"] = null;
    onend: (() => void) | null = null;
    started = false;
    constructor() {
      FakeRecognition.last = this;
    }
    start() {
      this.started = true;
    }
    stop() {
      this.onend?.();
    }
  }

  test("speech input reports speech start, interim and final transcripts, and the end", () => {
    const input = createSpeechInput(FakeRecognition);
    const log: string[] = [];
    input.start({
      onSpeechStart: () => log.push("start"),
      onTranscript: (t, final) => log.push(`${final ? "final" : "interim"}:${t}`),
      onEnd: () => log.push("end"),
      onError: (m) => log.push(`error:${m}`),
    });
    const rec = FakeRecognition.last;
    expect(rec).toMatchObject({ started: true, lang: "en-US", interimResults: true });
    rec.onspeechstart?.();
    rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: "an order" }], { isFinal: false })] });
    rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: "an ordering " }], { isFinal: false }), Object.assign([{ transcript: "of events" }], { isFinal: true })] });
    rec.onerror?.({ error: "no-speech" });
    input.stop();
    expect(log).toEqual(["start", "interim:an order", "final:an ordering of events", "error:no-speech", "end"]);
  });

  test("a browser with no Web Speech API reports it is unsupported", () => {
    expect(createSpeechInput(undefined).supported).toBe(false);
  });
});

// ───────────────────────────── Unsent turns ─────────────────────────────────

describe("unsent turns", () => {
  const turn = (n: number, review: ReviewId = reviewId) => ({ turnId: tid(`u${n}`), reviewId: review, act: { kind: "skip" } as LearnerAct, createdAtMs: n });

  test("the memory store returns a review's turns oldest first and forgets removed ones", async () => {
    const store = createMemoryUnsent();
    await store.put(turn(2));
    await store.put(turn(1));
    await store.put(turn(3, randomId("rvw")));
    expect((await store.forReview(reviewId)).map((t) => t.createdAtMs)).toEqual([1, 2]);
    await store.remove(tid("u1"));
    expect((await store.forReview(reviewId)).map((t) => t.createdAtMs)).toEqual([2]);
  });

  test("with no IndexedDB, or one that throws, the store keeps working in memory", async () => {
    const throwing = { open: () => { throw new Error("SecurityError"); } } as unknown as IDBFactory;
    for (const idb of [undefined, throwing]) {
      const store = createIndexedDbUnsent(idb);
      await store.put(turn(1));
      await store.put(turn(2));
      await store.remove(tid("u1"));
      expect((await store.forReview(reviewId)).map((t) => t.createdAtMs)).toEqual([2]);
      expect(store.degraded).toBe(true);
    }
  });
});

type FakeTx = { oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; error: unknown };

/** An IndexedDB whose open and transactions the test releases by hand. Requests succeed on the next tick, as in a browser. */
function fakeIdb(opts: { opens?: boolean } = {}) {
  const rows = new Map<string, unknown>();
  const txs: FakeTx[] = [];
  const db = {
    close() {},
    transaction() {
      const tx: FakeTx = { oncomplete: null, onerror: null, onabort: null, error: null };
      txs.push(tx);
      const request = <T,>(result: T, apply: () => void) => {
        const r: { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = { result, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          apply();
          r.onsuccess?.();
        });
        return r;
      };
      return Object.assign(tx, {
        objectStore: () => ({
          put: (v: { turnId: string }) => request(undefined, () => void rows.set(v.turnId, v)),
          delete: (k: string) => request(undefined, () => void rows.delete(k)),
          getAll: () => request([...rows.values()], () => {}),
        }),
      });
    },
  };
  const factory = {
    open() {
      const r: { result: unknown; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded: (() => void) | null; onblocked: (() => void) | null } =
        { result: { ...db, createObjectStore() {} }, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      if (opts.opens !== false) queueMicrotask(() => r.onsuccess?.());
      return r;
    },
  } as unknown as IDBFactory;
  return { factory, rows, txs, complete: (i = txs.length - 1) => txs[i]!.oncomplete?.(), abort: (i = txs.length - 1) => { txs[i]!.error = new Error("QuotaExceededError"); txs[i]!.onabort?.(); } };
}

describe("IndexedDB unsent turns", () => {
  const turn = { turnId: tid("idb1"), reviewId, act: { kind: "skip" } as LearnerAct, createdAtMs: 1 };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test("a write resolves when its transaction completes, not when the request succeeds", async () => {
    const idb = fakeIdb();
    const store = createIndexedDbUnsent(idb.factory, 1000);
    let done = false;
    const put = store.put(turn).then(() => (done = true));
    await tick();
    expect(idb.rows.has(turn.turnId)).toBe(true);
    expect(done).toBe(false);
    idb.complete();
    await put;
    expect(store.degraded).toBe(false);
  });

  test("a transaction that aborts (quota, a closing database) degrades the store and loses nothing already accepted", async () => {
    const idb = fakeIdb();
    const store = createIndexedDbUnsent(idb.factory, 1000);
    const put = store.put(turn);
    await tick();
    idb.abort();
    await put;
    expect(store.degraded).toBe(true);
    expect((await store.forReview(reviewId)).map((t) => t.turnId)).toEqual([turn.turnId]);
  });

  test("a blocked open cannot hang the app: it times out into memory", async () => {
    const store = createIndexedDbUnsent(fakeIdb({ opens: false }).factory, 20);
    await store.put(turn);
    expect(store.degraded).toBe(true);
    expect((await store.forReview(reviewId)).map((t) => t.turnId)).toEqual([turn.turnId]);
  });

  test("a browser whose indexedDB getter throws still gets a working, degraded store", async () => {
    Object.defineProperty(globalThis, "indexedDB", { get() { throw new Error("SecurityError"); }, configurable: true });
    try {
      const store = createIndexedDbUnsent();
      await store.put(turn);
      expect(store.degraded).toBe(true);
      expect((await store.forReview(reviewId)).map((t) => t.turnId)).toEqual([turn.turnId]);
    } finally {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  test("a transaction that never finishes times out into memory", async () => {
    const store = createIndexedDbUnsent(fakeIdb().factory, 20);
    await store.put(turn);
    expect(store.degraded).toBe(true);
    await store.remove(turn.turnId);
    expect(await store.forReview(reviewId)).toEqual([]);
  });
});

// ───────────────────────────── Session controller ───────────────────────────

type SendCall = { readonly turnId: TurnId; readonly act: LearnerAct };

function setup(opts: {
  sendTurn: (call: SendCall, n: number) => AsyncIterable<TurnEvent>;
  review?: () => ReviewView;
  save?: () => ReturnType<Api["save"]>;
}) {
  const unsent = createMemoryUnsent();
  const sends: SendCall[] = [];
  const spoken: string[] = [];
  let stops = 0;
  let saves = 0;
  let reviews = 0;
  const speaker: Speaker = {
    beginTurn() {},
    speak: (s) => void spoken.push(s),
    stop: () => void stops++,
  };
  const api: Api = {
    reviewOptions: async () => { throw new Error("unused"); },
    startReview: async () => { throw new Error("unused"); },
    sendTurn: (_review, turnId, act) => {
      sends.push({ turnId, act });
      return opts.sendTurn({ turnId, act }, sends.length - 1);
    },
    review: async () => (reviews++, opts.review ? opts.review() : parsedReview()),
    save: async () => (saves++, opts.save ? opts.save() : { kind: "saved", notes: 1, observations: 1, links: 0 }),
    record: async () => { throw new Error("unused"); },
    usage: async () => { throw new Error("unused"); },
  };
  const controller = createReviewController({ api, reviewId, speaker, unsent, nowMs: () => 1000 });
  return { controller, unsent, sends, spoken, stops: () => stops, saves: () => saves, reviews: () => reviews };
}

async function* events(...list: TurnEvent[]): AsyncGenerator<TurnEvent> {
  for (const e of list) yield e;
}

const answer: LearnerAct = { kind: "answer", text: "An ordering of events.", modality: "speech" };

describe("save banner", () => {
  const session = (o: Partial<SessionState>): SessionState => ({
    view: parsedReview(), loadError: null, live: null, unsent: [], sendError: null, saving: false, saveError: null, savedSummary: null, storageDegraded: false, ...o,
  });
  const banner = (o: Partial<SessionState>) => renderToStaticMarkup(createElement(SaveBanner, { state: session(o), onRetry: () => {}, reviewId }));

  test("it says Saved only when the backend reports the review saved", () => {
    expect(banner({ view: parsedReview({ saved: "saved" }) })).toContain("Saved.");
    expect(banner({ view: parsedReview({ saved: "unsaved" }) })).not.toContain("Saved");
    expect(banner({ view: parsedReview({ saved: "save_pending" }) })).not.toContain("Saved.");
    expect(banner({ saveError: "offline" })).toContain("not saved yet: offline");
  });

  test("degraded local storage is stated, with the consequence, whatever the save state; healthy storage claims nothing about it", () => {
    for (const saved of ["unsaved", "saved", "save_pending"] as const) {
      const out = banner({ storageDegraded: true, view: parsedReview({ saved }) });
      expect(out).toContain("not keeping your unsent messages");
      expect(out).toContain("reload");
    }
    expect(banner({ storageDegraded: true, saveError: "offline" })).not.toContain("kept on this computer");
    expect(banner({ saveError: "offline" })).not.toContain("not keeping your unsent messages");
  });
});

describe("review session controller", () => {
  test("a sent turn is kept until the backend stores it, its sentences are spoken, and the view is refreshed", async () => {
    let keptWhileStreaming = -1;
    const h = setup({
      sendTurn: async function* ({ turnId }) {
        keptWhileStreaming = (await h.unsent.forReview(reviewId)).length;
        yield { type: "learner_turn_stored", turnId };
        yield { type: "move", turnId, move: { kind: "wrap_up" } };
        yield { type: "say_delta", text: "Good. Next." };
        yield sentence("Good.");
        yield sentence("Next.");
        yield { type: "turn_complete", turnId };
      },
    });
    await h.controller.send(answer);
    expect(keptWhileStreaming).toBe(1);
    expect(await h.unsent.forReview(reviewId)).toEqual([]);
    expect(h.spoken).toEqual(["Good.", "Next."]);
    expect(h.reviews()).toBe(1);
    expect(h.controller.getState()).toMatchObject({ live: null, view: { reviewId } });
  });

  test("R15: a turn lost before it was stored is resent under the same id", async () => {
    const h = setup({
      sendTurn: ({ turnId }, n) =>
        n === 0
          ? events({ type: "turn_failed", error: "connection reset", retryable: true })
          : events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }),
    });
    await h.controller.send(answer);
    expect(h.controller.getState().live).toMatchObject({ status: "failed", retryable: true });
    expect(h.controller.getState().unsent).toHaveLength(1);
    await h.controller.retryTurn();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toEqual(h.sends[0]!);
    expect(h.controller.getState().unsent).toEqual([]);
  });

  test("a turn kept from a previous page load is resent with its original id", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    const original = { turnId: randomId("turn"), reviewId, act: answer, createdAtMs: 5 };
    await h.unsent.put(original);
    await h.controller.load();
    expect(h.controller.getState().unsent).toEqual([original]);
    await h.controller.retryTurn();
    expect(h.sends).toEqual([{ turnId: original.turnId, act: answer }]);
  });

  test("a stored turn the tutor never answered is resent from the view, again under its own id", async () => {
    const h = setup({
      review: () => parsedReview({ turns: [tutorAsk, learnerAnswer()] }),
      sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }),
    });
    await h.controller.load();
    await h.controller.retryTurn();
    expect(h.sends).toEqual([{ turnId: stableId("turn", "l2"), act: { kind: "answer", text: "An ordering of events.", modality: "speech" } }]);
  });

  test("an HTTP failure before the stream starts leaves the turn unsent and marks it retryable by status", async () => {
    const h = setup({
      sendTurn: async function* () {
        throw new ApiError("backend restarting", 503);
      },
    });
    await h.controller.send(answer);
    expect(h.controller.getState().live).toMatchObject({ status: "failed", error: "backend restarting", retryable: true });
    expect(h.controller.getState().unsent).toHaveLength(1);
  });

  test("chat-first: a gated-off speaker never delays a send, and the sentences still stream to the screen", async () => {
    const calls: string[] = [];
    const speaker = gateSpeaker(() => false, () => (calls.push("made"), { beginTurn: () => void calls.push("begin"), speak: () => void calls.push("speak"), stop: () => void calls.push("stop") }));
    const api: Api = {
      reviewOptions: async () => { throw new Error("unused"); },
      startReview: async () => { throw new Error("unused"); },
      sendTurn: async function* (_r, turnId) {
        yield { type: "learner_turn_stored", turnId };
        yield sentence("One.");
        yield sentence("Two.");
        yield { type: "turn_complete", turnId };
      },
      review: async () => parsedReview(),
      save: async () => ({ kind: "saved", notes: 0, observations: 0, links: 0 }),
      record: async () => { throw new Error("unused"); },
      usage: async () => { throw new Error("unused"); },
    };
    const controller = createReviewController({ api, reviewId, speaker, unsent: createMemoryUnsent() });
    await controller.send(answer);
    expect(controller.getState().unsent).toHaveLength(0);
    expect(controller.getState().sendError).toBeNull();
    expect(calls).toEqual([]);
  });

  test("the tutor stops mid-turn when the learner starts speaking, and speaks again on the next turn", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const spoken: string[] = [];
    let beginCount = 0;
    const real = createSynthSpeaker({ speak: (u) => void spoken.push(u.text), cancel: () => {} }, (text) => ({ text }) as SpeechSynthesisUtterance);
    const speaker: Speaker = { ...real, beginTurn: () => (beginCount++, real.beginTurn()) };
    const api: Api = {
      reviewOptions: async () => { throw new Error("unused"); },
      startReview: async () => { throw new Error("unused"); },
      sendTurn: async function* (_r, turnId) {
        yield { type: "learner_turn_stored", turnId };
        yield sentence("One.");
        await gate;
        yield sentence("Two.");
        yield { type: "turn_complete", turnId };
      },
      review: async () => parsedReview(),
      save: async () => ({ kind: "saved", notes: 0, observations: 0, links: 0 }),
      record: async () => { throw new Error("unused"); },
      usage: async () => { throw new Error("unused"); },
    };
    const controller = createReviewController({ api, reviewId, speaker, unsent: createMemoryUnsent() });
    const first = controller.send(answer);
    while (spoken.length < 1) await Promise.resolve();
    controller.learnerSpeaking();
    release();
    await first;
    expect(spoken).toEqual(["One."]);
    await controller.send({ kind: "skip" });
    expect(beginCount).toBe(2);
    expect(spoken).toEqual(["One.", "One.", "Two."]);
  });

  test("a second send while a turn is streaming is ignored", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = setup({
      sendTurn: async function* ({ turnId }) {
        yield { type: "learner_turn_stored", turnId };
        await gate;
        yield { type: "turn_complete", turnId };
      },
    });
    const first = h.controller.send(answer);
    await h.controller.send({ kind: "skip" });
    release();
    await first;
    expect(h.sends).toHaveLength(1);
  });

  test("a pending save waits for Retry, and Retry calls the same save until it succeeds", async () => {
    const results: Awaited<ReturnType<Api["save"]>>[] = [
      { kind: "save_failed", error: "disk full", retryable: true },
      { kind: "saved", notes: 2, observations: 1, links: 1 },
    ];
    const h = setup({
      review: () => parsedReview({ phase: "ended", saved: "save_pending", turns: [tutorAsk] }),
      sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }),
      save: async () => results.shift()!,
    });
    await h.controller.load();
    expect(h.saves()).toBe(0);
    await h.controller.save();
    expect(h.controller.getState()).toMatchObject({ saving: false, saveError: "disk full" });
    await h.controller.save();
    expect(h.saves()).toBe(2);
    expect(h.controller.getState()).toMatchObject({ saveError: null, savedSummary: { notes: 2, observations: 1, links: 1 } });
  });

  test("a review that ends unsaved is saved automatically, and a failure does not loop", async () => {
    const h = setup({
      review: () => parsedReview({ phase: "ended", saved: "unsaved", turns: [tutorAsk] }),
      sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }),
      save: async () => ({ kind: "save_failed", error: "locked", retryable: true }),
    });
    await h.controller.send({ kind: "end" });
    expect(h.saves()).toBe(1);
    expect(h.controller.getState().saveError).toBe("locked");
    await h.controller.send({ kind: "end" });
    expect(h.saves()).toBe(1);
    expect(h.stops()).toBe(2);
  });

  test("a save that throws is a pending save with the error shown", async () => {
    const h = setup({
      review: () => parsedReview({ saved: "unsaved" }),
      sendTurn: () => events(),
      save: async () => { throw new ApiError("offline", 0); },
    });
    await h.controller.save();
    expect(h.controller.getState().saveError).toBe("offline");
  });
  test("after a reload with an unsent turn, a new send is refused with a message and nothing is sent or stored", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    const original = { turnId: randomId("turn"), reviewId, act: answer, createdAtMs: 5 };
    await h.unsent.put(original);
    await h.controller.load();
    const accepted = await h.controller.send({ kind: "answer", text: "A newer answer.", modality: "text" });
    expect(accepted).toBe(false);
    expect(h.sends).toEqual([]);
    expect(await h.unsent.forReview(reviewId)).toEqual([original]);
    expect(h.controller.getState().sendError).toContain("not delivered");
    await h.controller.retryTurn();
    expect(h.sends).toEqual([{ turnId: original.turnId, act: answer }]);
    expect(await h.controller.send({ kind: "answer", text: "A newer answer.", modality: "text" })).toBe(true);
    expect(h.sends.map((c) => c.act.kind === "answer" && c.act.text)).toEqual(["An ordering of events.", "A newer answer."]);
    expect(h.controller.getState().sendError).toBeNull();
  });

  test("a turn the backend rejects for good can be discarded, and the review can then be ended", async () => {
    const h = setup({
      sendTurn: ({ turnId, act }) => {
        if (act.kind === "answer") {
          return (async function* () {
            throw new ApiError("another turn on this review is still running", 409);
          })();
        }
        return events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId });
      },
    });
    await h.controller.send(answer);
    expect(h.controller.getState().live).toMatchObject({ status: "failed", retryable: false });
    expect(h.controller.getState().unsent).toHaveLength(1);
    expect(await h.controller.send({ kind: "end" })).toBe(false);

    await h.controller.discardUnsent();
    const after = h.controller.getState();
    expect(after.unsent).toEqual([]);
    expect(after.live).toBeNull();
    expect(after.sendError).toBeNull();
    expect(await h.unsent.forReview(reviewId)).toEqual([]);

    expect(await h.controller.send({ kind: "end" })).toBe(true);
    expect(h.sends.map((c) => c.act.kind)).toEqual(["answer", "end"]);
  });

  test("an undelivered message offers Retry and Discard; a tutor reply that stalled offers Retry only", () => {
    const buttons = (props: Parameters<typeof UndeliveredNote>[0]) =>
      findElements(UndeliveredNote(props), (e) => e.type === "button").map((b) => (b.props as { children?: unknown }).children);
    const base = { unsent: 1, failed: true, onRetry: () => {}, onDiscard: () => {} };
    expect(buttons(base)).toEqual(["Retry", "Discard message"]);
    expect(buttons({ ...base, unsent: 0 })).toEqual(["Retry"]);
    let discarded = 0;
    const [, discard] = findElements(UndeliveredNote({ ...base, onDiscard: () => discarded++ }), (e) => e.type === "button");
    (discard!.props as { onClick: () => void }).onClick();
    expect(discarded).toBe(1);
  });

  test("the session says when local storage is degraded, and not before", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    await h.controller.load();
    expect(h.controller.getState().storageDegraded).toBe(false);

    const degraded = { ...createMemoryUnsent(), degraded: true };
    const api = { review: async () => parsedReview() } as unknown as Api;
    const speaker: Speaker = { beginTurn() {}, speak() {}, stop() {} };
    const controller = createReviewController({ api, reviewId, speaker, unsent: degraded });
    await controller.load();
    expect(controller.getState().storageDegraded).toBe(true);
  });

  test("discarding with nothing unsent does nothing, and never touches a turn that is streaming", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    await h.controller.discardUnsent();
    expect(h.controller.getState().unsent).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  test("an over-length answer is rejected up front with a message and never reaches the unsent store", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, { type: "turn_complete", turnId }) });
    const accepted = await h.controller.send({ kind: "answer", text: "x".repeat(8001), modality: "text" });
    expect(accepted).toBe(false);
    expect(h.sends).toEqual([]);
    expect(await h.unsent.forReview(reviewId)).toEqual([]);
    expect(h.controller.getState().unsent).toEqual([]);
    expect(h.controller.getState().sendError).toContain("8000");
  });
});


describe("review composer", () => {
  const composer = (actions: Parameters<typeof Composer>[0]["actions"], disabled = false) => renderToStaticMarkup(createElement(Composer, {
    actions, disabled, sendError: null,
    speech: { supported: false, start() {}, stop() {} },
    onSpeaking() {}, send: async () => true,
  }));

  test("the answer field has a visible label and empty answers cannot be sent", () => {
    const out = composer(["answer", "hint", "end"]);
    const label = out.match(/<label for="([^"]+)">Your response<\/label>/);
    expect(label).not.toBeNull();
    expect(out).toContain(`id="${label![1]}"`);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Share my thinking<\/button>/);
    expect(out).toContain("Speech input is not available in this browser.");
    expect(out).toContain(">End review</button>");
  });

  test("a pending turn disables every action and a phase without answering has no answer field", () => {
    const pending = composer(["answer", "hint", "end"], true);
    const buttons = pending.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    const paused = composer(["resume", "end"]);
    expect(paused).not.toContain("<textarea");
    expect(paused).toContain(">Resume</button>");
    expect(paused).toContain(">End review</button>");
  });
});

describe("opening the review (flow D: topic checklist, then the learner starts it)", () => {
  const state = (o: Partial<SessionState> = {}): SessionState => ({
    view: parsedReview(), loadError: null, live: null, unsent: [], sendError: null, saving: false, saveError: null, savedSummary: null, storageDegraded: false, ...o,
  });
  const cpt2 = stableId("cpt", "concept-2");
  const topics = [{ id: cpt, label: "Logical clocks", summary: "Order events without a shared clock." }, { id: cpt2, label: "Vector clocks", summary: "" }];

  test("the wire schema round-trips begin with fuzzy and note, with or without them, and rejects other spellings", () => {
    expect(learnerAct.parse({ kind: "begin" })).toEqual({ kind: "begin" });
    expect(learnerAct.parse({ kind: "begin", fuzzy: [], note: "  the ordering part " })).toEqual({ kind: "begin", fuzzy: [], note: "the ordering part" });
    expect(learnerAct.parse({ kind: "begin", fuzzy: [cpt, cpt2] })).toEqual({ kind: "begin", fuzzy: [cpt, cpt2] });
    expect(learnerAct.safeParse({ kind: "begin", fuzzy: ["nope"] }).success).toBe(false);
    expect(learnerAct.safeParse({ kind: "begins" }).success).toBe(false);
  });

  test("the review view carries its topics in scope order", () => {
    expect(parsedReview().topics.map((t) => t.label)).toEqual(["Logical clocks", "Vector clocks"]);
  });

  test("an empty active review shows the checklist; a review with turns, paused, ended, unsent or streaming does not", () => {
    expect(needsChecklist(state())).toBe(true);
    expect(needsChecklist(state({ view: parsedReview({ turns: [tutorAsk] }) }))).toBe(false);
    expect(needsChecklist(state({ view: parsedReview({ phase: "paused" }) }))).toBe(false);
    expect(needsChecklist(state({ view: parsedReview({ phase: "ended" }) }))).toBe(false);
    expect(needsChecklist(state({ unsent: [{ turnId: stableId("turn", "u"), reviewId, act: { kind: "begin" } as LearnerAct, createdAtMs: 1 }] }))).toBe(false);
    expect(needsChecklist(state({ live: startLive(stableId("turn", "x")) }))).toBe(false);
    expect(needsChecklist(state({ view: null }))).toBe(false);
  });

  test("nothing begins by itself on load: the controller sends no turn until the learner acts", async () => {
    const h = setup({ sendTurn: async function* () {} });
    await h.controller.load();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sends).toEqual([]);
    expect("beginOnce" in (await import("../src/app/controller"))).toBe(false);
    expect(await Bun.file(new URL("../src/app/review.tsx", import.meta.url)).text()).not.toContain("beginOnce");
  });

  test("starting sends one begin carrying the marked topics and the note; a failed begin is resent with the same turn id", async () => {
    const h = setup({
      sendTurn: async function* ({ turnId }, n) {
        if (n === 0) throw new ApiError("down", 0);
        yield { type: "learner_turn_stored", turnId };
        yield { type: "turn_complete", turnId };
      },
    });
    await h.controller.load();
    await h.controller.send({ kind: "begin", fuzzy: [cpt], note: "ordering" });
    expect(h.sends.map((s) => s.act)).toEqual([{ kind: "begin", fuzzy: [cpt], note: "ordering" }]);
    await h.controller.retryTurn();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]!.turnId).toBe(h.sends[0]!.turnId);
    expect(h.sends[1]!.act).toEqual({ kind: "begin", fuzzy: [cpt], note: "ordering" });
  });

  test("the checklist lists every topic with its summary, an optional note box, Start review and the None path", () => {
    const html = renderToStaticMarkup(createElement(TopicChecklist, { topics, disabled: false, onStart: () => {} }));
    expect(html).toContain("Logical clocks");
    expect(html).toContain("Order events without a shared clock.");
    expect(html).toContain("Vector clocks");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("<textarea");
    expect(html).toContain(">Start review</button>");
    expect(html).toContain(">None, just quiz me</button>");
  });

  test("the begin act is a system line naming the learner's picks and note, never a learner line", () => {
    const begin = (act: unknown) => parsedReview({ turns: [turnJson(1, "learner", { act }), tutorAsk] });
    const plain = conversationLines(begin({ kind: "begin" }).turns);
    expect(plain.map((l) => l.speaker)).toEqual(["system", "tutor"]);
    expect(plain[0]!.text).toBe("Review started");
    const picked = begin({ kind: "begin", fuzzy: [cpt, cpt2], note: "the ordering" });
    expect(conversationLines(picked.turns, picked.topics)[0]!).toMatchObject({ speaker: "system", text: "You marked: Logical clocks, Vector clocks. Your note: the ordering" });
    const none = begin({ kind: "begin", fuzzy: [] });
    expect(conversationLines(none.turns, none.topics)[0]!.text).toBe("Review started");
  });

  test("a quick check is labelled Quick check", () => {
    const qc = turnJson(2, "tutor", { move: { kind: "quick_check", threadId: stableId("thr", "thread-2"), claimIds: [clm] }, say: "In a sentence, what is a vector clock?" });
    expect(conversationLines(parsedReview({ turns: [tutorAsk, qc] }).turns).map((l) => l.label)).toEqual(["Question", "Quick check"]);
  });
});

describe("a chain that stopped part-way resumes after reload", () => {
  const closeThread = turnJson(3, "tutor", { move: { kind: "close_thread", threadId: thr }, say: "Let's leave that question there and move on." });
  const owing = (o: Parameters<typeof reviewJson>[0] = {}) => parsedReview({ turns: [tutorAsk, learnerAnswer(2), closeThread], owesMove: true, ...o });
  const state = (view: ReviewView | null, o: Partial<SessionState> = {}): SessionState => ({
    view, loadError: null, live: null, unsent: [], sendError: null, saving: false, saveError: null, savedSummary: null, storageDegraded: false, ...o,
  });
  const run = (states: SessionState[]) => {
    let n = 0;
    const offer = resumeOnce({ retryTurn: async () => void n++ });
    for (const s of states) offer(s);
    return n;
  };

  test("the wire schema carries owesMove", () => {
    expect(owing().owesMove).toBe(true);
    expect(parsedReview().owesMove).toBe(false);
    expect(reviewViewz.safeParse({ ...reviewJson(), owesMove: undefined }).success).toBe(false);
  });

  test("the owed turn is the last learner turn, only for an active review", () => {
    expect(owedLearnerTurn(owing())?.id).toBe(learnerAnswer(2).id);
    expect(owedLearnerTurn(parsedReview({ turns: [tutorAsk, learnerAnswer(2)] }))).toBeNull();
    expect(owedLearnerTurn(owing({ phase: "paused" }))).toBeNull();
    expect(owedLearnerTurn(owing({ phase: "ended" }))).toBeNull();
  });

  test("it fires once however often the state is offered, and never for paused, ended, unsent or streaming", () => {
    expect(run([state(owing()), state(owing()), state(owing())])).toBe(1);
    expect(run([state(null), state(owing())])).toBe(1);
    expect(run([state(owing({ phase: "paused" }))])).toBe(0);
    expect(run([state(owing({ phase: "ended" }))])).toBe(0);
    expect(run([state(parsedReview({ turns: [tutorAsk] }))])).toBe(0);
    expect(run([state(owing(), { live: startLive(stableId("turn", "x")) })])).toBe(0);
    expect(run([state(owing(), { unsent: [{ turnId: stableId("turn", "u"), reviewId, act: answer, createdAtMs: 1 }] })])).toBe(0);
    expect(needsResume(state(owing()))).toBe(true);
  });

  test("through the controller: the retry resends the last learner turn id, once", async () => {
    const h = setup({
      review: () => owing(),
      sendTurn: async function* ({ turnId }) {
        yield { type: "learner_turn_stored", turnId };
        yield { type: "turn_complete", turnId };
      },
    });
    await h.controller.load();
    const offer = resumeOnce(h.controller);
    offer(h.controller.getState());
    offer(h.controller.getState());
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sends).toEqual([{ turnId: learnerAnswer(2).id, act: { kind: "answer", text: "An ordering of events.", modality: "speech" } }]);
  });

  test("a failed automatic continue leaves the Retry button, which resends the same id", async () => {
    const h = setup({
      review: () => owing(),
      sendTurn: async function* ({ turnId }, n) {
        if (n === 0) throw new ApiError("down", 0);
        yield { type: "turn_complete", turnId };
      },
    });
    await h.controller.load();
    resumeOnce(h.controller)(h.controller.getState());
    await new Promise((r) => setTimeout(r, 10));
    expect(h.controller.getState().live?.status).toBe("failed");
    expect(needsResume(h.controller.getState())).toBe(false);
    await h.controller.retryTurn();
    expect(h.sends.map((s) => s.turnId)).toEqual([learnerAnswer(2).id, learnerAnswer(2).id]);
  });
});
