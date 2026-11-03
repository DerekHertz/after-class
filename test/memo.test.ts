import { describe, expect, test } from "bun:test";
import { appliesBefore, createMemo, ReplayMiss } from "../src/backend/providers/memo";
import type { Memo } from "../src/backend/providers/memo";
import type { Db } from "../src/backend/db";
import { deferred, fail, fakeTask, ok, testDb, usage } from "./fakes";
import type { FakeStep } from "./fakes";

type In = { readonly window: string };

function setup(): { db: Db; memo: Memo } {
  const db = testDb();
  return { db, memo: createMemo(db, "live", { retryDelayMs: () => 0, now: () => 1000 }) };
}

function usageRows(db: Db) {
  return db.sql
    .query<{ attempt_no: number; outcome: string; cost_kind: string; cost_usd: number | null }, []>(
      "SELECT attempt_no, outcome, cost_kind, cost_usd FROM usage_events ORDER BY attempt_no",
    )
    .all();
}

describe("content-keyed cache", () => {
  test("the same input is called once and then served from the memo", async () => {
    const { memo } = setup();
    const t = fakeTask<In, string>({ answer: (i) => ok(`judged ${i.window}`) });
    const first = await memo.run(t, { window: "w1" });
    const second = await memo.run(t, { window: "w1" });
    expect(first).toMatchObject({ kind: "hit", value: "judged w1" });
    expect(second).toEqual(first);
    expect(memo.lookup(t, { window: "w1" })).toEqual(first);
    expect(t.calls).toEqual([{ window: "w1" }]);
  });

  test("the key is the canonical input, task version and model", () => {
    const { memo } = setup();
    const t = fakeTask<{ a: number; b: number }, string>({ answer: () => ok("x") });
    expect(memo.key(t, { a: 1, b: 2 })).toBe(memo.key(t, { b: 2, a: 1 }));
    expect(memo.key(t, { a: 1, b: 2 })).not.toBe(memo.key(t, { a: 1, b: 3 }));
    expect(memo.key(fakeTask({ version: "v2", answer: () => ok("x") }), { a: 1, b: 2 })).not.toBe(memo.key(t, { a: 1, b: 2 }));
    expect(memo.key(fakeTask({ model: "jev-1.14", answer: () => ok("x") }), { a: 1, b: 2 })).not.toBe(memo.key(t, { a: 1, b: 2 }));
  });

  test("stored output is re-validated by the task's decoder on read", async () => {
    const { db, memo } = setup();
    const t = fakeTask<In, number>({ answer: () => ok(7) });
    await memo.run(t, { window: "w" });
    const stricter = createMemo(db, "live");
    const decodeFails = fakeTask<In, number>({ answer: () => ok(7), decode: () => { throw new Error("schema changed"); } });
    expect(() => stricter.lookup(decodeFails, { window: "w" })).toThrow("schema changed");
  });
});

describe("single-flight", () => {
  test("concurrent runs of one key share one call", async () => {
    const { memo } = setup();
    const gate = deferred<FakeStep<string>>();
    const t = fakeTask<In, string>({ answer: () => gate.promise });
    const a = memo.run(t, { window: "w" });
    const b = memo.run(t, { window: "w" });
    expect(memo.lookup(t, { window: "w" }).kind).toBe("inflight");
    gate.resolve(ok("done"));
    expect(await a).toEqual(await b);
    expect(t.calls.length).toBe(1);
  });
});

describe("Seq cutoff (R8: Results from cancelled or outdated jobs never overwrite current preparation or my notes.)", () => {
  test("a result that lands after a stop-early fact is stored but does not apply", async () => {
    const { db, memo } = setup();
    const gate = deferred<FakeStep<string>>();
    const t = fakeTask<In, string>({ answer: () => gate.promise });
    const running = memo.run(t, { window: "w" });
    const stopEarly = db.nextSeq();
    gate.resolve(ok("late"));
    const late = await running;
    expect(late.kind).toBe("hit");
    expect(appliesBefore(late, stopEarly)).toBe(false);
    expect(appliesBefore(late, null)).toBe(true);
    expect(appliesBefore(late, db.nextSeq())).toBe(true);
    expect(appliesBefore(memo.lookup(t, { window: "other" }), null)).toBe(false);
  });
});

describe("R17: Every paid call records a usage event; unknown cost is stored as unknown, not zero.", () => {
  test("every attempt, failed or not, writes one usage event", async () => {
    const { db, memo } = setup();
    const t = fakeTask<In, string>({
      maxAttempts: 3,
      answer: (_, n) => (n < 3 ? fail(`overloaded ${n}`, { retryable: true }) : ok("third time")),
    });
    expect(await memo.run(t, { window: "w" })).toMatchObject({ kind: "hit", value: "third time" });
    expect(usageRows(db)).toEqual([
      { attempt_no: 1, outcome: "error", cost_kind: "unknown", cost_usd: null },
      { attempt_no: 2, outcome: "error", cost_kind: "unknown", cost_usd: null },
      { attempt_no: 3, outcome: "ok", cost_kind: "unknown", cost_usd: null },
    ]);
  });

  test("a billed failure keeps the provider's usage", async () => {
    const { db, memo } = setup();
    const t = fakeTask<In, string>({ answer: () => fail("500", { usage: usage({ kind: "measured", usd: 0.03 }) }) });
    await memo.run(t, { window: "w" });
    expect(usageRows(db)).toEqual([{ attempt_no: 1, outcome: "error", cost_kind: "measured", cost_usd: 0.03 }]);
  });

  test("the result and its usage event commit together or not at all", async () => {
    const { db, memo } = setup();
    const t = fakeTask<In, string>({ answer: () => ok("x", { usage: usage({ kind: "measured", usd: -1 }) }) });
    await expect(memo.run(t, { window: "w" })).rejects.toThrow(/CHECK constraint/);
    expect(memo.lookup(t, { window: "w" }).kind).toBe("missing");
    expect(usageRows(db)).toEqual([]);
  });

  test("output the task cannot decode is a failure that still records the billed usage", async () => {
    const { db, memo } = setup();
    const t = fakeTask<In, number>({
      answer: () => ok(1, { usage: usage({ kind: "notional", usd: 0.2, basis: "claude_subscription" }) }),
      decode: () => { throw new Error("bad shape"); },
    });
    expect(await memo.run(t, { window: "w" })).toMatchObject({ kind: "failed", attempts: 1 });
    expect(usageRows(db)).toEqual([{ attempt_no: 1, outcome: "error", cost_kind: "notional", cost_usd: 0.2 }]);
  });
});

describe("failures", () => {
  test("a non-retryable error is terminal at once and is not retried until the user clears it", async () => {
    const { db, memo } = setup();
    let broken = true;
    const t = fakeTask<In, string>({ answer: () => (broken ? fail("bad request") : ok("fixed")) });
    const failed = await memo.run(t, { window: "w" });
    expect(failed).toMatchObject({ kind: "failed", attempts: 1, lastError: "ProviderError: bad request" });
    expect(await memo.run(t, { window: "w" })).toEqual(failed);
    expect(t.calls.length).toBe(1);

    broken = false;
    memo.clearFailures([failed.key]);
    expect(await memo.run(t, { window: "w" })).toMatchObject({ kind: "hit", value: "fixed" });
    expect(usageRows(db).map((r) => r.attempt_no)).toEqual([1, 2]);
  });

  test("retryable errors stop at maxAttempts", async () => {
    const { memo } = setup();
    const t = fakeTask<In, string>({ maxAttempts: 2, answer: () => fail("429", { retryable: true }) });
    expect(await memo.run(t, { window: "w" })).toMatchObject({ kind: "failed", attempts: 2 });
    expect(t.calls.length).toBe(2);
  });

  test("an aborted call records an aborted usage event and leaves the key missing", async () => {
    const { db, memo } = setup();
    const gate = deferred<FakeStep<string>>();
    const t = fakeTask<In, string>({ answer: () => gate.promise });
    const ctl = new AbortController();
    const running = memo.run(t, { window: "w" }, { signal: ctl.signal });
    ctl.abort();
    expect(await running).toMatchObject({ kind: "missing" });
    expect(usageRows(db)).toEqual([{ attempt_no: 1, outcome: "aborted", cost_kind: "unknown", cost_usd: null }]);
    expect(memo.lookup(t, { window: "w" }).kind).toBe("missing");
  });
});

describe("streaming", () => {
  test("streamTo receives the provider's deltas and the final output is stored", async () => {
    const { memo } = setup();
    const t = fakeTask<In, string>({ purpose: "tutor_turn", provider: "claude", answer: () => ok("Hello there.", { deltas: ["Hello", " there."] }) });
    const seen: string[] = [];
    expect(await memo.run(t, { window: "w" }, { streamTo: (d) => seen.push(d) })).toMatchObject({ value: "Hello there." });
    expect(seen).toEqual(["Hello", " there."]);
  });
});

describe("replay", () => {
  test("a recorded database answers lookups and runs, and a miss throws instead of calling", async () => {
    const { db, memo } = setup();
    const recorder = fakeTask<In, string>({ answer: () => ok("recorded") });
    await memo.run(recorder, { window: "w1" });

    const replay = createMemo(db, "replay");
    const t = fakeTask<In, string>({ answer: () => ok("live call") });
    expect(await replay.run(t, { window: "w1" })).toMatchObject({ kind: "hit", value: "recorded" });
    await expect(replay.run(t, { window: "w2" })).rejects.toBeInstanceOf(ReplayMiss);
    expect(t.calls).toEqual([]);
  });
});

describe("inspect", () => {
  test("returns the exact input, output and usage for a key", async () => {
    const { memo } = setup();
    const t = fakeTask<In, string>({ answer: () => ok("judged") });
    const r = await memo.run(t, { window: "w1" });
    expect(memo.inspect(r.key)).toMatchObject({
      purpose: "boundary",
      version: "v1",
      input: { window: "w1" },
      output: "judged",
      failure: null,
      usage: [{ attemptNo: 1, outcome: "ok", cost: { kind: "unknown", reason: "fake provider" } }],
    });
    expect(memo.inspect("key_aaaaaaaaaaaaaaaaaaaaaaaaaa" as typeof r.key)).toBeNull();
  });
});
