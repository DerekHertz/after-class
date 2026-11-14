/**
 * A second process for test/budget-process.test.ts, run as `bun test/budget-child.ts <mode> <db> ...`.
 *   crash <db>               reserves through the memo and is killed with SIGKILL while its request is in flight.
 *   race <db> <me> <other>   reserves once and prints "reserved" or "held". It writes <me>.begin just before it asks to reserve
 *                            and <me>.in once inside the reserve transaction. There it waits for <other>.begin, so the other
 *                            process has reached its own reserve, then for <other>.in for up to GRACE_MS. With the write lock
 *                            taken first the other cannot get in, so the first process commits after GRACE_MS and the second
 *                            finds <me>.in already there. Without it both get in at once and one write fails.
 */
import { existsSync, writeFileSync } from "node:fs";
import { LOCAL_USER, openDb, scopeDb } from "../src/backend/db";
import { createBudget } from "../src/backend/providers/budget";
import { createMemo } from "../src/backend/providers/memo";
import type { MemoKey } from "../src/shared/ids";
import { fakeTask } from "./fakes";

const [mode, path, me, other] = process.argv.slice(2);
const db = openDb(path!);

if (mode === "crash") {
  const budget = createBudget(db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => false });
  const memo = createMemo(scopeDb(db, LOCAL_USER), "live", { budget });
  const task = fakeTask<{ n: number }, string>({
    purpose: "interpretation",
    provider: "claude",
    answer: () => {
      process.kill(process.pid, "SIGKILL");
      return new Promise(() => {});
    },
  });
  await memo.run(task, { n: 1 });
} else if (mode === "race") {
  // Well under the 5 s busy_timeout the blocked process waits through, and over the time the other takes to write <other>.in.
  const GRACE_MS = 1_000;
  const waitFor = (file: string, ms: number): boolean => {
    const deadline = Date.now() + ms;
    while (!existsSync(file)) {
      if (Date.now() >= deadline) return false;
      Bun.sleepSync(5);
    }
    return true;
  };
  const now = () => {
    // A read here, inside the reserve transaction, fixes what this transaction sees before the other process can write.
    db.sql.query("SELECT COUNT(*) FROM budget_holds").get();
    writeFileSync(`${me}.in`, "");
    if (!waitFor(`${other}.begin`, 15_000)) throw new Error(`${other} never reached its reserve`);
    waitFor(`${other}.in`, GRACE_MS);
    return Date.UTC(2026, 10, 10, 12);
  };
  const budget = createBudget(db, { limits: { userUsd: 0.75, totalUsd: 50 }, stopped: () => false, now });
  writeFileSync(`${me}.begin`, "");
  console.log(budget.reserve(LOCAL_USER, "tutor_turn", `key_${me}` as MemoKey).kind);
}
