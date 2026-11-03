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
}

export const toWire = (f: StoredFact): WireFact => ({ ...f.body, clientSeq: f.clientSeq, wallMs: f.wallMs });

// ───────────────────────────── Stores ───────────────────────────────────────

export function createMemoryOutbox(): OutboxStore {
  const facts = new Map<CaptureId, StoredFact[]>();
  const next = new Map<CaptureId, number>();
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
  };
}

const done = <T>(req: IDBRequest<T>) => new Promise<T>((res, rej) => ((req.onsuccess = () => res(req.result)), (req.onerror = () => rej(req.error))));
const txDone = (tx: IDBTransaction) => new Promise<void>((res, rej) => ((tx.oncomplete = () => res()), (tx.onerror = tx.onabort = () => rej(tx.error))));

/** Facts keyed [captureId, clientSeq]; `seq` holds the next clientSeq per capture. */
export function createIdbOutbox(factory: IDBFactory = indexedDB, name = "afterclass-outbox"): OutboxStore {
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("facts", { keyPath: ["captureId", "clientSeq"] });
      req.result.createObjectStore("seq", { keyPath: "captureId" });
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

export type TransportResult = { readonly ok: true; readonly ack: IngestAck } | { readonly ok: false; readonly retryable: boolean; readonly error: string };
export type Transport = (captureId: CaptureId, facts: readonly WireFact[]) => Promise<TransportResult>;

export function isIngestAck(v: unknown): v is IngestAck {
  const a = v as Partial<IngestAck> | null;
  return !!a && typeof a === "object" && Number.isInteger(a.ackedThroughSeq) && typeof a.invite === "object" && a.invite !== null && typeof a.capture === "object" && a.capture !== null;
}

/** Auth and validation failures need a human or a fix; outages and overload are retried. */
export function classifyStatus(status: number): { readonly retryable: boolean; readonly error: string } {
  if (status === 401 || status === 403) return { retryable: false, error: `pairing token rejected (HTTP ${status}): check the token in After Class options` };
  if (status === 408 || status === 429 || status >= 500) return { retryable: true, error: `backend error (HTTP ${status})` };
  return { retryable: false, error: `backend rejected the batch (HTTP ${status})` };
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
  for (let first = true; ; first = false) {
    const batch = selectBatch(await store.pending(captureId, BATCH_MAX_FACTS));
    if (batch.length === 0 && !(first && opts.heartbeat)) break;
    const result = await transport(captureId, batch.map(toWire));
    if (!result.ok) return { ack, error: result.error, retryable: result.retryable, remaining: await store.backlog(captureId) };
    ack = result.ack;
    if (batch.length === 0) break;
    if (ack.ackedThroughSeq < batch[0]!.clientSeq) {
      return { ack, error: "backend did not acknowledge the batch", retryable: true, remaining: await store.backlog(captureId) };
    }
    await store.ackThrough(captureId, ack.ackedThroughSeq);
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
