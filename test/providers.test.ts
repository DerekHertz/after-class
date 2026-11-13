import { describe, expect, test } from "bun:test";
import type { JevRequest } from "../src/backend/providers/jev";
import { createJevClient, imageFormat, imageSize } from "../src/backend/providers/jev";
import type { ClaimSupportInput, FrameChangeInput } from "../src/backend/providers/jev-tasks";
import { boundaryTask, claimSupportTask, frameChangeTask, THRESHOLDS, toVerdict } from "../src/backend/providers/jev-tasks";
import type { Task } from "../src/backend/providers/memo";
import { createMemo, ProviderError } from "../src/backend/providers/memo";
import { testDb } from "./fakes";
import { answersBody, boundaryInput, claim, ctx, fakeJev, frame, jpeg, json, NEVER, noulReq, p, passage, png, scriptedFetch, withBytes } from "./providers-fixtures";

// ───────────────────────────── Jev client ───────────────────────────────────

describe("Jev client", () => {
  test("posts one systemone request and returns probabilities, tokens and unknown cost", async () => {
    const { fetch, seen } = scriptedFetch(() => json(answersBody({ q: { type: "noul", noul: 0.82 }, c: { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.9 } })));
    const jev = createJevClient({ apiKey: "k", fetch });
    const res = await jev.ask(
      { ...noulReq(), questions: { q: { type: "noul", instructions: "i" }, c: { type: "choice", instructions: "pick", criteria: { a: "x", b: "y" } } } },
      NEVER,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
    expect(seen[0]!.headers["typesafe-danger-zone-images"]).toBeUndefined();
    expect(seen[0]!.body).toEqual({
      model: "jev-1.13",
      state: { passage: "a" },
      questions: { q: { type: "noul", instructions: "i" }, c: { type: "choice", instructions: "pick", criteria: { a: "x", b: "y" } } },
    });
    expect(res.answers.q).toEqual({ type: "noul", p: 0.82 });
    expect(res.answers.c).toEqual({ type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 } });
    expect(res.usage).toEqual({
      model: "jev-1.13.0",
      inputTokens: 1234,
      outputTokens: 5,
      cacheReadTokens: null,
      cost: { kind: "unknown", reason: "typesafe pricing not published" },
    });
  });

  test("a score question is sent with its levels and read back", async () => {
    const { fetch, seen } = scriptedFetch(() => json(answersBody({ s: { type: "score", score: 3.2, probabilities: { "3": 0.8 } } })));
    const res = await createJevClient({ apiKey: "k", fetch }).ask(
      { ...noulReq(), questions: { s: { type: "score", instructions: "rate", criteria: ["bad", "ok", "good"] } } },
      NEVER,
    );
    expect(seen[0]!.body.questions.s).toEqual({ type: "score", instructions: "rate", criteria: ["bad", "ok", "good"] });
    expect(res.answers.s).toEqual({ type: "score", score: 3.2, probabilities: { "3": 0.8 } });
  });

  test("unreported tokens stay null, never zero", async () => {
    const { fetch } = scriptedFetch(() => json({ answers: { q: { type: "noul", noul: 0.5 } }, extra: "ignored" }));
    const res = await createJevClient({ apiKey: "k", fetch }).ask(noulReq(), NEVER);
    expect(res.usage.inputTokens).toBeNull();
    expect(res.usage.outputTokens).toBeNull();
    expect(res.usage.model).toBe("jev-1.13");
  });

  test("question limits are enforced before sending", async () => {
    const { fetch, seen } = scriptedFetch(() => json(answersBody({})));
    const jev = createJevClient({ apiKey: "k", fetch });
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, "x"]));
    await expect(jev.ask({ ...noulReq(), questions: { q: { type: "choice", instructions: "i", criteria } } }, NEVER)).rejects.toThrow(/at most 255/);
    await expect(jev.ask({ ...noulReq(), questions: { q: { type: "score", instructions: "i", criteria: Array.from({ length: 11 }, String) } } }, NEVER)).rejects.toThrow(/at most 10/);
    expect(seen).toEqual([]);
  });

  describe("images", () => {
    const okImage = { ref: "frame_0", format: "jpeg" as const, bytes: jpeg(1280, 720), width: 1280, height: 720 };
    const withImages = (...images: JevRequest<"q">["images"][number][]) => noulReq({ state: { frames: images.map((i) => i.ref) }, images });

    test("sends assets with the danger-zone header", async () => {
      const { fetch, seen } = scriptedFetch(() => json(answersBody({ q: { type: "noul", noul: 0.1 } })));
      await createJevClient({ apiKey: "k", fetch }).ask(withImages(okImage), NEVER);
      expect(seen[0]!.headers["typesafe-danger-zone-images"]).toBe("true");
      expect(seen[0]!.body.assets).toEqual({ frame_0: { type: "image", format: "jpeg", data_base64: Buffer.from(okImage.bytes).toString("base64") } });
    });

    test.each([
      ["too narrow", jpeg(279, 720)],
      ["too wide", jpeg(1569, 900)],
      ["too tall", png(900, 1569)],
      ["too short", jpeg(900, 279)],
    ])("rejects an image that is %s, before any request", async (_, bytes) => {
      const { fetch, seen } = scriptedFetch(() => json(answersBody({})));
      const format = imageFormat(bytes)!;
      const err = await createJevClient({ apiKey: "k", fetch }).ask(withImages({ ...okImage, format, bytes }), NEVER).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
      expect(seen).toEqual([]);
    });

    test("bounds use the real pixels, not the declared size", async () => {
      const { fetch, seen } = scriptedFetch(() => json(answersBody({})));
      const liar = { ...okImage, bytes: jpeg(100, 100), width: 1280, height: 720 };
      await expect(createJevClient({ apiKey: "k", fetch }).ask(withImages(liar), NEVER)).rejects.toThrow(/100x100/);
      expect(seen).toEqual([]);
    });

    test("accepts the exact limits", async () => {
      const { fetch, seen } = scriptedFetch(() => json(answersBody({ q: { type: "noul", noul: 0.5 } })));
      const jev = createJevClient({ apiKey: "k", fetch });
      await jev.ask(withImages({ ...okImage, bytes: jpeg(280, 280) }), NEVER);
      await jev.ask(withImages({ ...okImage, format: "png", bytes: png(1568, 1568) }), NEVER);
      expect(seen).toHaveLength(2);
    });

    test("rejects an asset nothing refers to, and bytes that do not match the declared format", async () => {
      const { fetch, seen } = scriptedFetch(() => json(answersBody({})));
      const jev = createJevClient({ apiKey: "k", fetch });
      await expect(jev.ask(noulReq({ images: [okImage] }), NEVER)).rejects.toThrow(/never referenced/);
      await expect(jev.ask(withImages({ ...okImage, format: "png" }), NEVER)).rejects.toThrow(/not png/);
      await expect(jev.ask({ ...withImages(okImage), state: { frames: ["frame_01"] } }, NEVER)).rejects.toThrow(/never referenced/);
      expect(seen).toEqual([]);
    });

    test("a reference in question text counts", async () => {
      const { fetch, seen } = scriptedFetch(() => json(answersBody({ q: { type: "noul", noul: 0.5 } })));
      const req = noulReq({ images: [okImage], questions: { q: { type: "noul", instructions: "Does frame_0 show an equation?" } } });
      await createJevClient({ apiKey: "k", fetch }).ask(req, NEVER);
      expect(seen).toHaveLength(1);
    });

    test("reads sizes and formats from the bytes", () => {
      expect(imageSize(jpeg(640, 360), "jpeg")).toEqual({ width: 640, height: 360 });
      expect(imageSize(png(640, 360), "png")).toEqual({ width: 640, height: 360 });
      expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]), "jpeg")).toBeNull();
      expect(imageFormat(new Uint8Array([1, 2, 3]))).toBeNull();
    });
  });

  describe("errors", () => {
    const ask = (respond: () => Response | Error): Promise<ProviderError> =>
      createJevClient({ apiKey: "k", fetch: scriptedFetch(respond).fetch }).ask(noulReq(), NEVER).then(
        () => { throw new Error("expected the request to fail"); },
        (e: ProviderError) => e,
      );

    test.each([
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [401, false],
      [422, false],
    ])("status %i is retryable=%p", async (status, retryable) => {
      const err = await ask(() => json({ message: "nope" }, status));
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(retryable);
      expect(err.usage).toBeNull();
      expect(err.message).toContain(String(status));
    });

    test("the message comes from whichever error field is present", async () => {
      expect((await ask(() => json({ message: "m", error: "e" }, 400))).message).toContain("m");
      expect((await ask(() => json({ error: "plain" }, 400))).message).toContain("plain");
      expect((await ask(() => json({ error: { message: "nested" }, error_type: "invalid_request" }, 400))).message).toMatch(/invalid_request.*nested/);
      expect((await ask(() => json({ detail: [{ loc: ["questions"] }] }, 422))).message).toContain("questions");
      expect((await ask(() => new Response("<html>bad gateway</html>", { status: 502 }))).message).toContain("bad gateway");
    });

    test("a network failure is retryable; a caller abort is passed through untouched", async () => {
      const net = await ask(() => new Error("connection reset"));
      expect(net.retryable).toBe(true);
      const c = new AbortController();
      const jev = createJevClient({ apiKey: "k", fetch: (async (_u: unknown, init?: RequestInit) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch });
      const pending = jev.ask(noulReq(), c.signal).catch((e) => e);
      c.abort();
      expect((await pending).name).toBe("AbortError");
    });

    test("a timeout is retryable", async () => {
      const jev = createJevClient({ apiKey: "k", timeoutMs: 10, fetch: (async (_u: unknown, init?: RequestInit) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("t", "TimeoutError"))))) as unknown as typeof fetch });
      const err = await jev.ask(noulReq(), NEVER).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
    });

    test("a failure while reading the response body is a retryable ProviderError, like a connect failure", async () => {
      const broken = () => new Response(new ReadableStream({ start: (c) => c.error(new Error("stream reset")) }), { status: 200 });
      const err = await ask(broken);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
      expect(err.usage).toBeNull();
      expect(err.message).toContain("stream reset");
    });

    test("a timeout while reading the response body is retryable; a caller abort there passes through", async () => {
      const stalled = (init?: RequestInit) =>
        new Response(new ReadableStream({ start: (c) => init!.signal!.addEventListener("abort", () => c.error(new DOMException("a", "AbortError"))) }), { status: 200 });
      const slow = createJevClient({ apiKey: "k", timeoutMs: 10, fetch: (async (_u: unknown, init?: RequestInit) => stalled(init)) as unknown as typeof fetch });
      const timedOut = await slow.ask(noulReq(), NEVER).catch((e) => e);
      expect(timedOut).toBeInstanceOf(ProviderError);
      expect(timedOut.retryable).toBe(true);

      const c = new AbortController();
      const caller = createJevClient({ apiKey: "k", fetch: (async (_u: unknown, init?: RequestInit) => stalled(init)) as unknown as typeof fetch });
      const pending = caller.ask(noulReq(), c.signal).catch((e) => e);
      await Bun.sleep(5);
      c.abort();
      expect((await pending).name).toBe("AbortError");
    });

    test("a response in the wrong shape is a non-retryable error", async () => {
      expect((await ask(() => json({ answers: "x" }))).retryable).toBe(false);
      expect((await ask(() => json(answersBody({ q: { type: "noul", noul: 1.5 } })))).retryable).toBe(false);
      expect((await ask(() => new Response("not json"))).retryable).toBe(false);
    });

    test("a question left unanswered, or answered as another type, keeps the usage that was billed", async () => {
      const missing = await ask(() => json(answersBody({})));
      expect(missing.message).toMatch(/without question q/);
      expect(missing.usage?.inputTokens).toBe(1234);
      const wrong = await ask(() => json(answersBody({ q: { type: "choice", choice: "a", probabilities: { a: 1 } } })));
      expect(wrong.message).toMatch(/as choice, asked noul/);
      expect(wrong.usage?.outputTokens).toBe(5);
    });
  });
});

describe("verdict thresholds", () => {
  test.each([
    [0.7, "yes"],
    [0.95, "yes"],
    [0.3, "no"],
    [0.05, "no"],
    [0.31, "uncertain"],
    [0.5, "uncertain"],
    [0.69, "uncertain"],
    [null, "uncertain"],
    [Number.NaN, "uncertain"],
  ] as const)("p=%p is %s", (prob, verdict) => {
    expect(toVerdict(prob)).toBe(verdict);
    expect(THRESHOLDS.noAtOrBelow).toBeLessThan(THRESHOLDS.yesAtOrAbove);
  });
});

describe("boundaryTask", () => {
  test("asks both questions in one request over one state and maps each probability", async () => {
    const { jev, requests } = fakeJev(() => ({ new_concept: p(0.9), stopping_point: p(0.1) }));
    const task = boundaryTask(jev);
    const { output, usage } = await task.attempt(boundaryInput(), ctx);
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toEqual(["new_concept", "stopping_point"]);
    expect(requests[0]!.questions.new_concept!.instructions).toContain("state.passage");
    expect(requests[0]!.state).toEqual({
      context: [{ t: 30, text: "We solved the row picture." }, { t: 60, text: "Each equation is a line." }],
      passage: [{ t: 120, text: "Now consider the column picture." }],
      frames: [],
    });
    expect(output).toMatchObject({ windowId: "win_1", newConcept: "yes", stoppingPoint: "no", pNewConcept: 0.9, pStoppingPoint: 0.1 });
    expect(usage.inputTokens).toBe(100);
  });

  test("window frames go as images referenced from state", async () => {
    const { jev, requests } = fakeJev(() => ({ new_concept: p(0.5), stopping_point: p(0.5) }));
    await boundaryTask(jev).attempt(boundaryInput({ frames: [withBytes(frame("ev_f1")), withBytes(frame("ev_f2"))] }), ctx);
    expect(requests[0]!.images.map((i) => [i.ref, i.format, i.width, i.height])).toEqual([["frame_0", "jpeg", 1280, 720], ["frame_1", "jpeg", 1280, 720]]);
    expect((requests[0]!.state as { frames: string[] }).frames).toEqual(["frame_0", "frame_1"]);
  });

  test("an answer that is not a probability is uncertain, never no", async () => {
    const { jev } = fakeJev(() => ({ new_concept: { type: "choice", choice: "a", probabilities: {} }, stopping_point: p(0.5) }));
    const { output } = await boundaryTask(jev).attempt(boundaryInput(), ctx);
    expect(output).toMatchObject({ newConcept: "uncertain", pNewConcept: null, stoppingPoint: "uncertain" });
  });

  test("the key follows the evidence and the wording, not the image bytes", () => {
    const task = boundaryTask(fakeJev(() => ({})).jev);
    const memo = createMemo(testDb(), "live");
    const a = memo.key(task, boundaryInput({ frames: [withBytes(frame("ev_f1"), jpeg(1280, 720))] }));
    const b = memo.key(task, boundaryInput({ frames: [withBytes(frame("ev_f1"), jpeg(640, 360))] }));
    const c = memo.key(task, boundaryInput({ frames: [withBytes(frame("ev_f2"))] }));
    const d = memo.key(task, boundaryInput({ newPassages: [passage("ev_n2", 120, "Something else.")] }));
    expect(a).toBe(b);
    expect(new Set([a, c, d]).size).toBe(3);
    expect(task.version).toContain(`${THRESHOLDS.yesAtOrAbove}/${THRESHOLDS.noAtOrBelow}`);
  });

  test("a stored judgment is validated on read", () => {
    const task = boundaryTask(fakeJev(() => ({})).jev);
    expect(() => task.decode({ windowId: "win_1", newConcept: "maybe" })).toThrow();
  });
});

describe("Jev failures reach the caller as failed, never as a no-verdict", () => {
  const run = async (task: Task<any, any>, input: unknown) => {
    const db = testDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    return { memo, db, result: await memo.run(task, input) };
  };

  test("a non-retryable error is one attempt and a terminal failure", async () => {
    const { jev, requests } = fakeJev(() => new ProviderError("jev 400: bad", null, false));
    const { result } = await run(boundaryTask(jev), boundaryInput());
    expect(result.kind).toBe("failed");
    expect(requests).toHaveLength(1);
  });

  test("a retryable error is retried up to maxAttempts, then fails", async () => {
    const { jev, requests } = fakeJev(() => new ProviderError("jev 503", null, true));
    const task = frameChangeTask(jev);
    const { result } = await run(task, { before: withBytes(frame("a")), after: withBytes(frame("b")), nearbyPassages: [] } satisfies FrameChangeInput);
    expect(result).toMatchObject({ kind: "failed", attempts: task.maxAttempts });
    expect(requests).toHaveLength(task.maxAttempts);
  });

  test("a transient error followed by an answer is a hit", async () => {
    const { jev } = fakeJev((_, n) => (n === 1 ? new ProviderError("jev 429", null, true) : { teaching_change: p(0.9) }));
    const { result } = await run(frameChangeTask(jev), { before: withBytes(frame("a")), after: withBytes(frame("b")), nearbyPassages: [] } satisfies FrameChangeInput);
    expect(result).toMatchObject({ kind: "hit", value: "yes" });
  });

  test("an out-of-bounds frame fails the call before any Jev request is made", async () => {
    const jev = createJevClient({ apiKey: "k", fetch: scriptedFetch(() => json({})).fetch });
    const small = withBytes(frame("small", 200, 200));
    const { result } = await run(claimSupportTask(jev), { claim: claim(), passages: [], frames: [small] } satisfies ClaimSupportInput);
    expect(result.kind).toBe("failed");
  });
});

describe("frameChangeTask", () => {
  const input = (over: Partial<FrameChangeInput> = {}): FrameChangeInput => ({
    before: withBytes(frame("ev_a")),
    after: withBytes(frame("ev_b")),
    nearbyPassages: [passage("ev_p", 40.26, "so we add the second row")],
    ...over,
  });

  test("sends both frames as named images and maps the probability", async () => {
    const { jev, requests } = fakeJev(() => ({ teaching_change: p(0.2) }));
    const { output } = await frameChangeTask(jev).attempt(input(), ctx);
    expect(output).toBe("no");
    expect(requests[0]!.images.map((i) => i.ref)).toEqual(["frame_before", "frame_after"]);
    expect(requests[0]!.state).toEqual({ before: "frame_before", after: "frame_after", captions: [{ t: 40.3, text: "so we add the second row" }] });
  });

  test("the first frame of a source is kept without a call, and the empty call is labelled as such", async () => {
    const { jev, requests } = fakeJev(() => ({}));
    const { output, usage } = await frameChangeTask(jev).attempt(input({ before: null }), ctx);
    expect(requests).toEqual([]);
    expect(output).toBe("uncertain");
    expect(usage.cost).toEqual({ kind: "unknown", reason: "no provider call was made" });
  });
});

describe("claimSupportTask", () => {
  test("R3: the verdict and its probability come from one question over the cited evidence", async () => {
    const { jev, requests } = fakeJev(() => ({ supported: p(0.85) }));
    const task = claimSupportTask(jev);
    const { output } = await task.attempt({ claim: claim(), passages: [passage("ev_p1", 12.34, "two lines meet at a point")], frames: [withBytes(frame("ev_f"))] }, ctx);
    expect(output).toEqual({ verdict: "yes", p: 0.85 });
    expect(requests[0]!.state).toEqual({
      claim: "Two lines in the plane meet at one point unless parallel.",
      assumptions: ["lines are not identical"],
      evidence: [{ id: "ev_p1", t: 12.3, text: "two lines meet at a point" }],
      frames: ["frame_0"],
    });
    expect(requests[0]!.questions.supported!.instructions).toContain("labelled assumptions, not as evidence");
  });

  test("mid-range and missing probabilities are uncertain", async () => {
    const mid = await claimSupportTask(fakeJev(() => ({ supported: p(0.5) })).jev).attempt({ claim: claim(), passages: [], frames: [] }, ctx);
    expect(mid.output).toEqual({ verdict: "uncertain", p: 0.5 });
    const gone = await claimSupportTask(fakeJev(() => ({})).jev).attempt({ claim: claim(), passages: [], frames: [] }, ctx);
    expect(gone.output).toEqual({ verdict: "uncertain", p: null });
  });

  test("a different claim text or assumption is a different call", () => {
    const task = claimSupportTask(fakeJev(() => ({})).jev);
    const memo = createMemo(testDb(), "live");
    const base = { passages: [passage("ev_p1", 1, "x")], frames: [] };
    const keys = [claim(), claim({ text: "changed" }), claim({ assumptions: [] })].map((c) => memo.key(task, { ...base, claim: c }));
    expect(new Set(keys).size).toBe(3);
  });
});
