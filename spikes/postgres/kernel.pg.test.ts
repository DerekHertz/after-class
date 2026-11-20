/**
 * test/db.test.ts ported to PostgreSQL, case for case, against the translated migrations.
 *   bun test spikes/postgres/kernel.pg.test.ts
 * Each test gets its own database cloned from a migrated template, so tests cannot see each other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { OWNERS, tableOwners } from "../../src/backend/db";
import { ADMIN_URL, freshDatabase, placeholders, urlFor } from "./pg";
import { openPgDb } from "./kernel-pg";
import type { PgDb } from "./kernel-pg";
import { pgMigrations } from "./translate";

const migrations = pgMigrations(true);
let template: { drop: () => Promise<void> };
let n = 0;
const opened: PgDb[] = [];

beforeAll(async () => {
  template = await freshDatabase("spike_tpl");
  const db = await openPgDb(urlFor("spike_tpl"), migrations, { max: 1 });
  await db.close();
});

afterAll(async () => {
  for (const d of opened) await d.close();
  const admin = new SQL({ url: ADMIN_URL, max: 1 });
  for (let i = 1; i <= n; i++) await admin.unsafe(`DROP DATABASE IF EXISTS spike_t${i} WITH (FORCE)`);
  await admin.close();
  await template.drop();
});

async function testDb(): Promise<PgDb> {
  const name = `spike_t${++n}`;
  const admin = new SQL({ url: ADMIN_URL, max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE spike_tpl`);
  await admin.close();
  const db = await openPgDb(urlFor(name), migrations, { max: 3 });
  opened.push(db);
  return db;
}

/** An async wrapper: a bare Bun.sql query is a lazy thenable, and `expect(query).rejects` hangs on Bun 1.4.3. */
const run = async (db: PgDb, text: string, params: unknown[] = []) => await db.sql.unsafe(placeholders(text), params as never[]);
const seq = async (db: PgDb): Promise<number> => Number(await db.tx((t) => db.nextSeq(t)));
const count = async (db: PgDb, table: string) => Number((await db.sql.unsafe(`SELECT count(*) AS n FROM ${table}`))[0].n);

describe("migrations", () => {
  test("every table in the database has exactly one owner", async () => {
    const db = await testDb();
    const tables = (await db.sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`).map((r: { tablename: string }) => r.tablename);
    const owners = tableOwners(migrations);
    expect(tables.length).toBeGreaterThan(20);
    for (const t of tables) expect(owners.has(t)).toBe(true);
    expect(new Set(owners.values())).toEqual(new Set(OWNERS));
  });

  test("reopening applies nothing twice and keeps data and the Seq counter", async () => {
    const a = await testDb();
    const s1 = await seq(a);
    const url = a.url;
    await a.close();
    const b = await openPgDb(url, migrations);
    opened.push(b);
    expect(await seq(b)).toBe(s1 + 1);
    expect(await count(b, "schema_migrations")).toBe(13);
  });

  test("an applied migration whose text changed is refused", async () => {
    const a = await testDb();
    const url = a.url;
    const edited = { ...migrations, kernel: [{ ...migrations.kernel[0]!, sql: `${migrations.kernel[0]!.sql}\n-- edited` }] };
    await expect(openPgDb(url, edited)).rejects.toThrow(/changed after it was applied/);
  });

  test("two servers starting at once apply each migration once", async () => {
    const f = await freshDatabase("spike_race");
    const [a, b] = await Promise.all([openPgDb(f.url, migrations), openPgDb(f.url, migrations)]);
    opened.push(a, b);
    expect(await count(a, "schema_migrations")).toBe(13);
    await f.drop().catch(() => {});
  });
});

describe("nextSeq", () => {
  test("is strictly increasing and rolls back with its transaction", async () => {
    const db = await testDb();
    const a = await seq(db);
    await expect(
      db.tx(async (t) => {
        await db.nextSeq(t);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await seq(db)).toBe(a + 1);
  });
});

async function insertUsage(db: PgDb, cost: { kind: string; usd: number | null; basis: string | null; reason: string | null }, k = 1) {
  await run(
    db,
    "INSERT INTO memo_inputs (key, provider, purpose, version, model, input_json, first_seen_ms) VALUES ('key_x', 'jev', 'boundary', 'v1', 'jev-1.13', '{}', 0) ON CONFLICT DO NOTHING",
  );
  await run(
    db,
    `INSERT INTO usage_events (id, memo_key, attempt_no, provider, model, purpose, outcome, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
     VALUES (?, 'key_x', ?, 'jev', 'jev-1.13', 'boundary', 'ok', ?, ?, ?, ?, 0, 0)`,
    [`use_${k}`, k, cost.kind, cost.usd, cost.basis, cost.reason],
  );
}

describe("R17: Every paid call records a usage event; unknown cost is stored as unknown, not zero.", () => {
  test("unknown cost carries no number, and known cost carries one", async () => {
    const db = await testDb();
    await insertUsage(db, { kind: "unknown", usd: null, basis: null, reason: "typesafe pricing not published" }, 1);
    await insertUsage(db, { kind: "measured", usd: 0.01, basis: null, reason: null }, 2);
    await insertUsage(db, { kind: "notional", usd: 0.2, basis: "claude_subscription", reason: null }, 3);
    await expect(insertUsage(db, { kind: "unknown", usd: 0, basis: null, reason: "x" }, 4)).rejects.toThrow();
    await expect(insertUsage(db, { kind: "unknown", usd: null, basis: null, reason: null }, 5)).rejects.toThrow();
    await expect(insertUsage(db, { kind: "measured", usd: null, basis: null, reason: null }, 6)).rejects.toThrow();
    await expect(insertUsage(db, { kind: "notional", usd: 1, basis: null, reason: null }, 7)).rejects.toThrow();
    await expect(insertUsage(db, { kind: "free", usd: 0, basis: null, reason: null }, 8)).rejects.toThrow();
  });

  test("usage events can be neither edited nor deleted", async () => {
    const db = await testDb();
    await insertUsage(db, { kind: "unknown", usd: null, basis: null, reason: "r" });
    await expect(run(db, "UPDATE usage_events SET cost_kind = 'measured', cost_usd = 0, cost_reason = NULL")).rejects.toThrow(/R17/);
    await expect(run(db, "DELETE FROM usage_events")).rejects.toThrow(/R17/);
  });
});

async function seedCapture(db: PgDb, captureId: string) {
  await run(db, "INSERT INTO capture_facts (seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, 0, 0, 'span', '{}', 0)", [await seq(db), captureId]);
  await run(
    db,
    "INSERT INTO frames (evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq) VALUES ('ev_f', ?, 'src_1', 'f1', 1, 1280, 720, '/tmp/f.jpg', ?)",
    [captureId, await seq(db)],
  );
}

async function startReview(db: PgDb, reviewId: string, captureId: string) {
  await run(db, "INSERT INTO reviews (id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, 'prepared_only', '{}', ?, 0)", [reviewId, captureId, await seq(db)]);
}

describe("R16: Evidence cited by a saved note is only deleted when I delete it, never by expiry.", () => {
  async function snapshotCitedBy(db: PgDb, noteId: string) {
    await run(db, "INSERT INTO evidence_snapshots (evidence_id, kind, source_id, start_s, end_s, text, created_ms) VALUES ('ev_p', 'passage', 'src_1', 1, 2, 'Ax = b', 0)");
    await run(db, "INSERT INTO note_evidence (note_id, evidence_id) VALUES (?, 'ev_p')", [noteId]);
  }

  test("expiry cannot delete a snapshot a note cites", async () => {
    const db = await testDb();
    await snapshotCitedBy(db, "note_1");
    await expect(run(db, "DELETE FROM evidence_snapshots WHERE created_ms < 1")).rejects.toThrow(/R16/);
  });

  test("deleting the citing note releases the snapshot", async () => {
    const db = await testDb();
    await snapshotCitedBy(db, "note_1");
    await run(db, "INSERT INTO note_deletions (note_id, deleted_ms) VALUES ('note_1', 0)");
    await run(db, "DELETE FROM evidence_snapshots");
    expect(await count(db, "evidence_snapshots")).toBe(0);
  });

  test("the user deleting the evidence itself releases it", async () => {
    const db = await testDb();
    await snapshotCitedBy(db, "note_1");
    await run(db, "INSERT INTO evidence_deletions (evidence_id, request_id, deleted_ms, seq) VALUES ('ev_p', 'req_1', 0, ?)", [await seq(db)]);
    await run(db, "DELETE FROM evidence_snapshots");
    expect(await count(db, "evidence_snapshots")).toBe(0);
  });

  test("snapshots never change after they are written", async () => {
    const db = await testDb();
    await snapshotCitedBy(db, "note_1");
    await expect(run(db, "UPDATE evidence_snapshots SET text = 'other'")).rejects.toThrow(/R16/);
  });

  test("a pending save counts as citing: raw evidence of an unsaved review cannot expire", async () => {
    const db = await testDb();
    await seedCapture(db, "cap_1");
    await startReview(db, "rvw_1", "cap_1");
    await expect(run(db, "DELETE FROM capture_facts")).rejects.toThrow(/R16/);
    await expect(run(db, "DELETE FROM frames")).rejects.toThrow(/R16/);
    await run(db, "INSERT INTO saved_reviews (review_id, bundle_hash, saved_ms) VALUES ('rvw_1', 'h', 0)");
    await run(db, "DELETE FROM capture_facts");
    await run(db, "DELETE FROM frames");
    expect(await count(db, "capture_facts")).toBe(0);
  });

  test("a capture with no review expires normally", async () => {
    const db = await testDb();
    await seedCapture(db, "cap_2");
    await startReview(db, "rvw_other", "cap_other");
    await run(db, "DELETE FROM capture_facts");
    expect(await count(db, "capture_facts")).toBe(0);
  });
});

describe("append-only facts and snapshots", () => {
  test("R7: a frozen review scope cannot be rewritten", async () => {
    const db = await testDb();
    await startReview(db, "rvw_1", "cap_1");
    await expect(run(db, `UPDATE reviews SET scope_json = '{"grown":true}'`)).rejects.toThrow(/R7/);
  });

  test("review turns, chunk revisions and memo results are never updated", async () => {
    const db = await testDb();
    await startReview(db, "rvw_1", "cap_1");
    await run(db, "INSERT INTO review_turns (id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES ('turn_1', 'rvw_1', ?, 'learner', NULL, '{}', 0)", [await seq(db)]);
    await expect(run(db, "UPDATE review_turns SET body_json = '{}'")).rejects.toThrow(/append-only/);
    await run(
      db,
      `INSERT INTO chunk_revisions (id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq, supersedes)
       VALUES ('crv_1', 'chk_1', 'cap_1', 0, 1, '[]', '[]', 'boundary', ?, NULL)`,
      [await seq(db)],
    );
    await expect(run(db, "UPDATE chunk_revisions SET provenance = 'time'")).rejects.toThrow(/append-only/);
  });

  test("R14: the record refuses 'disputed' as a stored proposal or override", async () => {
    const db = await testDb();
    await expect(
      run(db, "INSERT INTO observations (id, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms) VALUES ('obs_1', 'rvw_1', 'thr_1', '[]', '[]', 'disputed', '{}', 0)"),
    ).rejects.toThrow();
    await expect(run(db, "INSERT INTO observation_decisions (observation_id, kind, value, decided_ms) VALUES ('obs_1', 'override', 'disputed', 0)")).rejects.toThrow();
  });
});

describe("what SQLite did not do", () => {
  test("TRUNCATE bypasses the row triggers, so append-only needs a statement trigger too", async () => {
    const db = await testDb();
    await insertUsage(db, { kind: "unknown", usd: null, basis: null, reason: "r" });
    await run(db, "TRUNCATE usage_events");
    expect(await count(db, "usage_events")).toBe(0);
  });
});
