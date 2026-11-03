/**
 * bun:sqlite connection, global fact sequence, migration runner.
 *
 * Table ownership: each module declares its own DDL and is the only module that
 * writes its tables (no split ownership). This file only collects and runs them.
 * test/boundaries.test.ts fails the build if a module's SQL names another
 * module's table in an INSERT/UPDATE/DELETE.
 *
 * Single process, synchronous bun:sqlite, WAL mode: every command is one
 * `db.transaction(...)`, so writers serialize without locks.
 */
import { Database } from "bun:sqlite";
import type { Seq } from "../shared/domain";

export type Db = {
  readonly sql: Database;
  /** Monotonic across ALL fact tables. Cancellation and late-result rules compare Seqs. */
  nextSeq(): Seq;
  tx<T>(fn: () => T): T;
};

export type ModuleSchema = { readonly module: string; readonly version: number; readonly ddl: readonly string[] };

/** Open `<dataDir>/afterclass.sqlite`, PRAGMA journal_mode=WAL, foreign_keys=ON, run schemas. */
export function openDb(dataDir: string, schemas: readonly ModuleSchema[]): Db {
  // TODO: schema_versions(module, version); apply ddl for modules whose version advanced.
  //       nextSeq: in-memory counter initialised from `SELECT max(seq) FROM seq_floor` and
  //       persisted by each fact insert (every fact table has a `seq INTEGER NOT NULL UNIQUE`).
  throw new Error("not implemented");
}
