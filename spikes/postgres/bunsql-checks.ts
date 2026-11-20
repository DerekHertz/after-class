/**
 * Small runnable checks of what Bun.sql does on Bun 1.4.3 against PostgreSQL 17. One block per question.
 *   bun run spikes/postgres/bunsql-checks.ts
 * Every wait is raced against a timer, so a hang prints HANG instead of stalling the run.
 */
import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { freshDatabase } from "./pg";

const f = await freshDatabase("spike_bunsql");
const mk = (opts: Record<string, unknown> = {}) => new SQL({ url: f.url, max: 5, ...opts } as never);
const db = mk();
const results: string[] = [];
const note = (label: string, value: unknown) => {
  const line = `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  results.push(line);
  console.log(line);
};
const within = <T>(p: Promise<T>, ms: number): Promise<T | "HANG"> => Promise.race([p, Bun.sleep(ms).then(() => "HANG" as const)]);
const err = async (p: PromiseLike<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e as Error & { code?: string; errno?: string; detail?: string; constraint?: string; table?: string };
  }
};

await db.unsafe(`CREATE TABLE acct (id int PRIMARY KEY, bal bigint NOT NULL CHECK (bal >= 0))`);
await db.unsafe(`INSERT INTO acct VALUES (1, 100), (2, 100)`);

console.log("== 1. transactions ==");
{
  await db.begin(async (t) => {
    await t`UPDATE acct SET bal = bal - 10 WHERE id = 1`;
    await t`UPDATE acct SET bal = bal + 10 WHERE id = 2`;
  });
  note("commit keeps both writes", (await db`SELECT id, bal::int AS bal FROM acct ORDER BY id`).map((r: { bal: number }) => r.bal));

  const e = await err(
    db.begin(async (t) => {
      await t`UPDATE acct SET bal = 0 WHERE id = 1`;
      throw new Error("boom");
    }),
  );
  note("throw inside begin rejects with", e?.message);
  note("and rolls back", (await db`SELECT bal::int AS bal FROM acct WHERE id = 1`)[0].bal);

  const e2 = await err(
    db.begin(async (t) => {
      await t`UPDATE acct SET bal = bal - 1000 WHERE id = 1`;
    }),
  );
  note("CHECK violation inside begin", { errno: e2?.errno, code: e2?.code, constraint: e2?.constraint });

  const sp = await db.begin(async (t) => {
    await t`UPDATE acct SET bal = bal + 1 WHERE id = 1`;
    const inner = await err(
      t.savepoint(async (s) => {
        await s`UPDATE acct SET bal = bal + 1000 WHERE id = 1`;
        throw new Error("inner");
      }),
    );
    const mid = (await t`SELECT bal::int AS bal FROM acct WHERE id = 1`)[0].bal;
    return { inner: inner?.message, balAfterInnerRollback: mid };
  });
  note("savepoint: inner throw rolls back only the inner work", sp);

  const ret = await db.begin(async (t) => (await t`SELECT 42 AS n`)[0].n);
  note("begin returns the callback value", ret);

  const als = new AsyncLocalStorage<SQL>();
  const viaAls = await db.begin((t) => als.run(t, async () => {
    await Bun.sleep(5);
    const cur = als.getStore()!;
    await cur`UPDATE acct SET bal = bal + 0 WHERE id = 2`;
    return cur === t;
  }));
  note("AsyncLocalStorage carries the transaction handle across awaits", viaAls);
}

console.log("== 2. pg_advisory_xact_lock ==");
{
  const hold = 400;
  const t0 = Date.now();
  let secondEntered = 0;
  const a = db.begin(async (t) => {
    await t`SELECT pg_advisory_xact_lock(${12345})`;
    await Bun.sleep(hold);
  });
  await Bun.sleep(50);
  const b = db.begin(async (t) => {
    await t`SELECT pg_advisory_xact_lock(${12345})`;
    secondEntered = Date.now() - t0;
  });
  await Promise.all([a, b]);
  note("same key: second transaction got the lock after", `${secondEntered} ms (first held it ${hold} ms)`);

  const t1 = Date.now();
  await Promise.all(
    [1, 2, 3].map((k) =>
      db.begin(async (t) => {
        await t`SELECT pg_advisory_xact_lock(${k})`;
        await Bun.sleep(hold);
      }),
    ),
  );
  note("three different keys ran in parallel in", `${Date.now() - t1} ms (serial would be ${3 * hold})`);

  const r = await err(
    db.begin(async (t) => {
      await t`SELECT pg_advisory_xact_lock(${777})`;
      throw new Error("x");
    }),
  );
  const got = await within(db`SELECT pg_try_advisory_lock(${777}) AS ok`.then((x: { ok: boolean }[]) => x[0]!.ok), 2000);
  note("lock released after a rollback", got);
  await db`SELECT pg_advisory_unlock(${777})`;
  void r;

  const key = "user_abc";
  const hashed = await db`SELECT hashtextextended(${key}, 0) AS k`;
  note("per-user key from a text id via hashtextextended (bigint, returned as)", typeof hashed[0].k);
  const two = await db`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NOT NULL AS ok`;
  note("lock call returns", two[0].ok);
}

console.log("== 3. jsonb ==");
{
  await db.unsafe(`CREATE TABLE doc (id int PRIMARY KEY, j jsonb, t text)`);
  await db`INSERT INTO doc VALUES (1, ${{ b: 1, a: [1, 2, { z: null }] }}, 'x')`;
  const r1 = await db`SELECT j, jsonb_typeof(j) AS ty FROM doc WHERE id = 1`;
  note("JS object into jsonb param, read back as", { value: r1[0].j, typeofValue: typeof r1[0].j, pgType: r1[0].ty });

  const text = `{"b":1,  "a":[1,2,{"z":null}]}`;
  await db`INSERT INTO doc VALUES (2, ${text}::jsonb, ${text})`;
  const r2 = await db`SELECT jsonb_typeof(j) AS ty, j::text AS as_text FROM doc WHERE id = 2`;
  note("string param with an explicit ::jsonb cast is stored as", { pgType: r2[0].ty, asText: r2[0].as_text });

  await db`INSERT INTO doc VALUES (3, ${text}, 'x')`;
  const r3 = await db`SELECT jsonb_typeof(j) AS ty, j FROM doc WHERE id = 3`;
  note("string param into a jsonb column without a cast is stored as", { pgType: r3[0].ty, value: r3[0].j });

  await db.unsafe(`INSERT INTO doc VALUES (6, $1::text::jsonb, null)`, [text]);
  const r6 = await db`SELECT jsonb_typeof(j) AS ty, j::text AS as_text FROM doc WHERE id = 6`;
  note("string param cast ::text::jsonb is parsed and stored as", { pgType: r6[0].ty, asText: r6[0].as_text });

  const r4 = await db`SELECT j ->> 'b' AS b, (SELECT array_agg(e) FROM jsonb_array_elements_text(j -> 'a') e) AS arr FROM doc WHERE id = 1`;
  note("->> and jsonb_array_elements_text", { b: r4[0].b, arr: r4[0].arr });

  const nul = await err(db.unsafe(`INSERT INTO doc VALUES (4, '{"a":"x\\u0000y"}'::jsonb, null)`));
  note("jsonb rejects \\u0000 in a string", nul?.message);
  const nul2 = await err(db.unsafe(`INSERT INTO doc VALUES (5, null, $1)`, ["a\u0000b"]));
  note("text rejects a NUL byte", nul2?.message);

  const big = await db`SELECT '{"n": 12345678901234567890, "f": 1.10, "e": 1e2}'::jsonb AS j`;
  note("jsonb number handling after parse (JS side)", big[0].j);
  const bigText = await db`SELECT ('{"n": 12345678901234567890, "f": 1.10, "e": 1e2}'::jsonb)::text AS t`;
  note("jsonb number handling as text", bigText[0].t);
  const jsonCol = await db`SELECT '{"b": 1,  "a": 2}'::json::text AS t`;
  note("json (not jsonb) keeps the original text", jsonCol[0].t);
}

console.log("== 4. prepared statements ==");
{
  const one = mk({ max: 1 });
  await one`SELECT ${1}::int AS a`;
  await one`SELECT ${2}::int AS a`;
  await one`SELECT ${3}::int AS a`;
  const ps = await one`SELECT name, statement FROM pg_prepared_statements`;
  note("default: named prepared statements on the connection after 3 tagged-template runs", { count: ps.length, first: ps[0]?.statement });
  const un = await one.unsafe(`SELECT $1::int AS a`, [1]);
  void un;
  const ps2 = await one`SELECT count(*)::int AS n FROM pg_prepared_statements`;
  note("after one unsafe() with params, prepared statements now", ps2[0].n);
  await one.close();

  const np = mk({ max: 1, prepare: false });
  await np`SELECT ${1}::int AS a`;
  await np`SELECT ${2}::int AS a`;
  const ps3 = await np`SELECT count(*)::int AS n FROM pg_prepared_statements`;
  note("with { prepare: false } prepared statements on the connection", ps3[0].n);
  await np.close();

  const one2 = mk({ max: 1 });
  await one2.unsafe(`CREATE TABLE IF NOT EXISTS ddl_cache (a int)`);
  await one2`SELECT * FROM ddl_cache`;
  await one2.unsafe(`ALTER TABLE ddl_cache ADD COLUMN b int`);
  const first = await err(one2`SELECT * FROM ddl_cache`);
  const second = await err(one2`SELECT * FROM ddl_cache`);
  const explicit = await err(one2`SELECT a FROM ddl_cache`);
  note("cached `SELECT *` after ALTER TABLE ADD COLUMN, first retry", first ? first.message : "works");
  note("second retry on the same connection", second ? second.message : "works");
  note("an explicit column list on the same connection", explicit ? explicit.message : "works");
  await one2.close({ timeout: 0 }).catch(() => {});
  const fresh = mk({ max: 1, prepare: false });
  await fresh`SELECT * FROM ddl_cache`;
  await fresh.unsafe(`ALTER TABLE ddl_cache ADD COLUMN c int`);
  const nf = await err(fresh`SELECT * FROM ddl_cache`);
  note("with { prepare: false } the same ALTER then SELECT *", nf ? nf.message : "works");
  await fresh.close();
}

console.log("== 5. connection pool ==");
{
  const pool = mk({ max: 4 });
  const t0 = Date.now();
  let peak = 0;
  const watcher = setInterval(async () => {
    const r = await db`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${"spike_bunsql"} AND state = 'active' AND query LIKE 'SELECT pg_sleep%'`;
    peak = Math.max(peak, r[0].n);
  }, 40);
  await Promise.all(Array.from({ length: 12 }, () => pool`SELECT pg_sleep(0.3)`));
  clearInterval(watcher);
  note("12 slow queries through max:4", `${Date.now() - t0} ms (ideal 3 waves = 900 ms), peak concurrent sleeps seen: ${peak}`);

  const small = mk({ max: 2 });
  const dead = await within(
    Promise.all([
      small.begin(async () => { await Bun.sleep(100); await small`SELECT 1`; }),
      small.begin(async () => { await Bun.sleep(100); await small`SELECT 1`; }),
    ]),
    2500,
  );
  note("pool deadlock: 2 transactions on max:2 that each also query the pool (not the tx handle)", dead === "HANG" ? "HANG (needs a third connection; this is the async rewrite's main trap)" : "no hang");

  const victim = mk({ max: 1 });
  const pid = (await victim`SELECT pg_backend_pid() AS pid`)[0].pid;
  await db`SELECT pg_terminate_backend(${pid})`;
  await Bun.sleep(100);
  const after = await within(victim`SELECT 1 AS ok`.then((x: { ok: number }[]) => x[0]!.ok).catch((e: Error & { code?: string }) => `error ${e.code} ${e.message}`), 3000);
  note("query right after the server killed the pooled connection", after);
  const after2 = await within(victim`SELECT 1 AS ok`.then((x: { ok: number }[]) => x[0]!.ok).catch((e: Error) => `error ${e.message}`), 3000);
  note("next query", after2);
  await victim.close({ timeout: 0 }).catch(() => {});

  const idle = mk({ max: 3, idleTimeout: 1 });
  await Promise.all([idle`SELECT 1`, idle`SELECT 1`, idle`SELECT 1`]);
  const before = (await db`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = 'spike_bunsql' AND pid <> pg_backend_pid()`)[0].n;
  await Bun.sleep(2500);
  const afterIdle = (await db`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = 'spike_bunsql' AND pid <> pg_backend_pid()`)[0].n;
  note("idleTimeout: 1 s drops idle connections (this db's other connections before and after)", { before, afterIdle });
  await idle.close({ timeout: 0 }).catch(() => {});
  await pool.close({ timeout: 0 }).catch(() => {});
}

console.log("== 6. errors from a PL/pgSQL trigger ==");
{
  await db.unsafe(`CREATE TABLE ledger (id int PRIMARY KEY, v text)`);
  await db.unsafe(`CREATE OR REPLACE FUNCTION ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN RAISE EXCEPTION '%', 'R17: ledger is append-only' USING ERRCODE = 'AC017', DETAIL = 'row ' || OLD.id, HINT = 'insert a new row'; RETURN NEW; END $f$`);
  await db.unsafe(`CREATE TRIGGER ledger_t BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION ledger_guard()`);
  await db`INSERT INTO ledger VALUES (1, 'a')`;
  const e = await err(db`UPDATE ledger SET v = 'b'`);
  note("RAISE EXCEPTION surfaces as", { class: e?.constructor.name, code: e?.code, errno: e?.errno, message: e?.message, detail: e?.detail, table: e?.table });
  note("a test can match it by message", /R17/.test(e?.message ?? ""));
  const e2 = await err(
    db.begin(async (t) => {
      await t`INSERT INTO ledger VALUES (2, 'c')`;
      await t`DELETE FROM ledger WHERE id = 1`;
    }),
  );
  note("inside begin the error rejects the transaction and the earlier insert is gone", { errno: e2?.errno, rows: (await db`SELECT count(*)::int AS n FROM ledger`)[0].n });
  const e3 = await err(
    db.begin(async (t) => {
      const inner = await err(t`DELETE FROM ledger`);
      note("statement after catching a trigger error in the same transaction", (await err(t`SELECT 1`))?.message ?? "works");
      void inner;
    }),
  );
  note("transaction that swallowed a failed statement then ended", e3?.message ?? "committed without error");
  await db.unsafe(`CREATE FUNCTION ledger_stmt_guard() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'R17: no truncate' USING ERRCODE = 'AC017'; END $f$`);
  await db.unsafe(`CREATE TRIGGER ledger_trunc BEFORE TRUNCATE ON ledger FOR EACH STATEMENT EXECUTE FUNCTION ledger_stmt_guard()`);
  note("BEFORE TRUNCATE statement trigger blocks TRUNCATE", (await err(db.unsafe(`TRUNCATE ledger`)))?.errno);
}

console.log("== 7. value types ==");
{
  const r = await db`SELECT 2::bigint AS big, 2::int AS i, count(*) AS n, sum(1) AS s, 1.5::float8 AS f, 3::numeric AS num, true AS b, 'x'::text AS t, now() AS ts, '\\x0102'::bytea AS by`;
  const row = r[0];
  note("JS types of bigint, int, count(*), sum(int), float8, numeric, boolean, timestamptz, bytea", {
    big: typeof row.big, i: typeof row.i, n: typeof row.n, s: typeof row.s, f: typeof row.f, num: typeof row.num, b: typeof row.b, ts: row.ts instanceof Date ? "Date" : typeof row.ts, by: row.by?.constructor.name,
  });
  const msNow = Date.now();
  const back = await db`SELECT ${msNow}::bigint AS ms`;
  note("a JS ms timestamp round-trips through bigint as", { value: back[0].ms, type: typeof back[0].ms });
  const asInt = await db`SELECT ${msNow}::int AS ms`.then(() => "ok", (e: Error) => e.message);
  note("the same ms timestamp cast to int4", asInt);
  const opt = mk({ bigint: true });
  const bb = await opt`SELECT 2::bigint AS big, count(*) AS n`;
  note("option { bigint: true } returns", { big: typeof bb[0].big, n: typeof bb[0].n });
  await opt.close();
  const bare = await err(db.unsafe(`SELECT $1::text[] AS a`, [["x", "y"]] as never));
  note("unsafe() with a bare JS array bound to text[]", bare ? bare.message : "works");
  const viaArray = await err(db`SELECT x FROM unnest(ARRAY['p','q','r']) AS x WHERE x = ANY(${db.array(["p", "r"], "TEXT")})`);
  note("tagged template with db.array([...], 'TEXT') in = ANY(...)", viaArray ? viaArray.message : (await db`SELECT x FROM unnest(ARRAY['p','q','r']) AS x WHERE x = ANY(${db.array(["p", "r"], "TEXT")})`).map((r: { x: string }) => r.x));
  const viaJson = await db.unsafe(`SELECT x FROM unnest(ARRAY['p','q','r']) AS x WHERE x IN (SELECT jsonb_array_elements_text($1::text::jsonb))`, [JSON.stringify(["p", "r"])]);
  note("a JSON text param through jsonb_array_elements_text (what json_each(?) did)", viaJson.map((r: { x: string }) => r.x));
  const cnt = await db`SELECT count(*)::int AS n FROM acct`;
  note("count(*)::int comes back as", typeof cnt[0].n);
  const nullParam = await db.unsafe(`SELECT $1::text IS NULL AS isnull`, [null]);
  note("null param with a cast", nullParam[0].isnull);
}

console.log("== 8. close ==");
{
  const t0 = Date.now();
  await db.close();
  note("close()", `${Date.now() - t0} ms`);
}

await f.drop();
console.log(`\n${results.length} observations`);
process.exit(0);
