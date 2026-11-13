# Spike 1: the kernel and every migration on PostgreSQL through Bun.sql

Status: results of Phase 0, Spike 1 in `docs/architecture/plan.md`. Run on 2026-11-13 against `master` at `476d2a4`. Nothing under `src/` or `test/` changed. The scratch code is in `spikes/postgres/`.

## Goal

Find out what in After Class's SQLite dialect does not carry over to PostgreSQL, how many call sites must become asynchronous, and whether `Bun.sql` on Bun 1.4.3 does what the plan needs. The answer decides how big Phases 2 and 3 are.

## What I ran

- PostgreSQL 17.6 from the official `postgres:17.6` image, in a local container that was removed at the end. No other database, no live API call, no file under `data/` or `~/afterclass-data` was touched.
- Bun 1.4.3 with the built-in `Bun.sql`. No dependency was added.
- `kernel-pg.ts` reimplements the `db.ts` runner and `nextSeq` on `Bun.sql`. `translate.ts` translates the 13 migrations mechanically.
- `kernel.pg.test.ts` is `test/db.test.ts` ported case for case, plus a concurrent start and a TRUNCATE case. All 17 tests pass.
- `queries-check.ts` pulls every SQL statement out of `src/backend`, rewrites the placeholders, and asks PostgreSQL to `PREPARE` it against the migrated schema.
- `dialect-checks.ts` runs the same SQL on SQLite and PostgreSQL where behaviour could differ without an error.
- `bunsql-checks.ts` is one runnable check per `Bun.sql` question. `count-callsites.ts` counts call sites.

To reproduce, start a container with `docker run -d --name ac-spike-pg -e POSTGRES_PASSWORD=spike -p 127.0.0.1:55432:5432 postgres:17.6` and run `bun run spikes/postgres/<script>.ts`. Set `SPIKE_PG_URL` to use another address.

## Result in one table

| Question | Answer |
| --- | --- |
| Do the migrations carry over | 12 of 13 translate by a few text rules. 1 needs a hand-written replacement. |
| Do the queries carry over | 72 of 86 statements run unchanged after `?` becomes `$n`. 14 need one of 7 rewrites. All 86 then prepare. |
| Does the kernel test file pass | Yes, 17 of 17, including all of R7, R14, R16 and R17. |
| Call sites to make asynchronous | 107 SQL executions, 16 transaction blocks and 11 `nextSeq` calls, 134 in all. The plan's 86 is the count of distinct statements. |
| Does `Bun.sql` do what the plan needs | Yes for transactions, savepoints, advisory locks, prepared statements, pool and trigger errors. Five behaviours need a rule. |
| Silent differences that no error reveals | Six. Two of them break a Derek rule if left alone. |

## Migrations

Twelve migrations needed only these text rules, applied by `translate.ts`.

- Drop `STRICT`. Map `INTEGER` to `BIGINT` and `REAL` to `DOUBLE PRECISION`.
- Rewrite each trigger of the form `BEFORE UPDATE|DELETE ... BEGIN SELECT RAISE(ABORT, 'msg'); END` into a PL/pgSQL function that runs `RAISE EXCEPTION`, plus a `CREATE TRIGGER ... FOR EACH ROW EXECUTE FUNCTION`.
- Remove `PRAGMA` lines.

The 17 triggers are 12 append-only guards, two of them carrying R7, R8, R16 or R17 text, two R17 delete guards and three R16 guards. All 17 were translated by one regular expression, and the ported R16 tests pass. R14 is a CHECK constraint, not a trigger, and it carried over as it was.

One migration did not translate. `providers/003-diagram-purpose` rebuilds two tables behind `PRAGMA defer_foreign_keys`. PostgreSQL refuses `DROP TABLE memo_inputs` while `memo` and `memo_failures` point at it, and `DROP ... CASCADE` would silently remove those two foreign keys. The intent is two wider CHECK lists, so the replacement is one `ALTER TABLE ... DROP CONSTRAINT ..., ADD CONSTRAINT ...` per table. A new PostgreSQL baseline does not need the rebuild at all, because it can start with the final list.

Needed real thought, beyond the text rules.

- PostgreSQL rejects a subquery in a trigger `WHEN` condition. I ran it and got `cannot use subquery in trigger WHEN condition`. The three R16 triggers use `EXISTS` there, so the condition moves into the function body. The translator does this mechanically.
- `TRUNCATE` does not fire row triggers. SQLite has no `TRUNCATE`. The ported test shows `TRUNCATE usage_events` succeeds and empties the ledger. R17 needs a `BEFORE TRUNCATE` statement trigger on each append-only table. I confirmed that a statement trigger blocks it.
- `REAL` is 4 bytes in PostgreSQL. `0.1234567891` came back as `0.12345679`. It must be `DOUBLE PRECISION` for `cost_usd`, `wall_ms` and `media_s`.
- Millisecond timestamps need `BIGINT` and arrive as strings, see the type table below.

## Dialect features, one by one

| Feature | Used in the repo | Carries over | What to do |
| --- | --- | --- | --- |
| `STRICT` | every table | No | Drop it. PostgreSQL columns are typed already. |
| `INSERT OR IGNORE` | 6 statements | Syntax no, behaviour no | `ON CONFLICT DO NOTHING`. See the silent differences. |
| `INSERT OR REPLACE` | none | n/a | |
| `ON CONFLICT DO UPDATE` and `excluded` | 9 statements, plus 1 `DO NOTHING` | Yes | `memo.ts` needs `memo_failures.attempts` because a bare `attempts` is ambiguous. |
| `RETURNING` | 6 statements | Yes | None. |
| Triggers and `RAISE(ABORT, ...)` | 17 | No | PL/pgSQL, as above. The error text survives, so `toThrow(/R17/)` still matches. |
| `json_extract` | 1 | No | `(body_json::jsonb ->> 'action')`. |
| `json_each` | 2 | No | `jsonb_array_elements_text(col::jsonb) AS e(value)`. |
| `rowid` | 3 `ORDER BY` | No | Add `ord BIGINT GENERATED ALWAYS AS IDENTITY` to `notes`, `observations` and `link_suggestions`. |
| `SUM(boolean)` | 2 | No | `COUNT(*) FILTER (WHERE ...)`. This also returns 0 instead of NULL. |
| `PRAGMA` | 3 in `openDb`, 1 in a migration, 1 in a test | No | Gone. Foreign keys are always on. |
| Type affinity | none left, every table is `STRICT` | Mostly | `BIGINT` returns strings. See below. |
| Datetime functions | none, all times are epoch milliseconds | n/a | |
| Partial indexes | none | n/a | |
| Generated columns | none | n/a | |
| `?` and `?N` placeholders | all | No | `$n`. `placeholders()` in `pg.ts` rewrites them. |
| `$n IS NULL` filters | 3 | No | The first use gives no type. Write `$n::text IS NULL`. |

## Silent differences

`PREPARE` proves a statement parses. It does not prove it behaves the same. These came from running both engines on the same rows.

1. `INSERT OR IGNORE` also swallows CHECK and NOT NULL failures. A `frames` row with width 100 stored nothing in SQLite and raised an error on PostgreSQL. The duplicate-key case the code means behaves the same. A bad frame would now fail the whole ingest transaction.
2. `EXISTS(...)` returns 1 in SQLite and `true` in PostgreSQL. `evidence/index.ts` tests `has_bytes === 1`, which is false for `true`. No error, just wrong. Cast with `::int`.
3. `BIGINT`, `COUNT(*)`, `SUM` and `NUMERIC` arrive as strings. Only `INTEGER` and `DOUBLE PRECISION` arrive as numbers. Every `*_ms` column holds a value above 2^31, so it must be `BIGINT`. Options are a read-side conversion at one place, `DOUBLE PRECISION` for the timestamps, or `{ bigint: true }`, which returns `BigInt` for all of them. I did not decide among them.
4. Text ordering. SQLite sorts bytes. The container database uses `en_US.utf8`, which sorted `["a b","a-b","a_b","ab","aB","Ab"]` where SQLite gave `["Ab","a b","a-b","aB","a_b","ab"]`. Create the database with the `C` collation or order with `COLLATE "C"`.
5. Ten statements use `SELECT *`. See the prepared statement result below, they break when a migration adds a column.
6. A test that relies on `sqlite_master` or `PRAGMA foreign_key_check` has no PostgreSQL form. There are three, in `db.test.ts`, `e2e-replay.test.ts` and `diagram.test.ts`.

Two more are about concurrency, and they matter more than the rest.

- R16 is not safe at the default isolation level on its own. One connection inserted a review and held its transaction open. A second connection ran the expiry delete. The trigger found no review, because the review was uncommitted, so the delete committed. Afterwards the review existed and its raw facts were gone. With both transactions taking the same `pg_advisory_xact_lock` first, the delete was blocked by the trigger and nothing was lost. SQLite never showed this, because one writer at a time hid it. The advisory lock is therefore required for R16, and `sweepExpired` must take it too.
- The global `seq_counter` row serializes everything. Four transactions that each took a Seq and then worked for 300 ms finished in 1214 ms, which is serial. A PostgreSQL sequence runs in parallel, but a rolled-back `nextval` is gone and values need not commit in order. `appliesBefore` and `asOf` rely on Seq order matching commit order, so keep a counter row per user, taken under that user's lock, as the plan says.

## Call sites

`count-callsites.ts` scans each file, matches the parentheses of every `db.sql.query` and `db.sql.run`, and checks whether the call runs in place or is stored under a name. Stored statements are then counted where they run. A test preload, `site-recorder.ts`, records every statement execution during `bun test` as a cross-check. The suite of 1616 tests reached 116 distinct source lines in `src/backend`, against 118 counted here. The two numbers agree closely, and the gap is lines the suite never reaches or two sites on one line.

| Module | SQL executions | `db.tx` blocks | `db.nextSeq` | Total |
| --- | --- | --- | --- | --- |
| evidence | 32 | 4 | 2 | 38 |
| record | 23 | 1 | 0 | 24 |
| preparation | 16 | 3 | 4 | 23 |
| providers/memo | 14 | 4 | 2 | 20 |
| review | 10 | 3 | 0 | 13 |
| segmentation | 5 | 1 | 0 | 6 |
| providers/ledger | 5 | 0 | 0 | 5 |
| main | 1 | 0 | 3 | 4 |
| providers/elevenlabs | 1 | 0 | 0 | 1 |
| Total | 107 | 16 | 11 | 134 |

The plan's "about 86" is the number of distinct SQL statements, and I also count 86. The work is the 134 places that run them. Add the sync methods that sit on top. The grep estimate, by receiver name and not traced, is about 75 calls from other modules and `http.ts` into evidence, record, review, segmentation and `memo.lookup`. Tests and scripts add 133 more lines that touch `db.sql`, `db.tx` or `nextSeq`.

## What `Bun.sql` 1.4.3 does

| Check | Result |
| --- | --- |
| Transactions | `sql.begin(fn)` commits, rolls back on a throw, and returns the callback's value. A CHECK failure inside it rejects with SQLSTATE `23514` and the constraint name. |
| Savepoints | `t.savepoint(fn)` rolled back only the inner work. This is the equivalent of today's nested `tx`. |
| Transaction handle | The handle is a separate object. `AsyncLocalStorage` carried it across awaits, so ambient `tx` is possible. |
| `pg_advisory_xact_lock` | Same key, the second transaction waited 403 ms for a 400 ms hold. Three different keys ran in parallel in 403 ms. The lock was free after a rollback. |
| `jsonb` | A JS object parameter is stored as an object and read back parsed. A string parameter is stored as a JSON string, even with `::jsonb` on it, which double-encodes. Write `$1::text::jsonb` to parse it. `\u0000` is rejected. `1e2` becomes `100`, and an integer above 2^53 is exact in `jsonb` but loses digits once parsed into a JS number. |
| Prepared statements | On by default, named per statement text, also for `unsafe()` with parameters. `{ prepare: false }` gave none. |
| Pool | `max: 4` ran 12 sleeps of 300 ms in 915 ms, at most 4 at once. After the server killed the pooled connection, the next query succeeded. `idleTimeout: 1` closed idle connections. |
| Trigger `RAISE EXCEPTION` | Rejects with a `PostgresError`. `errno` is the SQLSTATE, `P0001` by default or one set with `ERRCODE`, and `message` and `detail` carry the text. |
| Value types | `int` and `float8` are numbers. `bigint`, `numeric`, `count(*)` and `sum` are strings. `timestamptz` is a `Date`. `bytea` is a `Buffer`. |

Five behaviours need a rule.

1. A pool deadlocks when a transaction also queries the pool. Two transactions on `max: 2`, each also running one query on the pool rather than on its handle, hung. In the async rewrite, every statement in a command must use the transaction handle. A statement that slips outside it runs on another connection, outside the transaction.
2. After a failed statement the transaction is aborted. A later statement in it fails with `current transaction is aborted`, and the final commit was reported as rolled back. Code must not catch a failure and carry on, unless it uses a savepoint.
3. A cached `SELECT *` breaks after `ALTER TABLE ... ADD COLUMN`. The error is `cached plan must not change result type`, and it repeated on the same connection. An explicit column list on that connection worked, and so did `{ prepare: false }`. Use column lists, or turn prepared statements off, which RDS Proxy in transaction mode would need anyway. This bites old servers during a rolling deploy.
4. A bare JS array bound to `text[]` fails with `malformed array literal`. `db.array(["p","r"], "TEXT")` in a tagged template worked, and so did a JSON text parameter through `jsonb_array_elements_text`.
5. `await expect(db.unsafe(...)).rejects.toThrow()` never settles on Bun 1.4.3, and the runner then does not exit. A bare query is a lazy thenable. `Promise.resolve(q)`, an `async` wrapper and `.execute()` all work. The ported tests use a wrapper. `expect-rejects-hang.test.ts` has the cases.

Because `Bun.sql` returns `jsonb` already parsed, the many `JSON.parse(row.x_json)` calls would throw. Keep the `*_json` columns as `TEXT` and cast inside the two queries that need JSON functions.

## Changes to the plan

1. Phase 3 shrinks. Porting the migrations one PR per module is not needed. The translator did 12 of 13 and the trigger functions come out mechanically. Do one PR with a PostgreSQL baseline migration set, the kernel runner and the ported `db.test.ts`. That work is done in `spikes/postgres/` and can be lifted.
2. Phase 2 grows by more than half. The plan counts 86 sites, the real count is 134 at the database boundary, plus first-level callers, plus 133 test lines. Step 1 of Phase 2 should be sized as 134.
3. Phase 2 must fix the shape of `Db.tx` before the per-module PRs. A transaction handle passed in, or carried by `AsyncLocalStorage`, is required on PostgreSQL. The SQLite implementation should refuse a statement made outside the handle during a transaction, so the pool deadlock and the lost atomicity fail in Phase 2 and not in Phase 3.
4. Move the PostgreSQL kernel suite into CI at Phase 2. It takes 9 seconds and it catches Phase 3 problems while the code is still being reshaped.
5. The per-user lock cannot be a no-op in Phase 2 step 3. R16 breaks without it on PostgreSQL. Make it a real lock in the PostgreSQL run, and cover `sweepExpired`, which works across users.
6. Add `BEFORE TRUNCATE` guards to the R17 and append-only tables in Phase 3.
7. Decide the integer type policy before Phase 3 starts, since string `BIGINT` touches every `*_ms` and count read.
8. Ask Derek now whether SQLite stays after Phase 3, because the plan keeps it for local use. It would mean two migration sets, two texts for 14 statements, a second trigger set and the three SQLite-only tests, kept in step for good.
9. Replace `SELECT *` with column lists in Phase 2, and set `{ prepare: false }` if RDS Proxy is chosen.

I did not change the order of the phases. The estimate for Phase 3 falls. The estimate for Phase 2 rises, because of the extra 48 sites and the handle discipline.

## Not tested

- Any query result beyond the cases above. `PREPARE` covers all 86 statements for syntax and types, but only about 15 behaviours were run on both engines. The module test suites were not run on PostgreSQL, since that needs the Phase 2 rewrite.
- Performance. The only timings are the lock, pool and counter checks above. No query plan, index or load was measured.
- RDS, RDS Proxy, PgBouncer, TLS, IAM authentication and a different PostgreSQL major version. Everything ran on one local 17.6 container.
- `SERIALIZABLE` or `REPEATABLE READ` as an alternative to the advisory lock.
- How the importer would move an existing `afterclass.sqlite`.
- The transitive count of functions that become asynchronous. The 75 is a grep.
- Memory use, reconnect under load, and pool behaviour past a single killed connection.
- Whether `{ bigint: true }` or `DOUBLE PRECISION` is the better fix for the number types.
