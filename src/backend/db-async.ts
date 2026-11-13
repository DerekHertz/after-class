/**
 * The asynchronous database interface, SQLite implementation.
 *
 * Phase 2 of the hosted move. Modules still use the synchronous `Db`/`UserDb` from db.ts and move to this interface one
 * PR at a time. `asAsync(db)` wraps the same connection, so both can exist in one suite.
 *
 * Rules the interface fixes now, so the PostgreSQL implementation (Bun.sql) drops in without reshaping callers:
 *
 * 1. Every statement of a transaction goes through the `Tx` handle that `tx` passes in. On PostgreSQL a transaction is
 *    bound to one pooled connection, and a statement on the pool instead of the handle either deadlocks the pool or
 *    runs outside the transaction. The handle is passed explicitly, not carried by AsyncLocalStorage, so a function
 *    that needs the transaction says so in its signature and the compiler rejects a call without one. The one
 *    AsyncLocalStorage use below is a tripwire for a nested `db.tx` call, not the carrier.
 * 2. While a transaction is open, a statement on the `AsyncDb` itself throws. On SQLite it would silently join the
 *    open transaction, which hides the bug until PostgreSQL runs it on another connection.
 * 3. A nested `t.tx` is a savepoint. A failed statement poisons the handle it ran on, as PostgreSQL does: later
 *    statements on that handle throw until a savepoint around it rolls back. A caller that wants to carry on after a
 *    failure wraps the statement in `t.tx`. A savepoint must be awaited before its parent settles.
 * 4. A handle is dead once its transaction ends, and so is every savepoint handle under it. A handle that has an open
 *    savepoint refuses statements itself.
 * 5. `nextSeq` exists only on `Tx`, so a Seq is always taken inside a transaction and rolls back with it.
 * 6. A transaction body awaits only database calls, never a timer, I/O or a model call, which on Postgres would hold a
 *    pooled connection. The SQLite implementation detects a violation on a best-effort basis with a macrotask marker
 *    and then rolls back and rejects at once. It does not isolate anything: other tasks can still run between two
 *    awaited database calls. On one SQLite connection that is made safe by refusal. While a transaction is open, any
 *    other use of the connection throws `ConnectionBusyError` (see `asAsync`), so a writer is never acknowledged and
 *    then rolled back.
 * 7. Every command starts with `withUserLock(userId, fn)` (or `lockUsers` inside a longer transaction). See `Tx.lockUsers`.
 *
 * Statements use `?` placeholders. The PostgreSQL implementation rewrites them to `$n`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Seq } from "../shared/domain";
import type { UserId } from "../shared/ids";
import { asSeq, connectionOf } from "./db";
import type { Db, Gate } from "./db";

export type Param = string | number | bigint | null | Uint8Array;

/** Statement methods shared by the connection and a transaction handle. */
export type Statements = {
  all<R>(sql: string, ...params: Param[]): Promise<R[]>;
  get<R>(sql: string, ...params: Param[]): Promise<R | null>;
  run(sql: string, ...params: Param[]): Promise<{ readonly changes: number }>;
};

export type Tx = Statements & {
  /** Monotonic across every fact table. Rolled back with its transaction, so a Seq is never handed out twice. */
  nextSeq(): Promise<Seq>;
  /**
   * Take the per-user command lock of each user, in ascending id order whatever order they are passed in, skipping
   * users this transaction already holds. Order holds across calls too: a user whose id is lower than one already
   * held is refused, because two transactions that lock the same users in different orders deadlock on Postgres.
   * A command that needs several users names them all in its first call.
   *
   * Contract, which the PostgreSQL implementation meets with `pg_advisory_xact_lock`:
   * - The lock is held until the outermost transaction commits or rolls back. Call it on the transaction's own handle,
   *   never inside a savepoint: whether PostgreSQL releases an advisory lock when a savepoint rolls back was not
   *   tested, so the SQLite implementation refuses it.
   * - While one transaction holds a user's lock, another transaction's `lockUsers` for that user waits. Locks of
   *   different users never wait on each other (SQLite has a single writer, so everything waits there).
   * - Take the lock before reading any state the command decides on. State read before the lock can be stale once
   *   the lock is granted.
   * - A command that works across users (`sweepExpired`) finds its candidate users, locks them all with one call,
   *   and then reads and deletes. It must not delete a user's rows without that user's lock.
   */
  lockUsers(...userIds: readonly UserId[]): Promise<void>;
  holdsUserLock(userId: UserId): boolean;
  /** The users this transaction has locked, in acquisition order, which is ascending. */
  heldUserLocks(): readonly UserId[];
  /** A savepoint. A throw rolls back to it and rethrows. */
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
};

export type AsyncDb = Statements & {
  /** One transaction. Transactions on one connection run one after another. Throws if called inside a transaction's own `fn`; use `t.tx`. */
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
  /** A transaction that takes `userId`'s command lock before `fn` runs. */
  withUserLock<T>(userId: UserId, fn: (t: Tx) => Promise<T>): Promise<T>;
  close(): void;
};

/** An `AsyncDb` bound to the user whose data the holder may touch. */
export type AsyncUserDb = AsyncDb & {
  readonly userId: UserId;
  /** `withUserLock` for this user. Every command calls it at its start. */
  command<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
};

export function scopeAsyncDb(db: AsyncDb, userId: UserId): AsyncUserDb {
  return { ...db, userId, command: (fn) => db.withUserLock(userId, fn) };
}

type Conn = Db["sql"];

/** State of one open transaction, shared by its handle and every savepoint handle under it. */
type Core = { dead: Error | null; expired: boolean; ended: boolean; handles: Set<SqliteTx>; locks: UserId[] };


const EXPIRED =
  "transaction body awaited something other than the database (a timer, I/O or another task), so it was rolled back; load what the command needs before the transaction";

class SqliteTx implements Tx {
  closed = false;
  private poisoned: Error | null = null;
  private child: SqliteTx | null = null;

  constructor(
    private readonly conn: Conn,
    private readonly gate: Gate,
    private readonly core: Core,
    private readonly parent: SqliteTx | null,
  ) {
    core.handles.add(this);
  }

  /** Throws when the transaction cannot commit: a rollback already happened, a savepoint is unfinished, or a failure was caught. */
  settle(): void {
    if (this.core.expired) throw new Error(EXPIRED);
    if (this.core.dead) throw new Error(`transaction was rolled back: ${this.core.dead.message}`);
    if (this.child) throw new Error("savepoint still running when its transaction handle settled; await every t.tx");
    if (this.poisoned) throw new Error(`transaction has a failed statement that was caught and ignored: ${this.poisoned.message}`);
  }

  private usable(): void {
    if (this.core.expired) throw new Error(EXPIRED);
    if (this.core.dead) throw new Error(`transaction was rolled back: ${this.core.dead.message}`);
    if (this.closed) throw new Error("transaction handle used after its transaction ended");
    if (this.child) throw new Error("statement on a handle that has an open savepoint; use the savepoint's handle");
    if (this.poisoned) throw new Error(`statement after a failed statement in the same transaction: ${this.poisoned.message}`);
  }

  private exec<R>(fn: () => R): R {
    this.usable();
    try {
      return fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.poisoned = err;
      // SQLite rolls the whole transaction back on some failures (OR ROLLBACK, disk errors). Nothing may autocommit after that.
      if (!this.conn.inTransaction) this.core.dead = err;
      throw error;
    }
  }

  async all<R>(sql: string, ...params: Param[]): Promise<R[]> {
    return this.exec(() => this.conn.query<R, Param[]>(sql).all(...params));
  }

  async get<R>(sql: string, ...params: Param[]): Promise<R | null> {
    return this.exec(() => this.conn.query<R, Param[]>(sql).get(...params) ?? null);
  }

  async run(sql: string, ...params: Param[]): Promise<{ readonly changes: number }> {
    return this.exec(() => ({ changes: this.conn.query(sql).run(...params).changes }));
  }

  async nextSeq(): Promise<Seq> {
    const row = await this.get<{ value: number }>("UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value");
    return asSeq(row!.value);
  }

  async lockUsers(...userIds: readonly UserId[]): Promise<void> {
    this.usable();
    if (this.parent) throw new Error("lockUsers inside a savepoint; take the lock on the transaction's own handle");
    const held = this.core.locks;
    for (const id of [...new Set(userIds)].sort()) {
      if (held.includes(id)) continue;
      const highest = held[held.length - 1];
      if (highest !== undefined && id < highest) {
        throw new Error(`lock order: ${id} is below ${highest}, which this transaction already holds; name every user in the first lockUsers call`);
      }
      held.push(id);
    }
  }

  holdsUserLock(userId: UserId): boolean {
    return this.core.locks.includes(userId);
  }

  heldUserLocks(): readonly UserId[] {
    return [...this.core.locks];
  }

  /** Kill this handle and, recursively, every savepoint handle running under it. */
  close(): void {
    this.closed = true;
    this.child?.close();
  }

  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    this.usable();
    const name = `sp_${++this.gate.savepoints}`;
    this.exec(() => this.conn.run(`SAVEPOINT ${name}`));
    const inner = new SqliteTx(this.conn, this.gate, this.core, this);
    this.child = inner;
    try {
      const value = await fn(inner);
      inner.settle();
      inner.close();
      this.child = null;
      this.exec(() => this.conn.run(`RELEASE ${name}`));
      return value;
    } catch (error) {
      inner.close();
      if (!this.closed && !this.core.ended && !this.core.dead && !this.core.expired) {
        try {
          this.conn.run(`ROLLBACK TO ${name}`);
          this.conn.run(`RELEASE ${name}`);
        } catch (cleanup) {
          // The savepoint is gone, so the transaction's state is unknown. Nothing in it may commit or autocommit.
          this.core.dead = cleanup instanceof Error ? cleanup : new Error(String(cleanup));
          this.poisoned = this.core.dead;
        }
      }
      throw error;
    } finally {
      this.child = null;
    }
  }
}

const inside = new AsyncLocalStorage<true>();

/**
 * Wrap a synchronous `Db`'s connection. Both interfaces share the connection and the Seq counter, and every wrapper of
 * one connection shares one transaction queue. While an async transaction is open, every use of the raw `db.sql` (and
 * of statements prepared from it), and the synchronous `tx` and `nextSeq`, throws `ConnectionBusyError`. An
 * interleaving writer therefore fails loudly and is never acknowledged and then rolled back.
 *
 * Mixing the two interfaces on one SQLite connection is NOT production-safe: a task that runs while a transaction
 * yields fails with `ConnectionBusyError` instead of waiting. It is only for the migration. Module conversions land
 * together, so no deployment runs a mix.
 */
export function asAsync(db: Db): AsyncDb {
  const { raw: conn, gate: g } = connectionOf(db.sql);

  const outside = <R>(fn: () => R): R => {
    if (g.open) throw new Error("statement issued outside the transaction handle while a transaction is open; use the handle passed to tx");
    return fn();
  };

  const transaction = async <T>(fn: (t: Tx) => Promise<T>): Promise<T> => {
    if (inside.getStore()) throw new Error("db.tx called inside a transaction; use the handle's t.tx for a savepoint");
    const prior = g.tail;
    let release!: () => void;
    g.tail = new Promise<void>((resolve) => (release = resolve));
    await prior;
    const core: Core = { dead: null, expired: false, ended: false, handles: new Set(), locks: [] };
    const t = new SqliteTx(conn, g, core, null);
    let marker: ReturnType<typeof setImmediate> | undefined;
    try {
      conn.run("BEGIN IMMEDIATE");
      g.open = core;
      // Best effort detector of a non-database await, not isolation. On expiry the transaction rejects and frees the
      // queue at once, whatever the body is still waiting for. The body's later statements throw.
      const expiry = new Promise<never>((_, reject) => {
        marker = setImmediate(() => {
          core.expired = true;
          if (conn.inTransaction) conn.run("ROLLBACK");
          g.open = null;
          reject(new Error(EXPIRED));
        });
      });
      try {
        const value = await Promise.race([inside.run(true, () => fn(t)), expiry]);
        t.settle();
        conn.run("COMMIT");
        return value;
      } catch (error) {
        if (conn.inTransaction) conn.run("ROLLBACK");
        throw error;
      }
    } finally {
      if (marker !== undefined) clearImmediate(marker);
      core.ended = true;
      for (const h of core.handles) h.closed = true;
      core.locks.length = 0;
      if (g.open === core) g.open = null;
      release();
    }
  };

  return {
    all: async (sql, ...params) => outside(() => conn.query<never, Param[]>(sql).all(...params)),
    get: async (sql, ...params) => outside(() => conn.query<never, Param[]>(sql).get(...params) ?? null),
    run: async (sql, ...params) => outside(() => ({ changes: conn.query(sql).run(...params).changes })),
    tx: transaction,
    withUserLock: (userId, fn) =>
      transaction(async (t) => {
        await t.lockUsers(userId);
        return fn(t);
      }),
    close: () => db.close(),
  };
}
