/**
 * The PostgreSQL kernel on Bun.sql: a pool, transactions with the handle passed in, savepoints, the per-user command
 * lock, per-user Seqs and the migration runner. src/MODULES.md ("PostgreSQL kernel") is the guide for module authors.
 *
 * Rules the types and the runtime enforce:
 * 1. Statements exist only on a transaction handle (`Tx`). `PgDb` has none, so nothing runs on the pool beside an
 *    open transaction, which on Bun.sql either deadlocks the pool or runs outside the transaction.
 * 2. A nested `t.tx` is a savepoint. A failed statement poisons its handle as PostgreSQL does: later statements on it
 *    throw, and a body that catches the failure and returns still rejects. Wrap a statement that may fail in `t.tx`.
 * 3. A handle is dead once its transaction or savepoint ends. A handle with an open savepoint refuses statements.
 * 4. `db.tx`, `db.command` or `db.read` called while the caller's own transaction is open throws instead of opening a
 *    second transaction on another connection (which would wait forever on the lock the first one holds).
 * 5. A transaction idle longer than `idleInTransactionMs` (it awaited something other than the database) is ended by
 *    the server, and its commit fails.
 *
 * Statements are tagged templates (t.all`SELECT ... WHERE id = ${id}`): every value is a bound parameter next to the
 * column it fills, so there is no placeholder to number or count, and no string building reaches the server.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import type { Seq } from "../shared/domain";
import type { UserId } from "../shared/ids";
import { asSeq, tableOwners } from "./db";
import { OWNERS } from "./migrations";
import type { Migration, Owner } from "./migrations";
import { PG_MIGRATIONS } from "./pg-schema";

/**
 * A bound value. An object or array is stored as jsonb; pass the value itself, never `JSON.stringify` of it, which
 * stores a JSON string. A JS string bound to a jsonb column is stored as a JSON string too.
 */
export type Param = string | number | boolean | null | object;
export type Row = Record<string, unknown>;

export type Tx = {
  /** Every row. `bigint` columns arrive as numbers; a value outside the safe integer range throws RangeError. */
  all<R = Row>(strings: TemplateStringsArray, ...values: readonly Param[]): Promise<R[]>;
  /** The first row, or null. */
  get<R = Row>(strings: TemplateStringsArray, ...values: readonly Param[]): Promise<R | null>;
  /** A statement for its effect. `changes` is the number of rows it inserted, updated or deleted. */
  run(strings: TemplateStringsArray, ...values: readonly Param[]): Promise<{ readonly changes: number }>;
  /**
   * The next Seq of `userId`, or of the one user this transaction has locked when omitted. Taken only under that
   * user's lock, so a user's Seqs commit in the order they were taken. Rolled back with its transaction or savepoint.
   */
  nextSeq(userId?: UserId): Promise<Seq>;
  /**
   * Take the command lock of each user, in ascending lock-key order whatever order they are passed in, skipping users
   * already held. Held until the transaction ends. A user whose key is below one already held is refused, because two
   * transactions that take the same locks in different orders deadlock; name every user in the first call. Refused
   * inside a savepoint and in a read transaction.
   */
  lockUsers(...userIds: readonly UserId[]): Promise<void>;
  holdsUserLock(userId: UserId): boolean;
  /** The users this transaction has locked, in acquisition order. */
  heldUserLocks(): readonly UserId[];
  /** A savepoint. A throw rolls back to it and rethrows; the outer transaction carries on. */
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
};

export type PgDb = {
  /** One transaction with no lock. A command uses `command`. */
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
  /** One transaction that takes `userId`'s command lock before `fn` runs. Every command starts here. */
  command<T>(userId: UserId, fn: (t: Tx) => Promise<T>): Promise<T>;
  /** One read-only transaction on a single snapshot (repeatable read). No lock, no Seq, no write. */
  read<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** A `PgDb` bound to the user whose data the holder may touch. */
export type UserPgDb = {
  readonly userId: UserId;
  command<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
  read<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
};

export type PgOptions = {
  /** Pool size. */
  readonly max?: number;
  /** The server ends a transaction left idle this long. */
  readonly idleInTransactionMs?: number;
  readonly migrations?: { readonly [O in Owner]: readonly Migration[] };
};

/** State of one open transaction, shared by its handle and every savepoint handle under it. */
type Core = { ended: boolean; readonly readOnly: boolean; readonly locks: { readonly userId: UserId; readonly key: bigint }[] };

const MIGRATION_LOCK = 7_240_001n;

/** The advisory lock key of a user: 64 bits of sha256, so two users share a key with negligible probability. */
function lockKey(userId: UserId): bigint {
  const digest = new Bun.CryptoHasher("sha256").update(`afterclass-user:${userId}`).digest();
  return BigInt.asIntN(64, new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0));
}

function toNumbers(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "bigint") {
      if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`column ${k}: ${v} is not a safe integer`);
      out[k] = Number(v);
    } else out[k] = v;
  }
  return out;
}

type Raw = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<Row[] & { count: number | null }>;
type RawTx = Raw & { savepoint<T>(fn: (sp: RawTx) => Promise<T>): Promise<T> };

class PgTx implements Tx {
  private closed = false;
  private poisoned: Error | null = null;
  private child: PgTx | "opening" | null = null;

  constructor(
    private readonly raw: RawTx,
    private readonly core: Core,
    private readonly parent: PgTx | null,
  ) {}

  /** Throws when this handle's work cannot commit: a savepoint is unfinished, or a failure was caught. */
  settle(): void {
    if (this.child) throw new Error("savepoint still running when its transaction handle settled; await every t.tx");
    if (this.poisoned) throw new Error(`transaction has a failed statement that was caught and ignored: ${this.poisoned.message}`);
  }

  close(): void {
    this.closed = true;
    if (this.child instanceof PgTx) this.child.close();
  }

  private usable(): void {
    if (this.closed || this.core.ended) throw new Error("transaction handle used after its transaction ended");
    if (this.child) throw new Error("statement on a handle that has an open savepoint; use the savepoint's handle");
    if (this.poisoned) throw new Error(`statement after a failed statement in the same transaction: ${this.poisoned.message}`);
  }

  private async exec(strings: TemplateStringsArray, values: readonly Param[]): Promise<Row[] & { count: number | null }> {
    this.usable();
    try {
      return await this.raw(strings, ...values);
    } catch (error) {
      this.poisoned = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  async all<R = Row>(strings: TemplateStringsArray, ...values: readonly Param[]): Promise<R[]> {
    return (await this.exec(strings, values)).map(toNumbers) as R[];
  }

  async get<R = Row>(strings: TemplateStringsArray, ...values: readonly Param[]): Promise<R | null> {
    const rows = await this.exec(strings, values);
    return rows.length > 0 ? (toNumbers(rows[0]!) as R) : null;
  }

  async run(strings: TemplateStringsArray, ...values: readonly Param[]): Promise<{ readonly changes: number }> {
    return { changes: (await this.exec(strings, values)).count ?? 0 };
  }

  async nextSeq(userId?: UserId): Promise<Seq> {
    this.usable();
    if (this.core.readOnly) throw new Error("nextSeq in a read transaction");
    const held = this.core.locks;
    const user = userId ?? (held.length === 1 ? held[0]!.userId : undefined);
    if (user === undefined) throw new Error(`nextSeq without a user: this transaction holds ${held.length} user locks; name the user`);
    if (!this.holdsUserLock(user)) throw new Error(`nextSeq for ${user} without its command lock`);
    const row = await this.get<{ value: number }>`
      INSERT INTO seq_counter (user_id, value) VALUES (${user}, 1)
      ON CONFLICT (user_id) DO UPDATE SET value = seq_counter.value + 1
      RETURNING value`;
    return asSeq(row!.value);
  }

  async lockUsers(...userIds: readonly UserId[]): Promise<void> {
    this.usable();
    if (this.parent) throw new Error("lockUsers inside a savepoint; take the lock on the transaction's own handle");
    if (this.core.readOnly) throw new Error("lockUsers in a read transaction; a command uses db.command");
    const held = this.core.locks;
    const wanted = [...new Set(userIds)]
      .filter((u) => !this.holdsUserLock(u))
      .map((userId) => ({ userId, key: lockKey(userId) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const highest = held[held.length - 1];
    if (highest && wanted[0] && wanted[0].key < highest.key) {
      throw new Error(`lock order: ${wanted[0].userId} sorts below ${highest.userId}, which this transaction already holds; name every user in the first lockUsers call`);
    }
    for (const w of wanted) {
      await this.run`SELECT pg_advisory_xact_lock(${w.key.toString()}::bigint)`;
      held.push(w);
    }
  }

  holdsUserLock(userId: UserId): boolean {
    return !this.core.ended && this.core.locks.some((l) => l.userId === userId);
  }

  heldUserLocks(): readonly UserId[] {
    return this.core.ended ? [] : this.core.locks.map((l) => l.userId);
  }

  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    this.usable();
    this.child = "opening";
    let inner: PgTx | null = null;
    let thrown: { error: unknown } | null = null;
    try {
      return await this.raw.savepoint(async (sp) => {
        inner = new PgTx(sp, this.core, this);
        this.child = inner;
        try {
          const value = await fn(inner);
          inner.settle();
          return value;
        } catch (error) {
          thrown = { error };
          throw error;
        } finally {
          inner.close();
        }
      });
    } catch (error) {
      // The savepoint's own BEGIN, RELEASE or ROLLBACK TO failed, so the transaction's state is unknown: nothing more may run.
      if (thrown === null || (thrown as { error: unknown }).error !== error) this.poisoned = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      this.child = null;
    }
  }
}

/** The open transaction of the current async context, so a nested `db.tx` is refused instead of waiting on itself. */
const inside = new AsyncLocalStorage<Core>();

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Connect and apply pending migrations in owner order, all in one transaction under a migration lock, so two servers
 * starting at once apply each migration once. Refuses a migration whose text changed after it was applied.
 */
export async function openPgDb(url: string, opts: PgOptions = {}): Promise<PgDb> {
  const migrations = opts.migrations ?? PG_MIGRATIONS;
  tableOwners(migrations);
  const sql = new SQL({
    url,
    max: opts.max ?? 10,
    bigint: true,
    connection: { idle_in_transaction_session_timeout: opts.idleInTransactionMs ?? 10_000 },
  });

  try {
    await sql.begin(async (t) => {
      await t`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK.toString()}::bigint)`;
      await t`CREATE TABLE IF NOT EXISTS schema_migrations (
        owner text COLLATE "C" NOT NULL, id text COLLATE "C" NOT NULL, sha256 text COLLATE "C" NOT NULL, applied_ms bigint NOT NULL,
        PRIMARY KEY (owner, id))`;
      for (const owner of OWNERS) {
        for (const m of migrations[owner]) {
          const hash = sha256(m.sql);
          const [prior] = await t<{ sha256: string }[]>`SELECT sha256 FROM schema_migrations WHERE owner = ${owner} AND id = ${m.id}`;
          if (prior) {
            if (prior.sha256 !== hash) throw new Error(`migration ${owner}/${m.id} changed after it was applied; append a new migration instead`);
            continue;
          }
          await t.unsafe(m.sql);
          await t`INSERT INTO schema_migrations (owner, id, sha256, applied_ms) VALUES (${owner}, ${m.id}, ${hash}, ${Date.now()})`;
        }
      }
    });
  } catch (error) {
    await sql.close();
    throw error;
  }

  const transaction = <T>(mode: string, readOnly: boolean, fn: (t: Tx) => Promise<T>): Promise<T> => {
    const open = inside.getStore();
    if (open && !open.ended) return Promise.reject(new Error("db.tx called inside a transaction; pass the handle, or use t.tx for a savepoint"));
    const core: Core = { ended: false, readOnly, locks: [] };
    return sql.begin(mode, (raw) =>
      inside.run(core, async () => {
        const t = new PgTx(raw as unknown as RawTx, core, null);
        try {
          const value = await fn(t);
          t.settle();
          return value;
        } finally {
          t.close();
          core.ended = true;
        }
      }),
    ) as Promise<T>;
  };

  return {
    tx: (fn) => transaction("read write", false, fn),
    command: (userId, fn) =>
      transaction("read write", false, async (t) => {
        await t.lockUsers(userId);
        return fn(t);
      }),
    read: (fn) => transaction("isolation level repeatable read read only", true, fn),
    close: () => sql.close(),
  };
}

/** Insert the user if absent. Idempotent. */
export async function ensurePgUser(db: PgDb, userId: UserId, createdMs: number): Promise<void> {
  await db.tx((t) => t.run`INSERT INTO users (id, created_ms) VALUES (${userId}, ${createdMs}) ON CONFLICT (id) DO NOTHING`);
}

/** Bind the database to a user that has a `users` row. */
export async function scopePgDb(db: PgDb, userId: UserId): Promise<UserPgDb> {
  const known = await db.read((t) => t.get`SELECT id FROM users WHERE id = ${userId}`);
  if (!known) throw new Error(`scopePgDb: no such user ${userId}`);
  return { userId, command: (fn) => db.command(userId, fn), read: (fn) => db.read(fn) };
}
