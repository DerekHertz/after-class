/**
 * Budgets across real processes on one SQLite file: a process killed mid-call, and two processes reserving the last of a cap.
 * The second process is test/budget-child.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ensureLocalUser, openDb } from "../src/backend/db";
import { INTERRUPTED } from "../src/backend/providers/budget";
import { main } from "../src/backend/main";
import type { Running } from "../src/backend/main";
import { tmpDir } from "./tmp";

const CHILD = join(import.meta.dir, "budget-child.ts");

const child = (...args: string[]) => Bun.spawn([process.execPath, CHILD, ...args], { stdout: "pipe", stderr: "pipe" });

/** Over the 15 s a race child waits for the other to reach its reserve, so a stuck child fails with its own stderr first. */
const PROCESS_TEST_MS = 30_000;

async function finished(p: ReturnType<typeof child>) {
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, signal: p.signalCode, out: out.trim(), err };
}

function freshDb(dir: string): string {
  const path = join(dir, "afterclass.sqlite");
  const db = openDb(path);
  ensureLocalUser(db);
  db.sql.close();
  return path;
}

function read(path: string) {
  const db = openDb(path);
  try {
    return {
      holds: db.sql.query<{ reserved_micros: number; settled_micros: number | null }, []>("SELECT reserved_micros, settled_micros FROM budget_holds").all(),
      events: db.sql.query<{ purpose: string; outcome: string; cost_kind: string; cost_reason: string | null }, []>("SELECT purpose, outcome, cost_kind, cost_reason FROM usage_events").all(),
    };
  } finally {
    db.sql.close();
  }
}

const running: Running[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

describe("a process killed while its paid call is in flight", () => {
  test("R17: the next boot records the call as a usage event of unknown cost, and its hold counts at its reservation, once", async () => {
    const dataDir = tmpDir("budget-crash-data-");
    const path = freshDb(dataDir);
    const killed = await finished(child("crash", path));
    expect(killed.signal, `crash child exited ${killed.code}: ${killed.err}`).toBe("SIGKILL");
    expect(read(path)).toEqual({ holds: [{ reserved_micros: 750_000, settled_micros: null }], events: [] });

    const configDir = tmpDir("budget-crash-config-");
    writeFileSync(join(configDir, "keys.env"), "TYPESAFE_API_KEY=sk-budget-crash\n", { mode: 0o600 });
    const refuse = () => {
      throw new Error("the crash test reached a provider");
    };
    const boot = async () => {
      const logs: string[] = [];
      const r = await main({ port: 0, buildApp: false, configDir, fetch: refuse as unknown as typeof fetch, spawn: refuse, log: (t) => void logs.push(t), error: () => {}, env: { AFTERCLASS_DATA: dataDir, AFTERCLASS_MODE: "live" } });
      running.push(r);
      expect(r.mode).toBe("live");
      return { r, logs };
    };
    const first = await boot();
    expect(read(path)).toEqual({
      holds: [{ reserved_micros: 750_000, settled_micros: 750_000 }],
      events: [{ purpose: "interpretation", outcome: "aborted", cost_kind: "unknown", cost_reason: INTERRUPTED }],
    });
    expect(first.logs.join("\n")).toContain("1 call(s) a previous process left unfinished");
    expect(first.r.modules.ledger.summary().allowance?.usedUsd).toBe(0.75);
    await first.r.stop();
    running.length = 0;

    await boot();
    expect(read(path).events).toHaveLength(1);
  }, PROCESS_TEST_MS);
});

describe("two processes reserving the last of a cap at once", () => {
  test("exactly one reserves and the other is held, with no error, because the reserve transaction takes the write lock first", async () => {
    const dir = tmpDir("budget-race-");
    const path = freshDb(dir);
    const [a, b] = [join(dir, "a.ready"), join(dir, "b.ready")];
    const results = await Promise.all([finished(child("race", path, a, b)), finished(child("race", path, b, a))]);
    for (const r of results) expect({ code: r.code, err: r.err }, `race child exited ${r.code}: ${r.err}`).toEqual({ code: 0, err: "" });
    expect(results.map((r) => r.out).sort()).toEqual(["held", "reserved"]);
    expect(read(path).holds).toHaveLength(1);
  }, PROCESS_TEST_MS);
});
