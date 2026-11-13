/**
 * A second process for test/budget-process.test.ts, run as `bun test/budget-child.ts <mode> <db> ...`.
 *   crash <db>               reserves through the memo and is killed with SIGKILL while its request is in flight.
 *   race <db> <me> <other>   waits for the other process to start, then reserves once, waiting inside the reserve
 *                            transaction until <other> exists or 1.5 s pass, then prints "reserved" or "held".
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
  const meet = (mine: string, theirs: string, ms: number) => {
    writeFileSync(mine, "");
    const deadline = Date.now() + ms;
    while (!existsSync(theirs) && Date.now() < deadline) Bun.sleepSync(5);
  };
  // Both processes are up before either begins its transaction, so their transactions overlap unless the lock keeps them apart.
  meet(`${me}.up`, `${other}.up`, 10_000);
  const now = () => {
    // A read here, inside the reserve transaction, fixes what this transaction sees before the other process can write.
    db.sql.query("SELECT COUNT(*) FROM budget_holds").get();
    meet(me!, other!, 1_500);
    return Date.UTC(2026, 10, 10, 12);
  };
  const budget = createBudget(db, { limits: { userUsd: 0.75, totalUsd: 50 }, stopped: () => false, now });
  console.log(budget.reserve(LOCAL_USER, "tutor_turn", `key_${me}` as MemoKey).kind);
}
