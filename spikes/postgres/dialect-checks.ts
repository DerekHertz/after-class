/**
 * Runs the same SQL on SQLite (the product's openDb) and on PostgreSQL where behaviour could differ silently,
 * and prints both results side by side. Each block is one dialect difference.
 *   bun run spikes/postgres/dialect-checks.ts
 */
import { SQL } from "bun";
import { openDb } from "../../src/backend/db";
import { freshDatabase, placeholders } from "./pg";
import { openPgDb } from "./kernel-pg";
import { pgMigrations } from "./translate";
import { ORD_DDL, fixQuery } from "./query-fixes";

const f = await freshDatabase("spike_dialect");
const pg = await openPgDb(f.url, pgMigrations(true), { max: 6 });
for (const ddl of ORD_DDL) await pg.sql.unsafe(ddl);
const lite = openDb(":memory:");
const side = async (label: string, a: () => unknown, b: () => Promise<unknown>) => {
  let sa: unknown;
  let sb: unknown;
  try {
    sa = a();
  } catch (e) {
    sa = `ERROR ${(e as Error).message}`;
  }
  try {
    sb = await b();
  } catch (e) {
    sb = `ERROR ${(e as Error).message}`;
  }
  console.log(`${label}\n   sqlite:   ${JSON.stringify(sa)}\n   postgres: ${JSON.stringify(sb)}`);
};
const pgq = (text: string, params: unknown[] = []) => pg.sql.unsafe(fixQuery(placeholders(text)).pg, params as never[]);

console.log("== INSERT OR IGNORE versus ON CONFLICT DO NOTHING ==");
const badFrame = ["ev_bad", "cap", "src", "f", 1, 100, 100, "p", 1] as const; // width 100 violates CHECK (width BETWEEN 280 AND 1568)
const insertFrame = "INSERT OR IGNORE INTO frames (evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
await side(
  "frame whose width breaks a CHECK",
  () => {
    lite.sql.query(insertFrame).run(...badFrame);
    return `no error, rows stored: ${(lite.sql.query("SELECT count(*) AS n FROM frames").get() as { n: number }).n}`;
  },
  async () => {
    await pgq(insertFrame, [...badFrame]);
    return "no error";
  },
);
await side(
  "frame with a duplicate evidence_id (the case the code means)",
  () => {
    const ok = ["ev_ok", "cap", "src", "f1", 1, 640, 360, "p", 2] as const;
    lite.sql.query(insertFrame).run(...ok);
    lite.sql.query(insertFrame).run(...ok);
    return `rows stored: ${(lite.sql.query("SELECT count(*) AS n FROM frames").get() as { n: number }).n}`;
  },
  async () => {
    const ok = ["ev_ok", "cap", "src", "f1", 1, 640, 360, "p", 2];
    await pgq(insertFrame, ok);
    await pgq(insertFrame, ok);
    return `rows stored: ${(await pg.sql`SELECT count(*)::int AS n FROM frames`)[0].n}`;
  },
);

console.log("\n== boolean results where SQLite gives 0 and 1 ==");
const hasBytes = "SELECT EXISTS (SELECT 1 FROM frames f WHERE f.evidence_id = 'ev_ok') AS has_bytes";
await side(
  "EXISTS(...) AS has_bytes, compared with === 1 in evidence/index.ts",
  () => {
    const v = (lite.sql.query(hasBytes).get() as { has_bytes: number }).has_bytes;
    return { value: v, equalsOne: v === 1 };
  },
  async () => {
    const v = (await pgq(hasBytes))[0].has_bytes;
    return { value: v, equalsOne: v === 1 };
  },
);

console.log("\n== integer and aggregate types ==");
await side(
  "COUNT(*), SUM(int) and a ms timestamp column",
  () => {
    lite.sql.query("INSERT INTO evidence_deletions (evidence_id, request_id, deleted_ms, seq) VALUES ('e', 'r', ?, 1)").run(Date.now());
    const r = lite.sql.query("SELECT COUNT(*) AS n, SUM(seq) AS s, MAX(deleted_ms) AS ms FROM evidence_deletions").get() as Record<string, unknown>;
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v]));
  },
  async () => {
    await pgq("INSERT INTO evidence_deletions (evidence_id, request_id, deleted_ms, seq) VALUES (?, ?, ?, 1)", ["e", "r", Date.now()]);
    const r = (await pgq("SELECT COUNT(*) AS n, SUM(seq) AS s, MAX(deleted_ms) AS ms FROM evidence_deletions"))[0];
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v]));
  },
);

console.log("\n== REAL is 8 bytes in SQLite and 4 bytes in Postgres ==");
await side(
  "0.1234567891 stored as REAL, and the same through the translated column type",
  () => (lite.sql.query("SELECT CAST(0.1234567891 AS REAL) AS v").get() as { v: number }).v,
  async () => ({ asReal: (await pg.sql`SELECT 0.1234567891::real AS v`)[0].v, asDoublePrecision: (await pg.sql`SELECT 0.1234567891::double precision AS v`)[0].v }),
);

console.log("\n== text ordering (BINARY in SQLite, database collation in Postgres) ==");
const words = ["a_b", "aB", "a-b", "Ab", "ab", "a b"];
const collation = (await pg.sql`SELECT datcollate FROM pg_database WHERE datname = current_database()`)[0].datcollate;
await side(
  `ORDER BY on ids, Postgres collation ${collation}`,
  () => lite.sql.query(`WITH t(w) AS (VALUES ${words.map((w) => `('${w}')`).join(",")}) SELECT w FROM t ORDER BY w`).all().map((r) => (r as { w: string }).w),
  async () => ({
    default: (await pg.sql.unsafe(`SELECT w FROM (VALUES ${words.map((w) => `('${w}')`).join(",")}) AS t(w) ORDER BY w`)).map((r: { w: string }) => r.w),
    collateC: (await pg.sql.unsafe(`SELECT w FROM (VALUES ${words.map((w) => `('${w}')`).join(",")}) AS t(w) ORDER BY w COLLATE "C"`)).map((r: { w: string }) => r.w),
  }),
);

console.log("\n== ORDER BY rowid versus an identity column, after an upsert ==");
const upsertNote = "INSERT INTO notes (id, review_id, concept_id, generated_json, saved_ms) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (id) DO UPDATE SET generated_json = excluded.generated_json";
const order = (db: "lite" | "pg") => (db === "lite" ? "ORDER BY n.rowid" : "ORDER BY n.ord");
await side(
  "insert n1, n2, then upsert n1 again",
  () => {
    for (const id of ["n1", "n2", "n1"]) lite.sql.query(upsertNote).run(id, "r", "c", "{}", 0);
    return lite.sql.query(`SELECT n.id FROM notes n ${order("lite")}`).all().map((r) => (r as { id: string }).id);
  },
  async () => {
    for (const id of ["n1", "n2", "n1"]) await pgq(upsertNote, [id, "r", "c", "{}", 0]);
    return (await pg.sql.unsafe(`SELECT n.id FROM notes n ${order("pg")}`)).map((r: { id: string }) => r.id);
  },
);

console.log("\n== INSERT ... SELECT with parameters (record markEnded) ==");
const markEnded = `INSERT INTO save_failures (review_id, error, failed_ms) SELECT ?1, ?2, ?3
       WHERE NOT EXISTS (SELECT 1 FROM saved_reviews WHERE review_id = ?1)
       ON CONFLICT (review_id) DO NOTHING`;
await side(
  "markEnded as written",
  () => {
    lite.sql.query(markEnded).run("rvw_x", "ended", 5);
    return (lite.sql.query("SELECT count(*) AS n FROM save_failures").get() as { n: number }).n;
  },
  async () => {
    const asWritten = await pg.sql.unsafe(placeholders(markEnded), ["rvw_x", "ended", 5] as never[]).then(() => "ok", (e: Error) => `ERROR ${e.message}`);
    const casted = await pg.sql
      .unsafe(placeholders(markEnded).replace("SELECT $1, $2, $3", "SELECT $1::text, $2::text, $3::bigint"), ["rvw_y", "ended", 5] as never[])
      .then(() => "ok", (e: Error) => `ERROR ${e.message}`);
    return { asWritten, withCasts: casted };
  },
);

console.log("\n== the global Seq counter row under concurrent transactions ==");
{
  const hold = 300;
  const t0 = Date.now();
  const one = (i: number) =>
    pg.tx(async (t) => {
      await pg.nextSeq(t);
      await Bun.sleep(hold);
      return i;
    });
  await Promise.all([one(1), one(2), one(3), one(4)]);
  console.log(`   four transactions that each take a Seq and then work for ${hold} ms finished in ${Date.now() - t0} ms (parallel would be ~${hold}, serial ${4 * hold})`);
  await pg.sql.unsafe("CREATE SEQUENCE spike_seq");
  const t1 = Date.now();
  await Promise.all(
    [1, 2, 3, 4].map(() =>
      pg.tx(async (t) => {
        await t`SELECT nextval('spike_seq')`;
        await Bun.sleep(hold);
      }),
    ),
  );
  console.log(`   the same with a Postgres SEQUENCE: ${Date.now() - t1} ms, but a rolled-back nextval is not returned:`);
  await pg.tx(async (t) => {
    await t`SELECT nextval('spike_seq')`;
    throw new Error("x");
  }).catch(() => {});
  console.log(`   next value after a rollback: ${(await pg.sql`SELECT nextval('spike_seq') AS v`)[0].v} (5 went to the rolled-back transaction and is gone)`);
}

console.log("\n== R16 under concurrent writers at READ COMMITTED ==");
{
  const seedCapture = async (cap: string) => {
    await pgq("INSERT INTO capture_facts (seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, 0, 0, 'span', '{}', 0)", [Math.floor(Math.random() * 1e9), cap]);
  };
  const race = async (label: string, lockKey: number | null) => {
    const cap = `cap_${label}`;
    await seedCapture(cap);
    const startReview = pg.tx(async (t) => {
      if (lockKey !== null) await t`SELECT pg_advisory_xact_lock(${lockKey})`;
      await t.unsafe(
        "INSERT INTO reviews (id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES ($1, $2, 'prepared_only', '{}', $3, 0)",
        [`rvw_${label}`, cap, Math.floor(Math.random() * 1e9)],
      );
      await Bun.sleep(300);
    });
    await Bun.sleep(100);
    const expire = pg.tx(async (t) => {
      if (lockKey !== null) await t`SELECT pg_advisory_xact_lock(${lockKey})`;
      await t.unsafe("DELETE FROM capture_facts WHERE capture_id = $1", [cap]);
    }).then(() => "expiry delete succeeded", (e: Error) => `expiry blocked: ${e.message}`);
    const [, outcome] = await Promise.all([startReview, expire]);
    const facts = (await pg.sql.unsafe("SELECT count(*)::int AS n FROM capture_facts WHERE capture_id = $1", [cap]))[0].n;
    const reviews = (await pg.sql.unsafe("SELECT count(*)::int AS n FROM reviews WHERE capture_id = $1", [cap]))[0].n;
    console.log(`   ${label}: ${outcome}; afterwards raw facts=${facts}, unsaved reviews=${reviews}${facts === 0 && reviews === 1 ? "   <- R16 broken: a pending review lost its raw evidence" : ""}`);
  };
  await race("no_lock", null);
  await race("with_lock", 4242);
}

pg.sql.close();
await f.drop();
process.exit(0);
