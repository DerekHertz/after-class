import { describe, expect, test } from "bun:test";
import { LOCAL_USER } from "../src/backend/db";
import { asAsync, scopeAsyncDb } from "../src/backend/db-async";
import type { AsyncDb, Tx } from "../src/backend/db-async";
import { stableId } from "../src/shared/ids";
import { testDb } from "./fakes";

/** An in-memory database with a scratch table, handed out through both interfaces. */
function setup() {
  const sync = testDb();
  sync.sql.run("CREATE TABLE scratch (k TEXT PRIMARY KEY, v INTEGER NOT NULL) STRICT");
  return { sync, db: asAsync(sync) };
}

const keys = async (db: AsyncDb) => (await db.all<{ k: string }>("SELECT k FROM scratch ORDER BY k")).map((r) => r.k);
const put = (t: Tx, k: string) => t.run("INSERT INTO scratch (k, v) VALUES (?, 1)", k);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("async Db: transactions", () => {
  test("a transaction that returns commits its writes and returns the callback's value", async () => {
    const { db } = setup();
    const out = await db.tx(async (t) => {
      await put(t, "a");
      return 42;
    });
    expect(out).toBe(42);
    expect(await keys(db)).toEqual(["a"]);
  });

  test("a throw rolls back every write of the transaction and rethrows the same error", async () => {
    const { db } = setup();
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
    const { db } = setup();
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
    const { db } = setup();
    await expect(
      db.tx(async (t) => {
        await t.tx((inner) => put(inner, "inner"));
        throw new Error("outer abort");
      }),
    ).rejects.toThrow("outer abort");
    expect(await keys(db)).toEqual([]);
  });

  test("two transactions on one connection run one after the other, not interleaved", async () => {
    const { db } = setup();
    const trace: string[] = [];
    const run = (name: string) =>
      db.tx(async (t) => {
        trace.push(`${name} start`);
        await put(t, name);
        await delay(5);
        trace.push(`${name} end`);
      });
    await Promise.all([run("a"), run("b")]);
    expect(trace).toEqual(["a start", "a end", "b start", "b end"]);
  });
});

describe("async Db: nextSeq", () => {
  test("a Seq taken in a rolled-back transaction or savepoint is taken again, and Seqs rise otherwise", async () => {
    const { db } = setup();
    const first = await db.tx((t) => t.nextSeq());
    await expect(
      db.tx(async (t) => {
        await t.nextSeq();
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const second = await db.tx(async (t) => {
      await expect(
        t.tx(async (inner) => {
          await inner.nextSeq();
          throw new Error("inner abort");
        }),
      ).rejects.toThrow("inner abort");
      return t.nextSeq();
    });
    expect(second).toBe((first + 1) as typeof first);
  });

  test("is not offered outside a transaction", () => {
    const { db } = setup();
    expect("nextSeq" in db).toBe(false);
  });
});

describe("async Db: the handle discipline", () => {
  test("a statement on the connection while a transaction is open is refused and does not run", async () => {
    const { db } = setup();
    await db.tx(async (t) => {
      await put(t, "inside");
      await expect(db.run("INSERT INTO scratch (k, v) VALUES ('escaped', 1)")).rejects.toThrow(/outside the transaction handle/);
      await expect(db.all("SELECT k FROM scratch")).rejects.toThrow(/outside the transaction handle/);
      await expect(db.get("SELECT k FROM scratch")).rejects.toThrow(/outside the transaction handle/);
    });
    expect(await keys(db)).toEqual(["inside"]);
  });

  test("the same statement on the connection runs once the transaction has ended", async () => {
    const { db } = setup();
    await db.tx((t) => put(t, "a"));
    expect(await db.run("INSERT INTO scratch (k, v) VALUES ('b', 1)")).toEqual({ changes: 1 });
    expect(await keys(db)).toEqual(["a", "b"]);
  });

  test("a statement on the connection is refused even while another command's transaction is waiting on a timer", async () => {
    const { db } = setup();
    const open = db.tx(async () => {
      await delay(10);
    });
    await delay(1);
    await expect(db.all("SELECT k FROM scratch")).rejects.toThrow(/outside the transaction handle/);
    await open;
  });

  test("db.tx inside a transaction is refused instead of waiting on itself", async () => {
    const { db } = setup();
    await expect(db.tx(async () => db.tx(async () => 1))).rejects.toThrow(/db\.tx called inside a transaction/);
    expect(await keys(db)).toEqual([]);
  });

  test("a handle kept past its transaction refuses statements", async () => {
    const { db } = setup();
    let kept!: Tx;
    await db.tx(async (t) => {
      kept = t;
    });
    await expect(put(kept, "late")).rejects.toThrow(/after its transaction ended/);
    expect(await keys(db)).toEqual([]);
  });

  test("a handle with an open savepoint refuses statements until the savepoint ends", async () => {
    const { db } = setup();
    await db.tx(async (t) => {
      await t.tx(async () => {
        await expect(put(t, "parent")).rejects.toThrow(/open savepoint/);
      });
      await put(t, "parent");
    });
    expect(await keys(db)).toEqual(["parent"]);
  });

  test("a failed statement poisons its handle: the next statement on it throws, a savepoint around it does not", async () => {
    const { db } = setup();
    await expect(
      db.tx(async (t) => {
        await put(t, "dup");
        await expect(put(t, "dup")).rejects.toThrow(/UNIQUE/);
        await expect(put(t, "next")).rejects.toThrow(/after a failed statement/);
        await expect(t.nextSeq()).rejects.toThrow(/after a failed statement/);
        throw new Error("done checking");
      }),
    ).rejects.toThrow("done checking");

    await db.tx(async (t) => {
      await put(t, "dup");
      await expect(t.tx((inner) => put(inner, "dup"))).rejects.toThrow(/UNIQUE/);
      await put(t, "next");
    });
    expect(await keys(db)).toEqual(["dup", "next"]);
  });

  test("a failed statement whose error the code caught cannot commit", async () => {
    const { db } = setup();
    await expect(
      db.tx(async (t) => {
        await put(t, "kept-out");
        await put(t, "kept-out").catch(() => undefined);
      }),
    ).rejects.toThrow(/caught and ignored/);
    expect(await keys(db)).toEqual([]);
  });
});

describe("async Db: the per-user command lock", () => {
  const A = LOCAL_USER;
  const B = stableId("usr", "second");

  test("withUserLock holds the user's lock inside fn, and releases it when the transaction ends", async () => {
    const { db } = setup();
    let kept!: Tx;
    await db.withUserLock(A, async (t) => {
      kept = t;
      expect(t.holdsUserLock(A)).toBe(true);
      expect(t.holdsUserLock(B)).toBe(false);
    });
    expect(kept.holdsUserLock(A)).toBe(false);
  });

  test("a savepoint handle sees the locks of its transaction, and savepoint rollback keeps them", async () => {
    const { db } = setup();
    await db.withUserLock(A, async (t) => {
      await expect(
        t.tx(async (inner) => {
          expect(inner.holdsUserLock(A)).toBe(true);
          throw new Error("inner abort");
        }),
      ).rejects.toThrow("inner abort");
      expect(t.holdsUserLock(A)).toBe(true);
    });
  });

  test("locking inside a savepoint is refused", async () => {
    const { db } = setup();
    await db.tx(async (t) => {
      await expect(t.tx((inner) => inner.lockUsers(A))).rejects.toThrow(/inside a savepoint/);
    });
  });

  test("one lockUsers call takes every listed user once, whatever the order or repeats", async () => {
    const { db } = setup();
    await db.tx(async (t) => {
      await t.lockUsers(B, A, B);
      expect(t.holdsUserLock(A) && t.holdsUserLock(B)).toBe(true);
      await t.lockUsers(A);
      expect(t.holdsUserLock(A)).toBe(true);
    });
  });

  test("a second command for the same user does not start until the first one's transaction has ended", async () => {
    const { db } = setup();
    const trace: string[] = [];
    const command = (name: string) =>
      db.withUserLock(A, async (t) => {
        trace.push(`${name} start`);
        await delay(5);
        await put(t, name);
        trace.push(`${name} end`);
      });
    await Promise.all([command("first"), command("second")]);
    expect(trace).toEqual(["first start", "first end", "second start", "second end"]);
    expect(await keys(db)).toEqual(["first", "second"]);
  });

  test("a failed command releases the lock for the next one", async () => {
    const { db } = setup();
    const failing = db.withUserLock(A, async () => {
      throw new Error("boom");
    });
    const next = db.withUserLock(A, async (t) => t.holdsUserLock(A));
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe(true);
  });

  test("a user-scoped handle's command locks its own user and no other", async () => {
    const { db } = setup();
    const udb = scopeAsyncDb(db, B);
    const held = await udb.command(async (t) => [t.holdsUserLock(B), t.holdsUserLock(A)]);
    expect(held).toEqual([true, false]);
  });
});

describe("the synchronous Db beside the async one", () => {
  test("sync tx, sync SQL and sync nextSeq still work on the connection the async wrapper uses", async () => {
    const { sync, db } = setup();
    const s1 = sync.tx(() => {
      sync.sql.run("INSERT INTO scratch (k, v) VALUES ('sync', 1)");
      return sync.nextSeq();
    });
    const s2 = await db.tx(async (t) => {
      await put(t, "async");
      return t.nextSeq();
    });
    const s3 = sync.nextSeq();
    expect(s2).toBe((s1 + 1) as typeof s1);
    expect(s3).toBe((s2 + 1) as typeof s2);
    expect(await keys(db)).toEqual(["async", "sync"]);
    expect(() =>
      sync.tx(() => {
        sync.sql.run("INSERT INTO scratch (k, v) VALUES ('rolled', 1)");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(await keys(db)).toEqual(["async", "sync"]);
  });
});
