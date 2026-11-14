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
import { Database } from "bun:sqlite";
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
  // A user's connected browsers and connect codes. Looked up by token or code hash to find the user, so not through a UserDb.
  devices: "user",
  connect_codes: "user",
  seq_counter: "shared", // becomes a per-user sequence row in the Postgres phase
  schema_migrations: "shared",
  // The memo mixes lecture-derived rows with tutor_turn and wrap_up rows that hold a learner's answers, dialogue and notes,
  // so it is per-user until the budget phase moves lecture-only purposes into a separate shared cache.
  memo_inputs: "user",
  memo: "user",
  memo_failures: "user",
  usage_events: "user",
  voice_usage_events: "user",
  // Per user, though the monthly total sums every user's rows: that sum is the only read across users.
  budget_holds: "user",
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
  tutor_cache: "user",
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

/** Who signed in, as the sign-in provider names them. `subject` is the provider's user id. */
export type Identity = { readonly provider: "clerk"; readonly subject: string };

/**
 * The user row for a signed-in identity, created on its first sign-in. Idempotent: the unique index on
 * (auth_provider, auth_subject) makes a second insert for the same identity a no-op, so concurrent first sign-ins
 * converge on one row. The id is random, so it reveals nothing about the provider's subject.
 */
export function userForIdentity(db: Db, identity: Identity): UserId {
  const find = db.sql.query<{ id: UserId }, [string, string]>("SELECT id FROM users WHERE auth_provider = ? AND auth_subject = ?");
  return db.tx(() => {
    const known = find.get(identity.provider, identity.subject);
    if (known) return known.id;
    const id = stableId("usr", identity.provider, crypto.randomUUID());
    db.sql
      .query("INSERT INTO users (id, created_ms, auth_provider, auth_subject) VALUES (?, ?, ?, ?) ON CONFLICT (auth_provider, auth_subject) DO NOTHING")
      .run(id, Date.now(), identity.provider, identity.subject);
    return find.get(identity.provider, identity.subject)!.id;
  });
}

/** Every user who has signed in through a provider. Hosted mode builds their modules at boot so their work resumes. */
export function signedInUsers(db: Db): UserId[] {
  return db.sql.query<{ id: UserId }, []>("SELECT id FROM users WHERE auth_provider IS NOT NULL ORDER BY created_ms, id").all().map((r) => r.id);
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
  return {
    sql,
    nextSeq: () => asSeq(bump.get()!.value),
    tx: <T>(fn: () => T): T => sql.transaction(fn)(),
    close: () => sql.close(),
  };
}
