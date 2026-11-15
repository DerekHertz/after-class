/**
 * Derek, 2026-11-14: "yes build the admin account too". An uncapped account skips both caps and is left out of the monthly
 * total, its usage is still recorded, and the stop switch still holds it (providers/budget.ts).
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBudget, ESTIMATE_USD } from "../src/backend/providers/budget";
import { createMemo } from "../src/backend/providers/memo";
import { resolveUncappedUsers } from "../src/backend/main";
import { ensureLocalUser, scopeDb, userForIdentity } from "../src/backend/db";
import type { UserDb } from "../src/backend/db";
import { AllowanceNote } from "../src/app/record";
import { allowanceView } from "../src/app/core";
import { usageResponse } from "../src/shared/wire";
import type { Cost, Purpose } from "../src/shared/domain";
import { fakeTask, ok, testDb, usage } from "./fakes";

const NOV_10 = Date.UTC(2026, 10, 10, 12);
const DEC_1 = Date.UTC(2026, 11, 1);
const TUTOR = ESTIMATE_USD.tutor_turn;
const UNKNOWN: Cost = { kind: "unknown", reason: "test" };
const ADMIN = "user_admin_0001";

function rig(opts: { uncapped: readonly string[]; userUsd?: number | null; totalUsd?: number | null }) {
  const raw = testDb();
  let stopped = false;
  const budget = createBudget(raw, {
    limits: { userUsd: opts.userUsd === undefined ? 5 : opts.userUsd, totalUsd: opts.totalUsd === undefined ? 50 : opts.totalUsd },
    uncappedSubjects: opts.uncapped,
    stopped: () => stopped,
    now: () => NOV_10,
  });
  const signIn = (subject: string): UserDb => scopeDb(raw, userForIdentity(raw, { provider: "clerk", subject }));
  const memoFor = (u: UserDb) => createMemo(u, "live", { retryDelayMs: () => 0, now: () => NOV_10, budget });
  const task = (purpose: Purpose = "tutor_turn") => fakeTask<{ n: number }, string>({ purpose, provider: "claude", answer: () => ok("x", { usage: usage(UNKNOWN) }) });
  return { raw, budget, signIn, memoFor, task, stop: (on: boolean) => (stopped = on) };
}

describe("uncapped account", () => {
  test("passes both caps, even when the per-user and total caps are already used up", async () => {
    const w = rig({ uncapped: [ADMIN], userUsd: TUTOR, totalUsd: TUTOR });
    const admin = w.signIn(ADMIN);
    const t = w.task();
    for (const n of [1, 2, 3]) expect((await w.memoFor(admin).run(t, { n })).kind).toBe("hit");
    expect(t.calls).toHaveLength(3);
    expect(w.budget.allowance(admin.userId)).toEqual({ usedUsd: expect.closeTo(3 * TUTOR, 9), limitUsd: null, uncapped: true, resetsAtMs: DEC_1, held: null });
  });

  test("its spend does not count toward a friend's total cap", async () => {
    const w = rig({ uncapped: [ADMIN], userUsd: 5, totalUsd: 2 * TUTOR });
    const admin = w.signIn(ADMIN);
    const friend = w.signIn("user_friend_0001");
    const t = w.task();
    for (const n of [1, 2, 3, 4]) await w.memoFor(admin).run(t, { n });
    expect((await w.memoFor(friend).run(t, { n: 1 })).kind).toBe("hit");
    expect((await w.memoFor(friend).run(t, { n: 2 })).kind).toBe("hit");
    expect(await w.memoFor(friend).run(t, { n: 3 })).toMatchObject({ kind: "held", hold: { reason: "total_budget" } });
    expect(w.budget.allowance(friend.userId).usedUsd).toBe(2 * TUTOR);
  });

  test("its usage is still recorded: a settled hold and a usage event for the call, counted in its own month", async () => {
    const w = rig({ uncapped: [ADMIN] });
    const admin = w.signIn(ADMIN);
    await w.memoFor(admin).run(w.task(), { n: 1 });
    expect(w.raw.sql.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM budget_holds WHERE user_id = ? AND settled_micros IS NOT NULL").get(admin.userId)!.n).toBe(1);
    expect(w.raw.sql.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?").get(admin.userId)!.n).toBe(1);
    expect(w.budget.allowance(admin.userId).usedUsd).toBe(TUTOR);
  });

  test("the stop switch still holds it, with the same reason as anyone", async () => {
    const w = rig({ uncapped: [ADMIN] });
    const admin = w.signIn(ADMIN);
    const t = w.task();
    w.stop(true);
    expect(await w.memoFor(admin).run(t, { n: 1 })).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
    expect(t.calls).toEqual([]);
    expect(w.budget.allowance(admin.userId)).toMatchObject({ uncapped: true, held: { reason: "stopped" } });
  });

  test("a user who is not listed is capped as before, and a listed id that has not signed in matches nobody", async () => {
    const w = rig({ uncapped: [ADMIN, "user_never_signed_in"], userUsd: 2 * TUTOR, totalUsd: 50 });
    const friend = w.signIn("user_friend_0001");
    const t = w.task();
    for (const n of [1, 2]) expect((await w.memoFor(friend).run(t, { n })).kind).toBe("hit");
    expect(await w.memoFor(friend).run(t, { n: 3 })).toMatchObject({ kind: "held", hold: { reason: "user_budget", resetsAtMs: DEC_1 } });
    expect(w.budget.allowance(friend.userId)).toEqual({ usedUsd: 2 * TUTOR, limitUsd: 2 * TUTOR, uncapped: false, resetsAtMs: DEC_1, held: { reason: "user_budget", resetsAtMs: DEC_1, usedUp: true } });
  });

  test("the local user has no Clerk id, so listing the word local does not uncap it", () => {
    const w = rig({ uncapped: ["local"], userUsd: 1, totalUsd: 50 });
    const local = scopeDb(w.raw, ensureLocalUser(w.raw));
    expect(w.budget.allowance(local.userId)).toMatchObject({ uncapped: false, limitUsd: 1 });
  });
});

describe("AFTERCLASS_BUDGET_UNCAPPED_USERS", () => {
  test("parses comma separated Clerk ids, trimming spaces and dropping empty entries and repeats", () => {
    expect(resolveUncappedUsers("user_a,user_b")).toEqual(["user_a", "user_b"]);
    expect(resolveUncappedUsers("  user_a ,, user_b ,  user_a,")).toEqual(["user_a", "user_b"]);
    expect(resolveUncappedUsers("user_a\n")).toEqual(["user_a"]);
  });

  test("unset, empty and blank values list nobody", () => {
    expect(resolveUncappedUsers(undefined)).toEqual([]);
    expect(resolveUncappedUsers("")).toEqual([]);
    expect(resolveUncappedUsers(" , ,")).toEqual([]);
  });

  test("an id with a space inside is refused, because the typo would silently cap the admin", () => {
    expect(() => resolveUncappedUsers("user_a user_b")).toThrow(/space inside/);
  });

  test("the refusal names the entry's position and never an id", () => {
    let message = "";
    try {
      resolveUncappedUsers("user_ok, user_private_admin user_second_private");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("entry 2");
    expect(message).not.toContain("user_private_admin");
    expect(message).not.toContain("user_second_private");
    expect(message).not.toContain("user_ok");
  });
});

describe("the usage page", () => {
  const admin = { usedUsd: 1.5, limitUsd: null, uncapped: true, resetsAtMs: DEC_1, held: null } as const;

  test("labels an uncapped account and says its spend is not in everyone's total", () => {
    expect(allowanceView(admin)!.line).toBe("Uncapped account: $1.50 counted this month, with no cap. It is not counted toward everyone's total.");
    expect(renderToStaticMarkup(createElement(AllowanceNote, { allowance: admin }))).toContain("Uncapped account: $1.50 counted this month");
  });

  test("a backend that does not send the flag decodes as capped", () => {
    const decoded = usageResponse.parse({ byKind: {}, byPurpose: {}, allowance: { usedUsd: 1, limitUsd: 5, resetsAtMs: DEC_1, held: null } });
    expect(decoded.allowance).toEqual({ usedUsd: 1, limitUsd: 5, uncapped: false, resetsAtMs: DEC_1, held: null });
    expect(usageResponse.parse({ byKind: {}, byPurpose: {}, allowance: { ...admin } }).allowance!.uncapped).toBe(true);
  });
});
