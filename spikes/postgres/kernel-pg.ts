/**
 * The kernel of src/backend/db.ts rewritten on Bun.sql: migration runner with hashes, table ownership, nextSeq.
 * Same behaviour as `openDb`, asynchronous. Scratch code, not a proposal for the final `Db` interface.
 */
import { SQL } from "bun";
import { OWNERS, asSeq, tableOwners } from "../../src/backend/db";
import type { Migration, Owner } from "../../src/backend/db";
import type { Seq } from "../../src/shared/domain";

export type Tx = SQL;
export type PgDb = {
  readonly sql: SQL;
  readonly url: string;
  /** Takes the transaction handle because a Postgres transaction is bound to one connection. */
  nextSeq(t: Tx): Promise<Seq>;
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** Arbitrary constant. One lock for the whole migration run, so two starting servers never interleave migrations. */
const MIGRATION_LOCK = 7_240_001;

export async function openPgDb(
  url: string,
  migrations: { readonly [O in Owner]: readonly Migration[] },
  opts: { max?: number } = {},
): Promise<PgDb> {
  const sql = new SQL({ url, max: opts.max ?? 5 });
  tableOwners(migrations);

  await sql.begin(async (t) => {
    await t`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await t.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (
      owner TEXT NOT NULL, id TEXT NOT NULL, sha256 TEXT NOT NULL, applied_ms BIGINT NOT NULL,
      PRIMARY KEY (owner, id))`);
    for (const owner of OWNERS) {
      for (const m of migrations[owner]) {
        const hash = sha256(m.sql);
        const prior = await t`SELECT sha256 FROM schema_migrations WHERE owner = ${owner} AND id = ${m.id}`;
        if (prior.length > 0) {
          if (prior[0].sha256 !== hash) throw new Error(`migration ${owner}/${m.id} changed after it was applied; append a new migration instead`);
          continue;
        }
        await t.unsafe(m.sql);
        await t`INSERT INTO schema_migrations (owner, id, sha256, applied_ms) VALUES (${owner}, ${m.id}, ${hash}, ${Date.now()})`;
      }
    }
  });

  return {
    sql,
    url,
    nextSeq: async (t) => {
      const rows = await t`UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value`;
      return asSeq(Number(rows[0].value));
    },
    tx: (fn) => sql.begin(fn),
    close: () => sql.close(),
  };
}
