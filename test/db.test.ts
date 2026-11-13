import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_USER, MIGRATIONS, OWNERS, TABLE_SCOPES, ensureLocalUser, openDb, scopeDb, tableOwners } from "../src/backend/db";
import type { Db } from "../src/backend/db";
import { testDb } from "./fakes";

function withFile<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "afterclass-db-"));
  try {
    return fn(join(dir, "afterclass.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("migrations", () => {
  test("every table in the database has exactly one owner", () => {
    const db = testDb();
    const tables = db.sql.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const owners = tableOwners();
    expect(tables.length).toBeGreaterThan(20);
    for (const t of tables) expect(owners.has(t)).toBe(true);
    expect(new Set(owners.values())).toEqual(new Set(OWNERS));
  });

  test("reopening applies nothing twice and keeps data and the Seq counter", () => {
    withFile((path) => {
      const a = openDb(path);
      const s1 = a.nextSeq();
      a.close();
      const b = openDb(path);
      expect(b.nextSeq()).toBe((s1 + 1) as typeof s1);
      b.close();
    });
  });

  test("an applied migration whose text changed is refused", () => {
    withFile((path) => {
      openDb(path).close();
      const edited = { ...MIGRATIONS, kernel: [{ ...MIGRATIONS.kernel[0]!, sql: `${MIGRATIONS.kernel[0]!.sql}\n-- edited` }] };
      expect(() => openDb(path, edited)).toThrow(/changed after it was applied/);
    });
  });

  test("a table claimed by two owners is refused", () => {
    const dup = { ...MIGRATIONS, record: [...MIGRATIONS.record, { id: "999-dup", sql: "CREATE TABLE memo (x TEXT) STRICT;" }] };
    expect(() => tableOwners(dup)).toThrow(/declared by both/);
  });
});

describe("nextSeq", () => {
  test("is strictly increasing and rolls back with its transaction", () => {
    const db = testDb();
    const a = db.nextSeq();
    expect(() =>
      db.tx(() => {
        db.nextSeq();
        throw new Error("abort");
      }),
    ).toThrow("abort");
    const b = db.nextSeq();
    expect(b).toBe((a + 1) as typeof a);
  });
});

function insertUsage(db: Db, cost: { kind: string; usd: number | null; basis: string | null; reason: string | null }, n = 1) {
  ensureLocalUser(db);
  db.sql.run(
    `INSERT INTO memo_inputs (user_id, key, provider, purpose, version, model, input_json, first_seen_ms) VALUES ('${LOCAL_USER}', 'key_x', 'jev', 'boundary', 'v1', 'jev-1.13', '{}', 0)
     ON CONFLICT (user_id, key) DO NOTHING`,
  );
  db.sql
    .query(
      `INSERT INTO usage_events (id, user_id, memo_key, attempt_no, provider, model, purpose, outcome, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
       VALUES (?, '${LOCAL_USER}', 'key_x', ?, 'jev', 'jev-1.13', 'boundary', 'ok', ?, ?, ?, ?, 0, 0)`,
    )
    .run(`use_${n}`, n, cost.kind, cost.usd, cost.basis, cost.reason);
}

describe("R17: Every paid call records a usage event; unknown cost is stored as unknown, not zero.", () => {
  test("unknown cost carries no number, and known cost carries one", () => {
    const db = testDb();
    insertUsage(db, { kind: "unknown", usd: null, basis: null, reason: "typesafe pricing not published" }, 1);
    insertUsage(db, { kind: "measured", usd: 0.01, basis: null, reason: null }, 2);
    insertUsage(db, { kind: "notional", usd: 0.2, basis: "claude_subscription", reason: null }, 3);
    expect(() => insertUsage(db, { kind: "unknown", usd: 0, basis: null, reason: "x" }, 4)).toThrow();
    expect(() => insertUsage(db, { kind: "unknown", usd: null, basis: null, reason: null }, 5)).toThrow();
    expect(() => insertUsage(db, { kind: "measured", usd: null, basis: null, reason: null }, 6)).toThrow();
    expect(() => insertUsage(db, { kind: "notional", usd: 1, basis: null, reason: null }, 7)).toThrow();
    expect(() => insertUsage(db, { kind: "free", usd: 0, basis: null, reason: null }, 8)).toThrow();
  });

  test("usage events can be neither edited nor deleted", () => {
    const db = testDb();
    insertUsage(db, { kind: "unknown", usd: null, basis: null, reason: "r" });
    expect(() => db.sql.run("UPDATE usage_events SET cost_kind = 'measured', cost_usd = 0, cost_reason = NULL")).toThrow(/R17/);
    expect(() => db.sql.run("DELETE FROM usage_events")).toThrow(/R17/);
  });
});

function seedCapture(db: Db, captureId: string) {
  db.sql
    .query("INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, ?, 0, 0, 'span', '{}', 0)")
    .run(ensureLocalUser(db), db.nextSeq(), captureId);
  db.sql
    .query(
      "INSERT INTO frames (user_id, evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq) VALUES (?, 'ev_f', ?, 'src_1', 'f1', 1, 1280, 720, '/tmp/f.jpg', ?)",
    )
    .run(LOCAL_USER, captureId, db.nextSeq());
}

function startReview(db: Db, reviewId: string, captureId: string) {
  db.sql
    .query("INSERT INTO reviews (id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, 'prepared_only', '{}', ?, 0)")
    .run(reviewId, captureId, db.nextSeq());
}

describe("R16: Evidence cited by a saved note is only deleted when I delete it, never by expiry.", () => {
  function snapshotCitedBy(db: Db, noteId: string) {
    db.sql
      .query("INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, text, created_ms) VALUES (?, 'ev_p', 'passage', 'src_1', 1, 2, 'Ax = b', 0)")
      .run(ensureLocalUser(db));
    db.sql.query("INSERT INTO note_evidence (note_id, evidence_id) VALUES (?, 'ev_p')").run(noteId);
  }

  test("expiry cannot delete a snapshot a note cites", () => {
    const db = testDb();
    snapshotCitedBy(db, "note_1");
    expect(() => db.sql.run("DELETE FROM evidence_snapshots WHERE created_ms < 1")).toThrow(/R16/);
  });

  test("deleting the citing note releases the snapshot", () => {
    const db = testDb();
    snapshotCitedBy(db, "note_1");
    db.sql.run("INSERT INTO note_deletions (note_id, deleted_ms) VALUES ('note_1', 0)");
    db.sql.run("DELETE FROM evidence_snapshots");
    expect(db.sql.query("SELECT count(*) AS n FROM evidence_snapshots").get()).toEqual({ n: 0 });
  });

  test("the user deleting the evidence itself releases it", () => {
    const db = testDb();
    snapshotCitedBy(db, "note_1");
    db.sql.query("INSERT INTO evidence_deletions (user_id, evidence_id, request_id, deleted_ms, seq) VALUES (?, 'ev_p', 'req_1', 0, ?)").run(LOCAL_USER, db.nextSeq());
    db.sql.run("DELETE FROM evidence_snapshots");
    expect(db.sql.query("SELECT count(*) AS n FROM evidence_snapshots").get()).toEqual({ n: 0 });
  });

  test("snapshots never change after they are written", () => {
    const db = testDb();
    snapshotCitedBy(db, "note_1");
    expect(() => db.sql.run("UPDATE evidence_snapshots SET text = 'other'")).toThrow(/R16/);
  });

  test("a pending save counts as citing: raw evidence of an unsaved review cannot expire", () => {
    const db = testDb();
    seedCapture(db, "cap_1");
    startReview(db, "rvw_1", "cap_1");
    expect(() => db.sql.run("DELETE FROM capture_facts")).toThrow(/R16/);
    expect(() => db.sql.run("DELETE FROM frames")).toThrow(/R16/);

    db.sql.run("INSERT INTO saved_reviews (review_id, bundle_hash, saved_ms) VALUES ('rvw_1', 'h', 0)");
    db.sql.run("DELETE FROM capture_facts");
    db.sql.run("DELETE FROM frames");
    expect(db.sql.query("SELECT count(*) AS n FROM capture_facts").get()).toEqual({ n: 0 });
  });

  test("a capture with no review expires normally", () => {
    const db = testDb();
    seedCapture(db, "cap_2");
    startReview(db, "rvw_other", "cap_other");
    db.sql.run("DELETE FROM capture_facts");
    expect(db.sql.query("SELECT count(*) AS n FROM capture_facts").get()).toEqual({ n: 0 });
  });
});

describe("append-only facts and snapshots", () => {
  test("R7: a frozen review scope cannot be rewritten", () => {
    const db = testDb();
    startReview(db, "rvw_1", "cap_1");
    expect(() => db.sql.run("UPDATE reviews SET scope_json = '{\"grown\":true}'")).toThrow(/R7/);
  });

  test("review turns, chunk revisions and memo results are never updated", () => {
    const db = testDb();
    startReview(db, "rvw_1", "cap_1");
    db.sql
      .query("INSERT INTO review_turns (id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES ('turn_1', 'rvw_1', ?, 'learner', NULL, '{}', 0)")
      .run(db.nextSeq());
    expect(() => db.sql.run("UPDATE review_turns SET body_json = '{}'")).toThrow(/append-only/);
    db.sql
      .query(
        `INSERT INTO chunk_revisions (id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq, supersedes)
         VALUES ('crv_1', 'chk_1', 'cap_1', 0, 1, '[]', '[]', 'boundary', ?, NULL)`,
      )
      .run(db.nextSeq());
    expect(() => db.sql.run("UPDATE chunk_revisions SET provenance = 'time'")).toThrow(/append-only/);
  });

  test("R14: the record refuses 'disputed' as a stored proposal or override", () => {
    const db = testDb();
    expect(() =>
      db.sql.run(
        "INSERT INTO observations (id, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms) VALUES ('obs_1', 'rvw_1', 'thr_1', '[]', '[]', 'disputed', '{}', 0)",
      ),
    ).toThrow();
    expect(() =>
      db.sql.run("INSERT INTO observation_decisions (observation_id, kind, value, decided_ms) VALUES ('obs_1', 'override', 'disputed', 0)"),
    ).toThrow();
  });
});

describe("users", () => {
  const userRows = (db: Db) => db.sql.query<{ id: string }, []>("SELECT id FROM users").all();

  test("first boot creates exactly one user", () => {
    const db = testDb();
    expect(userRows(db)).toEqual([]);
    expect(ensureLocalUser(db)).toBe(LOCAL_USER);
    expect(userRows(db)).toEqual([{ id: LOCAL_USER }]);
  });

  test("a reboot keeps the one user and its creation time", () => {
    withFile((path) => {
      const a = openDb(path);
      ensureLocalUser(a);
      const created = a.sql.query<{ created_ms: number }, []>("SELECT created_ms FROM users").get()!.created_ms;
      a.close();
      const b = openDb(path);
      expect(ensureLocalUser(b)).toBe(LOCAL_USER);
      expect(ensureLocalUser(b)).toBe(LOCAL_USER);
      expect(userRows(b)).toHaveLength(1);
      expect(b.sql.query<{ created_ms: number }, []>("SELECT created_ms FROM users").get()!.created_ms).toBe(created);
      b.close();
    });
  });

  test("a database from before the users migration gains the table and one user, and keeps its data", () => {
    withFile((path) => {
      const old = { ...MIGRATIONS, kernel: MIGRATIONS.kernel.filter((m) => m.id !== "002-users"), providers: MIGRATIONS.providers.filter((m) => m.id !== "004-user-id"), evidence: MIGRATIONS.evidence.filter((m) => m.id !== "003-user-id" && m.id !== "004-capture-owners") };
      const a = openDb(path, old);
      const seq = a.nextSeq();
      expect(a.sql.query("SELECT name FROM sqlite_master WHERE name = 'users'").all()).toEqual([]);
      a.close();
      const b = openDb(path);
      expect(userRows(b)).toEqual([]);
      ensureLocalUser(b);
      expect(userRows(b)).toEqual([{ id: LOCAL_USER }]);
      expect(b.nextSeq()).toBe((seq + 1) as typeof seq);
      b.close();
    });
  });

  test("scopeDb binds the user, shares the Seq counter, and refuses an unknown user", () => {
    const db = testDb();
    expect(() => scopeDb(db, LOCAL_USER)).toThrow(/no such user/);
    const scoped = scopeDb(db, ensureLocalUser(db));
    expect(scoped.userId).toBe(LOCAL_USER);
    const a = scoped.nextSeq();
    expect(db.nextSeq()).toBe((a + 1) as typeof a);
    expect(scoped.tx(() => 7)).toBe(7);
  });

  test("every table is classified as per-user, shared or identity, and nothing else is", () => {
    const tables = testDb().sql.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(Object.keys(TABLE_SCOPES).sort()).toEqual(tables.sort());
    expect(Object.entries(TABLE_SCOPES).filter(([, s]) => s === "identity").map(([t]) => t)).toEqual(["users"]);
  });

  test("only tables that hold no learner's data are shared", () => {
    const shared = Object.entries(TABLE_SCOPES).filter(([, s]) => s === "shared").map(([t]) => t).sort();
    expect(shared).toEqual(["schema_migrations", "seq_counter"]);
  });
});
