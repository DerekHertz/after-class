/**
 * Providers and tenancy: every memo, usage and voice row names its user, two users in one database never see or
 * change each other's rows, and the 004-user-id rebuild keeps the R8 and R17 guards and every old row.
 * No call leaves the process: every task is a fake and every fetch is scripted.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_USER, MIGRATIONS, ensureLocalUser, openDb, scopeDb } from "../src/backend/db";
import type { UserDb } from "../src/backend/db";
import { serve } from "../src/backend/http";
import { DEFAULT_VOICE_ID, DEFAULT_VOICE_MODEL, createVoice } from "../src/backend/providers/elevenlabs";
import { createLedger } from "../src/backend/providers/ledger";
import { createMemo } from "../src/backend/providers/memo";
import { stableId } from "../src/shared/ids";
import type { CaptureId, MemoKey } from "../src/shared/ids";
import { fail, fakeTask, ok, otherUserDb, testUserDb } from "./fakes";

const CAP = stableId("cap", "tenancy") as CaptureId;
const live = (db: UserDb) => createMemo(db, "live", { retryDelayMs: () => 0, now: () => 1000 });
const echo = () => fakeTask<{ w: string }, string>({ answer: (i) => ok(`judged ${i.w}`) });
const count = (db: UserDb, sql: string) => db.sql.query<{ n: number }, []>(sql).get()!.n;

describe("two users share one database", () => {
  test("the same call is made and stored once per user, and neither sees the other's row", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const task = echo();
    const memoA = live(a);
    const memoB = live(b);
    const key = memoA.key(task, { w: "x" });

    expect((await memoA.run(task, { w: "x" })).kind).toBe("hit");
    expect(memoB.lookup(task, { w: "x" }).kind).toBe("missing");
    expect(memoB.inspect(key)).toBeNull();

    await memoB.run(task, { w: "x" });
    expect(task.calls).toHaveLength(2);
    expect(memoB.key(task, { w: "x" })).toBe(key);
    expect(count(a, `SELECT COUNT(*) AS n FROM memo WHERE user_id = '${a.userId}'`)).toBe(1);
    expect(count(a, `SELECT COUNT(*) AS n FROM memo WHERE user_id = '${b.userId}'`)).toBe(1);
    expect(memoA.inspect(key)!.usage.map((u) => u.attemptNo)).toEqual([1]);
    expect(memoB.inspect(key)!.usage.map((u) => u.attemptNo)).toEqual([1]);
  });

  test("a failure, its retry and clearFailures stay inside one user", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const memoA = live(a);
    const memoB = live(b);
    const broken = fakeTask<{ w: string }, string>({ maxAttempts: 1, answer: () => fail("boom") });
    const key = memoA.key(broken, { w: "x" });
    expect((await memoA.run(broken, { w: "x" })).kind).toBe("failed");
    expect(memoB.lookup(broken, { w: "x" }).kind).toBe("missing");

    await memoB.run(broken, { w: "x" });
    memoB.clearFailures([key]);
    expect(memoB.lookup(broken, { w: "x" }).kind).toBe("missing");
    expect(memoA.lookup(broken, { w: "x" }).kind).toBe("failed");
    expect(count(a, `SELECT COUNT(*) AS n FROM memo_failures WHERE user_id = '${a.userId}'`)).toBe(1);
  });

  test("the ledger of each user totals and lists only that user's events", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const task = echo();
    const memoA = live(a);
    await memoA.run(task, { w: "one" });
    await memoA.run(task, { w: "two" });
    await live(b).run(task, { w: "one" });

    const ledgerA = createLedger(a);
    const ledgerB = createLedger(b);
    expect(ledgerA.summary().byKind.unknown.calls).toBe(2);
    expect(ledgerB.summary().byKind.unknown.calls).toBe(1);
    expect(ledgerA.stages().map((s) => s.calls)).toEqual([2]);
    expect(ledgerB.stages().map((s) => s.calls)).toEqual([1]);
    expect(ledgerA.list({ limit: 10 })).toHaveLength(2);
    expect(ledgerB.list({ limit: 10 })).toHaveLength(1);
    expect(ledgerB.list({ memoKey: memoA.key(task, { w: "two" }), limit: 10 })).toEqual([]);
    expect(new Set([...ledgerA.list({ limit: 10 }), ...ledgerB.list({ limit: 10 })].map((e) => e.id)).size).toBe(3);
  });

  test("GET /usage answers with the usage of the user the server's ledger belongs to", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const task = echo();
    await live(a).run(task, { w: "one" });
    await live(a).run(task, { w: "two" });
    await live(b).run(task, { w: "one" });
    const token = "tok-tenancy-1234";
    const servers = [a, b].map((db) =>
      serve({
        modules: { ledger: createLedger(db), evidence: {} as never, reviews: {} as never },
        auth: { port: 0, extensionId: "abcdefghijklmnopabcdefghijklmnop", token },
        appDir: tmpdir(),
      }),
    );
    try {
      const calls = await Promise.all(
        servers.map(async (s) => {
          const r = await fetch(`http://127.0.0.1:${s.port}/usage`, { headers: { authorization: `Bearer ${token}` } });
          return ((await r.json()) as { byKind: { unknown: { calls: number } } }).byKind.unknown.calls;
        }),
      );
      expect(calls).toEqual([2, 1]);
    } finally {
      for (const s of servers) await s.stop(true);
    }
  });

  test("the capture a call was for is stored on its usage event, and null when the caller had none", async () => {
    const db = testUserDb();
    const memo = live(db);
    await memo.run(echo(), { w: "with" }, { captureId: CAP });
    await memo.run(echo(), { w: "without" });
    const rows = db.sql.query<{ capture_id: string | null; memo_key: string }, []>("SELECT capture_id, memo_key FROM usage_events").all();
    expect(rows.map((r) => r.capture_id).sort()).toEqual([CAP, null].sort());
  });

  test("a usage event cannot point at another user's memo input", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const task = echo();
    const memoA = live(a);
    await memoA.run(task, { w: "x" });
    const key = memoA.key(task, { w: "x" });
    expect(() =>
      a.sql.run(
        `INSERT INTO usage_events (id, user_id, memo_key, attempt_no, provider, model, purpose, outcome, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
         VALUES ('use_x', '${b.userId}', '${key}', 1, 'jev', 'm', 'boundary', 'ok', 'unknown', NULL, NULL, 'r', 0, 0)`,
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  test("the voice path writes the handle's user, and a second user's calls are theirs alone", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const fetchFn = (async () => new Response("audio")) as unknown as typeof fetch;
    for (const [db, text] of [[a, "abc"], [b, "defgh"]] as const) {
      const voice = createVoice({ apiKey: "xi-test", voiceId: DEFAULT_VOICE_ID, model: DEFAULT_VOICE_MODEL, db, fetch: fetchFn });
      const res = await voice.speak(text, new AbortController().signal);
      if (res.kind !== "audio") throw new Error("expected audio");
      await new Response(res.body).text();
    }
    const rows = a.sql.query<{ user_id: string; characters: number }, []>("SELECT user_id, characters FROM voice_usage_events ORDER BY characters").all();
    expect(rows).toEqual([
      { user_id: a.userId, characters: 3 },
      { user_id: b.userId, characters: 5 },
    ]);
  });
});

describe("migration 004-user-id", () => {
  const withFile = <T>(fn: (path: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "afterclass-tenancy-"));
    try {
      return fn(join(dir, "afterclass.sqlite"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const before = { ...MIGRATIONS, providers: MIGRATIONS.providers.filter((m) => m.id !== "004-user-id") };

  function seedOld(path: string) {
    const db = openDb(path, before);
    db.sql.run("INSERT INTO memo_inputs VALUES ('k1','claude','tutor_turn','v','m','{}',1), ('k2','jev','boundary','v','m','{}',2)");
    db.sql.run(`INSERT INTO memo VALUES ('k1','{"a":1}',1,1)`);
    db.sql.run("INSERT INTO memo_failures VALUES ('k2',2,'e',2,1)");
    db.sql.run(`INSERT INTO usage_events VALUES
      ('u1','k1',1,'claude','m','tutor_turn','ok',1,1,1,'notional',0.5,'claude_subscription',NULL,1,1),
      ('u2','k2',1,'jev','m','boundary','error',NULL,NULL,NULL,'unknown',NULL,NULL,'no usage',2,1)`);
    db.sql.run("INSERT INTO voice_usage_events VALUES ('v1','elevenlabs','m','voice',7,'ok','unknown','r',3,1)");
    db.close();
  }

  test("every old row moves to the local user with its values, and the local user exists", () => {
    withFile((path) => {
      seedOld(path);
      const db = openDb(path);
      expect(db.sql.query("SELECT id FROM users").all()).toEqual([{ id: LOCAL_USER }]);
      expect(db.sql.query("SELECT user_id, key, purpose, first_seen_ms FROM memo_inputs ORDER BY key").all()).toEqual([
        { user_id: LOCAL_USER, key: "k1", purpose: "tutor_turn", first_seen_ms: 1 },
        { user_id: LOCAL_USER, key: "k2", purpose: "boundary", first_seen_ms: 2 },
      ]);
      expect(db.sql.query("SELECT user_id, key, output_json, seq FROM memo").all()).toEqual([{ user_id: LOCAL_USER, key: "k1", output_json: '{"a":1}', seq: 1 }]);
      expect(db.sql.query("SELECT user_id, key, attempts, terminal FROM memo_failures").all()).toEqual([{ user_id: LOCAL_USER, key: "k2", attempts: 2, terminal: 1 }]);
      expect(db.sql.query("SELECT id, user_id, memo_key, capture_id, cost_kind, cost_usd, cost_reason FROM usage_events ORDER BY id").all()).toEqual([
        { id: "u1", user_id: LOCAL_USER, memo_key: "k1", capture_id: null, cost_kind: "notional", cost_usd: 0.5, cost_reason: null },
        { id: "u2", user_id: LOCAL_USER, memo_key: "k2", capture_id: null, cost_kind: "unknown", cost_usd: null, cost_reason: "no usage" },
      ]);
      expect(db.sql.query("SELECT id, user_id, characters FROM voice_usage_events").all()).toEqual([{ id: "v1", user_id: LOCAL_USER, characters: 7 }]);
      expect(db.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.sql.query("SELECT name FROM sqlite_master WHERE name LIKE '%\\_save' ESCAPE '\\'").all()).toEqual([]);
      db.close();
    });
  });

  test("an upgraded database reads through the memo and the ledger as the local user", () => {
    withFile((path) => {
      seedOld(path);
      const raw = openDb(path);
      const db = scopeDb(raw, ensureLocalUser(raw));
      const memo = createMemo(db, "replay");
      expect(memo.inspect("k1" as MemoKey)?.output).toEqual({ a: 1 });
      expect(memo.inspect("k1" as MemoKey)?.usage).toHaveLength(1);
      const ledger = createLedger(db);
      expect(ledger.summary().byKind.notional).toEqual({ calls: 1, usd: 0.5 });
      expect(ledger.summary().byKind.unknown).toEqual({ calls: 1, usd: null });
      db.close();
    });
  });

  test("a database with no rows gets no user from the migration", () => {
    withFile((path) => {
      const db = openDb(path);
      expect(db.sql.query("SELECT id FROM users").all()).toEqual([]);
      db.close();
    });
  });

  test("the R17 and R8 triggers and every constraint still hold after the rebuild", () => {
    withFile((path) => {
      seedOld(path);
      const db = openDb(path);
      expect(() => db.sql.run("UPDATE usage_events SET model = 'y'")).toThrow(/R17: usage_events is append-only/);
      expect(() => db.sql.run("DELETE FROM usage_events")).toThrow(/R17: usage events are never deleted/);
      expect(() => db.sql.run("UPDATE voice_usage_events SET characters = 0")).toThrow(/R17: voice_usage_events is append-only/);
      expect(() => db.sql.run("DELETE FROM voice_usage_events")).toThrow(/R17: usage events are never deleted/);
      expect(() => db.sql.run("UPDATE memo SET output_json = '2'")).toThrow(/R8: memo is append-only/);

      const insert = (id: string, kind: string, usd: string, reason: string, basis = "NULL") =>
        db.sql.run(`INSERT INTO usage_events (id, user_id, memo_key, attempt_no, provider, model, purpose, outcome, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
          VALUES ('${id}', '${LOCAL_USER}', 'k1', 9, 'claude', 'm', 'tutor_turn', 'ok', '${kind}', ${usd}, ${basis}, ${reason}, 0, 0)`);
      expect(() => insert("c1", "unknown", "0", "'x'")).toThrow(/CHECK/);
      expect(() => insert("c2", "unknown", "NULL", "NULL")).toThrow(/CHECK/);
      expect(() => insert("c3", "notional", "1", "NULL")).toThrow(/CHECK/);
      expect(() => insert("c4", "free", "0", "NULL")).toThrow(/CHECK/);

      const bare = (id: string, userId: string, key: string, attempt: number) =>
        db.sql.run(`INSERT INTO usage_events (id, user_id, memo_key, attempt_no, provider, model, purpose, outcome, cost_kind, cost_reason, started_ms, duration_ms)
          VALUES ('${id}', '${userId}', '${key}', ${attempt}, 'claude', 'm', 'tutor_turn', 'ok', 'unknown', 'r', 0, 0)`);
      expect(() => bare("c5", LOCAL_USER, "k1", 1)).toThrow(/UNIQUE/);
      expect(() => bare("c6", LOCAL_USER, "nope", 1)).toThrow(/FOREIGN KEY/);
      expect(() => bare("c7", "usr_missing", "k1", 5)).toThrow(/FOREIGN KEY/);
      expect(() =>
        db.sql.run(`INSERT INTO usage_events (id, memo_key, attempt_no, provider, model, purpose, outcome, cost_kind, cost_reason, started_ms, duration_ms)
          VALUES ('c8', 'k1', 6, 'claude', 'm', 'tutor_turn', 'ok', 'unknown', 'r', 0, 0)`),
      ).toThrow(/NOT NULL/);
      expect(() =>
        db.sql.run("INSERT INTO voice_usage_events (id, provider, model, voice_id, characters, outcome, cost_kind, cost_reason, started_ms, duration_ms) VALUES ('v9','elevenlabs','m','v',1,'ok','unknown','r',0,0)"),
      ).toThrow(/NOT NULL/);
      db.close();
    });
  });
});
