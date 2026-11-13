import { describe, expect, test } from "bun:test";
import { ConnectionBusyError, LOCAL_USER } from "../src/backend/db";
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
/** Yield to other promise continuations without leaving the microtask queue, as a database call does. */
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

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
        await ticks(5);
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

  test("a second wrapper of the same Db shares the open transaction's refusal and the queue", async () => {
    const sync = testDb();
    sync.sql.run("CREATE TABLE scratch (k TEXT PRIMARY KEY, v INTEGER NOT NULL) STRICT");
    const a = asAsync(sync);
    const b = asAsync(sync);
    await a.tx(async (t) => {
      await put(t, "a");
      await expect(b.run("INSERT INTO scratch (k, v) VALUES ('b', 1)")).rejects.toThrow(/outside the transaction handle/);
    });
    const trace: string[] = [];
    const run = (db: AsyncDb, name: string) =>
      db.tx(async (t) => {
        trace.push(`${name} start`);
        await ticks(5);
        await put(t, name);
        trace.push(`${name} end`);
      });
    await Promise.all([run(a, "x"), run(b, "y")]);
    expect(trace).toEqual(["x start", "x end", "y start", "y end"]);
    expect(await keys(a)).toEqual(["a", "x", "y"]);
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

  test("one lockUsers call takes every listed user once, in ascending order, whatever the order or repeats", async () => {
    const { db } = setup();
    const [low, high] = [A, B].sort() as [typeof A, typeof A];
    await db.tx(async (t) => {
      await t.lockUsers(high, low, high);
      expect(t.heldUserLocks()).toEqual([low, high]);
      await t.lockUsers(low);
      expect(t.heldUserLocks()).toEqual([low, high]);
    });
  });

  test("a user below one already held is refused, so no transaction takes locks in descending order", async () => {
    const { db } = setup();
    const [low, high] = [A, B].sort() as [typeof A, typeof A];
    await expect(
      db.withUserLock(high, async (t) => {
        await t.lockUsers(low);
      }),
    ).rejects.toThrow(/lock order/);
    await db.withUserLock(low, (t) => t.lockUsers(high));
  });

  test("a second command for the same user does not start until the first one's transaction has ended", async () => {
    const { db } = setup();
    const trace: string[] = [];
    const command = (name: string) =>
      db.withUserLock(A, async (t) => {
        trace.push(`${name} start`);
        await ticks(5);
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

describe("async Db: savepoint lifetime and a rollback SQLite does on its own", () => {
  test("a savepoint left running when its transaction settles fails the transaction, and its later work never lands", async () => {
    const { db } = setup();
    let child!: Promise<unknown>;
    await expect(
      db.tx(async (t) => {
        child = t.tx(async (inner) => {
          await ticks(3);
          await put(inner, "child");
        });
        child.catch(() => undefined);
      }),
    ).rejects.toThrow(/savepoint still running/);
    await expect(child).rejects.toThrow(/after its transaction ended|rolled back/);
    await delay(5);
    expect(await keys(db)).toEqual([]);
  });

  test("a failure that makes SQLite roll the whole transaction back kills the transaction, so nothing after it autocommits", async () => {
    const { db } = setup();
    await expect(
      db.tx(async (t) => {
        await put(t, "x");
        await t.tx((inner) => inner.run("INSERT OR ROLLBACK INTO scratch (k, v) VALUES ('x', 1)")).catch(() => undefined);
        await put(t, "after");
      }),
    ).rejects.toThrow(/transaction was rolled back/);
    expect(await keys(db)).toEqual([]);
  });

  test("a body that catches that failure and returns still rejects and leaves nothing behind", async () => {
    const { db } = setup();
    await expect(
      db.tx(async (t) => {
        await put(t, "x");
        await t.tx((inner) => inner.run("INSERT OR ROLLBACK INTO scratch (k, v) VALUES ('x', 1)")).catch(() => undefined);
      }),
    ).rejects.toThrow(/transaction was rolled back: .*UNIQUE/);
    expect(await keys(db)).toEqual([]);
  });
});

describe("async Db: a transaction body awaits only the database", () => {
  test("a long chain of database calls and microtasks finishes before any timer or immediate runs", async () => {
    const { db } = setup();
    let fired = false;
    setImmediate(() => (fired = true));
    setTimeout(() => (fired = true), 0);
    await db.tx(async (t) => {
      for (let i = 0; i < 200; i++) await t.get("SELECT 1 AS one");
      await ticks(1000);
      await t.nextSeq();
      expect(fired).toBe(false);
    });
    expect(fired).toBe(false);
  });

  test.each([
    ["a timer", () => delay(0)],
    ["an immediate", () => new Promise<void>((resolve) => setImmediate(resolve))],
  ])("awaiting %s rolls the transaction back at once and rejects with the named error", async (_, wait) => {
    const { db } = setup();
    await expect(
      db.tx(async (t) => {
        await put(t, "a");
        await wait();
        await put(t, "b");
      }),
    ).rejects.toThrow(/awaited something other than the database/);
    expect(await keys(db)).toEqual([]);
  });

  test("a body that awaits a timer and then returns without another statement still rejects and keeps nothing", async () => {
    const { db } = setup();
    await expect(
      db.tx(async (t) => {
        await put(t, "a");
        await delay(5);
      }),
    ).rejects.toThrow(/awaited something other than the database/);
    expect(await keys(db)).toEqual([]);
  });

  test("another task's sync command that runs while such a body waits is acknowledged and is not rolled back", async () => {
    const { sync, db } = setup();
    const before = sync.nextSeq();
    let other = before;
    setTimeout(() => {
      other = sync.nextSeq();
      sync.sql.run("INSERT INTO scratch (k, v) VALUES ('sync', 1)");
    }, 2);
    await expect(
      db.tx(async (t) => {
        await t.nextSeq();
        await delay(20);
      }),
    ).rejects.toThrow(/awaited something other than the database/);
    expect(other).toBe((before + 1) as typeof before);
    expect(await keys(db)).toEqual(["sync"]);
    expect(sync.nextSeq()).toBe((other + 1) as typeof other);
  });

  test("expiry rejects the transaction and frees the queue at once, even if the body never resumes", async () => {
    const { db } = setup();
    const stuck = db.tx(async (t) => {
      await put(t, "a");
      await new Promise<never>(() => undefined);
    });
    await expect(stuck).rejects.toThrow(/awaited something other than the database/);
    await db.tx((t) => put(t, "b"));
    expect(await keys(db)).toEqual(["b"]);
  });

  test("a statement from the abandoned body after expiry throws and cannot touch the next transaction", async () => {
    const { db } = setup();
    let late!: Tx;
    const gate = Promise.withResolvers<void>();
    const expired = db.tx(async (t) => {
      late = t;
      await gate.promise;
    });
    await expect(expired).rejects.toThrow(/awaited something other than the database/);
    await db.tx(async (t) => {
      await put(t, "next");
      gate.resolve();
      await ticks(3);
      await expect(put(late, "late")).rejects.toThrow(/awaited something other than the database/);
    });
    expect(await keys(db)).toEqual(["next"]);
  });

  test("a statement on the connection from another task is allowed once the open transaction expired", async () => {
    const { db } = setup();
    const outcome = db
      .tx(async () => {
        await delay(20);
      })
      .then(
        () => "committed",
        (e: Error) => e.message,
      );
    await delay(5);
    expect(await keys(db)).toEqual([]);
    expect(await outcome).toMatch(/awaited something other than the database/);
  });
});

describe("async Db: a descendant savepoint cannot outlive a failed ancestor", () => {
  test("an unawaited grandchild whose parent failed cannot write, and the root still commits its own work", async () => {
    const { db } = setup();
    await db.tx(async (t) => {
      await t
        .tx(async (child) => {
          child
            .tx(async (grand) => {
              await ticks(3);
              await put(grand, "grand");
            })
            .catch(() => undefined);
        })
        .then(
          () => expect.unreachable("the child should fail with its grandchild still running"),
          (e: Error) => expect(e.message).toMatch(/savepoint still running/),
        );
      await ticks(10);
      await put(t, "root");
    });
    expect(await keys(db)).toEqual(["root"]);
  });
});

describe("the raw connection during an async transaction", () => {
  test("an unrelated promise continuation writing through db.sql, the shape of an HTTP handler, throws and is not acknowledged", async () => {
    const { sync, db } = setup();
    const outcome: string[] = [];
    await db.tx(async (t) => {
      await put(t, "mine");
      const handler = Promise.resolve().then(() => {
        sync.sql.run("INSERT INTO scratch (k, v) VALUES ('handler', 1)");
        outcome.push("acknowledged");
      });
      handler.catch((e: Error) => outcome.push(e.name));
      await ticks(5);
    });
    expect(outcome).toEqual(["ConnectionBusyError"]);
    expect(await keys(db)).toEqual(["mine"]);
  });

  test("query, prepare, exec, transaction and a statement prepared earlier all throw while a transaction is open, and work after", async () => {
    const { sync, db } = setup();
    const earlier = sync.sql.query("INSERT INTO scratch (k, v) VALUES ('earlier', 1)");
    const prepared = sync.sql.prepare("SELECT k FROM scratch");
    await db.tx(async (t) => {
      await put(t, "mine");
      expect(() => sync.sql.query("SELECT 1")).toThrow(/asynchronous transaction is open/);
      expect(() => sync.sql.prepare("SELECT 1")).toThrow(/asynchronous transaction is open/);
      expect(() => sync.sql.exec("SELECT 1")).toThrow(/asynchronous transaction is open/);
      expect(() => sync.sql.transaction(() => 1)()).toThrow(/asynchronous transaction is open/);
      expect(() => earlier.run()).toThrow(/asynchronous transaction is open/);
      expect(() => prepared.all()).toThrow(/asynchronous transaction is open/);
    });
    earlier.run();
    expect(prepared.all()).toEqual([{ k: "earlier" }, { k: "mine" }]);
  });

  test("the refusal is the named error", async () => {
    const { sync, db } = setup();
    await db.tx(async () => {
      expect(() => sync.sql.query("SELECT 1")).toThrow(ConnectionBusyError);
    });
  });
});

describe("the synchronous Db during an async transaction", () => {
  test("sync tx and sync nextSeq throw while an async transaction is open, and work after it", async () => {
    const { sync, db } = setup();
    await db.tx(async (t) => {
      await put(t, "a");
      expect(() => sync.nextSeq()).toThrow(/asynchronous transaction is open/);
      expect(() => sync.tx(() => 1)).toThrow(/asynchronous transaction is open/);
    });
    expect(sync.tx(() => sync.nextSeq())).toBeGreaterThan(0);
  });

  test("a sync tx may still nest sync txs and take Seqs inside itself", () => {
    const { sync } = setup();
    expect(sync.tx(() => sync.tx(() => sync.nextSeq()))).toBeGreaterThan(0);
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
