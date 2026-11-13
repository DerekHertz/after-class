import type { ReactNode } from "react";
import { isValidElement } from "react";
import type { Api } from "../src/app/api";
import { createReviewController } from "../src/app/controller";
import { reviewViewz } from "../src/app/decode";
import type { Speaker } from "../src/app/speech";
import { createMemoryUnsent } from "../src/app/unsent";
import type { LearnerAct, ReviewView, TurnEvent } from "../src/shared/domain";
import type { TurnId } from "../src/shared/ids";
import { randomId, stableId } from "../src/shared/ids";

// ───────────────────────────── Fixtures ─────────────────────────────────────

export const captureId = randomId("cap");

export const reviewId = randomId("rvw");

export const src = stableId("src", "yt", "QgWz_s7uugE");

export const crv = stableId("crv", "chunk-1");

export const clm = stableId("clm", "claim-1");

export const thr = stableId("thr", "thread-1");

export const ev1 = stableId("ev", "passage-1");

export const ev2 = stableId("ev", "frame-1");

export const cpt = stableId("cpt", "concept-1");

export const canonicalMaterial = [[src, [[0, 120], [300, 420]]]];

export const gapJson = { sourceId: src, interval: { start: 120, end: 180 }, channel: "frames", reason: "hidden_tab" };

export const claimJson = (status: string) => ({
  id: clm, sourceChunkId: stableId("chk", "c"), conceptId: cpt,
  original: { text: "A clock tick orders events.", evidence: [ev1], visualDependent: false, assumptions: [] },
  originalCheck: null, revision: null, revisionCheck: null, status,
});

export const READY = { kind: "ready", scope: { chunkRevisions: [crv], supportedClaims: 4, topics: [], material: [[src, [[0, 120]]]], partial: [] } };

export function turnJson(n: number, actor: "learner" | "tutor" | "code", rest: Record<string, unknown>) {
  return { id: actor === "learner" ? stableId("turn", `l${n}`) : stableId("turn", `${actor}${n}`), reviewId, seq: n, atMs: n * 1000, threadId: actor === "code" ? null : thr, actor, ...rest };
}

export function reviewJson(overrides: { turns?: unknown[]; phase?: string; saved?: string; detour?: unknown; observations?: unknown[]; owesMove?: boolean } = {}) {
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

export const parsedReview = (o: Parameters<typeof reviewJson>[0] = {}): ReviewView => reviewViewz.parse(reviewJson(o));

export const tutorAsk = turnJson(1, "tutor", { move: { kind: "ask_main", threadId: thr, claimIds: [clm] }, say: "What does a logical clock give you?" });

export const learnerAnswer = (n = 2) => turnJson(n, "learner", { act: { kind: "answer", text: "An ordering of events.", modality: "speech" } });

/** Every element in a rendered tree, found without a DOM by walking props.children. */
export function findElements(node: ReactNode, match: (e: { type: unknown; props: unknown }) => boolean): { type: unknown; props: unknown }[] {
  if (Array.isArray(node)) return node.flatMap((n) => findElements(n, match));
  if (!isValidElement(node)) return [];
  const el = node as { type: unknown; props: { children?: ReactNode } };
  return [...(match(el) ? [el] : []), ...findElements(el.props.children, match)];
}

export const enc = new TextEncoder();

export const line = (e: TurnEvent) => `${JSON.stringify(e)}\n`;

export function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

export const tid = (s: string) => stableId("turn", s);

export const stored = (s: string): TurnEvent => ({ type: "learner_turn_stored", turnId: tid(s) });

export const complete = (s: string): TurnEvent => ({ type: "turn_complete", turnId: tid(s) });

export const sentence = (text: string): TurnEvent => ({ type: "sentence", text });

// ───────────────────────────── Api client ───────────────────────────────────

type Call = { readonly url: string; readonly method: string; readonly headers: Headers; readonly body: unknown };

export function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
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

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type FakeTx = { oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; error: unknown };

/**
 * An IndexedDB whose open and transactions the test releases by hand, unless `autoComplete` completes each transaction
 * after its request. Requests succeed on the next tick, as in a browser. Each database name has its own rows.
 */
export function fakeIdb(opts: { opens?: boolean; autoComplete?: boolean } = {}) {
  const dbs = new Map<string, Map<string, unknown>>();
  const rowsOf = (name: string) => dbs.get(name) ?? dbs.set(name, new Map()).get(name)!;
  const txs: FakeTx[] = [];
  const connection = (name: string) => ({
    close() {},
    transaction() {
      const rows = rowsOf(name);
      const tx: FakeTx = { oncomplete: null, onerror: null, onabort: null, error: null };
      txs.push(tx);
      const request = <T,>(result: T, apply: () => void) => {
        const r: { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = { result, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          apply();
          r.onsuccess?.();
          if (opts.autoComplete) tx.oncomplete?.();
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
  });
  type Request = { result: unknown; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded: (() => void) | null; onblocked: (() => void) | null };
  const factory = {
    open(name: string) {
      const r: Request = { result: { ...connection(name), createObjectStore() {} }, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      if (opts.opens !== false) queueMicrotask(() => (rowsOf(name), r.onsuccess?.()));
      return r;
    },
    deleteDatabase(name: string) {
      const r: Request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => (dbs.delete(name), r.onsuccess?.()));
      return r;
    },
    databases: async () => [...dbs.keys()].map((name) => ({ name, version: 1 })),
  } as unknown as IDBFactory;
  return {
    factory, dbs, txs,
    /** The local app's database. */
    get rows() {
      return rowsOf("afterclass-app");
    },
    complete: (i = txs.length - 1) => txs[i]!.oncomplete?.(),
    abort: (i = txs.length - 1) => { txs[i]!.error = new Error("QuotaExceededError"); txs[i]!.onabort?.(); },
  };
}

// ───────────────────────────── Session controller ───────────────────────────

type SendCall = { readonly turnId: TurnId; readonly act: LearnerAct };

export function setup(opts: {
  sendTurn: (call: SendCall, n: number) => AsyncIterable<TurnEvent>;
  review?: () => ReviewView;
  save?: () => ReturnType<Api["save"]>;
  /** Holds every `review` call until it settles, so a test can stop a turn between its stream and its refresh. */
  reviewGate?: Promise<void>;
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
    review: async () => (reviews++, await opts.reviewGate, opts.review ? opts.review() : parsedReview()),
    save: async () => (saves++, opts.save ? opts.save() : { kind: "saved", notes: 1, observations: 1, links: 0 }),
    record: async () => { throw new Error("unused"); },
    usage: async () => { throw new Error("unused"); },
  };
  const controller = createReviewController({ api, reviewId, speaker, unsent, nowMs: () => 1000 });
  return { controller, unsent, sends, spoken, stops: () => stops, saves: () => saves, reviews: () => reviews };
}

export async function* events(...list: TurnEvent[]): AsyncGenerator<TurnEvent> {
  for (const e of list) yield e;
}

export const answer: LearnerAct = { kind: "answer", text: "An ordering of events.", modality: "speech" };
