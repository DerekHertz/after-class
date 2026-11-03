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

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
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

export function createIndexedDbUnsent(idb: IDBFactory | undefined = globalThis.indexedDB): UnsentStore {
  const memory = createMemoryUnsent();
  let degraded = idb === undefined;
  let db: Promise<IDBDatabase> | null = null;

  /** Runs one request against the store; null means IndexedDB failed and the caller should use memory. */
  async function run(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest): Promise<{ readonly value: unknown } | null> {
    if (degraded || idb === undefined) return null;
    try {
      db ??= openDatabase(idb);
      const handle = await db;
      return { value: await request(make(handle.transaction(STORE, mode).objectStore(STORE))) };
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
