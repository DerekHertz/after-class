import { describe, expect, test } from "bun:test";
import { createClaudeCli } from "../src/backend/providers/claude";
import { boundaryTask, claimSupportTask, frameChangeTask } from "../src/backend/providers/jev-tasks";
import { createLedger } from "../src/backend/providers/ledger";
import type { Task } from "../src/backend/providers/memo";
import { createMemo, ProviderError, unbudgeted } from "../src/backend/providers/memo";
import { testUserDb } from "./fakes";
import { boundaryInput, claim, cli, fakeJev, frame, Out, p, passage, req, successEnvelope, withBytes } from "./providers-fixtures";

// ───────────────────────────── ledger + memo (R17) ──────────────────────────

describe("R17 and the ledger", () => {
  const claudeTask = (claude: ReturnType<typeof createClaudeCli>, purpose: "interpretation" | "wrap_up"): Task<{ tag: string }, { concepts: string[] }> => ({
    provider: "claude",
    purpose,
    model: "opus",
    version: "t1",
    maxAttempts: 1,
    canonicalInput: (i) => ({ tag: i.tag }),
    decode: (s) => Out.parse(s),
    async attempt(_i, c) {
      const r = await claude.structured(req(), Out, unbudgeted(c.signal));
      return { output: r.output, usage: r.usage };
    },
  });

  test("Jev events are stored with cost unknown and usd NULL; Claude events are notional; totals never mix them", async () => {
    const db = testUserDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const ledger = createLedger(db);

    const { jev } = fakeJev(() => ({ new_concept: p(0.9), stopping_point: p(0.1) }));
    await memo.run(boundaryTask(jev), boundaryInput());
    await memo.run(boundaryTask(jev), boundaryInput({ newPassages: [passage("ev_n2", 5, "x")] }));
    const failing = fakeJev(() => new ProviderError("jev 400", null, false));
    await memo.run(claimSupportTask(failing.jev), { claim: claim(), passages: [], frames: [] });

    const { claude } = cli(() => ({ stdout: [JSON.stringify(successEnvelope)] }));
    await memo.run(claudeTask(claude, "interpretation"), { tag: "a" });
    await memo.run(claudeTask(claude, "interpretation"), { tag: "b" });
    const noCost = (() => {
      const { total_cost_usd: _x, ...rest } = successEnvelope;
      return cli(() => ({ stdout: [JSON.stringify(rest)] })).claude;
    })();
    await memo.run(claudeTask(noCost, "wrap_up"), { tag: "c" });

    const raw = db.sql.query<{ provider: string; cost_kind: string; cost_usd: number | null; cost_reason: string | null }, []>(`SELECT provider, cost_kind, cost_usd, cost_reason FROM usage_events`).all();
    expect(raw.filter((r) => r.provider === "jev").every((r) => r.cost_kind === "unknown" && r.cost_usd === null && r.cost_reason !== null)).toBe(true);
    expect(raw.filter((r) => r.provider === "claude" && r.cost_kind === "notional").every((r) => r.cost_usd === 0.0421)).toBe(true);

    const s = ledger.summary();
    expect(s.byKind.unknown).toEqual({ calls: 4, usd: null });
    expect(s.byKind.notional).toEqual({ calls: 2, usd: 0.0842 });
    expect(s.byKind.measured).toEqual({ calls: 0, usd: null });
    expect(s.byPurpose.boundary).toEqual({ calls: 2, errors: 0, unknownCost: 2 });
    expect(s.byPurpose.claim_check).toEqual({ calls: 1, errors: 1, unknownCost: 1 });
    expect(s.byPurpose.wrap_up).toEqual({ calls: 1, errors: 0, unknownCost: 1 });

    const stages = ledger.stages();
    expect(stages.map((x) => x.purpose)).toEqual(["boundary", "claim_check", "interpretation", "wrap_up"]);
    const interp = stages.find((x) => x.purpose === "interpretation")!;
    expect(interp).toMatchObject({ provider: "claude", calls: 2, unknownCostCalls: 0, usd: { measured: null, notional: 0.0842, estimated: null }, inputTokens: 300, outputTokens: 150, cacheReadTokens: 1800 });
    const boundary = stages.find((x) => x.purpose === "boundary")!;
    expect(boundary).toMatchObject({ provider: "jev", calls: 2, unknownCostCalls: 2, usd: { measured: null, notional: null, estimated: null }, inputTokens: 200, outputTokens: 4, cacheReadTokens: null });
    expect(stages.find((x) => x.purpose === "claim_check")).toMatchObject({ calls: 1, errors: 1, inputTokens: null });
  });

  test("filters narrow summary and stages; list returns events newest first", async () => {
    let t = 1_000;
    const db = testUserDb();
    const memo = createMemo(db, "live", { now: () => (t += 10) });
    const ledger = createLedger(db);
    const { jev } = fakeJev(() => ({ new_concept: p(0.9), stopping_point: p(0.1) }));
    const first = boundaryInput();
    await memo.run(boundaryTask(jev), first);
    const cutoff = t;
    t += 1_000;
    await memo.run(boundaryTask(jev), boundaryInput({ newPassages: [passage("ev_n2", 5, "x")] }));
    await memo.run(frameChangeTask(jev), { before: null, after: withBytes(frame("z")), nearbyPassages: [] });

    expect(ledger.summary({ sinceMs: cutoff }).byPurpose.boundary.calls).toBe(1);
    expect(ledger.summary({ purpose: "frame_change" }).byPurpose.boundary.calls).toBe(0);
    expect(ledger.stages({ purpose: "boundary" }).map((s) => s.calls)).toEqual([2]);
    const events = ledger.list({ limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0]!.startedAtMs).toBeGreaterThanOrEqual(events[1]!.startedAtMs);
    expect(events[0]!.cost).toEqual({ kind: "unknown", reason: "no provider call was made" });
    expect(ledger.list({ memoKey: memo.key(boundaryTask(jev), first), limit: 10 })).toHaveLength(1);
  });

  test("a kind with no calls reports usd null, not $0; a ledger of only unknown-cost calls prices nothing", async () => {
    const db = testUserDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const { jev } = fakeJev(() => ({ new_concept: p(0.9), stopping_point: p(0.1) }));
    await memo.run(boundaryTask(jev), boundaryInput());
    const s = createLedger(db).summary();
    expect(s.byKind.unknown).toEqual({ calls: 1, usd: null });
    for (const k of ["measured", "notional", "estimated"] as const) expect(s.byKind[k]).toEqual({ calls: 0, usd: null });
  });

  test("an empty ledger reports zero calls and no invented money", () => {
    const ledger = createLedger(testUserDb());
    const s = ledger.summary();
    expect(s.byKind.unknown).toEqual({ calls: 0, usd: null });
    for (const k of ["measured", "notional", "estimated"] as const) expect(s.byKind[k]).toEqual({ calls: 0, usd: null });
    expect(Object.values(s.byPurpose).every((x) => x.calls === 0)).toBe(true);
    expect(ledger.stages()).toEqual([]);
    expect(ledger.list({ limit: 5 })).toEqual([]);
  });
});
