import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalUser, MIGRATIONS, openDb } from "../src/backend/db";
import { serve } from "../src/backend/http";
import { createBudget, ESTIMATE_USD, WRAP_UPS_PER_REVIEW } from "../src/backend/providers/budget";
import { createMemo } from "../src/backend/providers/memo";
import { createRecord } from "../src/backend/record";
import { createReviews, ReviewLimitError, UNTUTORED_REVIEWS_PER_DAY } from "../src/backend/review";
import { nextThreadId, wrapUpPrompt } from "../src/backend/review/tutor";
import type { UserDb } from "../src/backend/db";
import type { LearnerAct } from "../src/shared/domain";
import { randomId } from "../src/shared/ids";
import type { MemoKey, ReviewId } from "../src/shared/ids";
import { Material } from "../src/shared/time";
import { fail, fakeTask, ok, otherUserDb, testUserDb, usage } from "./fakes";
import { answer, collect, started, World } from "./review-fixtures";

// #244: the wrap-up that saves a review passes both caps ("i think it should be allowed to finish"). It may do so only for a review
// that holds tutoring the learner paid for under those caps, and a bounded number of times.

const NOW = Date.UTC(2026, 10, 14, 12);
const TUTOR = ESTIMATE_USD.tutor_turn;
const UNKNOWN = { kind: "unknown", reason: "test" } as const;
type In = { readonly n: number };

// ───────────────────────────── the budget and memo, without a review ─────────────────────────────

/** A user who paid for one tutor turn in each of `reviews` and has now used up the budget. */
async function spentWorld(reviews: readonly ReviewId[]) {
  const db = testUserDb();
  const budget = createBudget(db, { limits: { userUsd: reviews.length * TUTOR, totalUsd: 50 }, stopped: () => false, now: () => NOW });
  const memo = createMemo(db, "live", { retryDelayMs: () => 0, now: () => NOW, budget });
  const tutor = fakeTask<In, string>({ purpose: "tutor_turn", provider: "claude", answer: () => ok("x", { usage: usage(UNKNOWN) }) });
  for (const [n, review] of reviews.entries()) await memo.run(tutor, { n }, { review });
  expect(budget.allowance(db.userId).held).toMatchObject({ reason: "user_budget" });
  const wrapUp = fakeTask<In, string>({ purpose: "wrap_up", provider: "claude", answer: () => ok("saved", { usage: usage(UNKNOWN) }) });
  return { db, budget, memo, wrapUp };
}

const review = () => randomId("rvw");

describe("the wrap-up passes the caps only for a review with paid tutoring", () => {
  test("wrap-ups of reviews that paid for no tutoring make no call once the user is capped", async () => {
    const w = await spentWorld([review()]);
    for (let n = 0; n < 10; n++) {
      expect(await w.memo.run(w.wrapUp, { n }, { review: review() })).toMatchObject({ kind: "held", hold: { reason: "user_budget" } });
    }
    expect(await w.memo.run(w.wrapUp, { n: 99 })).toMatchObject({ kind: "held", hold: { reason: "user_budget" } });
    expect(w.wrapUp.calls).toEqual([]);
  });

  test("a review that paid for tutoring finishes past the cap, and the call still counts", async () => {
    const paid = review();
    const w = await spentWorld([paid]);
    expect((await w.memo.run(w.wrapUp, { n: 1 }, { review: paid })).kind).toBe("hit");
    expect(w.wrapUp.calls).toEqual([{ n: 1 }]);
    expect(w.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events WHERE purpose = 'wrap_up'").get()!.n).toBe(1);
  });

  test("tutoring in another review, or a tutor request that was not charged, does not open the exemption", async () => {
    const db = testUserDb();
    const budget = createBudget(db, { limits: { userUsd: 2 * TUTOR, totalUsd: 50 }, stopped: () => false, now: () => NOW });
    const memo = createMemo(db, "live", { retryDelayMs: () => 0, now: () => NOW, budget });
    const [free, other] = [review(), review()];
    const tutor = (usd: number) => fakeTask<In, string>({ purpose: "tutor_turn", provider: "claude", answer: () => ok("x", { usage: usage({ kind: "measured", usd }) }) });
    await memo.run(tutor(0), { n: 0 }, { review: free });
    await memo.run(tutor(2 * TUTOR), { n: 1 }, { review: other });
    expect(budget.allowance(db.userId).held).toMatchObject({ reason: "user_budget" });
    const wrapUp = fakeTask<In, string>({ purpose: "wrap_up", provider: "claude", answer: () => ok("saved", { usage: usage(UNKNOWN) }) });
    expect(await memo.run(wrapUp, { n: 0 }, { review: free })).toMatchObject({ kind: "held" });
    expect(await memo.run(wrapUp, { n: 1 }, { review: review() })).toMatchObject({ kind: "held" });
    expect((await memo.run(wrapUp, { n: 2 }, { review: other })).kind).toBe("hit");
  });

  test("a second save of the same review makes no second call, and a review cannot pass the caps without bound", async () => {
    const [paid, otherPaid] = [review(), review()];
    const w = await spentWorld([paid, otherPaid]);
    await w.memo.run(w.wrapUp, { n: 1 }, { review: paid });
    await w.memo.run(w.wrapUp, { n: 1 }, { review: paid });
    expect(w.wrapUp.calls).toHaveLength(1);
    const results = [];
    for (let n = 2; n < WRAP_UPS_PER_REVIEW + 4; n++) results.push((await w.memo.run(w.wrapUp, { n }, { review: paid })).kind);
    expect(w.wrapUp.calls).toHaveLength(WRAP_UPS_PER_REVIEW);
    expect(results.at(-1)).toBe("held");
    expect((await w.memo.run(w.wrapUp, { n: 99 }, { review: otherPaid })).kind).toBe("hit");
  });

  test("the stop switch still holds a real review's wrap-up", async () => {
    const db = testUserDb();
    let stopped = false;
    const budget = createBudget(db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => stopped, now: () => NOW });
    const memo = createMemo(db, "live", { retryDelayMs: () => 0, now: () => NOW, budget });
    const paid = review();
    await memo.run(fakeTask<In, string>({ purpose: "tutor_turn", provider: "claude", answer: () => ok("x", { usage: usage(UNKNOWN) }) }), { n: 0 }, { review: paid });
    stopped = true;
    const t = fakeTask<In, string>({ purpose: "wrap_up", provider: "claude", answer: () => ok("x", { usage: usage(UNKNOWN) }) });
    expect(await memo.run(t, { n: 1 }, { review: paid })).toMatchObject({ kind: "held", hold: { reason: "stopped" } });
  });

  test("the exemption holds across processes on one file: six wrap-up holds in all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrap-up-race-"));
    try {
      const path = join(dir, "db.sqlite");
      const db = openDb(path);
      const uid = ensureLocalUser(db);
      db.sql.run(
        "INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms, review_id, settled_micros, settled_ms) VALUES ('seed', ?, '2026-11', 'tutor_turn', 'seed-key', 5, 1, 'same-review', 5, 1)",
        [uid],
      );
      db.close();
      const worker = join(dir, "worker.ts");
      writeFileSync(
        worker,
        `import { openDb } from ${JSON.stringify(join(import.meta.dir, "../src/backend/db"))};
import { createBudget } from ${JSON.stringify(join(import.meta.dir, "../src/backend/providers/budget"))};
const db = openDb(process.argv[2]);
const budget = createBudget(db, { limits: { userUsd: 0, totalUsd: 0 }, stopped: () => false });
let n = 0;
for (let i = 0; i < 20; i++) if (budget.reserve(process.argv[3], "wrap_up", "k" + i, "same-review").kind === "reserved") n++;
console.log(n);
db.close();`,
      );
      const procs = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, worker, path, uid], { stdout: "pipe", stderr: "pipe" }));
      const counts = await Promise.all(procs.map(async (p) => Number((await new Response(p.stdout).text()).trim())));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(WRAP_UPS_PER_REVIEW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── a review end to end ─────────────────────────────

type Rig = ReturnType<typeof rig>;

/** A hosted-shaped stack: the budget, the memo, the review module and the record share one database, as in main.ts. */
/** Holds written before 006 carry no review id, so the upgrade moment decides which reviews are judged by their stored turns. */
const upgradedAt = (db: UserDb, ms: number) => db.sql.run("UPDATE schema_migrations SET applied_ms = ? WHERE id = '006-budget-holds-review'", [ms]);

function rig(wrapFailures = 0, sharedDb: UserDb | null = null, legacyTutor = false) {
  const db = sharedDb ?? testUserDb();
  // The test clock is fixed at NOW, before the real time migration 006 was applied, so mark the upgrade as already past.
  upgradedAt(db, NOW - 1);
  const world = new World(db);
  const budget = createBudget(db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => false, now: () => NOW });
  const memo = createMemo(db, "live", { budget, retryDelayMs: () => 0, now: () => NOW });
  const tutor = {
    ...fakeTask<any, any>({
      purpose: "tutor_turn",
      provider: "claude",
      answer: (input) => {
        const thread = input.state.openThread ?? nextThreadId(input.state);
        const kind = input.allowed.includes("ask_main") ? "ask_main" : input.allowed[0];
        const move =
          kind === "ask_main" ? { kind, threadId: thread, claimIds: [input.claims[0].id] }
          : kind === "explain" ? { kind, threadId: thread, evidence: input.claims[0].evidence }
          : kind === "hint" ? { kind, threadId: thread }
          : { kind };
        return ok({ move, say: "A response." });
      },
    }),
    canonicalInput: (i: any) => ({ turns: i.turns.map((t: any) => t.id), allowed: i.allowed }),
  };
  const wrap = fakeTask<any, any>({
    purpose: "wrap_up",
    provider: "claude",
    maxAttempts: 3,
    answer: (_input, n) => (n <= wrapFailures ? fail("temporary failure", { retryable: true }) : ok({ observations: [], notes: [] })),
  });
  const wrapTask = { ...wrap, canonicalInput: (i: any) => wrapUpPrompt(i) };
  const reviews = createReviews(
    db,
    {
      ...world.deps,
      runTutor: (i, streamTo, signal, onRetry) => memo.run(tutor as any, i, { streamTo, signal, onRetry, ...(legacyTutor ? {} : { review: i.state.reviewId }) }) as any,
      clearFailures: memo.clearFailures,
      endedInTx: (id) => record.markEndedInTx(id),
    },
    { now: () => NOW },
  );
  const record = createRecord(db, {
    turns: (id) => reviews.view(id).turns,
    claims: (id) => world.deps.assessableIn(world.captureId, reviews.view(id).scope.material),
    wrapUp: async (id) => {
      const turns = reviews.view(id).turns;
      const input = { turns, claims: world.deps.assessableIn(world.captureId, reviews.view(id).scope.material), threads: [] };
      const asOf = db.nextSeq();
      const run = { review: id };
      let result = await memo.run(wrapTask as any, input, run);
      if (result.kind === "failed" && result.atSeq < asOf) {
        memo.clearFailures([result.key]);
        result = await memo.run(wrapTask as any, input, run);
      }
      if (result.kind !== "hit") throw new Error(JSON.stringify(result));
      return result.value as any;
    },
    snapshotEvidenceInTx: () => {},
  });
  world.close(0, 0, 300);
  world.claim(1, 10, 20);
  const id = randomId("rvw");
  expect(started(reviews.start(world.captureId, "prepared_only", id)).kind).toBe("started");
  const turn = (act: LearnerAct) => collect(reviews.turn(id, randomId("turn"), act));
  /** Spends the user's whole budget, as another review's calls would have. */
  const cap = () => {
    const a = budget.reserve(db.userId, "tutor_turn", crypto.randomUUID() as MemoKey);
    expect(a.kind).toBe("reserved");
    if (a.kind === "reserved") budget.settle(a.reservation, { kind: "measured", usd: 50 });
  };
  const tutorTurns = () => reviews.view(id).turns.filter((t) => t.actor === "tutor");
  return { db, world, budget, memo, wrap, tutor, record, reviews, id, turn, cap, tutorTurns };
}

const begin = { kind: "begin" } as LearnerAct;
const act = (kind: string) => ({ kind }) as LearnerAct;

describe("a real review that passes the cap mid-review still finishes and saves", () => {
  for (const kind of ["hint_request", "explain_request"] as const) {
    test(`a review answered only by ${kind === "hint_request" ? "a hint" : "an explanation"} saves past the cap`, async () => {
      const r = rig();
      await r.turn(begin);
      await r.turn(act(kind));
      expect(r.tutorTurns().some((t) => t.actor === "tutor" && t.move.kind === (kind === "hint_request" ? "hint" : "explain"))).toBe(true);
      r.cap();
      await r.turn(act("end"));
      expect(r.reviews.view(r.id).state.phase).toBe("ended");
      expect((await r.record.save(r.id)).kind).toBe("saved");
      expect(r.wrap.calls).toHaveLength(1);
    });
  }

  test("an answered review ended from a pause saves past both caps", async () => {
    const r = rig();
    await r.turn(begin);
    await r.turn(answer("my answer"));
    await r.turn(act("pause"));
    r.cap();
    await r.turn(act("end"));
    expect(r.reviews.view(r.id).state.phase).toBe("ended");
    expect((await r.record.save(r.id)).kind).toBe("saved");
    expect(r.wrap.calls).toHaveLength(1);
  });

  test("a failed save can be retried once past the cap, and a saved review answers again from its first save", async () => {
    const r = rig(5);
    await r.turn(begin);
    await r.turn(answer());
    r.cap();
    await r.turn(act("end"));
    expect((await r.record.save(r.id)).kind).toBe("save_failed");
    expect(r.wrap.calls).toHaveLength(3);
    expect((await r.record.save(r.id)).kind).toBe("saved");
    expect(r.wrap.calls).toHaveLength(6);
    expect((await r.record.save(r.id)).kind).toBe("saved");
    expect(r.wrap.calls).toHaveLength(6);
  });
});

describe("a review started before migration 006", () => {
  test("with a tutor turn paid before the upgrade, it still saves past the cap", async () => {
    const r = rig(0, null, true);
    upgradedAt(r.db, NOW + 1);
    await r.turn(begin);
    r.cap();
    await r.turn(act("end"));
    expect((await r.record.save(r.id)).kind).toBe("saved");
    expect(r.wrap.calls).toHaveLength(1);
  });

  test("started after the upgrade, a tutor turn with no review id does not open the exemption", async () => {
    const r = rig(0, null, true);
    upgradedAt(r.db, NOW - 1);
    await r.turn(begin);
    r.cap();
    await r.turn(act("end"));
    expect((await r.record.save(r.id)).kind).not.toBe("saved");
    expect(r.wrap.calls).toHaveLength(0);
  });
});

describe("a learner act that cost nothing does not open the exemption (reviewer reproductions)", () => {
  test("an answer with no tutor question, past the caps, ends but does not save uncapped", async () => {
    const r = rig();
    r.cap();
    const events = await r.turn(answer("a"));
    expect(events.some((e) => e.type === "turn_held")).toBe(true);
    expect(r.tutorTurns()).toHaveLength(0);
    await r.turn(act("end"));
    expect(await r.record.save(r.id)).toMatchObject({ kind: "save_failed", retryable: true });
    expect(r.wrap.calls).toHaveLength(0);
  });

  test("25 reviews with answers and no tutor turn get no uncapped save, and the 21st start is refused", async () => {
    const db = testUserDb();
    let saved = 0;
    let refused = 0;
    let wrapCalls = 0;
    for (let n = 0; n < 25; n++) {
      let r: Rig;
      try {
        r = rig(0, db);
      } catch (e) {
        expect(e).toBeInstanceOf(ReviewLimitError);
        refused++;
        continue;
      }
      if (n === 0) r.cap();
      await r.turn(answer(`a${n}`));
      await r.turn(act("end"));
      if ((await r.record.save(r.id)).kind === "saved") saved++;
      wrapCalls += r.wrap.calls.length;
    }
    expect(saved).toBe(0);
    expect(wrapCalls).toBe(0);
    expect(refused).toBe(25 - UNTUTORED_REVIEWS_PER_DAY);
    expect(db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM budget_holds WHERE purpose = 'wrap_up'").get()!.n).toBe(0);
  });
});

// ───────────────────────────── the start limit ─────────────────────────────

describe("starting reviews that never got tutoring is limited", () => {
  const EMPTY_SCOPE = JSON.stringify({ scope: { material: Material.canonical(Material.empty) }, claimTexts: {} });
  let seeded = 0;
  function seedReviews(r: Rig, count: number, startedMs: number, paid = false): string[] {
    return Array.from({ length: count }, () => {
      const id = randomId("rvw");
      r.db.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, ?, 'prepared_only', ?, ?, ?)", [
        id, r.db.userId, r.world.captureId, EMPTY_SCOPE, 10_000 + seeded++, startedMs,
      ]);
      if (paid) {
        r.db.sql.run(
          "INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms, review_id, settled_micros, settled_ms) VALUES (?, ?, '2026-11', 'tutor_turn', ?, 5, 1, ?, 5, 1)",
          [crypto.randomUUID(), r.db.userId, crypto.randomUUID(), id],
        );
      }
      return id;
    });
  }

  test("the next start is refused with a plain error once a day's worth have no paid tutoring", () => {
    const r = rig();
    seedReviews(r, UNTUTORED_REVIEWS_PER_DAY, NOW);
    expect(() => r.reviews.start(r.world.captureId, "prepared_only", randomId("rvw"))).toThrow(ReviewLimitError);
    expect(() => r.reviews.start(r.world.captureId, "prepared_only", randomId("rvw"))).toThrow("never reached a question from the tutor");
  });

  test("a review the learner answered still counts when no tutor question was paid for", () => {
    const r = rig();
    const ids = seedReviews(r, UNTUTORED_REVIEWS_PER_DAY, NOW);
    ids.forEach((rid, i) =>
      r.db.sql.run("INSERT INTO review_turns (user_id, id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES (?, ?, ?, ?, 'learner', NULL, ?, 1)", [
        r.db.userId, randomId("turn"), rid, 500 + i, JSON.stringify({ act: { kind: "answer", text: "a", modality: "text" } }),
      ]),
    );
    expect(() => r.reviews.start(r.world.captureId, "prepared_only", randomId("rvw"))).toThrow(ReviewLimitError);
  });

  test("reviews with paid tutoring, old reviews, a retry of a started review and another user are unaffected", () => {
    const r = rig();
    seedReviews(r, 2 * UNTUTORED_REVIEWS_PER_DAY, NOW, true);
    expect(() => r.reviews.start(r.world.captureId, "prepared_only", randomId("rvw"))).not.toThrow();
    expect(started(r.reviews.start(r.world.captureId, "prepared_only", r.id)).reviewId).toBe(r.id);

    const old = rig();
    seedReviews(old, UNTUTORED_REVIEWS_PER_DAY, NOW - 86_400_001);
    expect(() => old.reviews.start(old.world.captureId, "prepared_only", randomId("rvw"))).not.toThrow();

    const b = otherUserDb(r.db);
    const world = new World(b);
    world.close(0, 0, 300);
    world.claim(1, 10, 20);
    const reviews = createReviews(b, { ...world.deps, runTutor: () => { throw new Error("unused"); }, clearFailures: () => {} }, { now: () => NOW });
    expect(started(reviews.start(world.captureId, "prepared_only", randomId("rvw"))).kind).toBe("started");
  });

  test("the HTTP start answers 429 with that message, and an existing review still starts", async () => {
    const r = rig();
    seedReviews(r, UNTUTORED_REVIEWS_PER_DAY - 1, NOW);
    let handler: ((req: Request) => Response | Promise<Response>) | null = null;
    const original = Bun.serve;
    (Bun as any).serve = (opts: { fetch: typeof handler }) => {
      handler = opts.fetch;
      return { port: 39555, stop: () => {} };
    };
    try {
      serve({ modules: { reviews: r.reviews, evidence: { capturedByAnotherUser: () => false, holdsCapture: () => true } } as any, auth: { port: 39555, token: "test-token", extensionId: "" } as any, appDir: tmpdir() } as any);
    } finally {
      (Bun as any).serve = original;
    }
    const peer = { requestIP: () => null };
    const request = (id: string) =>
      (handler as unknown as (req: Request, srv: typeof peer) => Response | Promise<Response>)(new Request(`http://127.0.0.1:39555/captures/${r.world.captureId}/reviews`, {
        method: "POST",
        headers: { host: "127.0.0.1:39555", authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ choice: "prepared_only", reviewId: id }),
      }), peer);
    const refused = await request(randomId("rvw"));
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe(new ReviewLimitError().message);
    expect((await request(r.id)).status).toBe(200);
  });
});

// ───────────────────────────── the migration ─────────────────────────────

describe("migration 006", () => {
  test("upgrades populated holds without changing them, and keeps price once, settle once, immutable fields and no delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrap-up-migrate-"));
    try {
      const path = join(dir, "db.sqlite");
      const old = { ...MIGRATIONS, providers: MIGRATIONS.providers.filter((m) => m.id !== "006-budget-holds-review") };
      const a = openDb(path, old);
      const uid = ensureLocalUser(a);
      for (const [id, price, settled, settledMs] of [["open", null, null, null], ["priced", 2, null, null], ["settled", 2, 2, 2]] as const) {
        a.sql.run("INSERT INTO budget_holds(id,user_id,period,purpose,memo_key,reserved_micros,reserved_ms,priced_micros,settled_micros,settled_ms) VALUES(?,?,'2026-11','wrap_up','old-key',3,1,?,?,?)", [id, uid, price, settled, settledMs]);
      }
      const before = a.sql.query("SELECT * FROM budget_holds ORDER BY id").all();
      a.close();
      const b = openDb(path);
      const after = b.sql.query("SELECT * FROM budget_holds ORDER BY id").all() as Record<string, unknown>[];
      expect(after.map(({ review_id: _r, ...rest }) => rest)).toEqual(before as Record<string, unknown>[]);
      expect(after.every((row) => row.review_id === null)).toBe(true);
      expect(() => b.sql.run("UPDATE budget_holds SET review_id='fake',priced_micros=2 WHERE id='open'")).toThrow();
      b.sql.run("UPDATE budget_holds SET priced_micros=2 WHERE id='open'");
      expect(() => b.sql.run("UPDATE budget_holds SET priced_micros=3 WHERE id='open'")).toThrow();
      b.sql.run("UPDATE budget_holds SET settled_micros=2,settled_ms=2 WHERE id='open'");
      expect(() => b.sql.run("UPDATE budget_holds SET settled_micros=3,settled_ms=3 WHERE id='open'")).toThrow();
      expect(() => b.sql.run("DELETE FROM budget_holds WHERE id='open'")).toThrow();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
