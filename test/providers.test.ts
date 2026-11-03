/**
 * W5: Jev client, Jev tasks, Claude CLI adapter and the usage ledger.
 * Offline only: Jev is a scripted fetch, Claude is a fake process fed recorded
 * envelopes. No test spawns the real `claude` or touches the network.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Frame, Passage } from "../src/shared/domain";
import { createJevClient, imageFormat, imageSize } from "../src/backend/providers/jev";
import type { JevClient, JevRequest } from "../src/backend/providers/jev";
import { boundaryTask, claimSupportTask, frameChangeTask, THRESHOLDS, toVerdict } from "../src/backend/providers/jev-tasks";
import type { BoundaryInput, ClaimSupportInput, FrameChangeInput } from "../src/backend/providers/jev-tasks";
import { claudeArgs, createClaudeCli } from "../src/backend/providers/claude";
import type { ClaudeProcess, ClaudeRequest, SpawnFn } from "../src/backend/providers/claude";
import { createLedger } from "../src/backend/providers/ledger";
import { createMemo, ProviderError } from "../src/backend/providers/memo";
import type { Task, UsageReport } from "../src/backend/providers/memo";
import { deferred, testDb } from "./fakes";

// ───────────────────────────── fixtures ─────────────────────────────────────

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

/** SOI, an APP0 segment to skip, then a baseline frame header carrying the size. */
function jpeg(w: number, h: number): Uint8Array {
  const b = new Uint8Array(2 + 2 + 16 + 2 + 17 + 2);
  const v = new DataView(b.buffer);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  v.setUint16(4, 16);
  b.set([0xff, 0xc0], 20);
  v.setUint16(22, 17);
  b[24] = 8;
  v.setUint16(25, h);
  v.setUint16(27, w);
  b[29] = 3;
  b.set([0xff, 0xd9], b.length - 2);
  return b;
}

const passage = (id: string, start: number, text: string) =>
  ({ kind: "passage", id, interval: { start, end: start + 5 }, text }) as unknown as Passage;
const frame = (id: string, width = 1280, height = 720) => ({ kind: "frame", id, width, height }) as unknown as Frame;
const withBytes = (f: Frame, bytes: Uint8Array = jpeg(f.width, f.height)) => ({ frame: f, bytes: () => bytes });

const NEVER = new AbortController().signal;
const ctx = { signal: NEVER, streamTo: null };

const answersBody = (answers: unknown, usage: unknown = { input_tokens: 1234, output_tokens: 5 }) => ({ model: "jev-1.13.0", answers, usage });

type Seen = { url: string; headers: Record<string, string>; body: any };
function scriptedFetch(respond: (seen: Seen) => Response | Promise<Response> | Error): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) };
    seen.push(s);
    const r = respond(s);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch: f as unknown as typeof fetch, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const noulReq = (over: Partial<JevRequest<"q">> = {}): JevRequest<"q"> => ({
  model: "jev-1.13",
  state: { passage: "a" },
  questions: { q: { type: "noul", instructions: "Is state.passage short?" } },
  images: [],
  ...over,
});

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
      const { fetch } = scriptedFetch(() => json(answersBody({ q: { type: "noul", noul: 0.5 } })));
      const req = noulReq({ images: [okImage], questions: { q: { type: "noul", instructions: "Does frame_0 show an equation?" } } });
      await createJevClient({ apiKey: "k", fetch }).ask(req, NEVER);
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

// ───────────────────────────── Jev tasks ────────────────────────────────────

type Answered = Record<string, unknown>;
function fakeJev(respond: (req: JevRequest<string>, call: number) => Answered | Error): { jev: JevClient; requests: JevRequest<string>[] } {
  const requests: JevRequest<string>[] = [];
  const jev: JevClient = {
    async ask(req) {
      requests.push(req as JevRequest<string>);
      const r = respond(req as JevRequest<string>, requests.length);
      if (r instanceof Error) throw r;
      const usage: UsageReport = { model: "jev-1.13.0", inputTokens: 100, outputTokens: 2, cacheReadTokens: null, cost: { kind: "unknown", reason: "typesafe pricing not published" } };
      return { answers: r as never, usage };
    },
  };
  return { jev, requests };
}
const p = (x: number) => ({ type: "noul" as const, p: x });

const window = { id: "win_1", ordinal: 3 } as unknown as BoundaryInput["window"];
const boundaryInput = (over: Partial<BoundaryInput> = {}): BoundaryInput => ({
  window,
  newPassages: [passage("ev_n1", 120, "Now consider the column picture.")],
  contextPassages: [passage("ev_c1", 30, "We solved the row picture."), passage("ev_c2", 60.04, "Each equation is a line.")],
  frames: [],
  ...over,
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

const claim = (over: Partial<ClaimSupportInput["claim"]> = {}): ClaimSupportInput["claim"] => ({
  text: "Two lines in the plane meet at one point unless parallel.",
  evidence: ["ev_p1" as never],
  visualDependent: false,
  assumptions: ["lines are not identical"],
  ...over,
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

// ───────────────────────────── Claude CLI ───────────────────────────────────

const req = (over: Partial<ClaudeRequest> = {}): ClaudeRequest => ({
  model: "opus",
  effort: "high",
  system: "You are a careful tutor.",
  prompt: "Summarise the chunk.",
  images: [],
  webTools: false,
  timeoutMs: 5_000,
  ...over,
});

describe("claudeArgs", () => {
  test("structured call: the exact argv", () => {
    expect(claudeArgs(req(), "json", '{"type":"object"}')).toEqual([
      "-p", "--model", "opus", "--effort", "high", "--system-prompt", "You are a careful tutor.",
      "--restricted", "--tools", "Read", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
      "--output-format", "json", "--json-schema", '{"type":"object"}',
    ]);
  });

  test("streaming call adds verbose partials and no schema", () => {
    const args = claudeArgs(req({ model: "sonnet", effort: "medium" }), "stream-json", null);
    expect(args.slice(-4)).toEqual(["--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(args).not.toContain("--json-schema");
    expect(args.slice(0, 5)).toEqual(["-p", "--model", "sonnet", "--effort", "medium"]);
  });

  test("web tools are added only when asked, and the dir grant only with images", () => {
    expect(claudeArgs(req({ webTools: true }), "json", null)).toContain("Read,WebSearch,WebFetch");
    expect(claudeArgs(req(), "json", null)).not.toContain("--add-dir");
    expect(claudeArgs(req(), "json", null, "/tmp/frames").slice(-2)).toEqual(["--add-dir", "/tmp/frames"]);
  });

  test("auth policy: restricted, no bare, no MCP, no skills, no session, never the prompt", () => {
    const args = claudeArgs(req(), "json", null);
    for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) expect(args).toContain(flag);
    for (const flag of ["--bare", "--resume", "--continue", "--dangerously-skip-permissions", "--mcp-config", "--input-format"]) expect(args).not.toContain(flag);
    expect(args).not.toContain("Summarise the chunk.");
  });
});

/** A fake `claude` process: scripted stdout chunks, optionally held open until released or killed. */
type Script = { readonly stdout?: readonly (string | Uint8Array)[]; readonly stderr?: string; readonly code?: number; readonly hold?: Promise<void>; readonly ignoreSigterm?: boolean };
type Spawned = { argv: readonly string[]; cwd: string; env: Record<string, string>; stdin: string[]; killed: boolean; signals: (string | number | undefined)[]; ended: boolean };

function fakeSpawn(script: Script | ((n: number) => Script)): { spawn: SpawnFn; calls: Spawned[]; live: () => number; peak: () => number } {
  const calls: Spawned[] = [];
  let live = 0;
  let peak = 0;
  const spawn: SpawnFn = (argv, opts) => {
    const s = typeof script === "function" ? script(calls.length + 1) : script;
    const call: Spawned = { argv, cwd: opts.cwd, env: opts.env, stdin: [], killed: false, signals: [], ended: false };
    calls.push(call);
    live++;
    peak = Math.max(peak, live);
    const enc = new TextEncoder();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (err = c) });
    let exit!: (code: number) => void;
    const exited = new Promise<number>((r) => (exit = r));
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      live--;
      out.close();
      err.close();
      exit(code);
    };
    void (async () => {
      if (s.hold) await s.hold;
      if (done) return;
      if (s.stderr) err.enqueue(enc.encode(s.stderr));
      for (const chunk of s.stdout ?? []) out.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
      finish(s.code ?? 0);
    })();
    const proc: ClaudeProcess = {
      stdin: { write: (c) => void call.stdin.push(c), end: () => void (call.ended = true) },
      stdout,
      stderr,
      exited,
      kill: (signal) => {
        call.killed = true;
        call.signals.push(signal);
        if (s.ignoreSigterm && signal !== "SIGKILL") return;
        finish(signal === "SIGKILL" ? 137 : 143);
      },
    };
    return proc;
  };
  return { spawn, calls, live: () => live, peak: () => peak };
}

const cli = (s: Script | ((n: number) => Script), extra: { maxConcurrent?: number; env?: Record<string, string | undefined>; killGraceMs?: number } = {}) => {
  const fake = fakeSpawn(s);
  return { ...fake, claude: createClaudeCli({ bin: "claude", cwd: "/work", maxConcurrent: extra.maxConcurrent ?? 2, spawn: fake.spawn, ...(extra.env ? { env: extra.env } : {}), ...(extra.killGraceMs !== undefined ? { killGraceMs: extra.killGraceMs } : {}) }) };
};

const Out = z.object({ concepts: z.array(z.string()) });

const successEnvelope = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 4200,
  num_turns: 1,
  result: "ok",
  session_id: "s-1",
  total_cost_usd: 0.0421,
  structured_output: { concepts: ["row picture", "column picture"] },
  usage: { input_tokens: 120, cache_creation_input_tokens: 30, cache_read_input_tokens: 900, output_tokens: 75, service_tier: "standard", server_tool_use: { web_search_requests: 0 } },
  modelUsage: { "claude-opus-5-5": { inputTokens: 150, outputTokens: 75, cacheReadInputTokens: 900, costUSD: 0.0421 } },
  permission_denials: [],
  a_field_from_the_future: { nested: [1, 2, 3] },
};

describe("claude structured", () => {
  test("parses the recorded result envelope into validated output and notional usage", async () => {
    const { claude, calls } = cli({ stdout: [JSON.stringify(successEnvelope) + "\n"] });
    const { output, usage } = await claude.structured(req(), Out, NEVER);
    expect(output).toEqual({ concepts: ["row picture", "column picture"] });
    expect(usage).toEqual({
      model: "claude-opus-5-5",
      inputTokens: 150,
      outputTokens: 75,
      cacheReadTokens: 900,
      cost: { kind: "notional", usd: 0.0421, basis: "claude_subscription" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[0]).toBe("claude");
    expect(calls[0]!.cwd).toBe("/work");
    expect(calls[0]!.argv).toContain("--json-schema");
    const schema = JSON.parse(calls[0]!.argv[calls[0]!.argv.indexOf("--json-schema") + 1]!);
    expect(schema).toMatchObject({ type: "object", properties: { concepts: { type: "array" } } });
    expect(schema.$schema).toBeUndefined();
  });

  test("the prompt goes on stdin, so its size is not bounded by argv", async () => {
    const big = "x".repeat(500_000);
    const { claude, calls } = cli({ stdout: [JSON.stringify(successEnvelope)] });
    await claude.structured(req({ prompt: big }), Out, NEVER);
    expect(calls[0]!.stdin.join("")).toBe(big);
    expect(calls[0]!.ended).toBe(true);
    expect(calls[0]!.argv.join("").length).toBeLessThan(2_000);
  });

  test("unknown cost when total_cost_usd is absent, never zero", async () => {
    const { total_cost_usd: _drop, ...noCost } = successEnvelope;
    const { claude } = cli({ stdout: [JSON.stringify(noCost)] });
    const { usage } = await claude.structured(req(), Out, NEVER);
    expect(usage.cost).toEqual({ kind: "unknown", reason: "claude did not report total_cost_usd" });
    expect(usage.inputTokens).toBe(150);
  });

  test("unknown fields and missing usage are tolerated", async () => {
    const lean = { type: "result", subtype: "success", is_error: false, structured_output: { concepts: [] }, brand_new: true };
    const { claude } = cli({ stdout: [JSON.stringify(lean)] });
    const { output, usage } = await claude.structured(req({ model: "sonnet" }), Out, NEVER);
    expect(output).toEqual({ concepts: [] });
    expect(usage).toMatchObject({ model: "sonnet", inputTokens: null, outputTokens: null, cacheReadTokens: null });
  });

  test("reads the result out of an array of messages and out of NDJSON", async () => {
    const msgs = [{ type: "system", subtype: "init" }, { type: "assistant", message: { content: [] } }, successEnvelope];
    const asArray = await cli({ stdout: [JSON.stringify(msgs)] }).claude.structured(req(), Out, NEVER);
    const asLines = await cli({ stdout: msgs.map((m) => JSON.stringify(m) + "\n") }).claude.structured(req(), Out, NEVER);
    expect(asArray.output).toEqual(asLines.output);
    expect(asArray.usage.cost).toEqual({ kind: "notional", usd: 0.0421, basis: "claude_subscription" });
  });

  test("falls back to JSON text in the answer, fenced or not", async () => {
    const { structured_output: _s, ...bare } = successEnvelope;
    const fenced = { ...bare, result: '```json\n{"concepts":["a"]}\n```' };
    const plain = { ...bare, result: '{"concepts":["b"]}' };
    expect((await cli({ stdout: [JSON.stringify(fenced)] }).claude.structured(req(), Out, NEVER)).output).toEqual({ concepts: ["a"] });
    expect((await cli({ stdout: [JSON.stringify(plain)] }).claude.structured(req(), Out, NEVER)).output).toEqual({ concepts: ["b"] });
  });

  test("the CLI's own validation is not trusted: output failing our schema is a non-retryable error that keeps usage", async () => {
    const bad = { ...successEnvelope, structured_output: { concepts: "not a list" } };
    const err = await cli({ stdout: [JSON.stringify(bad)] }).claude.structured(req(), Out, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.usage?.cost).toEqual({ kind: "notional", usd: 0.0421, basis: "claude_subscription" });
  });

  test("no structured output at all is an error", async () => {
    const { structured_output: _s, ...bare } = successEnvelope;
    const err = await cli({ stdout: [JSON.stringify({ ...bare, result: "I could not." })] }).claude.structured(req(), Out, NEVER).catch((e) => e);
    expect(err.message).toMatch(/no structured output/);
  });

  describe("failures", () => {
    const failing = (over: object, code = 1) => cli({ stdout: [JSON.stringify({ ...successEnvelope, structured_output: undefined, is_error: true, ...over })], code });

    test("is_error with an overloaded message is retryable and keeps the billed usage", async () => {
      const err = await failing({ subtype: "success", result: "API Error: 529 Overloaded" }).claude.structured(req(), Out, NEVER).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
      expect(err.usage?.outputTokens).toBe(75);
    });

    test("an api_error_status decides retryability over the text", async () => {
      const server = await failing({ result: "something", api_error_status: 500 }).claude.structured(req(), Out, NEVER).catch((e) => e);
      const client = await failing({ result: "overloaded?", api_error_status: 400 }).claude.structured(req(), Out, NEVER).catch((e) => e);
      expect([server.retryable, client.retryable]).toEqual([true, false]);
    });

    test("an error subtype is an error even when is_error is false", async () => {
      const err = await failing({ is_error: false, subtype: "error_max_structured_output_retries", result: undefined }).claude.structured(req(), Out, NEVER).catch((e) => e);
      expect(err.message).toContain("error_max_structured_output_retries");
      expect(err.retryable).toBe(false);
    });

    test("a login problem is not retryable", async () => {
      const err = await failing({ result: "Invalid API key · Please run /login" }).claude.structured(req(), Out, NEVER).catch((e) => e);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("/login");
    });

    test("a crash with no result carries stderr, with null usage", async () => {
      const err = await cli({ stdout: [], stderr: "boom: segfault", code: 139 }).claude.structured(req(), Out, NEVER).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toMatch(/exited 139.*segfault/);
      expect(err.usage).toBeNull();
      expect(err.retryable).toBe(false);
    });

    test("a crash that says the service is overloaded is retryable", async () => {
      const err = await cli({ stdout: [], stderr: "Error: 529 overloaded_error", code: 1 }).claude.structured(req(), Out, NEVER).catch((e) => e);
      expect(err.retryable).toBe(true);
    });

    test("a hung process is killed at the timeout and the error is retryable", async () => {
      const { claude, calls } = cli({ hold: new Promise(() => {}) });
      const err = await claude.structured(req({ timeoutMs: 20 }), Out, NEVER).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
      expect(calls[0]!.killed).toBe(true);
    });
  });

  test("abort kills the process and rejects with an abort, so the memo records it as aborted", async () => {
    const { claude, calls } = cli({ hold: new Promise(() => {}) });
    const c = new AbortController();
    const pending = claude.structured(req(), Out, c.signal).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    const err = await pending;
    expect(err.name).toBe("AbortError");
    expect(calls[0]!.killed).toBe(true);
  });

  test("a child that ignores SIGTERM is SIGKILLed after the grace, so the call ends and the slot is released", async () => {
    const stubborn = { hold: new Promise<void>(() => {}), ignoreSigterm: true };
    const { claude, calls } = cli((n) => (n === 1 ? stubborn : { stdout: [JSON.stringify(successEnvelope)] }), { maxConcurrent: 1, killGraceMs: 20 });
    const c = new AbortController();
    const first = claude.structured(req(), Out, c.signal).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    expect((await first).name).toBe("AbortError");
    expect(calls[0]!.signals).toEqual([undefined, "SIGKILL"]);
    expect((await claude.structured(req(), Out, NEVER)).output.concepts).toHaveLength(2);
  });

  test("a timed-out child that ignores SIGTERM is SIGKILLed and the error stays retryable", async () => {
    const { claude, calls } = cli({ hold: new Promise(() => {}), ignoreSigterm: true }, { killGraceMs: 20 });
    const err = await claude.structured(req({ timeoutMs: 20 }), Out, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(calls[0]!.signals).toEqual([undefined, "SIGKILL"]);
  });

  test("a child that exits on SIGTERM is never SIGKILLed", async () => {
    const { claude, calls } = cli({ hold: new Promise(() => {}) }, { killGraceMs: 20 });
    const c = new AbortController();
    const pending = claude.structured(req(), Out, c.signal).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    await pending;
    await Bun.sleep(40);
    expect(calls[0]!.signals).toEqual([undefined]);
  });

  test("an already-aborted signal never spawns", async () => {
    const { claude, calls } = cli({ stdout: [JSON.stringify(successEnvelope)] });
    const c = new AbortController();
    c.abort();
    await expect(claude.structured(req(), Out, c.signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("no Anthropic credential or endpoint override reaches the child, so billing stays on the subscription", async () => {
    const { claude, calls } = cli(
      { stdout: [JSON.stringify(successEnvelope)] },
      { env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-secret", ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://proxy.example", HOME: "/h" } },
    );
    await claude.structured(req(), Out, NEVER);
    expect(calls[0]!.env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("claude over a real process (a stand-in script, not the claude binary)", () => {
  function standIn(body: string) {
    const dir = mkdtempSync(join(tmpdir(), "ac-standin-"));
    const bin = join(dir, "fake-claude");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return { bin, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("default spawn feeds the prompt on stdin, passes argv, strips ANTHROPIC_API_KEY and reads the envelope", async () => {
    const s = standIn(
      `IN=$(cat | wc -c | tr -d ' ')\nprintf '{"type":"result","is_error":false,"structured_output":{"concepts":["stdin=%s","key=%s","args=%s"]},"total_cost_usd":0.001}' "$IN" "\${ANTHROPIC_API_KEY:-none}" "$#"`,
    );
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const claude = createClaudeCli({ bin: s.bin, cwd: tmpdir(), maxConcurrent: 1 });
      const { output, usage } = await claude.structured(req({ prompt: "x".repeat(300_000) }), Out, NEVER);
      expect(output.concepts).toEqual(["stdin=300000", "key=none", `args=${claudeArgs(req(), "json", "{}").length}`]);
      expect(usage.cost).toEqual({ kind: "notional", usd: 0.001, basis: "claude_subscription" });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      s.done();
    }
  });

  test("abort kills a real hung process", async () => {
    const s = standIn("exec sleep 30");
    try {
      const claude = createClaudeCli({ bin: s.bin, cwd: tmpdir(), maxConcurrent: 1 });
      const c = new AbortController();
      const started = Date.now();
      const pending = claude.structured(req(), Out, c.signal).catch((e) => e);
      await Bun.sleep(50);
      c.abort();
      expect((await pending).name).toBe("AbortError");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      s.done();
    }
  });
});

describe("claude images", () => {
  test("images are staged as files the Read tool can open, granted by --add-dir, and removed afterwards", async () => {
    const bytes = jpeg(640, 360);
    let seenDuring: { dir: string; paths: string[]; same: boolean } | null = null;
    const fake = fakeSpawn({ stdout: [JSON.stringify(successEnvelope)] });
    const spawn: SpawnFn = (argv, opts) => {
      const dir = argv[argv.indexOf("--add-dir") + 1]!;
      const proc = fake.spawn(argv, opts);
      const paths = [...(fake.calls[0]!.stdin.join("") + "").matchAll(/: (\/\S+)/g)].map((m) => m[1]!);
      seenDuring = { dir, paths, same: false };
      const write = proc.stdin.write;
      proc.stdin.write = (c: string) => {
        write(c);
        const listed = [...c.matchAll(/: (\/\S+)/g)].map((m) => m[1]!);
        seenDuring = { dir, paths: listed, same: listed.every((p) => existsSync(p) && readFileSync(p).equals(Buffer.from(bytes))) };
      };
      return proc;
    };
    const claude = createClaudeCli({ bin: "claude", cwd: "/work", maxConcurrent: 1, spawn });
    await claude.structured(req({ images: [{ label: "frame 12 (board)", mediaType: "image/jpeg", bytes }, { label: "second", mediaType: "image/png", bytes }] }), Out, NEVER);
    expect(seenDuring).not.toBeNull();
    const seen = seenDuring!;
    expect(seen.paths).toHaveLength(2);
    expect(seen.paths.every((p) => p.startsWith(seen.dir + "/"))).toBe(true);
    expect(seen.paths[0]).toMatch(/0-frame_12_board_\.jpg$/);
    expect(seen.paths[1]).toMatch(/1-second\.png$/);
    expect(seen.same).toBe(true);
    expect(existsSync(seen.dir)).toBe(false);
    expect(fake.calls[0]!.stdin.join("")).toContain("Read tool");
    expect(fake.calls[0]!.stdin.join("")).toContain("frame 12 (board):");
  });

  test("the staging dir is removed when the call fails", async () => {
    const fake = fakeSpawn({ stdout: [], code: 1, stderr: "nope" });
    const claude = createClaudeCli({ bin: "claude", cwd: "/work", maxConcurrent: 1, spawn: fake.spawn });
    await claude.structured(req({ images: [{ label: "a", mediaType: "image/jpeg", bytes: jpeg(300, 300) }] }), Out, NEVER).catch(() => {});
    const dir = fake.calls[0]!.argv[fake.calls[0]!.argv.indexOf("--add-dir") + 1]!;
    expect(existsSync(dir)).toBe(false);
  });
});

describe("claude concurrency", () => {
  test("never runs more than maxConcurrent processes, and serves everyone", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const { claude, live, peak, calls } = cli((n) => ({ stdout: [JSON.stringify(successEnvelope)], hold: gates[n - 1]!.promise }), { maxConcurrent: 2 });
    const all = Array.from({ length: 5 }, () => claude.structured(req(), Out, NEVER));
    await Bun.sleep(10);
    expect(live()).toBe(2);
    for (const g of gates) {
      g.resolve();
      await Bun.sleep(5);
    }
    const done = await Promise.all(all);
    expect(done).toHaveLength(5);
    expect(peak()).toBe(2);
    expect(calls).toHaveLength(5);
  });

  test("a caller aborted while waiting for a slot never spawns, and frees nothing it did not hold", async () => {
    const gate = deferred<void>();
    const { claude, calls } = cli((n) => ({ stdout: [JSON.stringify(successEnvelope)], ...(n === 1 ? { hold: gate.promise } : {}) }), { maxConcurrent: 1 });
    const first = claude.structured(req(), Out, NEVER);
    const c = new AbortController();
    const queued = claude.structured(req(), Out, c.signal).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    expect((await queued).name).toBe("AbortError");
    gate.resolve();
    await first;
    expect(calls).toHaveLength(1);
    await claude.structured(req(), Out, NEVER);
    expect(calls).toHaveLength(2);
  });

  test("a killed call releases its slot", async () => {
    const { claude } = cli((n) => (n === 1 ? { hold: new Promise(() => {}) } : { stdout: [JSON.stringify(successEnvelope)] }), { maxConcurrent: 1 });
    const c = new AbortController();
    const first = claude.structured(req(), Out, c.signal).catch((e) => e);
    const second = claude.structured(req(), Out, NEVER);
    await Bun.sleep(5);
    c.abort();
    await first;
    expect((await second).output.concepts).toHaveLength(2);
  });

  test("rejects a nonsense limit", () => {
    expect(() => createClaudeCli({ bin: "claude", cwd: "/", maxConcurrent: 0 })).toThrow(RangeError);
  });
});

describe("claude streamText", () => {
  const ev = (event: unknown) => JSON.stringify({ type: "stream_event", session_id: "s", parent_tool_use_id: null, event }) + "\n";
  const delta = (text: string) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  const done = (result: string, over: object = {}) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 }, ...over }) + "\n";

  test("emits each text delta in order, ignores thinking and other events, resolves with the final text", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }) + "\n",
      ev({ type: "message_start", message: { id: "m1" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      delta('{"move":"probe"}\n'),
      delta("Why does "),
      delta("that hold?"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: '{"move":"probe"}\nWhy does that hold?' }] } }) + "\n",
      "not json at all\n",
      done('{"move":"probe"}\nWhy does that hold?'),
    ];
    const { claude, calls } = cli({ stdout: lines });
    const got: string[] = [];
    const res = await claude.streamText(req(), (d) => got.push(d), NEVER);
    expect(got).toEqual(['{"move":"probe"}\n', "Why does ", "that hold?"]);
    expect(res.text).toBe('{"move":"probe"}\nWhy does that hold?');
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, cost: { kind: "notional", usd: 0.5, basis: "claude_subscription" } });
    expect(calls[0]!.argv.slice(-4)).toEqual(["--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(calls[0]!.argv).not.toContain("--json-schema");
  });

  test("lines and multi-byte characters split across chunks still arrive whole", async () => {
    const bytes = new TextEncoder().encode(delta("héllo") + done("héllo"));
    const accent = bytes.indexOf(0xc3);
    const { claude } = cli({ stdout: [bytes.slice(0, 10), bytes.slice(10, accent + 1), bytes.slice(accent + 1, accent + 20), bytes.slice(accent + 20)] });
    const got: string[] = [];
    const res = await claude.streamText(req(), (d) => got.push(d), NEVER);
    expect(got).toEqual(["héllo"]);
    expect(res.text).toBe("héllo");
  });

  test("with no partial events, the whole assistant message is emitted once", async () => {
    const { claude } = cli({ stdout: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "all at once" }] } }) + "\n", done("all at once")] });
    const got: string[] = [];
    await claude.streamText(req(), (d) => got.push(d), NEVER);
    expect(got).toEqual(["all at once"]);
  });

  test("an assistant message only adds what the deltas did not already deliver", async () => {
    const { claude } = cli({
      stdout: [
        ev({ type: "message_start", message: {} }),
        delta("Hel"),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }) + "\n",
        done("Hello"),
      ],
    });
    const got: string[] = [];
    await claude.streamText(req(), (d) => got.push(d), NEVER);
    expect(got.join("")).toBe("Hello");
  });

  test("subagent text is not spoken", async () => {
    const { claude } = cli({
      stdout: [JSON.stringify({ type: "stream_event", parent_tool_use_id: "tool_1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "internal" } } }) + "\n", delta("spoken"), done("spoken")],
    });
    const got: string[] = [];
    await claude.streamText(req(), (d) => got.push(d), NEVER);
    expect(got).toEqual(["spoken"]);
  });

  test("a stream that ends in an error result throws with the usage so far", async () => {
    const { claude } = cli({ stdout: [delta("par"), done("API Error: 529 overloaded", { is_error: true })], code: 1 });
    const got: string[] = [];
    const err = await claude.streamText(req(), (d) => got.push(d), NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.usage?.outputTokens).toBe(20);
    expect(got).toEqual(["par"]);
  });

  test("the final text falls back to the streamed deltas when the result carries none", async () => {
    const { claude } = cli({ stdout: [delta("abc"), JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n"] });
    const res = await claude.streamText(req(), () => {}, NEVER);
    expect(res.text).toBe("abc");
    expect(res.usage.cost.kind).toBe("unknown");
  });

  test("abort mid-stream kills the process", async () => {
    const { claude, calls } = cli({ stdout: [delta("start")], hold: new Promise(() => {}) });
    const c = new AbortController();
    const pending = claude.streamText(req(), () => {}, c.signal).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    expect((await pending).name).toBe("AbortError");
    expect(calls[0]!.killed).toBe(true);
  });
});

// ───────────────────────────── ledger + memo (R17) ──────────────────────────

describe("R17 and the ledger", () => {
  const claudeTask = (claude: ReturnType<typeof createClaudeCli>, purpose: "interpretation" | "wrap_up", tag: string): Task<{ tag: string }, { concepts: string[] }> => ({
    provider: "claude",
    purpose,
    model: "opus",
    version: "t1",
    maxAttempts: 1,
    canonicalInput: (i) => ({ tag: i.tag }),
    decode: (s) => Out.parse(s),
    async attempt(_i, c) {
      const r = await claude.structured(req(), Out, c.signal);
      return { output: r.output, usage: r.usage };
    },
  });

  test("Jev events are stored with cost unknown and usd NULL; Claude events are notional; totals never mix them", async () => {
    const db = testDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const ledger = createLedger(db);

    const { jev } = fakeJev(() => ({ new_concept: p(0.9), stopping_point: p(0.1) }));
    await memo.run(boundaryTask(jev), boundaryInput());
    await memo.run(boundaryTask(jev), boundaryInput({ newPassages: [passage("ev_n2", 5, "x")] }));
    const failing = fakeJev(() => new ProviderError("jev 400", null, false));
    await memo.run(claimSupportTask(failing.jev), { claim: claim(), passages: [], frames: [] });

    const { claude } = cli(() => ({ stdout: [JSON.stringify(successEnvelope)] }));
    await memo.run(claudeTask(claude, "interpretation", "a"), { tag: "a" });
    await memo.run(claudeTask(claude, "interpretation", "b"), { tag: "b" });
    const noCost = (() => {
      const { total_cost_usd: _x, ...rest } = successEnvelope;
      return cli(() => ({ stdout: [JSON.stringify(rest)] })).claude;
    })();
    await memo.run(claudeTask(noCost, "wrap_up", "c"), { tag: "c" });

    const raw = db.sql.query<{ provider: string; cost_kind: string; cost_usd: number | null; cost_reason: string | null }, []>(`SELECT provider, cost_kind, cost_usd, cost_reason FROM usage_events`).all();
    expect(raw.filter((r) => r.provider === "jev").every((r) => r.cost_kind === "unknown" && r.cost_usd === null && r.cost_reason !== null)).toBe(true);
    expect(raw.filter((r) => r.provider === "claude" && r.cost_kind === "notional").every((r) => r.cost_usd === 0.0421)).toBe(true);

    const s = ledger.summary();
    expect(s.byKind.unknown).toEqual({ calls: 4, usd: null });
    expect(s.byKind.notional).toEqual({ calls: 2, usd: 0.0842 });
    expect(s.byKind.measured).toEqual({ calls: 0, usd: null });
    expect(s.byPurpose.boundary).toEqual({ calls: 2, errors: 0, unknownCost: 2 });
    expect(s.byPurpose.claim_check).toEqual({ calls: 1, errors: 1, unknownCost: 1 });
    expect(s.byPurpose.wrap_up).toEqual({ calls: 1, errors: 0, unknownCost: 1 });

    const stages = ledger.stages();
    expect(stages.map((x) => x.purpose)).toEqual(["boundary", "claim_check", "interpretation", "wrap_up"]);
    const interp = stages.find((x) => x.purpose === "interpretation")!;
    expect(interp).toMatchObject({ provider: "claude", calls: 2, unknownCostCalls: 0, usd: { measured: null, notional: 0.0842, estimated: null }, inputTokens: 300, outputTokens: 150, cacheReadTokens: 1800 });
    const boundary = stages.find((x) => x.purpose === "boundary")!;
    expect(boundary).toMatchObject({ provider: "jev", calls: 2, unknownCostCalls: 2, usd: { measured: null, notional: null, estimated: null }, inputTokens: 200, outputTokens: 4, cacheReadTokens: null });
    expect(stages.find((x) => x.purpose === "claim_check")).toMatchObject({ calls: 1, errors: 1, inputTokens: null });
  });

  test("filters narrow summary and stages; list returns events newest first", async () => {
    let t = 1_000;
    const db = testDb();
    const memo = createMemo(db, "live", { now: () => (t += 10) });
    const ledger = createLedger(db);
    const { jev } = fakeJev(() => ({ new_concept: p(0.9), stopping_point: p(0.1) }));
    const first = boundaryInput();
    await memo.run(boundaryTask(jev), first);
    const cutoff = t;
    t += 1_000;
    await memo.run(boundaryTask(jev), boundaryInput({ newPassages: [passage("ev_n2", 5, "x")] }));
    await memo.run(frameChangeTask(jev), { before: null, after: withBytes(frame("z")), nearbyPassages: [] });

    expect(ledger.summary({ sinceMs: cutoff }).byPurpose.boundary.calls).toBe(1);
    expect(ledger.summary({ purpose: "frame_change" }).byPurpose.boundary.calls).toBe(0);
    expect(ledger.stages({ purpose: "boundary" }).map((s) => s.calls)).toEqual([2]);
    const events = ledger.list({ limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0]!.startedAtMs).toBeGreaterThanOrEqual(events[1]!.startedAtMs);
    expect(events[0]!.cost).toEqual({ kind: "unknown", reason: "no provider call was made" });
    expect(ledger.list({ memoKey: memo.key(boundaryTask(jev), first), limit: 10 })).toHaveLength(1);
  });

  test("a kind with no calls reports usd null, not $0; a ledger of only unknown-cost calls prices nothing", async () => {
    const db = testDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const { jev } = fakeJev(() => ({ new_concept: p(0.9), stopping_point: p(0.1) }));
    await memo.run(boundaryTask(jev), boundaryInput());
    const s = createLedger(db).summary();
    expect(s.byKind.unknown).toEqual({ calls: 1, usd: null });
    for (const k of ["measured", "notional", "estimated"] as const) expect(s.byKind[k]).toEqual({ calls: 0, usd: null });
  });

  test("an empty ledger reports zero calls and no invented money", () => {
    const ledger = createLedger(testDb());
    const s = ledger.summary();
    expect(s.byKind.unknown).toEqual({ calls: 0, usd: null });
    for (const k of ["measured", "notional", "estimated"] as const) expect(s.byKind[k]).toEqual({ calls: 0, usd: null });
    expect(Object.values(s.byPurpose).every((x) => x.calls === 0)).toBe(true);
    expect(ledger.stages()).toEqual([]);
    expect(ledger.list({ limit: 5 })).toEqual([]);
  });
});
