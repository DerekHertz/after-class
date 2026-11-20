/**
 * Runs every module's migrations on PostgreSQL. First with the purely mechanical translation, to find what breaks,
 * then with the hand-written replacements. Prints one line per migration.
 *   bun run spikes/postgres/migrate-check.ts
 */
import { SQL } from "bun";
import { OWNERS } from "../../src/backend/db";
import { freshDatabase } from "./pg";
import { openPgDb } from "./kernel-pg";
import { pgMigrations } from "./translate";

async function oneByOne(useHand: boolean) {
  const db = await freshDatabase(useHand ? "spike_hand" : "spike_mech");
  const sql = new SQL({ url: db.url, max: 1 });
  const set = pgMigrations(useHand);
  console.log(`\n== ${useHand ? "mechanical + hand-written" : "mechanical only"}, each migration in its own transaction ==`);
  await sql.unsafe("CREATE TABLE schema_migrations (owner TEXT, id TEXT)");
  for (const owner of OWNERS) {
    for (const m of set[owner]) {
      try {
        await sql.begin(async (t) => {
          await t.unsafe(m.sql);
        });
        console.log(`ok    ${owner}/${m.id} (${m.translation})`);
      } catch (e) {
        console.log(`FAIL  ${owner}/${m.id} (${m.translation}): ${(e as Error).message}`);
      }
    }
  }
  const tables = await sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
  const triggers = await sql`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`;
  const fks = await sql`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f'`;
  console.log(`tables=${tables[0].n} user triggers=${triggers[0].n} foreign keys=${fks[0].n}`);
  await sql.close();
  await db.drop();
}

await oneByOne(false);
await oneByOne(true);

const db = await freshDatabase("spike_kernel_run");
const pg = await openPgDb(db.url, pgMigrations(true));
const applied = await pg.sql`SELECT owner, id FROM schema_migrations ORDER BY owner, id`;
console.log(`\nopenPgDb applied ${applied.length} migrations in one transaction`);
await pg.close();
await db.drop();
