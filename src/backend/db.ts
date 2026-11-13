/**
 * bun:sqlite connection, the global fact sequence and the migration runner.
 *
 * The schema is in migrations.ts, one append-only array per owning module.
 * db.ts runs it, reads table ownership from it (`tableOwners`) and re-exports
 * its names.
 *
 * Single process, synchronous bun:sqlite, WAL: every command is one `tx`, so
 * writers serialize without locks. Nested `tx` calls become savepoints.
 */
import { Database, Statement } from "bun:sqlite";
import type { Seq } from "../shared/domain";
import { stableId } from "../shared/ids";
import type { UserId } from "../shared/ids";
import { MIGRATIONS, OWNERS } from "./migrations";
import type { Owner } from "./migrations";

export { MIGRATIONS, OWNERS } from "./migrations";
export type { Migration, Owner } from "./migrations";

export type Db = {
  readonly sql: Database;
  /** Monotonic across every fact table. Rolled back with its transaction, so a Seq is never handed out twice. */
  nextSeq(): Seq;
  tx<T>(fn: () => T): T;
  close(): void;
};

/** A `Db` bound to the user whose data the holder may touch. Modules move from `Db` to `UserDb` one at a time. */
export type UserDb = Db & { readonly userId: UserId };

/** Only the db mints Seqs; rows read back carry them as plain integers. */
export function asSeq(n: number): Seq {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`asSeq: ${n}`);
  return n as Seq;
}


export type TableScope = "user" | "shared" | "identity";

/**
 * Whether a table's rows belong to one user. Every table must appear here (test/db.test.ts), so a new table has to
 * pick a side. "user" tables get a `user_id` column in the Phase 1 PRs, one per owning module, and the boundary test
 * for them follows. "shared" tables hold lecture-derived or process-wide rows. "identity" is `users` itself.
 */
export const TABLE_SCOPES: { readonly [table: string]: TableScope } = {
  users: "identity",
  seq_counter: "shared", // becomes a per-user sequence row in the Postgres phase
  schema_migrations: "shared",
  // The memo mixes lecture-derived rows with tutor_turn and wrap_up rows that hold a learner's answers, dialogue and notes,
  // so it is per-user until the budget phase moves lecture-only purposes into a separate shared cache.
  memo_inputs: "user",
  memo: "user",
  memo_failures: "user",
  usage_events: "user",
  voice_usage_events: "user",
  capture_facts: "user",
  frames: "user",
  evidence_snapshots: "user",
  evidence_deletions: "user",
  capture_owners: "user",
  chunk_revisions: "user",
  claim_index: "user",
  concept_index: "user", // content-derived, but carries a per-pipeline seq
  prep_controls: "user",
  prep_inputs: "user",
  invite_answers: "user",
  reviews: "user",
  review_turns: "user",
  notes: "user",
  note_edits: "user",
  note_deletions: "user",
  note_evidence: "user",
  observations: "user",
  observation_decisions: "user",
  link_suggestions: "user",
  link_decisions: "user",
  saved_reviews: "user",
  save_failures: "user",
};

/** The local app's only user. Derived, so every boot on every machine names it the same. */
export const LOCAL_USER: UserId = stableId("usr", "local");

/** Insert the local user if absent and return its id. Idempotent. A hosted deployment maps its accounts to rows instead. */
export function ensureLocalUser(db: Db): UserId {
  db.sql.query("INSERT OR IGNORE INTO users (id, created_ms) VALUES (?, ?)").run(LOCAL_USER, Date.now());
  return LOCAL_USER;
}

/** Bind a handle to a user that has a `users` row. The handle shares the connection and the Seq counter. */
export function scopeDb(db: Db, userId: UserId): UserDb {
  const known = db.sql.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get(userId);
  if (!known) throw new Error(`scopeDb: no such user ${userId}`);
  return { sql: db.sql, nextSeq: () => db.nextSeq(), tx: (fn) => db.tx(fn), close: () => db.close(), userId };
}

/** Table name → owning module, read from the CREATE TABLE statements above. */
export function tableOwners(migrations: typeof MIGRATIONS = MIGRATIONS): ReadonlyMap<string, Owner> {
  const owners = new Map<string, Owner>();
  for (const owner of OWNERS) {
    for (const m of migrations[owner]) {
      for (const match of m.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) {
        const table = match[1]!;
        const prior = owners.get(table);
        if (prior && prior !== owner) throw new Error(`table ${table} declared by both ${prior} and ${owner}`);
        owners.set(table, owner);
      }
    }
  }
  owners.set("schema_migrations", "kernel");
  return owners;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Open (or create) the database and apply pending migrations in owner order.
 * `path` is a file path or ":memory:" for tests.
 */
export function openDb(path: string, migrations: typeof MIGRATIONS = MIGRATIONS): Db {
  const sql = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") sql.run("PRAGMA journal_mode = WAL");
  sql.run("PRAGMA foreign_keys = ON");
  sql.run("PRAGMA busy_timeout = 5000");

  sql.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    owner TEXT NOT NULL, id TEXT NOT NULL, sha256 TEXT NOT NULL, applied_ms INTEGER NOT NULL,
    PRIMARY KEY (owner, id)) STRICT`);
  const applied = sql.query<{ sha256: string }, [string, string]>("SELECT sha256 FROM schema_migrations WHERE owner = ? AND id = ?");
  const record = sql.query("INSERT INTO schema_migrations (owner, id, sha256, applied_ms) VALUES (?, ?, ?, ?)");

  tableOwners(migrations);
  for (const owner of OWNERS) {
    for (const m of migrations[owner]) {
      const hash = sha256(m.sql);
      const prior = applied.get(owner, m.id);
      if (prior) {
        if (prior.sha256 !== hash) throw new Error(`migration ${owner}/${m.id} changed after it was applied; append a new migration instead`);
        continue;
      }
      sql.transaction(() => {
        sql.run(m.sql);
        record.run(owner, m.id, hash, Date.now());
      })();
    }
  }

  const bump = sql.query<{ value: number }, []>("UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value");
  const gate: Gate = { open: null, tail: Promise.resolve(), savepoints: 0 };
  const guarded = guardObject(sql, () => refuseDuringAsyncTx(gate, "db.sql"));
  connections.set(guarded, { raw: sql, gate });
  return {
    sql: guarded,
    nextSeq: () => {
      refuseDuringAsyncTx(gate, "nextSeq");
      return asSeq(bump.get()!.value);
    },
    tx: <T>(fn: () => T): T => {
      refuseDuringAsyncTx(gate, "tx");
      return sql.transaction(fn)();
    },
    close: () => sql.close(),
  };
}

/**
 * State of one connection's asynchronous transactions (db-async.ts). `open` is set while one is open.
 * `tail` queues the next one.
 */
export type Gate = { open: object | null; tail: Promise<void>; savepoints: number };

/** Thrown by any raw access to a connection while an asynchronous transaction is open on it. */
export class ConnectionBusyError extends Error {
  override name = "ConnectionBusyError";
}

/** The unguarded connection and gate behind a `Db.sql`, for db-async.ts only. */
const connections = new WeakMap<object, { readonly raw: Database; readonly gate: Gate }>();
export function connectionOf(sql: Database): { readonly raw: Database; readonly gate: Gate } {
  const found = connections.get(sql);
  if (!found) throw new Error("connectionOf: not a Db.sql");
  return found;
}

function refuseDuringAsyncTx(gate: Gate, what: string): void {
  if (gate.open) {
    throw new ConnectionBusyError(`${what} used while an asynchronous transaction is open on this connection; use the transaction's handle, or wait until it ends`);
  }
}

/**
 * A view of the connection whose every method, and every statement it hands out, throws while an asynchronous
 * transaction is open. On one SQLite connection a task that runs while such a transaction yields would otherwise join
 * it, be acknowledged and then be rolled back with it. The transaction's own handle uses the unguarded connection.
 */
function guardObject<T extends object>(target: T, check: () => void, cache = new WeakMap<object, object>()): T {
  return new Proxy(target, {
    get(t, p) {
      const value = Reflect.get(t, p, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        check();
        const result = value.apply(t, args);
        if (result instanceof Statement) {
          let wrapped = cache.get(result);
          if (!wrapped) cache.set(result, (wrapped = guardObject(result, check, cache)));
          return wrapped;
        }
        if (typeof result === "function") return (...inner: unknown[]) => (check(), result(...inner));
        return result;
      };
    },
  });
}
