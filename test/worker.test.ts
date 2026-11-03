import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtension, copyBuild, manifestFiles } from "../scripts/build-extension";
import type { CaptureFactBody } from "../src/shared/domain";
import type { CaptureId } from "../src/shared/ids";
import { randomId } from "../src/shared/ids";
import { media } from "../src/shared/time";
import type { IngestAck } from "../src/shared/wire";
import { acceptsFact, badgeFor, isWatchUrl, safeReviewUrl, transition } from "../src/extension/worker/control";
import type { ControlEvent, TabCaptureState } from "../src/extension/worker/control";
import {
  BATCH_MAX_BYTES, BATCH_MAX_FACTS, classifyStatus, createFlusher, createMemoryOutbox, flushCapture, isIngestAck, nextBackoffMs, selectBatch, toWire,
} from "../src/extension/worker/outbox";
import type { FlushOutcome, StoredFact, Transport, TransportResult } from "../src/extension/worker/outbox";
import { describePopup } from "../src/extension/popup/popup";

const CAP = randomId("cap");
const mint = () => CAP;
const state = (over: Partial<TabCaptureState> = {}): TabCaptureState => ({
  tabId: 7, captureId: CAP, state: "capturing", pauseReason: null, nextClientSeq: 0, lastAck: null, uploadBacklog: 0, lastError: null, deadLetters: { count: 0, latestReason: null }, ...over,
});
const control = (action: "start" | "pause" | "resume" | "stop", reason: string) => ({ kind: "control", action, reason }) as CaptureFactBody;

describe("control transition table", () => {
  type Row = { readonly from: TabCaptureState | null; readonly event: ControlEvent; readonly to: Partial<TabCaptureState> | "same"; readonly fact: CaptureFactBody | null };
  const capturing = state();
  const paused = state({ state: "paused", pauseReason: "user" });
  const away = state({ state: "paused", pauseReason: "left_watch_page" });
  const stopped = state({ state: "stopped" });

  const table: readonly (readonly [string, Row])[] = [
    ["start from nothing", { from: null, event: { kind: "start", tabId: 7 }, to: { state: "capturing", nextClientSeq: 0 }, fact: control("start", "user") }],
    ["start after stop mints a new capture", { from: stopped, event: { kind: "start", tabId: 7 }, to: { state: "capturing", nextClientSeq: 0 }, fact: control("start", "user") }],
    ["start while capturing is a no-op", { from: capturing, event: { kind: "start", tabId: 7 }, to: "same", fact: null }],
    ["start while paused is a no-op", { from: paused, event: { kind: "start", tabId: 7 }, to: "same", fact: null }],
    ["pause", { from: capturing, event: { kind: "pause" }, to: { state: "paused", pauseReason: "user" }, fact: control("pause", "user") }],
    ["pause while paused", { from: paused, event: { kind: "pause" }, to: "same", fact: null }],
    ["pause with no capture", { from: null, event: { kind: "pause" }, to: "same", fact: null }],
    ["resume", { from: paused, event: { kind: "resume" }, to: { state: "capturing", pauseReason: null }, fact: control("resume", "user") }],
    ["resume after leaving the page, by the user", { from: away, event: { kind: "resume" }, to: { state: "capturing", pauseReason: null }, fact: control("resume", "user") }],
    ["resume while capturing", { from: capturing, event: { kind: "resume" }, to: "same", fact: null }],
    ["resume after stop", { from: stopped, event: { kind: "resume" }, to: "same", fact: null }],
    ["leaving the watch page auto-pauses", { from: capturing, event: { kind: "left_watch_page" }, to: { state: "paused", pauseReason: "left_watch_page" }, fact: control("pause", "left_watch_page") }],
    ["leaving while already paused keeps the first reason", { from: paused, event: { kind: "left_watch_page" }, to: "same", fact: null }],
    ["leaving while stopped", { from: stopped, event: { kind: "left_watch_page" }, to: "same", fact: null }],
    ["returning never resumes", { from: away, event: { kind: "returned_to_watch_page" }, to: "same", fact: null }],
    ["returning while capturing", { from: capturing, event: { kind: "returned_to_watch_page" }, to: "same", fact: null }],
    ["stop while capturing", { from: capturing, event: { kind: "stop" }, to: { state: "stopped" }, fact: control("stop", "user") }],
    ["stop while paused", { from: paused, event: { kind: "stop" }, to: { state: "stopped" }, fact: control("stop", "user") }],
    ["stop twice", { from: stopped, event: { kind: "stop" }, to: "same", fact: null }],
    ["closing the tab while capturing", { from: capturing, event: { kind: "tab_closed" }, to: { state: "stopped" }, fact: control("stop", "tab_closed") }],
    ["closing the tab while paused", { from: away, event: { kind: "tab_closed" }, to: { state: "stopped" }, fact: control("stop", "tab_closed") }],
    ["closing a stopped tab", { from: stopped, event: { kind: "tab_closed" }, to: "same", fact: null }],
    ["closing a tab with no capture", { from: null, event: { kind: "tab_closed" }, to: "same", fact: null }],
  ];

  test.each(table)("%s", (_, row) => {
    const out = transition(row.from, row.event, mint);
    expect(out.fact).toEqual(row.fact);
    if (row.to === "same") expect(out.next).toBe(row.from);
    else expect(out.next).toMatchObject(row.to);
  });

  test("a new start mints a fresh capture id each time, and keeps the id through pause and resume", () => {
    const first = transition(null, { kind: "start", tabId: 1 }).next!;
    const second = transition({ ...first, state: "stopped" }, { kind: "start", tabId: 1 }).next!;
    expect(second.captureId).not.toBe(first.captureId);
    const resumed = transition(transition(first, { kind: "pause" }).next, { kind: "resume" }).next!;
    expect(resumed.captureId).toBe(first.captureId);
  });

  test("a full lecture: leave, return, and only an explicit resume restarts capture", () => {
    let s: TabCaptureState | null = transition(null, { kind: "start", tabId: 7 }, mint).next;
    s = transition(s, { kind: "left_watch_page" }).next;
    s = transition(s, { kind: "returned_to_watch_page" }).next;
    expect(s?.state).toBe("paused");
    expect(transition(s, { kind: "resume" }).next?.state).toBe("capturing");
  });
});

describe("what the worker accepts from a page", () => {
  const span: CaptureFactBody = { kind: "span", videoId: "QgWz_s7uugE", start: media(0), end: media(5), rate: 1, tabVisible: true, wallDurationMs: 5000 };
  const frame = { kind: "frame", videoId: "QgWz_s7uugE" } as CaptureFactBody;
  const transcript: CaptureFactBody = { kind: "transcript_unavailable", videoId: "QgWz_s7uugE", reason: "panel_missing" };
  const ad: CaptureFactBody = { kind: "ad", videoId: "QgWz_s7uugE", atContentS: media(3), wallDurationMs: 1000, signals: ["dom_class"] };

  test("R1: playback evidence is accepted only while capturing", () => {
    for (const f of [span, frame, ad]) {
      expect(acceptsFact(state(), f)).toBe(true);
      expect(acceptsFact(state({ state: "paused", pauseReason: "user" }), f)).toBe(false);
      expect(acceptsFact(state({ state: "stopped" }), f)).toBe(false);
      expect(acceptsFact(null, f)).toBe(false);
    }
  });

  test("source and transcript facts still arrive while paused; control facts never come from a page", () => {
    const paused = state({ state: "paused", pauseReason: "left_watch_page" });
    expect(acceptsFact(paused, transcript)).toBe(true);
    expect(acceptsFact(state(), { kind: "control", action: "stop", reason: "user" })).toBe(false);
  });

  test("watch pages are exactly youtube.com/watch with a video id", () => {
    expect(isWatchUrl("https://www.youtube.com/watch?v=QgWz_s7uugE&list=PLx")).toBe(true);
    for (const u of ["https://www.youtube.com/", "https://www.youtube.com/watch", "https://www.youtube.com/shorts/QgWz_s7uugE", "https://evil.example/watch?v=QgWz_s7uugE", "http://www.youtube.com/watch?v=QgWz_s7uugE", "not a url", undefined]) {
      expect(isWatchUrl(u)).toBe(false);
    }
  });

  test("a backend-supplied review url opens only when it points at the local backend", () => {
    const fallback = "http://127.0.0.1:4317/app/";
    expect(safeReviewUrl("http://localhost:4317/app/review/cap_x", fallback)).toBe("http://localhost:4317/app/review/cap_x");
    expect(safeReviewUrl("https://evil.example/app", fallback)).toBe(fallback);
    expect(safeReviewUrl("javascript:alert(1)", fallback)).toBe(fallback);
    expect(safeReviewUrl(undefined, fallback)).toBe(fallback);
  });
});

const fact = (n: number): CaptureFactBody => ({ kind: "channel", channel: "playback", health: "ok", videoId: null, atMediaS: null, detail: `f${n}` });
const ack = (through: number, invite: IngestAck["invite"] = { state: "none" }): IngestAck =>
  ({ ackedThroughSeq: through, invite, capture: { watchedSeconds: 0 }, reviewAppUrl: "http://127.0.0.1:4317/app/" }) as unknown as IngestAck;

/** Stands in for the backend's idempotent ingest: stores each (captureId, clientSeq) once. */
function fakeBackend(opts: { failNext?: TransportResult[] } = {}) {
  const stored = new Map<string, number>();
  const sent: number[][] = [];
  const failures = [...(opts.failNext ?? [])];
  const transport: Transport = async (captureId, facts) => {
    sent.push(facts.map((f) => f.clientSeq));
    const failure = failures.shift();
    if (failure) return failure;
    for (const f of facts) stored.set(`${captureId}:${f.clientSeq}`, f.clientSeq);
    let through = -1;
    while (stored.has(`${captureId}:${through + 1}`)) through++;
    return { ok: true, ack: ack(through) };
  };
  return { transport, stored, sent };
}

describe("outbox", () => {
  test("clientSeq is assigned once, contiguous from 0, and independent per capture", async () => {
    const store = createMemoryOutbox();
    const other = randomId("cap");
    const seqs = [await store.append(CAP, fact(0), 1), await store.append(CAP, fact(1), 2), await store.append(other, fact(2), 3), await store.append(CAP, fact(3), 4)].map((f) => f.clientSeq);
    expect(seqs).toEqual([0, 1, 0, 2]);
  });

  test("a send that loses its ack leaves every fact in place, and the resend carries the same ids", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 3; i++) await store.append(CAP, fact(i), i);
    const backend = fakeBackend({ failNext: [{ ok: false, retryable: true, error: "backend unreachable" }] });
    const first = await flushCapture(store, backend.transport, CAP);
    expect(first).toMatchObject({ error: "backend unreachable", retryable: true, remaining: 3 });
    const second = await flushCapture(store, backend.transport, CAP);
    expect(second).toMatchObject({ error: null, remaining: 0 });
    expect(backend.sent).toEqual([[0, 1, 2], [0, 1, 2]]);
    expect([...backend.stored.values()]).toEqual([0, 1, 2]);
  });

  test("a batch the backend stored but never acknowledged is resent without duplicating", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 2; i++) await store.append(CAP, fact(i), i);
    const backend = fakeBackend();
    // Backend stores the batch, then the response is lost.
    const lossy: Transport = async (id, facts) => {
      await backend.transport(id, facts);
      return { ok: false, retryable: true, error: "backend unreachable" };
    };
    await flushCapture(store, lossy, CAP);
    await flushCapture(store, backend.transport, CAP);
    expect(backend.stored.size).toBe(2);
    expect(await store.backlog(CAP)).toBe(0);
  });

  test("facts leave only through the ack high-water mark, and a late smaller ack cannot bring them back", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 4; i++) await store.append(CAP, fact(i), i);
    await store.ackThrough(CAP, 1);
    expect((await store.pending(CAP, 10)).map((f) => f.clientSeq)).toEqual([2, 3]);
    await store.ackThrough(CAP, 0);
    expect(await store.backlog(CAP)).toBe(2);
    await store.ackThrough(CAP, 3);
    expect(await store.captureIds()).toEqual([]);
  });

  test("an acknowledgement that does not reach the batch is a retryable failure, not a silent drop", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 2; i++) await store.append(CAP, fact(i), i);
    const stale: Transport = async () => ({ ok: true, ack: ack(-1) });
    expect(await flushCapture(store, stale, CAP)).toMatchObject({ error: "backend did not acknowledge the batch", retryable: true, remaining: 2 });
  });

  test("a large backlog goes out in batches of at most 500 facts, in order", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 1203; i++) await store.append(CAP, fact(i), i);
    const backend = fakeBackend();
    const out = await flushCapture(store, backend.transport, CAP);
    expect(backend.sent.map((b) => b.length)).toEqual([500, 500, 203]);
    expect(backend.sent.flat()).toEqual(Array.from({ length: 1203 }, (_, i) => i));
    expect(out.remaining).toBe(0);
  });

  test("an empty outbox sends nothing, except a heartbeat batch that refreshes the ack", async () => {
    const store = createMemoryOutbox();
    const backend = fakeBackend();
    expect((await flushCapture(store, backend.transport, CAP)).ack).toBeNull();
    expect(backend.sent).toEqual([]);
    const beat = await flushCapture(store, backend.transport, CAP, { heartbeat: true });
    expect(backend.sent).toEqual([[]]);
    expect(beat.ack).not.toBeNull();
  });

  test("the wire fact is the body plus clientSeq and wallMs, without the capture id", async () => {
    const stored = await createMemoryOutbox().append(CAP, fact(0), 1234);
    expect(toWire(stored)).toEqual({ ...fact(0), clientSeq: 0, wallMs: 1234 });
  });
});

describe("a batch the backend refuses", () => {
  const poison = (n: number): CaptureFactBody => ({ kind: "channel", channel: "playback", health: "ok", videoId: null, atMediaS: null, detail: `POISON ${n}` });
  const isPoison = (b: CaptureFactBody) => b.kind === "channel" && b.detail.startsWith("POISON");

  /** A backend that answers 400 to any batch holding a poison fact, and stores the rest idempotently. */
  function picky() {
    const stored = new Map<number, CaptureFactBody>();
    let requests = 0;
    const transport: Transport = async (_captureId, facts) => {
      requests++;
      if (facts.some(isPoison)) return { ok: false, rejected: true, retryable: false, error: "backend rejected the batch (HTTP 400)" };
      for (const f of facts) if (!stored.has(f.clientSeq)) stored.set(f.clientSeq, f);
      let through = -1;
      while (stored.has(through + 1)) through++;
      return { ok: true, ack: ack(through) };
    };
    return { transport, stored, requests: () => requests };
  }

  test("the offending fact is set aside with its reason, a placeholder keeps the sequence whole, and everything else is delivered", async () => {
    const store = createMemoryOutbox();
    const bodies = [fact(0), fact(1), poison(2), fact(3), fact(4), fact(5)];
    for (const [i, b] of bodies.entries()) await store.append(CAP, b, i);
    const backend = picky();
    const out = await flushCapture(store, backend.transport, CAP);
    expect(out).toMatchObject({ error: null, remaining: 0 });
    expect([...backend.stored.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const placeholder = backend.stored.get(2)!;
    expect(placeholder).toMatchObject({ kind: "channel", health: "failed" });
    expect((placeholder as { detail: string }).detail).toContain("channel fact");
    const dead = await store.deadLetters(CAP);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ clientSeq: 2, body: bodies[2], reason: "channel fact: backend rejected the batch (HTTP 400)" });
  });

  test("finding one bad fact in a full batch takes logarithmically many requests, not one per fact", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 500; i++) await store.append(CAP, i === 377 ? poison(i) : fact(i), i);
    const backend = picky();
    expect(await flushCapture(store, backend.transport, CAP)).toMatchObject({ error: null, remaining: 0 });
    expect(backend.requests()).toBeLessThan(30);
    expect(backend.stored.size).toBe(500);
    expect(await store.deadLetters(CAP)).toHaveLength(1);
  });

  test("several bad facts are each set aside and the good ones between them still arrive in order", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 9; i++) await store.append(CAP, i % 4 === 1 ? poison(i) : fact(i), i);
    const backend = picky();
    expect(await flushCapture(store, backend.transport, CAP)).toMatchObject({ error: null, remaining: 0 });
    expect((await store.deadLetters(CAP)).map((d) => d.clientSeq)).toEqual([1, 5]);
    expect([...backend.stored.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("an auth failure is not a bad fact: nothing is set aside and the batch stays whole", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 3; i++) await store.append(CAP, fact(i), i);
    const denied: Transport = async () => ({ ok: false, retryable: false, error: "pairing token rejected (HTTP 401)" });
    expect(await flushCapture(store, denied, CAP)).toMatchObject({ error: expect.stringContaining("401"), remaining: 3 });
    expect(await store.deadLetters(CAP)).toEqual([]);
  });

  test("a backend that refuses even the placeholder stops with an error instead of looping or discarding more", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 3; i++) await store.append(CAP, fact(i), i);
    const refuseAll: Transport = async () => ({ ok: false, rejected: true, retryable: false, error: "backend rejected the batch (HTTP 400)" });
    const out = await flushCapture(store, refuseAll, CAP);
    expect(out.error).not.toBeNull();
    expect(out.retryable).toBe(false);
    expect((await store.deadLetters(CAP)).length).toBeLessThanOrEqual(1);
    expect(await store.backlog(CAP)).toBeGreaterThan(0);
  });

  test("status codes 400, 413 and 422 mean the content was refused; 401 and 404 do not", () => {
    expect([400, 413, 422].map((s) => classifyStatus(s).rejected)).toEqual([true, true, true]);
    expect([401, 403, 404, 500].map((s) => classifyStatus(s).rejected ?? false)).toEqual([false, false, false, false]);
  });
});

describe("acknowledgement bounds", () => {
  test("an ack beyond the batch removes only what was sent, so a fact appended mid-flight survives", async () => {
    const store = createMemoryOutbox();
    for (let i = 0; i < 3; i++) await store.append(CAP, fact(i), i);
    let first = true;
    const generous: Transport = async () => {
      if (first) {
        first = false;
        await store.append(CAP, fact(3), 3);
        return { ok: true, ack: ack(100) };
      }
      return { ok: true, ack: ack(3) };
    };
    const seen: number[][] = [];
    const spy: Transport = async (id, facts) => {
      seen.push(facts.map((f) => f.clientSeq));
      return generous(id, facts);
    };
    expect(await flushCapture(store, spy, CAP)).toMatchObject({ error: null, remaining: 0 });
    expect(seen).toEqual([[0, 1, 2], [3]]);
  });
});

describe("batching", () => {
  const stored = (n: number, body: CaptureFactBody): StoredFact => ({ captureId: CAP, clientSeq: n, wallMs: n, body });
  const frame = (mb: number): CaptureFactBody =>
    ({ kind: "frame", videoId: "QgWz_s7uugE", frameId: "f", mediaS: media(1), width: 640, height: 360, trigger: "first", diff: 0, jpegBase64: "x".repeat(mb * 1024 * 1024) });

  test("count cap", () => {
    expect(selectBatch(Array.from({ length: BATCH_MAX_FACTS + 50 }, (_, i) => stored(i, fact(i))))).toHaveLength(BATCH_MAX_FACTS);
  });

  test("frames are counted by bytes: 8 MiB per batch", () => {
    const facts = [stored(0, frame(3)), stored(1, frame(3)), stored(2, frame(3)), stored(3, fact(3))];
    expect(selectBatch(facts).map((f) => f.clientSeq)).toEqual([0, 1]);
    expect(BATCH_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  test("an oversized first fact still goes alone, so the outbox cannot wedge", () => {
    expect(selectBatch([stored(0, frame(9)), stored(1, fact(1))]).map((f) => f.clientSeq)).toEqual([0]);
  });
});

describe("retry and backoff", () => {
  test("backoff doubles from 1 s to a 30 s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(nextBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  test("status codes: auth and bad requests wait for a human, outages retry", () => {
    expect(classifyStatus(401).retryable).toBe(false);
    expect(classifyStatus(403).error).toContain("pairing token");
    expect(classifyStatus(400).retryable).toBe(false);
    expect(classifyStatus(413).retryable).toBe(false);
    for (const s of [408, 429, 500, 503]) expect(classifyStatus(s).retryable).toBe(true);
  });

  test("acks are recognised by shape", () => {
    expect(isIngestAck(ack(3))).toBe(true);
    for (const bad of [null, {}, { ackedThroughSeq: "3" }, { ackedThroughSeq: 3 }, "ok"]) expect(isIngestAck(bad)).toBe(false);
  });

  test("failures schedule one retry at a time with growing delays, and success clears the streak", async () => {
    const store = createMemoryOutbox();
    await store.append(CAP, fact(0), 0);
    const down: TransportResult = { ok: false, retryable: true, error: "backend unreachable" };
    const backend = fakeBackend({ failNext: [down, down, down] });
    const timers: { fn: () => void; ms: number }[] = [];
    const outcomes: FlushOutcome[] = [];
    const flusher = createFlusher({ store, transport: backend.transport, schedule: (fn, ms) => timers.push({ fn, ms }), onOutcome: (_, o) => outcomes.push(o) });

    await flusher.flush(CAP);
    await flusher.flush(CAP); // a second trigger during the wait must not stack another timer
    expect(timers.map((t) => t.ms)).toEqual([1000]);

    timers.shift()!.fn();
    await Bun.sleep(0);
    expect(timers.map((t) => t.ms)).toEqual([2000]);
    timers.shift()!.fn();
    await Bun.sleep(0);
    expect(timers).toEqual([]);
    expect(outcomes.at(-1)).toMatchObject({ error: null, remaining: 0 });
    expect(await store.backlog(CAP)).toBe(0);
  });

  test("non-retryable failures schedule nothing and keep every fact", async () => {
    const store = createMemoryOutbox();
    await store.append(CAP, fact(0), 0);
    const denied: Transport = async () => ({ ok: false, ...classifyStatus(401) });
    const timers: unknown[] = [];
    const flusher = createFlusher({ store, transport: denied, schedule: (fn) => timers.push(fn), onOutcome: () => {} });
    expect((await flusher.flush(CAP)).error).toContain("pairing token rejected");
    expect(timers).toEqual([]);
    expect(await store.backlog(CAP)).toBe(1);
  });

  test("a flush requested while one runs shares it and sends the facts added meanwhile", async () => {
    const store = createMemoryOutbox();
    await store.append(CAP, fact(0), 0);
    const backend = fakeBackend();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Transport = async (id, facts) => {
      await gate;
      return backend.transport(id, facts);
    };
    const flusher = createFlusher({ store, transport: slow, schedule: () => {}, onOutcome: () => {} });
    const first = flusher.flush(CAP);
    await store.append(CAP, fact(1), 1);
    const second = flusher.flush(CAP);
    release();
    await Promise.all([first, second]);
    expect(await store.backlog(CAP)).toBe(0);
    expect(backend.stored.size).toBe(2);
  });
});

describe("popup view", () => {
  const watch = { url: "https://www.youtube.com/watch?v=QgWz_s7uugE" };
  const home = { url: "https://www.youtube.com/" };
  const withAck = (s: TabCaptureState, extra: Record<string, unknown>, invite: IngestAck["invite"] = { state: "none" }): TabCaptureState => ({
    ...s,
    lastAck: {
      ackedThroughSeq: 0,
      invite,
      reviewAppUrl: "http://127.0.0.1:4317/app/",
      capture: {
        captureId: CAP as CaptureId, status: { state: "capturing" }, currentSourceId: "src_a", watchedSeconds: 125, health: [],
        sources: [{ id: "src_a", videoId: "QgWz_s7uugE", title: "Lamport's Physical Clock", url: "u", channelName: "Georgia Tech", durationS: 600 }],
        transcript: "available", ...extra,
      },
    } as unknown as IngestAck,
  });

  test("with no capture, Start is offered on a watch page and a hint elsewhere", () => {
    expect(describePopup(null, watch).actions).toEqual(["start"]);
    const away = describePopup(null, home);
    expect(away.actions).toEqual([]);
    expect(away.hint).toContain("YouTube video");
  });

  test("capturing offers Pause and Stop; an auto-pause explains itself and offers Resume only on a watch page", () => {
    expect(describePopup(state(), watch)).toMatchObject({ headline: "Capturing", actions: ["pause", "stop"] });
    const paused = state({ state: "paused", pauseReason: "left_watch_page" });
    expect(describePopup(paused, home)).toMatchObject({ headline: "Paused: you left the video page", actions: ["stop"] });
    expect(describePopup(paused, watch).actions).toEqual(["resume", "stop"]);
  });

  test("a stopped capture can be started again", () => {
    expect(describePopup(state({ state: "stopped" }), watch)).toMatchObject({ headline: "Stopped", actions: ["start"] });
  });

  test("source, caption status, frame health and watched time come from the last ack", () => {
    const v = describePopup(withAck(state(), { health: [{ channel: "frames", health: "stalled", detail: "no frames for 6 s" }] }), watch);
    expect(v.source).toEqual({ title: "Lamport's Physical Clock", channel: "Georgia Tech", videoId: "QgWz_s7uugE" });
    expect(v.captions).toBe("Captions found");
    expect(v.health).toEqual([{ label: "Frames", text: "stalled: no frames for 6 s", tone: "warn" }]);
    expect(v.watched).toBe("2 min 5 s");
  });

  test("unusable captions offer the opt-in transcription choice", () => {
    expect(describePopup(withAck(state(), { transcript: "unavailable_offer_asr" }), watch).offerTranscription).toBe(true);
    expect(describePopup(withAck(state(), { transcript: "available" }), watch).offerTranscription).toBe(false);
  });

  test("an invite surfaces, and a backend problem is shown with the waiting count", () => {
    expect(describePopup(withAck(state(), {}, { state: "invited", atChunk: "crv_x" as never }), watch).invite.state).toBe("invited");
    const v = describePopup(state({ lastError: "backend unreachable", uploadBacklog: 12 }), watch);
    expect(v.problem).toBe("Backend: backend unreachable (12 facts waiting)");
    expect(v.captions).toBe("Waiting for the backend");
  });

  test("facts the backend refused are shown with a count and the reason, never silent", () => {
    expect(describePopup(state(), watch).deadLetters).toBeNull();
    const v = describePopup(state({ deadLetters: { count: 2, latestReason: "transcript fact: backend rejected the batch (HTTP 400)" } }), watch);
    expect(v.deadLetters).toContain("2 facts were refused");
    expect(v.deadLetters).toContain("HTTP 400");
  });

  test("the toolbar badge flags an invite first, then capture state", () => {
    expect(badgeFor(null).text).toBe("");
    expect(badgeFor(state()).text).toBe("REC");
    expect(badgeFor(state({ state: "paused", pauseReason: "user" })).text).toBe("II");
    expect(badgeFor(withAck(state(), {}, { state: "invited", atChunk: "crv_x" as never })).text).toBe("!");
    expect(badgeFor(state({ state: "stopped" })).text).toBe("");
  });
});

const scratch: string[] = [];
const scratchDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("extension build", () => {
  test("bundles every entry, copies the manifest and pages, and the manifest's files all exist", async () => {
    const out = scratchDir("afterclass-build-");
    await buildExtension(out);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    for (const f of manifestFiles(manifest)) expect(existsSync(join(out, f))).toBe(true);
    for (const f of ["content.js", "main-world.js", "worker.js", "popup.js", "options.js"]) {
      const code = readFileSync(join(out, f), "utf8");
      expect(code).not.toMatch(/src\/backend\//);
      expect(code).not.toMatch(/from\s+"(node|bun):/);
    }
    expect(readFileSync(join(out, "content.js"), "utf8")).not.toMatch(/^\s*(import|export)\s/m);
    expect(manifest.host_permissions).toContain("https://www.youtube.com/*");
    expect(manifest.host_permissions).toContain("http://127.0.0.1:4317/*");
  });

  test("copying to a Windows path replaces a previous build but refuses an unrelated non-empty folder", () => {
    const from = scratchDir("afterclass-from-");
    writeFileSync(join(from, "manifest.json"), "{}");
    writeFileSync(join(from, "worker.js"), "new");
    const dest = scratchDir("afterclass-dest-");
    mkdirSync(join(dest, "old"));
    expect(() => copyBuild(from, dest)).toThrow(/refusing/);
    expect(existsSync(join(dest, "old"))).toBe(true);

    writeFileSync(join(dest, "manifest.json"), "{}");
    writeFileSync(join(dest, "stale.js"), "stale");
    copyBuild(from, dest);
    expect(existsSync(join(dest, "stale.js"))).toBe(false);
    expect(readFileSync(join(dest, "worker.js"), "utf8")).toBe("new");

    const fresh = join(scratchDir("afterclass-fresh-"), "ext");
    copyBuild(from, fresh);
    expect(existsSync(join(fresh, "manifest.json"))).toBe(true);
  });
});
