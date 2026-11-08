import { describe, expect, test } from "bun:test";
import { ApiError, createApi, evidenceParams } from "../src/app/api";
import { evidenceBundlez } from "../src/app/decode";
import { StreamError, ndjson, tutorEvents } from "../src/app/ndjson";
import { randomId, stableId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { READY, canonicalMaterial, captureId, claimJson, collect, complete, enc, ev1, ev2, fakeFetch, gapJson, json, line, reviewId, reviewJson, sentence, src, stored, streamOf } from "./app-fixtures";

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
