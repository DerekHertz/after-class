// store/db.ts -- the ONLY file that imports bun:sqlite (test/architecture.test.ts enforces it).
//
// Pragmas (pseudocode): journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000.
// All repos share one connection (Bun is single-threaded; WAL gives readers a stable view).
// `tx` nests via SAVEPOINTs, so a repo method may call another repo's method inside one outer
// transaction (e.g. commitRecord -> evidence.cite) and the whole thing commits or rolls back together.
import type { Database } from "bun:sqlite";
import type { Clock } from "../../shared/core/clock";

export interface Db {
  readonly raw: Database; // repos only; never re-exported from store/index.ts
  tx<T>(fn: () => T): T;
  readonly clock: Clock;
  close(): void;
}

export interface Migration {
  readonly id: string;       // "capture-001"; ordering is lexicographic within owner, then by owner order in store/index.ts
  readonly owner: string;    // repo name; each repo ships its own migrations (no shared schema.ts to conflict on)
  readonly sql: string;
}

export function openDb(path: string, clock: Clock): Db {
  throw new Error("not implemented");
}

/** applies unapplied migrations in one tx each; records (owner,id) in `_migrations`; refuses to start if a recorded id has changed text. */
export function migrate(db: Db, migrations: readonly Migration[]): void {
  throw new Error("not implemented");
}
