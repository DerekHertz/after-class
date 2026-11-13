import { describe, expect, test } from "bun:test";
import { ensurePgUser, openPgDb, scopePgDb } from "../src/backend/pg";
import type { PgDb, Tx } from "../src/backend/pg";
import { PG_MIGRATIONS } from "../src/backend/pg-schema";
import { OWNERS, TABLE_SCOPES, tableOwners } from "../src/backend/db";
import { stableId } from "../src/shared/ids";
import { pgDatabases, skipWithoutPg } from "./pg-fixtures";

const skip = skipWithoutPg(import.meta.path);
const dbs = pgDatabases();

const A = stableId("usr", "a");
const B = stableId("usr", "b");

async function setup(opts: { idleInTransactionMs?: number; max?: number } = {}): Promise<PgDb> {
  const db = await dbs.fresh(opts);
  await db.tx((t) => t.run`CREATE TABLE scratch (k text COLLATE "C" PRIMARY KEY, v bigint NOT NULL DEFAULT 1)`);
  await ensurePgUser(db, A, 0);
  await ensurePgUser(db, B, 0);
  return db;
}

const keys = async (db: PgDb) => (await db.read((t) => t.all<{ k: string }>`SELECT k FROM scratch ORDER BY k`)).map((r) => r.k);
const put = (t: Tx, k: string) => t.run`INSERT INTO scratch (k) VALUES (${k})`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(skip)("PgDb: transactions", () => {
  test("a transaction that returns commits its writes and returns the callback's value", async () => {
    const db = await setup();
    const out = await db.tx(async (t) => {
      await put(t, "a");
      return 42;
    });
    expect(out).toBe(42);
    expect(await keys(db)).toEqual(["a"]);
  });

  test("a throw rolls back every write of the transaction and rethrows the same error", async () => {
    const db = await setup();
    const boom = new Error("abort");
    await expect(
      db.tx(async (t) => {
        await put(t, "a");
        await put(t, "b");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await keys(db)).toEqual([]);
  });

  test("a savepoint that throws rolls back only its own writes, and the outer transaction commits the rest", async () => {
    const db = await setup();
    await db.tx(async (t) => {
      await put(t, "outer-before");
      await expect(
        t.tx(async (inner) => {
          await put(inner, "inner");
          throw new Error("inner abort");
        }),
      ).rejects.toThrow("inner abort");
      await put(t, "outer-after");
    });
    expect(await keys(db)).toEqual(["outer-after", "outer-before"]);
  });

  test("a savepoint that returns is kept, and an outer throw then rolls it back too", async () => {
    const db = await setup();
    await expect(
      db.tx(async (t) => {
        await t.tx((inner) => put(inner, "inner"));
        throw new Error("outer abort");
      }),
    ).rejects.toThrow("outer abort");
    expect(await keys(db)).toEqual([]);
  });

  test("a failed statement poisons its handle: the next statement on it throws, a savepoint around it does not", async () => {
    const db = await setup();
    await expect(
      db.tx(async (t) => {
        await put(t, "dup");
        await expect(put(t, "dup")).rejects.toThrow(/duplicate key/);
        await expect(put(t, "next")).rejects.toThrow(/after a failed statement/);
        throw new Error("done checking");
      }),
    ).rejects.toThrow("done checking");

    await db.tx(async (t) => {
      await put(t, "dup");
      await expect(t.tx((inner) => put(inner, "dup"))).rejects.toThrow(/duplicate key/);
      await put(t, "next");
    });
    expect(await keys(db)).toEqual(["dup", "next"]);
  });

  test("a failed statement whose error the body caught cannot commit, at the top or inside a savepoint", async () => {
    const db = await setup();
    await expect(
      db.tx(async (t) => {
        await put(t, "kept-out");
        await put(t, "kept-out").catch(() => undefined);
      }),
    ).rejects.toThrow(/caught and ignored/);
    expect(await keys(db)).toEqual([]);

    await db.tx(async (t) => {
      await expect(
        t.tx(async (inner) => {
          await put(inner, "in-savepoint");
          await put(inner, "in-savepoint").catch(() => undefined);
        }),
      ).rejects.toThrow(/caught and ignored/);
      await put(t, "after");
    });
    expect(await keys(db)).toEqual(["after"]);
  });

  test("a handle kept past its transaction refuses statements", async () => {
    const db = await setup();
    let kept!: Tx;
    await db.tx(async (t) => {
      kept = t;
    });
    await expect(put(kept, "late")).rejects.toThrow(/after its transaction ended/);
    expect(await keys(db)).toEqual([]);
  });

  test("a handle with an open savepoint refuses statements until the savepoint ends", async () => {
    const db = await setup();
    await db.tx(async (t) => {
      await t.tx(async () => {
        await expect(put(t, "parent")).rejects.toThrow(/open savepoint/);
      });
      await put(t, "parent");
    });
    expect(await keys(db)).toEqual(["parent"]);
  });

  test("a savepoint left running when its transaction settles fails the transaction, and its work never lands", async () => {
    const db = await setup();
    let child!: Promise<unknown>;
    await expect(
      db.tx(async (t) => {
        child = t.tx(async (inner) => {
          await inner.run`SELECT pg_sleep(0.05)`;
          await put(inner, "child");
        });
        child.catch(() => undefined);
      }),
    ).rejects.toThrow(/savepoint still running/);
    await child.catch(() => undefined);
    expect(await keys(db)).toEqual([]);
  });

  test("db.tx, db.command and db.read inside a transaction are refused instead of opening a second connection", async () => {
    const db = await setup();
    await expect(db.tx(async () => db.tx(async () => 1))).rejects.toThrow(/inside a transaction/);
    await expect(db.command(A, async () => db.command(A, async () => 1))).rejects.toThrow(/inside a transaction/);
    await expect(db.tx(async () => db.read(async () => 1))).rejects.toThrow(/inside a transaction/);
    expect(await db.tx(async () => 1)).toBe(1);
  });

  test("work started inside a transaction may open its own once that transaction has ended", async () => {
    const db = await setup();
    let later!: Promise<unknown>;
    await db.tx(async (t) => {
      await put(t, "first");
      later = delay(20).then(() => db.tx((t2) => put(t2, "later")));
    });
    await later;
    expect(await keys(db)).toEqual(["first", "later"]);
  });

  test("a transaction left idle past the limit, awaiting something other than the database, does not commit", async () => {
    const db = await setup({ idleInTransactionMs: 200 });
    await expect(
      db.tx(async (t) => {
        await put(t, "a");
        await delay(600);
        await put(t, "b");
      }),
    ).rejects.toThrow();
    expect(await keys(db)).toEqual([]);
    await db.tx((t) => put(t, "after"));
    expect(await keys(db)).toEqual(["after"]);
  });

  test("a read transaction sees one snapshot and refuses writes, Seqs and locks", async () => {
    const db = await setup();
    await db.tx((t) => put(t, "a"));
    const firstRead = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    const reading = db.read(async (t) => {
      const before = await t.all<{ k: string }>`SELECT k FROM scratch`;
      firstRead.resolve();
      await written.promise;
      const after = await t.all<{ k: string }>`SELECT k FROM scratch`;
      return [before.length, after.length];
    });
    await firstRead.promise;
    await db.tx((t) => put(t, "b"));
    written.resolve();
    expect(await reading).toEqual([1, 1]);
    expect(await keys(db)).toEqual(["a", "b"]);
    await expect(db.read((t) => put(t, "x"))).rejects.toThrow(/read-only transaction/);
    await expect(db.read((t) => t.nextSeq(A))).rejects.toThrow(/read transaction/);
    await expect(db.read((t) => t.lockUsers(A))).rejects.toThrow(/read transaction/);
  });
});

describe.skipIf(skip)("PgDb: values at the boundary", () => {
  test("bigint columns and counts arrive as numbers, and a value past 2^53 throws instead of losing digits", async () => {
    const db = await setup();
    const row = await db.tx((t) => t.get<{ ms: number; n: number; f: number }>`SELECT 1762000000000::bigint AS ms, count(*) AS n, 0.1234567891::float8 AS f FROM scratch`);
    expect(row).toEqual({ ms: 1762000000000, n: 0, f: 0.1234567891 });
    await expect(db.tx((t) => t.get`SELECT 9007199254740993::bigint AS big`)).rejects.toThrow(RangeError);
  });

  test("SUM of a bigint is numeric and arrives as a string unless cast back to bigint", async () => {
    const db = await setup();
    await db.tx(async (t) => {
      await put(t, "a");
      await put(t, "b");
    });
    const row = await db.read((t) => t.get<{ raw: unknown; cast: unknown }>`SELECT SUM(v) AS raw, SUM(v)::bigint AS cast FROM scratch`);
    expect(row).toEqual({ raw: "2", cast: 2 });
  });

  test("an object or array value is stored as jsonb and read back parsed; a JSON string stays a string", async () => {
    const db = await setup();
    await db.tx((t) => t.run`CREATE TABLE j (id bigint PRIMARY KEY, v jsonb NOT NULL)`);
    const value = { b: 1, a: ["x", "y"] };
    await db.tx(async (t) => {
      await t.run`INSERT INTO j (id, v) VALUES (1, ${value})`;
      await t.run`INSERT INTO j (id, v) VALUES (2, ${JSON.stringify(value)})`;
      await t.run`INSERT INTO j (id, v) VALUES (3, ${["p", "q"]})`;
    });
    const rows = await db.read((t) => t.all<{ id: number; v: unknown; kind: string }>`SELECT id, v, jsonb_typeof(v) AS kind FROM j ORDER BY id`);
    expect(rows).toEqual([
      { id: 1, v: value, kind: "object" },
      { id: 2, v: JSON.stringify(value), kind: "string" },
      { id: 3, v: ["p", "q"], kind: "array" },
    ]);
    const hits = await db.read((t) => t.all<{ id: number }>`SELECT id FROM j WHERE v ->> 'b' = '1' OR v @> ${["q"]} ORDER BY id`);
    expect(hits.map((r) => r.id)).toEqual([1, 3]);
  });

  test("a list of ids binds as one jsonb array, for IN and ANY", async () => {
    const db = await setup();
    await db.tx(async (t) => {
      for (const k of ["a", "b", "c"]) await put(t, k);
    });
    const ids = ["a", "c", "zz"];
    const rows = await db.read((t) => t.all<{ k: string }>`SELECT k FROM scratch WHERE k IN (SELECT jsonb_array_elements_text(${ids})) ORDER BY k`);
    expect(rows.map((r) => r.k)).toEqual(["a", "c"]);
  });

  test("the SQLite rewrites in MODULES.md: a typed null filter, EXISTS as a boolean, COUNT FILTER, and a jsonb column's elements", async () => {
    const db = await setup();
    await db.tx(async (t) => {
      await t.run`CREATE TABLE obs (id text PRIMARY KEY, concept_ids_json jsonb NOT NULL, ok boolean NOT NULL)`;
      await t.run`INSERT INTO obs (id, concept_ids_json, ok) VALUES ('o1', ${["c1", "c2"]}, true), ('o2', ${["c3"]}, false)`;
    });
    const byConcept = (concept: string | null) =>
      db.read((t) =>
        t.all<{ id: string }>`SELECT id FROM obs o
          WHERE ${concept}::text IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(o.concept_ids_json) AS e(value) WHERE e.value = ${concept})
          ORDER BY id`,
      );
    expect((await byConcept(null)).map((r) => r.id)).toEqual(["o1", "o2"]);
    expect((await byConcept("c2")).map((r) => r.id)).toEqual(["o1"]);
    const row = await db.read((t) => t.get`SELECT EXISTS (SELECT 1 FROM obs) AS any, COUNT(*) FILTER (WHERE ok) AS oks FROM obs`);
    expect(row).toEqual({ any: true, oks: 1 });
  });

  test("text sorts by bytes, as SQLite does", async () => {
    const db = await setup();
    const words = ["a b", "a-b", "a_b", "ab", "aB", "Ab"];
    await db.tx(async (t) => {
      for (const w of words) await put(t, w);
    });
    expect(await keys(db)).toEqual(["Ab", "a b", "a-b", "aB", "a_b", "ab"]);
  });
});

describe.skipIf(skip)("PgDb: nextSeq", () => {
  test("a Seq taken in a rolled-back transaction or savepoint is taken again, and Seqs rise otherwise", async () => {
    const db = await setup();
    const first = await db.command(A, (t) => t.nextSeq());
    await expect(
      db.command(A, async (t) => {
        await t.nextSeq();
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const second = await db.command(A, async (t) => {
      await expect(
        t.tx(async (inner) => {
          await inner.nextSeq();
          throw new Error("inner abort");
        }),
      ).rejects.toThrow("inner abort");
      return t.nextSeq();
    });
    expect([first, second]).toEqual([1, 2] as typeof first[]);
  });

  test("each user has a Seq of their own", async () => {
    const db = await setup();
    const seqs = await db.tx(async (t) => {
      await t.lockUsers(A, B);
      return [await t.nextSeq(A), await t.nextSeq(A), await t.nextSeq(B)];
    });
    expect(seqs).toEqual([1, 2, 1] as typeof seqs);
  });

  test("a Seq needs its user's lock, and names the user unless the transaction holds exactly one", async () => {
    const db = await setup();
    await expect(db.tx((t) => t.nextSeq(A))).rejects.toThrow(/without its command lock/);
    await expect(db.tx((t) => t.nextSeq())).rejects.toThrow(/holds 0 user locks/);
    await expect(
      db.tx(async (t) => {
        await t.lockUsers(A, B);
        return t.nextSeq();
      }),
    ).rejects.toThrow(/holds 2 user locks/);
    expect(await db.command(B, (t) => t.nextSeq())).toBe(1 as never);
  });

  test("a reader never sees a later Seq of a user committed while an earlier one is not, under concurrent commands", async () => {
    const db = await setup({ max: 12 });
    await db.tx((t) => t.run`CREATE TABLE seq_log (user_id text NOT NULL, seq bigint NOT NULL, PRIMARY KEY (user_id, seq))`);
    const writers = Array.from({ length: 16 }, (_, i) =>
      db.command(A, async (t) => {
        const seq = await t.nextSeq();
        await t.run`SELECT pg_sleep(${((i * 7) % 5) * 0.01})`;
        await t.run`INSERT INTO seq_log (user_id, seq) VALUES (${A}, ${seq})`;
      }),
    );
    let done = false;
    const all = Promise.all(writers).finally(() => (done = true));
    const gaps: number[][] = [];
    while (!done) {
      const seen = (await db.read((t) => t.all<{ seq: number }>`SELECT seq FROM seq_log WHERE user_id = ${A} ORDER BY seq`)).map((r) => r.seq);
      if (seen.some((s, i) => s !== i + 1)) gaps.push(seen);
    }
    await all;
    expect(gaps).toEqual([]);
    expect(await db.read((t) => t.get`SELECT count(*) AS n, max(seq) AS top FROM seq_log`)).toEqual({ n: 16, top: 16 });
  });
});

describe.skipIf(skip)("PgDb: the per-user command lock", () => {
  test("command holds its user's lock inside fn and releases it when the transaction ends", async () => {
    const db = await setup();
    let kept!: Tx;
    await db.command(A, async (t) => {
      kept = t;
      expect([t.holdsUserLock(A), t.holdsUserLock(B)]).toEqual([true, false]);
    });
    expect(kept.holdsUserLock(A)).toBe(false);
  });

  test("one lockUsers call takes every listed user once, in ascending key order, whatever the order or repeats", async () => {
    const db = await setup();
    const order = await db.tx(async (t) => {
      await t.lockUsers(A, B, A);
      return t.heldUserLocks();
    });
    expect([...order].sort()).toEqual([A, B].sort());
    const reversed = await db.tx(async (t) => {
      await t.lockUsers(B, A);
      return t.heldUserLocks();
    });
    expect(reversed).toEqual(order);
  });

  test("a user below one already held is refused, so no transaction takes locks in descending order", async () => {
    const db = await setup();
    const [low, high] = await db.tx(async (t) => {
      await t.lockUsers(A, B);
      return t.heldUserLocks();
    });
    await expect(
      db.command(high!, async (t) => {
        await t.lockUsers(low!);
      }),
    ).rejects.toThrow(/lock order/);
    await db.command(low!, (t) => t.lockUsers(high!));
  });

  test("locking inside a savepoint is refused", async () => {
    const db = await setup();
    await db.tx(async (t) => {
      await expect(t.tx((inner) => inner.lockUsers(A))).rejects.toThrow(/inside a savepoint/);
    });
  });

  test("a second command for the same user does not start until the first one's transaction has ended", async () => {
    const db = await setup();
    const trace: string[] = [];
    const command = (name: string) =>
      db.command(A, async (t) => {
        trace.push(`${name} start`);
        await t.run`SELECT pg_sleep(0.2)`;
        await put(t, name);
        trace.push(`${name} end`);
      });
    const first = command("first");
    await delay(50);
    await Promise.all([first, command("second")]);
    expect(trace).toEqual(["first start", "first end", "second start", "second end"]);
  });

  test("a command for another user runs while the first user's command holds its lock", async () => {
    const db = await setup();
    const finished: string[] = [];
    const slow = db.command(A, async (t) => {
      await t.run`SELECT pg_sleep(1)`;
      finished.push("A");
    });
    await delay(100);
    await db.command(B, (t) => put(t, "b"));
    finished.push("B");
    await slow;
    expect(finished).toEqual(["B", "A"]);
  });

  test("a failed command releases the lock for the next one", async () => {
    const db = await setup();
    await expect(
      db.command(A, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.command(A, async (t) => t.holdsUserLock(A))).toBe(true);
  });

  test("a user-scoped database's command locks its own user and no other", async () => {
    const db = await setup();
    const udb = await scopePgDb(db, B);
    expect(await udb.command(async (t) => [t.holdsUserLock(B), t.holdsUserLock(A)])).toEqual([true, false]);
    await expect(scopePgDb(db, stableId("usr", "nobody"))).rejects.toThrow(/no such user/);
  });
});

describe.skipIf(skip)("R16 needs the lock: an uncommitted review against an expiry delete", () => {
  const CAPTURE = "cap_race";

  async function seeded(): Promise<PgDb> {
    const db = await setup({ max: 4 });
    await db.command(A, async (t) => {
      const seq = await t.nextSeq();
      await t.run`INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms)
        VALUES (${A}, ${seq}, ${CAPTURE}, 0, 0, 'span', ${{}}, 0)`;
    });
    return db;
  }

  /** Starts a review of CAPTURE and holds its transaction open for 400 ms; `inserted` resolves once the row is written. */
  function startReview(db: PgDb) {
    const inserted = Promise.withResolvers<void>();
    const done = db.command(A, async (t) => {
      const seq = await t.nextSeq();
      await t.run`INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms)
        VALUES ('rvw_race', ${A}, ${CAPTURE}, 'prepared_only', ${{}}, ${seq}, 0)`;
      inserted.resolve();
      await t.run`SELECT pg_sleep(0.4)`;
    });
    return { inserted: inserted.promise, done };
  }

  const expire = (t: Tx) => t.run`DELETE FROM capture_facts WHERE user_id = ${A} AND capture_id = ${CAPTURE}`;
  const counts = (db: PgDb) =>
    db.read((t) => t.get`SELECT (SELECT count(*) FROM capture_facts) AS facts, (SELECT count(*) FROM reviews) AS reviews`);

  test("without the lock, the delete misses the uncommitted review and the review loses its raw evidence", async () => {
    const db = await seeded();
    const review = startReview(db);
    await review.inserted;
    await db.tx(expire);
    await review.done;
    expect(await counts(db)).toEqual({ facts: 0, reviews: 1 });
  });

  test("with the user's lock, the delete waits for the review to commit and the R16 trigger refuses it", async () => {
    const db = await seeded();
    const review = startReview(db);
    await review.inserted;
    await expect(db.command(A, expire)).rejects.toThrow(/R16: raw evidence of an unsaved review is held/);
    await review.done;
    expect(await counts(db)).toEqual({ facts: 1, reviews: 1 });
  });
});

describe.skipIf(skip)("PgDb: migrations", () => {
  test("every table has exactly one owner, the same as in the SQLite schema", async () => {
    const db = await dbs.fresh();
    const tables = (await db.read((t) => t.all<{ name: string }>`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`)).map((r) => r.name);
    const owners = tableOwners(PG_MIGRATIONS);
    expect(tables.length).toBeGreaterThan(20);
    for (const table of tables) expect(table === "schema_migrations" || owners.has(table)).toBe(true);
    expect(new Set(owners.values())).toEqual(new Set(OWNERS));
    const sqliteOwners = tableOwners();
    expect([...tables].sort()).toEqual(Object.keys(TABLE_SCOPES).sort());
    expect(tables.filter((table) => owners.get(table) !== sqliteOwners.get(table))).toEqual([]);
  });

  test("reopening applies nothing twice and keeps data and the Seq counter", async () => {
    const url = await dbs.freshUrl();
    const a = await openPgDb(url);
    await ensurePgUser(a, A, 0);
    const s1 = await a.command(A, (t) => t.nextSeq());
    await a.close();
    const b = await openPgDb(url);
    try {
      expect(await b.command(A, (t) => t.nextSeq())).toBe((s1 + 1) as typeof s1);
      expect(await b.read((t) => t.get`SELECT count(*) AS n FROM schema_migrations`)).toEqual({ n: OWNERS.length });
    } finally {
      await b.close();
    }
  });

  test("an applied migration whose text changed is refused", async () => {
    const url = await dbs.freshUrl();
    const edited = { ...PG_MIGRATIONS, kernel: [{ ...PG_MIGRATIONS.kernel[0]!, sql: `${PG_MIGRATIONS.kernel[0]!.sql}\n-- edited` }] };
    await expect(openPgDb(url, { migrations: edited })).rejects.toThrow(/changed after it was applied/);
  });

  test("two servers starting at once on an empty database apply each migration once", async () => {
    const url = await dbs.blankUrl();
    const [a, b] = await Promise.all([openPgDb(url), openPgDb(url)]);
    try {
      expect(await a.read((t) => t.get`SELECT count(*) AS n FROM schema_migrations`)).toEqual({ n: OWNERS.length });
    } finally {
      await a.close();
      await b.close();
    }
  });
});
