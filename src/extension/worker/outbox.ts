/**
 * Durable outbox and upload loop (W2). The store is an interface so the loop is
 * tested against a memory store; the IndexedDB store is the production one.
 *
 * Idempotency: a fact's identity is (captureId, clientSeq), assigned once at
 * append. A resend after a lost ack carries the same identities, and the backend
 * stores each at most once. Facts leave the outbox only through the backend's
 * ack high-water mark, never on a send.
 */
import type { CaptureId } from "../../shared/ids";
import type { CaptureFactBody } from "../../shared/domain";
import type { IngestAck } from "../../shared/wire";

export type StoredFact = { readonly captureId: CaptureId; readonly clientSeq: number; readonly wallMs: number; readonly body: CaptureFactBody };
/** The wire shape of one fact: the body plus its sequence. The batch carries the captureId. */
export type WireFact = CaptureFactBody & { readonly clientSeq: number; readonly wallMs: number };

export interface OutboxStore {
  /** Atomically assigns the next clientSeq for the capture and persists the fact. */
  append(captureId: CaptureId, body: CaptureFactBody, wallMs: number): Promise<StoredFact>;
  /** Unacked facts in clientSeq order. */
  pending(captureId: CaptureId, limit: number): Promise<readonly StoredFact[]>;
  /** Deletes every fact with clientSeq ≤ seq. Idempotent. */
  ackThrough(captureId: CaptureId, seq: number): Promise<void>;
  backlog(captureId: CaptureId): Promise<number>;
  /** Captures that still hold unacked facts. */
  captureIds(): Promise<readonly CaptureId[]>;
  /**
   * Atomically sets a fact the backend refuses aside: the original (with the reason) goes to the
   * dead-letter store and `placeholder` takes its place at the same clientSeq, so the backend's
   * contiguous ack is never blocked by a hole.
   */
  quarantine(captureId: CaptureId, fact: StoredFact, placeholder: CaptureFactBody, reason: string): Promise<void>;
  /** Everything set aside for a capture, oldest first. Kept until a human looks; never deleted by an ack. */
  deadLetters(captureId: CaptureId): Promise<readonly DeadFact[]>;
}

export type DeadFact = StoredFact & { readonly reason: string; readonly atMs: number };

const VIDEO_ID = /^[\w-]{11}$/;
/** Marks a placeholder, so a refused placeholder is never set aside again. */
export const WITHHELD = "withheld by the extension";

export const isPlaceholder = (b: CaptureFactBody): boolean => b.kind === "channel" && b.detail.startsWith(WITHHELD);

/**
 * What the backend sees in place of a refused fact: a channel failure at the same clientSeq,
 * so the evidence side logs a gap for it instead of silently missing it.
 */
export function placeholderFor(fact: StoredFact, reason: string): CaptureFactBody {
  const b = fact.body;
  const channel = b.kind === "transcript" || b.kind === "transcript_unavailable" ? "transcript" : b.kind === "frame" ? "frames" : "playback";
  const videoId = "videoId" in b && typeof b.videoId === "string" && VIDEO_ID.test(b.videoId) ? b.videoId : null;
  const at = b.kind === "span" ? b.start : b.kind === "frame" ? b.mediaS : b.kind === "ad" ? b.atContentS : null;
  return {
    kind: "channel",
    channel,
    health: "failed",
    videoId,
    atMediaS: at !== null && Number.isFinite(at) && at >= 0 ? at : null,
    detail: `${WITHHELD}: the backend refused this ${b.kind} fact (${reason})`.slice(0, 500),
  };
}

export const toWire = (f: StoredFact): WireFact => ({ ...f.body, clientSeq: f.clientSeq, wallMs: f.wallMs });

// ───────────────────────────── Stores ───────────────────────────────────────

export function createMemoryOutbox(): OutboxStore {
  const facts = new Map<CaptureId, StoredFact[]>();
  const next = new Map<CaptureId, number>();
  const dead = new Map<CaptureId, DeadFact[]>();
  return {
    async append(captureId, body, wallMs) {
      const clientSeq = next.get(captureId) ?? 0;
      next.set(captureId, clientSeq + 1);
      const fact = { captureId, clientSeq, wallMs, body };
      facts.set(captureId, [...(facts.get(captureId) ?? []), fact]);
      return fact;
    },
    async pending(captureId, limit) {
      return (facts.get(captureId) ?? []).slice(0, limit);
    },
    async ackThrough(captureId, seq) {
      facts.set(captureId, (facts.get(captureId) ?? []).filter((f) => f.clientSeq > seq));
    },
    async backlog(captureId) {
      return facts.get(captureId)?.length ?? 0;
    },
    async captureIds() {
      return [...facts].filter(([, v]) => v.length > 0).map(([k]) => k);
    },
    async quarantine(captureId, fact, placeholder, reason) {
      facts.set(captureId, (facts.get(captureId) ?? []).map((f) => (f.clientSeq === fact.clientSeq ? { ...f, body: placeholder } : f)));
      dead.set(captureId, [...(dead.get(captureId) ?? []), { ...fact, reason, atMs: Date.now() }]);
    },
    async deadLetters(captureId) {
      return dead.get(captureId) ?? [];
    },
  };
}

const done = <T>(req: IDBRequest<T>) => new Promise<T>((res, rej) => ((req.onsuccess = () => res(req.result)), (req.onerror = () => rej(req.error))));
const txDone = (tx: IDBTransaction) => new Promise<void>((res, rej) => ((tx.oncomplete = () => res()), (tx.onerror = tx.onabort = () => rej(tx.error))));

/** Facts keyed [captureId, clientSeq]; `seq` holds the next clientSeq per capture; `dead` the facts the backend refused. */
export function createIdbOutbox(factory: IDBFactory = indexedDB, name = "afterclass-outbox"): OutboxStore {
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(name, 2);
    req.onupgradeneeded = () => {
      const have = req.result.objectStoreNames;
      if (!have.contains("facts")) req.result.createObjectStore("facts", { keyPath: ["captureId", "clientSeq"] });
      if (!have.contains("seq")) req.result.createObjectStore("seq", { keyPath: "captureId" });
      if (!have.contains("dead")) req.result.createObjectStore("dead", { keyPath: ["captureId", "clientSeq"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const range = (captureId: CaptureId, from: number, to: number) => IDBKeyRange.bound([captureId, from], [captureId, to]);

  return {
    async append(captureId, body, wallMs) {
      const db = await opened;
      const tx = db.transaction(["facts", "seq"], "readwrite");
      const seqStore = tx.objectStore("seq");
      const clientSeq = ((await done(seqStore.get(captureId))) as { next: number } | undefined)?.next ?? 0;
      const fact: StoredFact = { captureId, clientSeq, wallMs, body };
      tx.objectStore("facts").put(fact);
      seqStore.put({ captureId, next: clientSeq + 1 });
      await txDone(tx);
      return fact;
    },
    async pending(captureId, limit) {
      const db = await opened;
      return done(db.transaction("facts").objectStore("facts").getAll(range(captureId, 0, Number.MAX_SAFE_INTEGER), limit));
    },
    async ackThrough(captureId, seq) {
      const db = await opened;
      const tx = db.transaction("facts", "readwrite");
      tx.objectStore("facts").delete(range(captureId, 0, seq));
      await txDone(tx);
    },
    async backlog(captureId) {
      const db = await opened;
      return done(db.transaction("facts").objectStore("facts").count(range(captureId, 0, Number.MAX_SAFE_INTEGER)));
    },
    async captureIds() {
      const db = await opened;
      const keys = (await done(db.transaction("facts").objectStore("facts").getAllKeys())) as unknown as [CaptureId, number][];
      return [...new Set(keys.map((k) => k[0]))];
    },
    async quarantine(captureId, fact, placeholder, reason) {
      const db = await opened;
      const tx = db.transaction(["facts", "dead"], "readwrite");
      tx.objectStore("facts").put({ ...fact, body: placeholder });
      tx.objectStore("dead").put({ ...fact, reason, atMs: Date.now() } satisfies DeadFact);
      await txDone(tx);
    },
    async deadLetters(captureId) {
      const db = await opened;
      return done(db.transaction("dead").objectStore("dead").getAll(range(captureId, 0, Number.MAX_SAFE_INTEGER)));
    },
  };
}

// ───────────────────────────── Batching ─────────────────────────────────────

export const BATCH_MAX_FACTS = 500;
export const BATCH_MAX_BYTES = 8 * 1024 * 1024;

function approxBytes(f: StoredFact): number {
  const b = f.body;
  if (b.kind === "frame") return b.jpegBase64.length + 512;
  if (b.kind === "transcript") return b.segments.reduce((n, s) => n + s.text.length + 64, 512);
  return 512;
}

/** ≤ 500 facts and ≤ 8 MiB (frames counted by bytes); always at least one, so an oversized frame still goes alone. */
export function selectBatch(facts: readonly StoredFact[]): readonly StoredFact[] {
  const out: StoredFact[] = [];
  let bytes = 0;
  for (const f of facts) {
    const size = approxBytes(f);
    if (out.length > 0 && (out.length >= BATCH_MAX_FACTS || bytes + size > BATCH_MAX_BYTES)) break;
    out.push(f);
    bytes += size;
  }
  return out;
}

/** 1 s doubling to a 30 s cap. */
export function nextBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

// ───────────────────────────── Transport contract ───────────────────────────

/** `rejected`: the backend refused the batch's content (not its auth or availability), so some fact in it is the problem. */
export type TransportResult = { readonly ok: true; readonly ack: IngestAck } | { readonly ok: false; readonly retryable: boolean; readonly error: string; readonly rejected?: boolean };
export type Transport = (captureId: CaptureId, facts: readonly WireFact[]) => Promise<TransportResult>;

export function isIngestAck(v: unknown): v is IngestAck {
  const a = v as Partial<IngestAck> | null;
  return !!a && typeof a === "object" && Number.isInteger(a.ackedThroughSeq) && typeof a.invite === "object" && a.invite !== null && typeof a.capture === "object" && a.capture !== null;
}

/** Auth and validation failures need a human or a fix; outages and overload are retried. */
export function classifyStatus(status: number): { readonly retryable: boolean; readonly error: string; readonly rejected?: boolean } {
  if (status === 401 || status === 403) return { retryable: false, error: `pairing token rejected (HTTP ${status}): check the token in After Class options` };
  if (status === 408 || status === 429 || status >= 500) return { retryable: true, error: `backend error (HTTP ${status})` };
  return { retryable: false, error: `backend rejected the batch (HTTP ${status})`, rejected: status === 400 || status === 413 || status === 422 };
}

// ───────────────────────────── Flush ────────────────────────────────────────

export type FlushOutcome = {
  readonly ack: IngestAck | null;
  readonly error: string | null;
  readonly retryable: boolean;
  readonly remaining: number;
};

/**
 * Sends batches until the outbox is empty or one fails. With `heartbeat`, an
 * empty outbox still sends an empty batch so the ack (invite, capture view)
 * refreshes while nothing is being captured.
 */
export async function flushCapture(store: OutboxStore, transport: Transport, captureId: CaptureId, opts: { readonly heartbeat?: boolean } = {}): Promise<FlushOutcome> {
  let ack: IngestAck | null = null;
  type Failure = { readonly error: string; readonly retryable: boolean; readonly rejected: boolean };
  const failed = async (f: Failure): Promise<FlushOutcome> => ({ ack, error: f.error, retryable: f.retryable, remaining: await store.backlog(captureId) });

  /** Sends one batch and removes what the backend confirms. Null means delivered. */
  async function send(batch: readonly StoredFact[]): Promise<Failure | null> {
    const result = await transport(captureId, batch.map(toWire));
    if (!result.ok) return { error: result.error, retryable: result.retryable, rejected: result.rejected === true };
    ack = result.ack;
    if (batch.length === 0) return null;
    // An ack past the batch would delete facts appended while it was in flight, so it counts only up to what was sent.
    const through = Math.min(result.ack.ackedThroughSeq, batch[batch.length - 1]!.clientSeq);
    if (through < batch[0]!.clientSeq) return { error: "backend did not acknowledge the batch", retryable: true, rejected: false };
    await store.ackThrough(captureId, through);
    return null;
  }

  /**
   * `batch` was refused as a whole. Halves are sent in order, so every good fact is delivered
   * before the next is tried and the backend's contiguous ack keeps moving. A single refused
   * fact is set aside and its placeholder is sent in its place.
   */
  async function isolate(batch: readonly StoredFact[], why: string): Promise<Failure | null> {
    if (batch.length === 1) {
      const fact = batch[0]!;
      if (fact.body.kind === "control" || isPlaceholder(fact.body)) {
        return { error: `backend refuses a ${fact.body.kind === "control" ? "control fact" : "placeholder"} that cannot be set aside`, retryable: false, rejected: true };
      }
      const placeholder = placeholderFor(fact, why);
      await store.quarantine(captureId, fact, placeholder, `${fact.body.kind} fact: ${why}`);
      return send([{ ...fact, body: placeholder }]);
    }
    const mid = Math.ceil(batch.length / 2);
    for (const half of [batch.slice(0, mid), batch.slice(mid)]) {
      const f = await send(half);
      if (f === null) continue;
      if (!f.rejected) return f;
      const inner = await isolate(half, f.error);
      if (inner !== null) return inner;
    }
    return null;
  }

  for (let first = true; ; first = false) {
    const batch = selectBatch(await store.pending(captureId, BATCH_MAX_FACTS));
    if (batch.length === 0 && !(first && opts.heartbeat)) break;
    const f = await send(batch);
    if (f === null) {
      if (batch.length === 0) break;
      continue;
    }
    if (!f.rejected || batch.length === 0) return failed(f);
    const inner = await isolate(batch, f.error);
    if (inner !== null) return failed(inner);
  }
  return { ack, error: null, retryable: false, remaining: await store.backlog(captureId) };
}

export type Flusher = {
  /** Single-flight per capture: a call during a flush asks for one more pass and shares its result. */
  flush(captureId: CaptureId, opts?: { readonly heartbeat?: boolean }): Promise<FlushOutcome>;
};

export function createFlusher(deps: {
  readonly store: OutboxStore;
  readonly transport: Transport;
  readonly schedule: (fn: () => void, ms: number) => void;
  readonly onOutcome: (captureId: CaptureId, outcome: FlushOutcome) => void;
}): Flusher {
  const running = new Map<CaptureId, Promise<FlushOutcome>>();
  const again = new Set<CaptureId>();
  const failures = new Map<CaptureId, number>();
  const retryQueued = new Set<CaptureId>();

  function flush(captureId: CaptureId, opts: { readonly heartbeat?: boolean } = {}): Promise<FlushOutcome> {
    const current = running.get(captureId);
    if (current) {
      again.add(captureId);
      return current;
    }
    const run = (async () => {
      let outcome = await flushCapture(deps.store, deps.transport, captureId, opts);
      while (outcome.error === null && again.delete(captureId)) outcome = await flushCapture(deps.store, deps.transport, captureId, opts);
      if (outcome.error === null) {
        failures.delete(captureId);
      } else if (outcome.retryable && !retryQueued.has(captureId)) {
        const attempt = failures.get(captureId) ?? 0;
        failures.set(captureId, attempt + 1);
        retryQueued.add(captureId);
        deps.schedule(() => {
          retryQueued.delete(captureId);
          void flush(captureId);
        }, nextBackoffMs(attempt));
      }
      deps.onOutcome(captureId, outcome);
      return outcome;
    })().finally(() => {
      running.delete(captureId);
      again.delete(captureId);
    });
    running.set(captureId, run);
    return run;
  }
  return { flush };
}
