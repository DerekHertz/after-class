/**
 * Unsent learner turns, kept until the backend echoes `learner_turn_stored`.
 * A turn keeps its app-minted id here, so a resend after a crash or a dropped
 * connection is the same request (R15 for turns).
 *
 * IndexedDB can be missing, blocked or full (private windows, cleared site
 * data). Every operation is wrapped: on failure the store falls back to memory
 * for the rest of the page's life, and the learner's typing is never lost to
 * a storage error.
 *
 * The local app keeps one database. Hosted, each signed-in account has its own, closed when the account signs out and
 * then deleted with every other account's, so a shared computer holds only the signed-in account's unsent turns.
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

/** The local app's one database. */
export const LOCAL_UNSENT_DB = "afterclass-app";
const ACCOUNT_PREFIX = `${LOCAL_UNSENT_DB}.`;
/** Hosted, each signed-in account keeps its unsent turns in its own database, so no account's store can read another's. */
export const accountUnsentDb = (userId: string): string => `${ACCOUNT_PREFIX}${userId}`;
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

function openDatabase(idb: IDBFactory, name: string, onDeleted: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = idb.open(name, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE, { keyPath: "turnId" });
    };
    open.onsuccess = () => {
      // Another tab is deleting this database because its account signed out. Let go of it and keep this page in memory.
      open.result.onversionchange = () => {
        open.result.close();
        onDeleted();
      };
      resolve(open.result);
    };
    open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
    open.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/** Reading `indexedDB` itself throws in some contexts (storage blocked, sandboxed frames). */
export function browserIdb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch {
    return undefined;
  }
}

export type ClosableUnsentStore = UnsentStore & {
  /** The account signed out: forget the turns held in memory, let go of the database, and ignore every later call. */
  close(): void;
};

export function createIndexedDbUnsent(
  idb: IDBFactory | undefined = browserIdb(),
  timeoutMs: number = OPEN_TIMEOUT_MS,
  name: string = LOCAL_UNSENT_DB,
): ClosableUnsentStore {
  let memory = createMemoryUnsent();
  let degraded = idb === undefined;
  let closed = false;
  let db: Promise<IDBDatabase> | null = null;

  /** Runs one request against the store; null means IndexedDB failed and the caller should use memory. */
  async function run(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest): Promise<{ readonly value: unknown } | null> {
    if (closed || degraded || idb === undefined) return null;
    try {
      if (db === null) {
        const opening = openDatabase(idb, name, () => void (degraded = true));
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
      if (closed) return;
      await memory.put(t);
      await run("readwrite", (s) => s.put(t));
    },
    async remove(id) {
      if (closed) return;
      await memory.remove(id);
      await run("readwrite", (s) => s.delete(id));
    },
    async forReview(reviewId) {
      const res = await run("readonly", (s) => s.getAll());
      if (closed) return [];
      if (res === null) return memory.forReview(reviewId);
      const rows = (res.value as UnsentTurn[]).filter((t) => t.reviewId === reviewId);
      return rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
    },
    close() {
      closed = true;
      memory = createMemoryUnsent();
      db?.then((handle) => handle.close(), () => {});
    },
  };
}

/** Settles once the delete succeeds, fails, or is blocked by an open connection. A blocked delete still finishes when that connection closes. */
function deleteDatabase(idb: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = idb.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Deletes the unsent turns of every account in this browser except the signed-in one's, so a shared computer holds
 * only the signed-in account's drafts. `signedIn` is read after the databases are listed, not when the cleanup starts:
 * a cleanup that began before someone signed in must not delete that person's new drafts. `left` is deleted even
 * where the browser cannot list its databases.
 */
export async function clearOtherAccounts(idb: IDBFactory | undefined, signedIn: () => string | null, left: string | null): Promise<void> {
  if (idb === undefined) return;
  const listed = await Promise.resolve()
    .then(() => idb.databases())
    .then((dbs) => dbs.map((d) => d.name ?? ""), () => []);
  const names = new Set([...listed, ...(left === null ? [] : [accountUnsentDb(left)])]);
  const keep = signedIn();
  const kept = keep === null ? null : accountUnsentDb(keep);
  await Promise.all([...names].filter((n) => n.startsWith(ACCOUNT_PREFIX) && n !== kept).map((n) => deleteDatabase(idb, n)));
}
