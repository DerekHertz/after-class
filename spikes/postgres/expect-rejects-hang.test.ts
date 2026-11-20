/**
 * Bun 1.4.3: `expect(<bare Bun.sql query>).rejects` never settles, and the runner does not exit afterwards.
 * Cases A, B and D are skipped because they hang the runner. Remove `.skip` to reproduce. Cases C, E, F and G pass.
 *   bun test ./spikes/postgres/expect-rejects-hang.test.ts
 */
import { expect, test } from "bun:test";
import { SQL } from "bun";

const db = new SQL({ url: process.env.SPIKE_PG_URL?.replace(/\/postgres$/, "/spike") ?? "postgres://postgres:spike@127.0.0.1:55432/spike", max: 2 });

test.skip("A: rejects.toThrow() on a bare query hangs", async () => {
  await expect(db.unsafe("SELECT 1/0")).rejects.toThrow();
});
test.skip("B: rejects.toThrow(regex) on a bare query hangs", async () => {
  await expect(db.unsafe("SELECT 1/0")).rejects.toThrow(/division/);
});
test("C: try and catch works", async () => {
  let msg = "";
  try {
    await db.unsafe("SELECT 1/0");
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(/division/);
});
test.skip("D: a trigger error through a bare query hangs the same way", async () => {
  await db.unsafe("DROP TABLE IF EXISTS pt");
  await db.unsafe("CREATE TABLE pt (a int)");
  await db.unsafe("CREATE OR REPLACE FUNCTION pt_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION '%', 'R17: no'; RETURN NEW; END $f$");
  await db.unsafe("CREATE TRIGGER pt_t BEFORE INSERT ON pt FOR EACH ROW EXECUTE FUNCTION pt_fn()");
  await expect(db.unsafe("INSERT INTO pt VALUES (1)")).rejects.toThrow(/R17/);
});
test("E: Promise.resolve(query) works", async () => {
  await expect(Promise.resolve(db.unsafe("SELECT 1/0"))).rejects.toThrow(/division/);
});
test("F: an async wrapper works", async () => {
  await expect((async () => await db.unsafe("SELECT 1/0"))()).rejects.toThrow(/division/);
});
test("G: .execute() works", async () => {
  await expect(db.unsafe("SELECT 1/0").execute()).rejects.toThrow(/division/);
});
