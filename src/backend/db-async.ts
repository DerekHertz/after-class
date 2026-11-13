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
 *    failure wraps the statement in `t.tx`.
 * 4. A handle is dead once its transaction ends, and a handle that has an open savepoint refuses statements itself.
 * 5. `nextSeq` exists only on `Tx`, so a Seq is always taken inside a transaction and rolls back with it.
 * 6. Every command starts with `withUserLock(userId, fn)` (or `lockUsers` inside a longer transaction). See `Tx.lockUsers`.
 *
 * Statements use `?` placeholders. The PostgreSQL implementation rewrites them to `$n`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Seq } from "../shared/domain";
import type { UserId } from "../shared/ids";
import { asSeq } from "./db";
import type { Db } from "./db";

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
   * Take the per-user command lock of each user, in ascending id order whatever order they are passed in (two
   * transactions that lock overlapping sets cannot deadlock), skipping users this transaction already holds.
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

/** Shared state of one connection: which transaction is open and the queue behind it. */
type Gate = { open: SqliteTx | null; tail: Promise<void>; savepoints: number };

class SqliteTx implements Tx {
  private closed = false;
  private poisoned: Error | null = null;
  private child: SqliteTx | null = null;
  private readonly locks: Set<UserId>;

  constructor(
    private readonly conn: Conn,
    private readonly gate: Gate,
    private readonly parent: SqliteTx | null,
  ) {
    this.locks = parent ? parent.locks : new Set();
  }

  /** PostgreSQL refuses to commit or release a transaction that has a failed statement, even if the code caught the error. */
  settle(): void {
    if (this.poisoned) throw new Error(`transaction has a failed statement that was caught and ignored: ${this.poisoned.message}`);
  }

  private usable(): void {
    if (this.closed) throw new Error("transaction handle used after its transaction ended");
    if (this.child) throw new Error("statement on a handle that has an open savepoint; use the savepoint's handle");
    if (this.poisoned) throw new Error(`statement after a failed statement in the same transaction: ${this.poisoned.message}`);
  }

  private exec<R>(fn: () => R): R {
    this.usable();
    try {
      return fn();
    } catch (error) {
      this.poisoned = error instanceof Error ? error : new Error(String(error));
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
    for (const id of [...new Set(userIds)].sort()) this.locks.add(id);
  }

  holdsUserLock(userId: UserId): boolean {
    return this.locks.has(userId);
  }

  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    this.usable();
    const name = `sp_${++this.gate.savepoints}`;
    this.conn.run(`SAVEPOINT ${name}`);
    const inner = new SqliteTx(this.conn, this.gate, this);
    this.child = inner;
    try {
      const value = await fn(inner);
      inner.settle();
      inner.closed = true;
      this.conn.run(`RELEASE ${name}`);
      return value;
    } catch (error) {
      inner.closed = true;
      this.conn.run(`ROLLBACK TO ${name}`);
      this.conn.run(`RELEASE ${name}`);
      throw error;
    } finally {
      this.child = null;
    }
  }

  /** Called by the connection when the outermost transaction ends. */
  end(): void {
    this.closed = true;
    this.locks.clear();
  }
}

const inside = new AsyncLocalStorage<true>();

/**
 * Wrap a synchronous `Db`'s connection. Both interfaces share the connection and the Seq counter. While an async
 * transaction is open, do not call the synchronous `db.tx` or `db.sql` on the same `Db`: they cannot be told apart
 * from the handle and would join the transaction. That coexistence lasts only until the last module has moved.
 */
export function asAsync(db: Db): AsyncDb {
  const conn = db.sql;
  const gate: Gate = { open: null, tail: Promise.resolve(), savepoints: 0 };

  const outside = <R>(fn: () => R): R => {
    if (gate.open) throw new Error("statement issued outside the transaction handle while a transaction is open; use the handle passed to tx");
    return fn();
  };

  const transaction = async <T>(fn: (t: Tx) => Promise<T>): Promise<T> => {
    if (inside.getStore()) throw new Error("db.tx called inside a transaction; use the handle's t.tx for a savepoint");
    const prior = gate.tail;
    let release!: () => void;
    gate.tail = new Promise<void>((resolve) => (release = resolve));
    await prior;
    const t = new SqliteTx(conn, gate, null);
    try {
      conn.run("BEGIN IMMEDIATE");
      gate.open = t;
      try {
        const value = await inside.run(true, () => fn(t));
        t.settle();
        conn.run("COMMIT");
        return value;
      } catch (error) {
        conn.run("ROLLBACK");
        throw error;
      }
    } finally {
      t.end();
      gate.open = null;
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
