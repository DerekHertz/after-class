/**
 * Unsent learner turns, kept until the backend echoes `learner_turn_stored`.
 * A turn keeps its app-minted id here, so a resend after a crash or a dropped
 * connection is the same request (R15 for turns).
 *
 * IndexedDB can be missing, blocked or full (private windows, cleared site
 * data). Every operation is wrapped: on failure the store falls back to memory
 * for the rest of the page's life, and the learner's typing is never lost to
 * a storage error.
 */
import type { LearnerAct } from "../shared/domain";
import type { ReviewId, TurnId } from "../shared/ids";

export type UnsentTurn = {
  readonly turnId: TurnId;
  readonly reviewId: ReviewId;
  readonly act: LearnerAct;
  readonly createdAtMs: number;
};

export interface UnsentStore {
  put(turn: UnsentTurn): Promise<void>;
  remove(turnId: TurnId): Promise<void>;
  /** Oldest first. */
  forReview(reviewId: ReviewId): Promise<readonly UnsentTurn[]>;
  /** True once IndexedDB failed and the store is memory-only (lost on reload). */
  readonly degraded: boolean;
}

export function createMemoryUnsent(): UnsentStore {
  const turns = new Map<TurnId, UnsentTurn>();
  return {
    degraded: false,
    async put(t) {
      turns.set(t.turnId, t);
    },
    async remove(id) {
      turns.delete(id);
    },
    async forReview(reviewId) {
      return [...turns.values()].filter((t) => t.reviewId === reviewId).sort((a, b) => a.createdAtMs - b.createdAtMs);
    },
  };
}

const DB_NAME = "afterclass-app";
const STORE = "unsent_turns";

const OPEN_TIMEOUT_MS = 3000;

function timeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    work.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** Resolves on the transaction's `complete`: a request's `success` only means the write is queued, and an abort after it (quota) would be missed. */
function settle<T>(tx: IDBTransaction, r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = () => reject(tx.error ?? r.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE, { keyPath: "turnId" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
    open.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/** Reading `indexedDB` itself throws in some contexts (storage blocked, sandboxed frames). */
function browserIdb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch {
    return undefined;
  }
}

export function createIndexedDbUnsent(idb: IDBFactory | undefined = browserIdb(), timeoutMs: number = OPEN_TIMEOUT_MS): UnsentStore {
  const memory = createMemoryUnsent();
  let degraded = idb === undefined;
  let db: Promise<IDBDatabase> | null = null;

  /** Runs one request against the store; null means IndexedDB failed and the caller should use memory. */
  async function run(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest): Promise<{ readonly value: unknown } | null> {
    if (degraded || idb === undefined) return null;
    try {
      if (db === null) {
        const opening = openDatabase(idb);
        db = timeout(opening, timeoutMs, "opening IndexedDB");
        // A blocked open that finally succeeds after we gave up must not keep the database connection.
        db.catch(() => opening.then((late) => late.close(), () => {}));
      }
      const handle = await db;
      const tx = handle.transaction(STORE, mode);
      return { value: await timeout(settle(tx, make(tx.objectStore(STORE))), timeoutMs, "an IndexedDB transaction") };
    } catch {
      degraded = true;
      return null;
    }
  }

  // Memory mirrors every accepted write, so falling back mid-session loses nothing already accepted.
  return {
    get degraded() {
      return degraded;
    },
    async put(t) {
      await memory.put(t);
      await run("readwrite", (s) => s.put(t));
    },
    async remove(id) {
      await memory.remove(id);
      await run("readwrite", (s) => s.delete(id));
    },
    async forReview(reviewId) {
      const res = await run("readonly", (s) => s.getAll());
      if (res === null) return memory.forReview(reviewId);
      const rows = (res.value as UnsentTurn[]).filter((t) => t.reviewId === reviewId);
      return rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
    },
  };
}
