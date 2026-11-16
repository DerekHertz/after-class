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
   * Atomically records a refusal diagnostic and replaces the original with
   * `placeholder` at the same clientSeq, so the backend's
   * contiguous ack is never blocked by a hole.
   */
  quarantine(captureId: CaptureId, fact: StoredFact, placeholder: CaptureFactBody, reason: string): Promise<void>;
  /** Payload-free diagnostics for a capture, oldest first. */
  deadLetters(captureId: CaptureId): Promise<readonly DeadFact[]>;
}

export type DeadFact = Pick<StoredFact, "captureId" | "clientSeq"> & { readonly reason: string };

/** Older servers can echo a rejected value in their response, so keep only a recognized status. */
function refusal(reason: string): string {
  const status = /^backend rejected the batch \(HTTP (400|413|422)\)/.exec(reason)?.[1];
  return status ? `backend rejected the batch (HTTP ${status})` : "backend rejected the batch";
}

function diagnostic(fact: StoredFact, reason: string): DeadFact {
  return { captureId: fact.captureId, clientSeq: fact.clientSeq, reason: `${fact.body.kind} fact: ${refusal(reason)}` };
}

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
    detail: `${WITHHELD}: the backend refused this ${b.kind} fact (${refusal(reason)})`,
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
      dead.set(captureId, [...(dead.get(captureId) ?? []), diagnostic(fact, reason)]);
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
    const req = factory.open(name, 3);
    req.onupgradeneeded = (event) => {
      const have = req.result.objectStoreNames;
      if (!have.contains("facts")) req.result.createObjectStore("facts", { keyPath: ["captureId", "clientSeq"] });
      if (!have.contains("seq")) req.result.createObjectStore("seq", { keyPath: "captureId" });
      if (!have.contains("dead")) req.result.createObjectStore("dead", { keyPath: ["captureId", "clientSeq"] });
      if (event.oldVersion === 2) {
        const tx = req.transaction!;
        const cursor = tx.objectStore("dead").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const old = row.value as StoredFact & { reason: string };
          const prefix = `${old.body.kind} fact: `;
          const why = old.reason.startsWith(prefix) ? old.reason.slice(prefix.length) : "";
          row.update(diagnostic(old, why));
          // An unacknowledged v2 placeholder can also carry the old server response.
          const facts = tx.objectStore("facts");
          const pending = facts.get(row.primaryKey);
          pending.onsuccess = () => {
            const fact = pending.result as StoredFact | undefined;
            if (fact && isPlaceholder(fact.body)) facts.put({ ...fact, body: placeholderFor(old, why) });
            row.continue();
          };
        };
      }
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
      tx.objectStore("dead").put(diagnostic(fact, reason));
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
export const BATCH_MAX_BYTES = 4 * 1024 * 1024;

function approxBytes(f: StoredFact): number {
  const b = f.body;
  if (b.kind === "frame") return b.jpegBase64.length + 512;
  if (b.kind === "transcript") return b.segments.reduce((n, s) => n + s.text.length + 64, 512);
  return 512;
}

/** ≤ 500 facts and ≤ 4 MiB (frames counted by bytes); always at least one, so an oversized frame still goes alone. */
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
export type TransportResult =
  | { readonly ok: true; readonly ack: IngestAck }
  | { readonly ok: false; readonly retryable: boolean; readonly error: string; readonly rejected?: boolean; readonly waitMs?: number };
export type Transport = (captureId: CaptureId, facts: readonly WireFact[]) => Promise<TransportResult>;

export function isIngestAck(v: unknown): v is IngestAck {
  const a = v as Partial<IngestAck> | null;
  return !!a && typeof a === "object" && Number.isInteger(a.ackedThroughSeq) && typeof a.invite === "object" && a.invite !== null && typeof a.capture === "object" && a.capture !== null;
}

/** How long a 507 holds uploads. Freed space or a raised quota is rare, so one try per window is plenty. */
export const QUOTA_RETRY_MS = 15 * 60_000;
/** The longest a server's Retry-After may park uploads, so a bad header cannot silence a capture for good. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** A Retry-After in whole seconds, as the backend sends it. Anything else (a date, junk) is no instruction. */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined || !/^\d{1,7}$/.test(header.trim())) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Number(header.trim()) * 1000);
}

type Classified = { readonly retryable: boolean; readonly error: string; readonly rejected?: boolean; readonly waitMs?: number };

/** Auth and validation failures need a human or a fix; outages and overload are retried. `waitMs` is how long every upload waits. */
export function classifyStatus(status: number, retryAfter?: string | null): Classified {
  if (status === 401 || status === 403) return { retryable: false, error: `pairing token rejected (HTTP ${status}): check the token in After Class options` };
  // The account is over its storage limit. Retrying cannot help, so the facts stay in the outbox and the popup says why.
  if (status === 507) return { retryable: false, error: "storage limit reached on the server, so this capture is not being saved", waitMs: QUOTA_RETRY_MS };
  if (status === 503) {
    const waitMs = parseRetryAfter(retryAfter);
    return { retryable: true, error: `backend error (HTTP ${status})`, ...(waitMs === undefined ? {} : { waitMs }) };
  }
  if (status === 408 || status === 429 || status >= 500) return { retryable: true, error: `backend error (HTTP ${status})` };
  return { retryable: false, error: `backend rejected the batch (HTTP ${status})`, rejected: status === 400 || status === 413 || status === 422 };
}

/** Why a capture's uploads wait, and until when. Every flush trigger reads it, so a worker restart does not lose it. */
export type Gate = { readonly untilMs: number; readonly error: string; readonly retryable: boolean };
export interface GateStore {
  read(captureId: CaptureId): Promise<Gate | null>;
  write(captureId: CaptureId, gate: Gate | null): Promise<void>;
}
export function createMemoryGates(): GateStore {
  const m = new Map<CaptureId, Gate>();
  return { read: async (c) => m.get(c) ?? null, write: async (c, g) => void (g === null ? m.delete(c) : m.set(c, g)) };
}

// ───────────────────────────── Flush ────────────────────────────────────────

export type FlushOutcome = {
  readonly ack: IngestAck | null;
  readonly error: string | null;
  readonly retryable: boolean;
  readonly remaining: number;
  /** Set when the backend asked every upload to wait this long (507, or 503 with Retry-After). */
  readonly waitMs?: number;
};

/**
 * Sends batches until the outbox is empty or one fails. With `heartbeat`, an
 * empty outbox still sends an empty batch so the ack (invite, capture view)
 * refreshes while nothing is being captured.
 */
export async function flushCapture(store: OutboxStore, transport: Transport, captureId: CaptureId, opts: { readonly heartbeat?: boolean } = {}): Promise<FlushOutcome> {
  let ack: IngestAck | null = null;
  type Failure = { readonly error: string; readonly retryable: boolean; readonly rejected: boolean; readonly waitMs?: number };
  const failed = async (f: Failure): Promise<FlushOutcome> => ({ ack, error: f.error, retryable: f.retryable, remaining: await store.backlog(captureId), ...(f.waitMs === undefined ? {} : { waitMs: f.waitMs }) });

  /** Sends one batch and removes what the backend confirms. Null means delivered. */
  async function send(batch: readonly StoredFact[]): Promise<Failure | null> {
    const result = await transport(captureId, batch.map(toWire));
    if (!result.ok) return { error: result.error, retryable: result.retryable, rejected: result.rejected === true, ...(result.waitMs === undefined ? {} : { waitMs: result.waitMs }) };
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
      await store.quarantine(captureId, fact, placeholder, why);
      const sent = await send([{ ...fact, body: placeholder }]);
      // A failure fact stays open until the channel's next ok, flagging every later span. One lost fact is not a
      // broken channel, so close it at the tail; a transcript stays failed because it is still missing.
      if (sent === null && placeholder.kind === "channel" && placeholder.channel !== "transcript") {
        await store.append(captureId, { ...placeholder, health: "ok", videoId: null, atMediaS: null, detail: `${WITHHELD}: one fact was withheld, the channel is otherwise working` }, Date.now());
      }
      return sent;
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
  /** Single-flight per capture: a call during a flush asks for one more pass and shares its result. While the capture's gate is shut it sends nothing and answers with the gate's error. */
  flush(captureId: CaptureId, opts?: { readonly heartbeat?: boolean }): Promise<FlushOutcome>;
  /** Opens the capture's gate: the learner resumed the capture, so the next flush tries the backend. */
  release(captureId: CaptureId): Promise<void>;
};

export function createFlusher(deps: {
  readonly store: OutboxStore;
  readonly transport: Transport;
  readonly schedule: (fn: () => void, ms: number) => void;
  readonly onOutcome: (captureId: CaptureId, outcome: FlushOutcome) => void;
  readonly gates?: GateStore;
  readonly now?: () => number;
}): Flusher {
  const gates = deps.gates ?? createMemoryGates();
  const now = deps.now ?? Date.now;
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
      const gate = await gates.read(captureId);
      if (gate !== null && now() < gate.untilMs) {
        const held: FlushOutcome = { ack: null, error: gate.error, retryable: gate.retryable, remaining: await deps.store.backlog(captureId) };
        deps.onOutcome(captureId, held);
        return held;
      }
      let outcome = await flushCapture(deps.store, deps.transport, captureId, opts);
      while (outcome.error === null && again.delete(captureId)) outcome = await flushCapture(deps.store, deps.transport, captureId, opts);
      if (outcome.error === null) {
        failures.delete(captureId);
        if (gate !== null) await gates.write(captureId, null);
      } else {
        const attempt = failures.get(captureId) ?? 0;
        const backoff = outcome.retryable ? nextBackoffMs(attempt) : 0;
        const waitMs = Math.max(backoff, outcome.waitMs ?? 0);
        // Only a wait the backend asked for shuts the gate. An outage's own backoff stays a timer, so a status poll can still see it end.
        if (outcome.waitMs !== undefined) await gates.write(captureId, { untilMs: now() + waitMs, error: outcome.error, retryable: outcome.retryable });
        if (outcome.retryable && !retryQueued.has(captureId)) {
          failures.set(captureId, attempt + 1);
          retryQueued.add(captureId);
          deps.schedule(() => {
            retryQueued.delete(captureId);
            void flush(captureId);
          }, waitMs);
        }
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
  return { flush, release: (captureId) => gates.write(captureId, null) };
}
