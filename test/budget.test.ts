import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBudget, ESTIMATE_USD, periodEndMs } from "../src/backend/providers/budget";
import type { Budget, BudgetLimits } from "../src/backend/providers/budget";
import { priceUsage } from "../src/backend/providers/claude-api";
import { createJevClient, jevCost } from "../src/backend/providers/jev";
import { frameChangeTask } from "../src/backend/providers/jev-tasks";
import { createMemo, ProviderError } from "../src/backend/providers/memo";
import type { Memo, Task } from "../src/backend/providers/memo";
import { createLedger } from "../src/backend/providers/ledger";
import { createScheduler } from "../src/backend/scheduler";
import type { Timers } from "../src/backend/scheduler";
import { createReviews } from "../src/backend/review";
import { nextThreadId } from "../src/backend/review/tutor";
import type { TutorInput, TutorOutput } from "../src/backend/review/tutor";
import { resolveBudgetLimits, stopSwitch, STOP_FILE } from "../src/backend/main";
import type { Db, UserDb } from "../src/backend/db";
import { allowanceView, reduceLive, startLive } from "../src/app/core";
import { AllowanceNote } from "../src/app/record";
import { heldMessage } from "../src/shared/allowance";
import { tutorStreamEvent, usageResponse } from "../src/shared/wire";
import type { IdPart, MemoKey } from "../src/shared/ids";
import { randomId } from "../src/shared/ids";
import type { Cost, Purpose } from "../src/shared/domain";
import { deferred, fakeTask, ok, otherUserDb, testUserDb, usage } from "./fakes";
import type { FakeStep } from "./fakes";
import { answer, askMain, collect, kit, reply, startedRig, types } from "./review-fixtures";
import { frame, jpeg, json, scriptedFetch, withBytes } from "./providers-fixtures";
import { tmpDir } from "./tmp";

const NOV_10 = Date.UTC(2026, 10, 10, 12);
const DEC_1 = Date.UTC(2026, 11, 1);
const TUTOR = ESTIMATE_USD.tutor_turn;
/** Spent of a $5 cap with less than one tutor reservation left, but money left. */
const SOME_LEFT = 5 - TUTOR / 2;
const UNKNOWN: Cost = { kind: "unknown", reason: "test" };

type In = { readonly n: number };

function world(limits: BudgetLimits, opts: { db?: UserDb } = {}) {
  const db = opts.db ?? testUserDb();
  let at = NOV_10;
  let stopped = false;
  const budget = createBudget(db, { limits, stopped: () => stopped, now: () => at });
  const memoFor = (u: UserDb): Memo => createMemo(u, "live", { retryDelayMs: () => 0, now: () => at, budget });
  return {
    db,
    budget,
    memo: memoFor(db),
    memoFor,
    setNow: (ms: number) => (at = ms),
    stop: (on: boolean) => (stopped = on),
  };
}

const claudeTask = (purpose: Purpose, answer: (i: In, n: number) => FakeStep<string> | Promise<FakeStep<string>>) =>
  fakeTask<In, string>({ purpose, provider: "claude", answer });

const holds = (db: Db) =>
  db.sql.query<{ reserved_micros: number; settled_micros: number | null }, []>("SELECT reserved_micros, settled_micros FROM budget_holds ORDER BY reserved_ms, rowid").all();

const used = (budget: Budget, db: UserDb) => budget.allowance(db.userId).usedUsd;

describe("reserve and settle", () => {
  test("a priced attempt reserves its estimate while it runs, then counts the cost its usage event records", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const gate = deferred<FakeStep<string>>();
    const t = claudeTask("tutor_turn", () => gate.promise);
    const run = w.memo.run(t, { n: 1 });
    await Promise.resolve();
    expect(used(w.budget, w.db)).toBe(TUTOR);
    gate.resolve(ok("x", { usage: usage({ kind: "estimated", usd: 0.1234567, basis: "test" }) }));
    expect((await run).kind).toBe("hit");
    expect(holds(w.db)).toEqual([{ reserved_micros: TUTOR * 1_000_000, settled_micros: 123_457 }]);
    expect(used(w.budget, w.db)).toBe(0.123457);
  });

  test("an unknown cost keeps its reservation as spend", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    await w.memo.run(fakeTask<In, string>({ purpose: "boundary", provider: "jev", answer: () => ok("j", { usage: usage(UNKNOWN) }) }), { n: 1 });
    expect(used(w.budget, w.db)).toBe(ESTIMATE_USD.boundary);
  });

  test("a failure with no usage may have been billed, so it keeps its reservation", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const t = claudeTask("interpretation", () => ({ kind: "error", message: "502", retryable: false, usage: null }));
    expect((await w.memo.run(t, { n: 1 })).kind).toBe("failed");
    expect(used(w.budget, w.db)).toBe(ESTIMATE_USD.interpretation);
  });

  test("a failure the adapter says was turned away before any model ran counts nothing, and its usage event says $0, not unknown", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const t: Task<In, string> = {
      ...claudeTask("interpretation", () => ok("unused")),
      attempt: () => Promise.reject(new ProviderError("429 rate limited", null, false, "not_billed")),
    };
    expect((await w.memo.run(t, { n: 1 })).kind).toBe("failed");
    expect(used(w.budget, w.db)).toBe(0);
    const row = w.db.sql.query<{ cost_kind: string; cost_usd: number | null; cost_basis: string | null }, []>("SELECT cost_kind, cost_usd, cost_basis FROM usage_events").get();
    expect(row).toEqual({ cost_kind: "estimated", cost_usd: 0, cost_basis: "rejected before any model ran" });
  });
});

describe("caps", () => {
  test("an attempt that brings the month exactly to the cap starts, and the next one is held until the month ends", async () => {
    const w = world({ userUsd: 2 * TUTOR, totalUsd: 50 });
    const t = claudeTask("tutor_turn", () => ok("x", { usage: usage(UNKNOWN) }));
    expect((await w.memo.run(t, { n: 1 })).kind).toBe("hit");
    expect((await w.memo.run(t, { n: 2 })).kind).toBe("hit");
    const third = await w.memo.run(t, { n: 3 });
    expect(third).toMatchObject({ kind: "held", hold: { reason: "user_budget", resetsAtMs: DEC_1 } });
    expect(t.calls).toHaveLength(2);
    expect(used(w.budget, w.db)).toBe(2 * TUTOR);
  });

  test("a held attempt makes no call, records no usage event, and leaves the key missing", async () => {
    const w = world({ userUsd: 0, totalUsd: 50 });
    const t = claudeTask("tutor_turn", () => ok("x"));
    expect((await w.memo.run(t, { n: 1 })).kind).toBe("held");
    expect(t.calls).toEqual([]);
    expect(w.memo.lookup(t, { n: 1 }).kind).toBe("missing");
    expect(w.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(0);
    expect(holds(w.db)).toEqual([]);
  });

  test("the monthly total holds every user once their calls together reach it", async () => {
    const w = world({ userUsd: 5, totalUsd: 2 * TUTOR });
    const other = otherUserDb(w.db);
    const mine = claudeTask("tutor_turn", () => ok("x", { usage: usage(UNKNOWN) }));
    const theirs = claudeTask("tutor_turn", () => ok("y", { usage: usage(UNKNOWN) }));
    expect((await w.memo.run(mine, { n: 1 })).kind).toBe("hit");
    expect((await w.memoFor(other).run(theirs, { n: 1 })).kind).toBe("hit");
    expect(await w.memo.run(mine, { n: 2 })).toMatchObject({ kind: "held", hold: { reason: "total_budget" } });
    expect(await w.memoFor(other).run(theirs, { n: 2 })).toMatchObject({ kind: "held", hold: { reason: "total_budget" } });
    expect(used(w.budget, w.db)).toBe(TUTOR);
    expect(w.budget.allowance(other.userId).usedUsd).toBe(TUTOR);
  });

  test("attempts started together cannot jointly pass the cap: only as many start as the cap covers", async () => {
    const w = world({ userUsd: 2 * TUTOR, totalUsd: 50 });
    const gate = deferred<FakeStep<string>>();
    const t = claudeTask("tutor_turn", () => gate.promise);
    const runs = [1, 2, 3, 4, 5].map((n) => w.memo.run(t, { n }));
    await Promise.resolve();
    expect(t.calls).toHaveLength(2);
    gate.resolve(ok("x", { usage: usage(UNKNOWN) }));
    expect((await Promise.all(runs)).map((r) => r.kind)).toEqual(["hit", "hit", "held", "held", "held"]);
    expect(holds(w.db)).toHaveLength(2);
  });

  test("Derek: \"i think it should be allowed to finish\". The wrap-up passes both caps and still counts, but the stop switch holds it", async () => {
    const w = world({ userUsd: TUTOR, totalUsd: TUTOR });
    const t = claudeTask("tutor_turn", () => ok("x", { usage: usage(UNKNOWN) }));
    const review = randomId("rvw");
    expect((await w.memo.run(t, { n: 1 }, { review })).kind).toBe("hit");
    expect(await w.memo.run(t, { n: 2 }, { review })).toMatchObject({ kind: "held", hold: { reason: "user_budget" } });
    const wrapUp = claudeTask("wrap_up", () => ok("saved", { usage: usage(UNKNOWN) }));
    // A wrap-up that names no review is capped like any call (#244). One whose review has paid tutoring passes (test/wrap-up-bound.test.ts bounds it).
    expect(await w.memo.run(wrapUp, { n: 0 })).toMatchObject({ kind: "held", hold: { reason: "user_budget" } });
    expect((await w.memo.run(wrapUp, { n: 1 }, { review })).kind).toBe("hit");
    expect(used(w.budget, w.db)).toBe(TUTOR + ESTIMATE_USD.wrap_up);
    expect(w.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events WHERE purpose = 'wrap_up'").get()!.n).toBe(1);
    w.stop(true);
    expect(await w.memo.run(wrapUp, { n: 2 }, { review })).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
    expect(wrapUp.calls).toEqual([{ n: 1 }]);
  });

  test("the allowance reports what is reserved for running calls apart from what has settled", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const gate = deferred<FakeStep<string>>();
    const running = w.memo.run(claudeTask("tutor_turn", () => gate.promise), { n: 1 });
    await new Promise((res) => setTimeout(res, 0));
    expect(w.budget.allowance(w.db.userId)).toMatchObject({ usedUsd: TUTOR, reservedUsd: TUTOR });
    gate.resolve(ok("x", { usage: usage({ kind: "measured", usd: 0.25 }) }));
    await running;
    expect(w.budget.allowance(w.db.userId)).toMatchObject({ usedUsd: 0.25, reservedUsd: 0 });
  });

  test("no cap set means every attempt starts and is still counted", async () => {
    const w = world({ userUsd: null, totalUsd: null });
    const t = claudeTask("tutor_turn", () => ok("x", { usage: usage({ kind: "measured", usd: 2 }) }));
    for (const n of [1, 2, 3]) expect((await w.memo.run(t, { n })).kind).toBe("hit");
    expect(w.budget.allowance(w.db.userId)).toEqual({ usedUsd: 6, reservedUsd: 0, limitUsd: null, uncapped: false, resetsAtMs: DEC_1, held: null });
  });
});

describe("stop switch", () => {
  test("refuses every new attempt at once, lets a running one finish and settle, and lifts without a restart", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const gate = deferred<FakeStep<string>>();
    const t = claudeTask("tutor_turn", (i) => (i.n === 1 ? gate.promise : ok("later")));
    const running = w.memo.run(t, { n: 1 });
    await Promise.resolve();
    w.stop(true);
    expect(await w.memo.run(t, { n: 2 })).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
    expect(w.budget.allowance(w.db.userId).held).toEqual({ reason: "stopped" });
    gate.resolve(ok("finished", { usage: usage({ kind: "measured", usd: 0.1 }) }));
    expect(await running).toMatchObject({ kind: "hit", value: "finished" });
    expect(holds(w.db)).toEqual([{ reserved_micros: TUTOR * 1_000_000, settled_micros: 100_000 }]);
    w.stop(false);
    expect(await w.memo.run(t, { n: 2 })).toMatchObject({ kind: "hit", value: "later" });
  });

  test("the switch is the environment at boot or a file in the config dir, looked for on every call", () => {
    const dir = tmpDir("stop-switch-");
    const fromFile = stopSwitch({}, dir);
    expect(fromFile()).toBe(false);
    writeFileSync(join(dir, STOP_FILE), "");
    expect(fromFile()).toBe(true);
    unlinkSync(join(dir, STOP_FILE));
    expect(fromFile()).toBe(false);
    expect(stopSwitch({ AFTERCLASS_STOP_PAID_CALLS: "1" }, dir)()).toBe(true);
    expect(() => stopSwitch({ AFTERCLASS_STOP_PAID_CALLS: "yes" }, dir)).toThrow(/must be 1 or 0/);
  });

  test("hosted defaults to $5 per user and $50 in total; local has no cap unless one is set", () => {
    expect(resolveBudgetLimits({ AFTERCLASS_AUTH: "clerk" })).toEqual({ userUsd: 5, totalUsd: 50 });
    expect(resolveBudgetLimits({ AFTERCLASS_HOST: "0.0.0.0" })).toEqual({ userUsd: 5, totalUsd: 50 });
    expect(resolveBudgetLimits({})).toEqual({ userUsd: null, totalUsd: null });
    expect(resolveBudgetLimits({ AFTERCLASS_BUDGET_USER_USD: "2.5" })).toEqual({ userUsd: 2.5, totalUsd: null });
    expect(resolveBudgetLimits({ AFTERCLASS_AUTH: "clerk", AFTERCLASS_BUDGET_TOTAL_USD: "20" })).toEqual({ userUsd: 5, totalUsd: 20 });
    expect(() => resolveBudgetLimits({ AFTERCLASS_BUDGET_USER_USD: "-1" })).toThrow(/dollar amount/);
    expect(() => resolveBudgetLimits({ AFTERCLASS_BUDGET_TOTAL_USD: "lots" })).toThrow(/dollar amount/);
  });
});

describe("R17", () => {
  test("R17: \"Every paid call records a usage event; unknown cost is stored as unknown, not zero.\" Every attempt that ran has one, and the holds settle to the ledger's figures", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const steps: FakeStep<string>[] = [
      ok("a", { usage: usage({ kind: "measured", usd: 0.2 }) }),
      ok("b", { usage: usage(UNKNOWN) }),
      { kind: "error", message: "boom", retryable: false, usage: null },
      { kind: "error", message: "billed then failed", retryable: false, usage: usage({ kind: "estimated", usd: 0.05, basis: "test" }) },
    ];
    const t = claudeTask("claim_revision", (i) => steps[i.n]!);
    for (const n of [0, 1, 2, 3]) await w.memo.run(t, { n });
    const events = w.db.sql.query<{ cost_kind: string; cost_usd: number | null }, []>("SELECT cost_kind, cost_usd FROM usage_events").all();
    expect(events).toHaveLength(4);
    expect(events.filter((e) => e.cost_kind === "unknown")).toHaveLength(2);
    expect(events.filter((e) => e.cost_kind === "unknown").every((e) => e.cost_usd === null)).toBe(true);
    const ledger = createLedger(w.db, w.budget).summary();
    const known = (ledger.byKind.measured.usd ?? 0) + (ledger.byKind.estimated.usd ?? 0);
    const settled = holds(w.db).reduce((s, h) => s + h.settled_micros!, 0) / 1_000_000;
    expect(settled).toBeCloseTo(known + ledger.byKind.unknown.calls * ESTIMATE_USD.claim_revision, 9);
    expect(ledger.allowance?.usedUsd).toBeCloseTo(settled, 9);
  });
});

describe("held preparation", () => {
  test("is left alone while held and runs once the next month starts", async () => {
    let at = NOV_10;
    type Timer = { at: number; fn: () => void; live: boolean };
    const timers: Timer[] = [];
    const fakeTimers: Timers = {
      after: (ms, fn) => {
        const t = { at: at + ms, fn, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
      every: () => () => {},
    };
    const advance = async (ms: number) => {
      const end = at + ms;
      for (;;) {
        await new Promise((r) => setTimeout(r, 0));
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        at = Math.max(at, due.at);
        due.live = false;
        due.fn();
      }
      at = end;
    };
    const db = testUserDb();
    const budget = createBudget(db, { limits: { userUsd: ESTIMATE_USD.interpretation, totalUsd: 50 }, stopped: () => false, now: () => at });
    const memo = createMemo(db, "live", { retryDelayMs: () => 0, now: () => at, budget });
    const spent = claudeTask("interpretation", () => ok("earlier", { usage: usage(UNKNOWN) }));
    await memo.run(spent, { n: 0 });
    const t = claudeTask("interpretation", () => ok("prepared", { usage: usage({ kind: "measured", usd: 0.3 }) }));
    const input = { n: 1 };
    let runs = 0;
    const scheduler = createScheduler(
      [() => (memo.lookup(t, input).kind === "hit" ? [] : [{ key: memo.key(t, input), purpose: "interpretation" as const, provider: "claude" as const, run: (signal: AbortSignal) => (runs++, memo.run(t, input, { signal })) }])],
      { jev: 4, claude: 2 },
      { now: () => at, timers: fakeTimers, debounceMs: 50, heldRetryMs: 60_000 },
    );
    scheduler.pump();
    await advance(10 * 60_000);
    expect(runs).toBe(11);
    expect(t.calls).toEqual([]);
    expect(memo.lookup(t, input).kind).toBe("missing");
    at = DEC_1 - 1;
    await advance(120_000);
    expect(t.calls).toEqual([input]);
    expect(memo.lookup(t, input)).toMatchObject({ kind: "hit", value: "prepared" });
    await scheduler.stop();
  });
});

describe("what the learner sees", () => {
  test("the held messages are plain and name the day the allowance comes back", () => {
    expect(heldMessage({ reason: "user_budget", resetsAtMs: DEC_1, usedUp: true })).toBe("This month's AI allowance is used up. It resets on December 1.");
    expect(heldMessage({ reason: "total_budget", resetsAtMs: DEC_1, usedUp: true })).toBe("After Class has used this month's AI allowance for everyone. It resets on December 1.");
    for (const reason of ["user_budget", "total_budget"] as const) {
      expect(heldMessage({ reason, resetsAtMs: DEC_1, usedUp: false })).toBe("Not enough of this month's AI allowance is left for another AI step. It resets on December 1.");
    }
    expect(heldMessage({ reason: "stopped" })).toBe("AI features are paused for now. Nothing you have done is lost. Try again later.");
    expect(periodEndMs(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
  });

  function heldTutor(db: UserDb, limits: BudgetLimits, script: (i: TutorInput, n: number) => FakeStep<TutorOutput> | Promise<FakeStep<TutorOutput>>) {
    let at = NOV_10;
    let stopped = false;
    const budget = createBudget(db, { limits, stopped: () => stopped, now: () => at });
    const memo = createMemo(db, "live", { retryDelayMs: () => 0, budget });
    const base = fakeTask<IdPart, TutorOutput>({ purpose: "tutor_turn", provider: "claude", answer: (i, n) => script(i as unknown as TutorInput, n) });
    const task: Task<TutorInput, TutorOutput> = { ...(base as unknown as Task<TutorInput, TutorOutput>), canonicalInput: (i) => ({ turns: i.turns.map((x) => x.id) }) };
    return {
      budget,
      calls: base.calls,
      runTutor: (input: TutorInput, streamTo: (d: string) => void, signal: AbortSignal, onRetry: () => void) => memo.run(task, input, { signal, streamTo, onRetry }),
      clearFailures: memo.clearFailures,
      setNow: (ms: number) => (at = ms),
      stop: (on: boolean) => (stopped = on),
    };
  }

  test("a turn the budget holds ends with turn_held, not a failure; the learner's turn is kept and a resend next month goes on", async () => {
    const r = startedRig();
    const move = askMain(r.claim);
    const tutor = heldTutor(r.db, { userUsd: TUTOR, totalUsd: 50 }, () => reply(move, "What is the main idea?"));
    expect(tutor.budget.reserve(r.db.userId, "tutor_turn", "key_earlier" as MemoKey).kind).toBe("reserved");
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: tutor.runTutor, clearFailures: tutor.clearFailures }, { tutor: kit, now: () => 1 });
    const turnId = randomId("turn");
    const events = await collect(reviews.turn(r.reviewId, turnId, answer()));
    expect(types(events)).toEqual(["learner_turn_stored", "turn_held"]);
    expect(tutor.calls).toEqual([]);
    const live = events.reduce(reduceLive, startLive(turnId));
    expect(live).toMatchObject({ status: "held", error: "This month's AI allowance is used up. It resets on December 1.", retryable: false });
    expect(reviews.view(r.reviewId).turns.map((t) => t.actor)).toEqual(["learner"]);

    tutor.setNow(DEC_1);
    expect(types(await collect(reviews.turn(r.reviewId, turnId, answer()))).slice(-2)).toEqual(["move", "turn_complete"]);
    expect(tutor.calls).toHaveLength(1);
  });

  test("a learner held by a cap who asks to finish gets code's wrap-up line with no call, and the stop switch still holds it", async () => {
    const r = startedRig();
    const tutor = heldTutor(r.db, { userUsd: TUTOR, totalUsd: 50 }, (input) => reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "What is the main idea?"));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: tutor.runTutor, clearFailures: tutor.clearFailures }, { now: () => 1 });
    expect(types(await collect(reviews.turn(r.reviewId, randomId("turn"), { kind: "begin" }))).at(-1)).toBe("turn_complete");
    expect(tutor.calls).toHaveLength(1);
    expect(tutor.budget.allowance(r.db.userId).held).toMatchObject({ reason: "user_budget" });

    tutor.stop(true);
    expect(types(await collect(reviews.turn(r.reviewId, randomId("turn"), { kind: "end" })))).toEqual(["learner_turn_stored", "turn_held"]);
    tutor.stop(false);
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), { kind: "end" }));
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "wrap_up" } });
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(tutor.calls).toHaveLength(1);
    expect(reviews.view(r.reviewId).state.phase).toBe("ended");
  });

  test("a turn already streaming is never cut when the stop switch goes on", async () => {
    const r = startedRig();
    const move = askMain(r.claim);
    const gate = deferred<FakeStep<TutorOutput>>();
    const tutor = heldTutor(r.db, { userUsd: 5, totalUsd: 50 }, () => gate.promise);
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: tutor.runTutor, clearFailures: tutor.clearFailures }, { tutor: kit, now: () => 1 });
    const pending = collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    await new Promise((res) => setTimeout(res, 0));
    expect(tutor.calls).toHaveLength(1);
    tutor.stop(true);
    gate.resolve(reply(move, "What is the main idea?"));
    const events = await pending;
    expect(types(events)).not.toContain("turn_held");
    expect(types(events).slice(-2)).toEqual(["move", "turn_complete"]);
  });

  test("the usage page states this month's use and allowance, and why calls are held", () => {
    expect(allowanceView(null)).toBeNull();
    expect(allowanceView({ usedUsd: 0.75, reservedUsd: 0, limitUsd: 5, uncapped: false, resetsAtMs: DEC_1, held: null })).toEqual({
      line: "$0.75 of your $5.00 AI allowance used this month. It resets on December 1.",
      reserved: null,
      held: null,
    });
    expect(allowanceView({ usedUsd: 0.001, reservedUsd: 0, limitUsd: null, uncapped: false, resetsAtMs: DEC_1, held: null })!.line).toBe("<$0.01 counted this month, with no monthly cap. The month resets on December 1.");
    const html = renderToStaticMarkup(createElement(AllowanceNote, { allowance: { usedUsd: 5, reservedUsd: 0, limitUsd: 5, uncapped: false, resetsAtMs: DEC_1, held: { reason: "user_budget", resetsAtMs: DEC_1, usedUp: true } } }));
    expect(html).toContain("$5.00 of your $5.00 AI allowance used this month.");
    expect(html).toContain("This month&#x27;s AI allowance is used up. It resets on December 1.");
  });

  test("a hold says used up only once spend has reached that cap, for the user's cap and for the total", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const spend = (db: UserDb, usd: number) => w.memoFor(db).run(claudeTask("claim_revision", () => ok("x", { usage: usage({ kind: "measured", usd }) })), { n: usd });
    const [someLeft, spentAll, bystander] = [w.db, otherUserDb(w.db, "spent-all"), otherUserDb(w.db, "bystander")];
    const finisher = otherUserDb(w.db, "finisher");
    const finishes = randomId("rvw");
    await w.memoFor(finisher).run(claudeTask("tutor_turn", () => ok("x", { usage: usage({ kind: "measured", usd: 0.01 }) })), { n: 0 }, { review: finishes });
    await spend(someLeft, SOME_LEFT);
    await spend(spentAll, 5);
    expect(w.budget.allowance(someLeft.userId).held).toEqual({ reason: "user_budget", resetsAtMs: DEC_1, usedUp: false });
    expect(w.budget.allowance(spentAll.userId).held).toEqual({ reason: "user_budget", resetsAtMs: DEC_1, usedUp: true });
    // The 8th spender gives back what someLeft spent above $4.50, so the month still stands at $49.51 as the comment below counts it.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await spend(otherUserDb(w.db, `spender-${n}`), n === 8 ? 5 - (SOME_LEFT - 4.5) : 5);
    // A wrap-up passes the caps, so it can bring the month from $49.51 to $49.91, with less than a tutor reservation left, and then to $50.31.
    const wrapUp = (n: number) => w.memoFor(finisher).run(claudeTask("wrap_up", () => ok("x", { usage: usage({ kind: "measured", usd: 0.4 }) })), { n }, { review: finishes });
    await wrapUp(1);
    expect(w.budget.allowance(bystander.userId)).toMatchObject({ usedUsd: 0, held: { reason: "total_budget", resetsAtMs: DEC_1, usedUp: false } });
    await wrapUp(2);
    expect(w.budget.allowance(bystander.userId).held).toEqual({ reason: "total_budget", resetsAtMs: DEC_1, usedUp: true });
  });

  test("a tutor turn held with money left says so in the chat, not that the allowance is used up", async () => {
    const r = startedRig();
    const tutor = heldTutor(r.db, { userUsd: 5, totalUsd: 50 }, () => reply(askMain(r.claim), "What is the main idea?"));
    const spent = claudeTask("claim_revision", () => ok("x", { usage: usage({ kind: "measured", usd: SOME_LEFT }) }));
    await createMemo(r.db, "live", { budget: tutor.budget }).run(spent, { n: 1 });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: tutor.runTutor, clearFailures: tutor.clearFailures }, { tutor: kit, now: () => 1 });
    const turnId = randomId("turn");
    const events = await collect(reviews.turn(r.reviewId, turnId, answer()));
    expect(events.at(-1)).toEqual({ type: "turn_held", hold: { reason: "user_budget", resetsAtMs: DEC_1, usedUp: false } });
    expect(events.reduce(reduceLive, startLive(turnId)).error).toBe("Not enough of this month's AI allowance is left for another AI step. It resets on December 1.");
  });
  test("the usage page shows settled spend and what is reserved on separate lines", () => {
    const a = { usedUsd: 1.1, reservedUsd: 0.34, limitUsd: 5, uncapped: false, resetsAtMs: DEC_1, held: null } as const;
    expect(allowanceView(a)).toEqual({
      line: "$0.76 of your $5.00 AI allowance used this month. It resets on December 1.",
      reserved: "$0.34 more is set aside for AI steps still running. It counts against your allowance until they finish, and whatever they do not use is given back.",
      held: null,
    });
    expect(allowanceView({ ...a, reservedUsd: 0 })!.reserved).toBeNull();
    expect(renderToStaticMarkup(createElement(AllowanceNote, { allowance: a }))).toContain("$0.34 more is set aside for AI steps still running.");
    expect(usageResponse.parse({ byKind: {}, byPurpose: {}, allowance: { usedUsd: 1, limitUsd: 5, resetsAtMs: DEC_1, held: null } }).allowance!.reservedUsd).toBe(0);
  });

  test("the wire carries turn_held and the allowance, and an older backend's usage without one decodes as no budget", () => {
    expect(tutorStreamEvent.parse({ type: "turn_held", hold: { reason: "stopped" } })).toEqual({ type: "turn_held", hold: { reason: "stopped" } });
    const held = { type: "turn_held", hold: { reason: "user_budget", resetsAtMs: DEC_1, usedUp: false } } as const;
    expect(tutorStreamEvent.parse(held)).toEqual(held);
    expect(() => tutorStreamEvent.parse({ type: "turn_held", hold: { reason: "user_budget", resetsAtMs: DEC_1 } })).toThrow();
    const allowance = { usedUsd: 1, reservedUsd: 0, limitUsd: 5, uncapped: false, resetsAtMs: DEC_1, held: null };
    expect(usageResponse.parse({ byKind: {}, byPurpose: {}, allowance }).allowance).toEqual(allowance);
    expect(usageResponse.parse({ byKind: {}, byPurpose: {} }).allowance).toBeNull();
  });
});

describe("Jev spend", () => {
  const sum = (db: Db, column: string) => db.sql.query<{ n: number }, []>(`SELECT COALESCE(SUM(${column}), 0) AS n FROM ${column === "cost_usd" ? "usage_events" : "budget_holds"}`).get()!.n;

  test("once every call has finished, the allowance equals the sum of the usage events and no hold is left open", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const tokens = [5161, 5364, 5515, 420, 10_632];
    let call = 0;
    const fetched = scriptedFetch(() => json({ model: "jev-1.13.0", answers: { teaching_change: { type: "noul", noul: 0.2 } }, usage: { input_tokens: tokens[call++], output_tokens: 3 } }));
    const jev = createJevClient({ apiKey: "k", fetch: fetched.fetch });
    const task = frameChangeTask(jev);
    const input = (i: number, width = 1280) => ({ before: withBytes(frame(`a${i}`)), after: withBytes(frame(`b${i}`, width, 720), jpeg(width, 720)), nearbyPassages: [] });
    const outcomes = await Promise.all([...tokens.keys()].map((i) => w.memo.run(task, input(i))));
    expect(outcomes.map((o) => o.kind)).toEqual(tokens.map(() => "hit"));
    const bad = await w.memo.run(task, input(9, 100));
    expect(bad.kind).toBe("failed");
    expect(fetched.seen).toHaveLength(tokens.length);

    const events = w.db.sql.query<{ cost_kind: string; cost_usd: number }, []>("SELECT cost_kind, cost_usd FROM usage_events ORDER BY started_ms, id").all();
    expect(events.filter((e) => e.cost_kind === "estimated")).toHaveLength(tokens.length + 1);
    expect(events.filter((e) => e.cost_kind === "estimated" && e.cost_usd === 0)).toHaveLength(1);
    expect(events.some((e) => e.cost_kind === "unknown")).toBe(false);
    expect(w.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM budget_holds WHERE settled_micros IS NULL").get()!.n).toBe(0);
    const priced = tokens.reduce((a, t) => a + Math.ceil((t * 42) / 1000) / 1_000_000, 0);
    expect(sum(w.db, "cost_usd")).toBeCloseTo(priced, 9);
    expect(used(w.budget, w.db)).toBeCloseTo(sum(w.db, "cost_usd"), 5);
    expect(sum(w.db, "settled_micros") / 1_000_000).toBe(used(w.budget, w.db));
  });

  test("a Jev response with no tokens is unknown cost and counts at the reservation, a priced one counts its price", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const task = frameChangeTask(createJevClient({ apiKey: "k", fetch: scriptedFetch(() => json({ model: "jev-1.13.0", answers: { teaching_change: { type: "noul", noul: 0.2 } } })).fetch }));
    await w.memo.run(task, { before: withBytes(frame("a")), after: withBytes(frame("b")), nearbyPassages: [] });
    expect(w.db.sql.query("SELECT cost_kind, cost_usd FROM usage_events").get()).toEqual({ cost_kind: "unknown", cost_usd: null });
    expect(used(w.budget, w.db)).toBe(ESTIMATE_USD.frame_change);
  });
  const jevTask = (tokens: number, answer: unknown = { type: "noul", noul: 0.2 }) =>
    frameChangeTask(createJevClient({ apiKey: "k", fetch: scriptedFetch(() => json({ model: "jev-1.13.0", answers: { teaching_change: answer }, usage: { input_tokens: tokens, output_tokens: 3 } })).fetch }));
  const pair = { before: withBytes(frame("a")), after: withBytes(frame("b")), nearbyPassages: [] };
  const settledMicros = (db: Db) => db.sql.query<{ settled_micros: number }, []>("SELECT settled_micros FROM budget_holds").all().map((h) => h.settled_micros);

  test("a process that ends after a valid response is reconciled at the price already read, not the reservation", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const task = jevTask(30_000);
    void w.memo.run({ ...task, attempt: async (i, c) => (await task.attempt(i, c), new Promise<never>(() => {})) }, pair);
    await new Promise((r) => setTimeout(r, 20));
    const next = createBudget(w.db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => false });
    expect(next.reconcileInterrupted()).toBe(1);
    expect(settledMicros(w.db)).toEqual([1260]);
    expect(w.db.sql.query("SELECT cost_kind FROM usage_events").get()).toEqual({ cost_kind: "unknown" });
  });

  test("an answer that fails validation still settles at the price of the tokens Jev billed", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const out = await w.memo.run(jevTask(30_000, { type: "noul", noul: 1.5 }), pair);
    expect(out.kind).toBe("failed");
    expect(w.db.sql.query<{ cost_kind: string; cost_usd: number }, []>("SELECT cost_kind, cost_usd FROM usage_events").get()).toEqual({ cost_kind: "estimated", cost_usd: expect.closeTo(0.00126, 9) as unknown as number });
    expect(settledMicros(w.db)).toEqual([1260]);
  });

  test("an implausible token count is recorded as unknown and still settles, while a valid input count beside it is priced", async () => {
    const cases: [unknown, unknown, string, number][] = [
      [1e30, 3, "unknown", ESTIMATE_USD.frame_change * 1_000_000],
      [1.5, 3, "unknown", ESTIMATE_USD.frame_change * 1_000_000],
      [30_000, 1e30, "estimated", 1260],
    ];
    for (const [input_tokens, output_tokens, kind, micros] of cases) {
      const w = world({ userUsd: 5, totalUsd: 50 });
      const task = frameChangeTask(createJevClient({ apiKey: "k", fetch: scriptedFetch(() => json({ model: "jev-1.13.0", answers: { teaching_change: { type: "noul", noul: 0.2 } }, usage: { input_tokens, output_tokens } })).fetch }));
      await w.memo.run(task, pair);
      expect(w.db.sql.query<{ cost_kind: string }, []>("SELECT cost_kind FROM usage_events").all(), String(input_tokens)).toEqual([{ cost_kind: kind }]);
      expect(settledMicros(w.db), String(input_tokens)).toEqual([micros]);
    }
  });

  test("a settled amount is never below the cost recorded for it, down to a response of 11 tokens", async () => {
    for (const [tokens, micros] of [[5364, 226], [11, 1], [0, 0]] as const) {
      const w = world({ userUsd: 5, totalUsd: 50 });
      await w.memo.run(jevTask(tokens), pair);
      const [settled] = settledMicros(w.db);
      const recorded = w.db.sql.query<{ cost_usd: number }, []>("SELECT cost_usd FROM usage_events").get()!.cost_usd;
      expect(settled).toBe(micros);
      expect(settled! / 1_000_000).toBeGreaterThanOrEqual(recorded);
    }
  });

  test("an envelope-invalid reply is not memoised, though its answers are valid", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    const answers = { teaching_change: { type: "noul", noul: 0.2 } };
    for (const body of [{ model: "jev-1.13.0", answers, usage: { input_tokens: "bad" } }, { model: 3, answers, usage: { input_tokens: 30_000 } }]) {
      const task = frameChangeTask(createJevClient({ apiKey: "k", fetch: scriptedFetch(() => json(body)).fetch }));
      expect((await w.memo.run(task, { before: withBytes(frame("a")), after: withBytes(frame("b")), nearbyPassages: [] })).kind).toBe("failed");
    }
    expect(w.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memo").get()!.n).toBe(0);
  });

  test("input tokens settle at their price when output_tokens is malformed, and on an HTTP 500 that carries usage", async () => {
    for (const [status, body] of [
      [200, { model: "jev-1.13.0", answers: { teaching_change: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 30_000, output_tokens: "bad" } }],
      [500, { message: "boom", usage: { input_tokens: 30_000 } }],
    ] as const) {
      const w = world({ userUsd: 5, totalUsd: 50 });
      const task = frameChangeTask(createJevClient({ apiKey: "k", fetch: scriptedFetch(() => json(body, status)).fetch }));
      await w.memo.run(task, { before: withBytes(frame("a")), after: withBytes(frame("b")), nearbyPassages: [] });
      const settled = settledMicros(w.db);
      expect(settled.length).toBeGreaterThan(0);
      expect(settled.every((m) => m === 1260)).toBe(true);
    }
  });

  test("a settlement is the exact price rounded up, for 1,500 tokens and for every count from 0 to 3,000", async () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    await w.memo.run(jevTask(1500), pair);
    expect(settledMicros(w.db)).toEqual([63]);
    const w2 = world({ userUsd: null, totalUsd: null });
    for (let t = 0; t <= 3000; t++) {
      const c = jevCost("jev-1.13.0", t);
      const ticket = w2.budget.reserve(w2.db.userId, "frame_change", `k${t}` as never);
      if (ticket.kind !== "reserved" || c.kind === "unknown") throw new Error("not reserved or priced");
      w2.budget.settle(ticket.reservation, c);
    }
    const all = settledMicros(w2.db);
    expect(all).toHaveLength(3001);
    expect(all.every((settled, t) => settled * 1000 >= t * 42 && settled * 1000 < t * 42 + 1000)).toBe(true);
  });

  test("any other cost (Claude's floats) settles at the next micro above it, and a whole number of micros stays itself", () => {
    const w = world({ userUsd: null, totalUsd: null });
    const settle = (usd: number) => {
      const t = w.budget.reserve(w.db.userId, "frame_change", `k${usd}` as never);
      if (t.kind !== "reserved") throw new Error("held");
      w.budget.settle(t.reservation, { kind: "notional", usd, basis: "claude_subscription" });
      return settledMicros(w.db).at(-1);
    };
    expect(settle(0.00006300000000000001)).toBe(64);
    expect(settle(0.0000631)).toBe(64);
    expect(settle(0.000063)).toBe(63);
    expect(settle(0.0421)).toBe(42_100);
  });

  test("a cap is never rounded up: $0.0004991 refuses a $0.0005 reservation, and a cap of exactly $0.0005 admits it", () => {
    const hold = (cap: number) => {
      const w = world({ userUsd: null, totalUsd: cap });
      return w.budget.reserve(w.db.userId, "frame_change", "k" as never).kind;
    };
    expect(hold(0.0004991)).toBe("held");
    expect(hold(0.0005)).toBe("reserved");
  });
});

// #236: the flat figure a tutor request reserves when its adapter passes no estimate. The request-sensitive reservation is in tutor-reservation.test.ts.
describe("the tutor turn reservation", () => {
  // The Fable end-to-end audit of 2026-11-14 (docs/trail/fable-e2e-2026-11-14-data.json), Sonnet: the dearest turn is the one that writes
  // the system block, 31,241 input tokens, written at the 1 hour rate in the worst case (the turn after a long pause). 2,000 output tokens
  // is four times the most a measured turn spent (505).
  const dearestMeasured = priceUsage("claude-sonnet-5-5", { fresh: 0, creation5m: 0, creation1h: 31_241, read: 0, output: 2_000 })!;

  test("covers the dearest turn measured on Sonnet and is not many times it", () => {
    expect(TUTOR).toBeGreaterThanOrEqual(dearestMeasured);
    expect(TUTOR).toBeLessThanOrEqual(2 * dearestMeasured);
  });

  test("a learner with a tutor turn's worth of allowance left is not refused", () => {
    const w = world({ userUsd: 5, totalUsd: 50 });
    w.db.sql.query("INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms, settled_micros, settled_ms) VALUES ('h', ?, '2026-11', 'claim_revision', 'k', 1, 1, ?, 1)").run(w.db.userId, 4_850_000);
    expect(w.budget.allowance(w.db.userId).held).toBeNull();
  });
});
