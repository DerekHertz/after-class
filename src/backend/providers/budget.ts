/**
 * Budgets for paid calls (plan phase 7, step 1). Every outbound paid request reserves here at the moment it is sent (memo.ts
 * hands the adapter an `admit` it calls after any queue, right before the request leaves), memo.ts prices each hold as its
 * response is read, and settles the attempt's holds after it. `reconcileInterrupted` settles what a previous process left. Nothing else writes budget_holds. One budget
 * serves every user, because the monthly total sums all of them.
 *
 * Derek, amendment of 2026-11-13: "Every hosted call runs inside a per-user budget and a monthly total budget, and a stop
 * switch halts all paid calls." The amounts he set: "$5 per user and $50 total".
 * R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero." A settlement takes the cost the
 * usage event records, and an unknown cost keeps its reservation, so a call nobody priced still counts against the cap.
 *
 *   reserve   one IMMEDIATE transaction per request: the stop switch, then this user's month, then everyone's month, then the
 *             insert. The write lock is taken before the sums are read, so two requests (in this process or another on the same
 *             file) cannot both take the last of a budget. A call that sends several requests (a resource search that continues a
 *             paused turn) reserves for each one.
 *   price     as soon as a response is read and its cost is known, before the attempt sends anything else, so the next
 *             reservation counts what is already known to be spent, and a crash after it keeps that figure.
 *   settle    inside the transaction that records the attempt's usage event, so a hold is settled exactly when its event exists.
 *   crash     a hold a process never settled may have been billed. At boot, before any new request, `reconcileInterrupted` writes
 *             one usage event of unknown cost for each attempt such holds belong to, and settles each hold at its price, or at
 *             its reservation when it was never priced.
 *
 * A call can cost more than its estimate. Its settlement then takes the month past the cap by the difference, and every
 * request after it is refused. So the cap can be passed by at most the overrun of the requests already sent when it is reached.
 *
 * Derek, 2026-11-13, on a learner who reaches a cap mid-review: "i think it should be allowed to finish". So the wrap-up
 * that saves a review is never held by either cap. The stop switch still holds it, and it still reserves, settles and
 * counts toward the month like any other call, so a finished review can take a month past its cap by one wrap-up.
 */
import { stableId } from "../../shared/ids";
import type { MemoKey, UserId } from "../../shared/ids";
import type { Allowance, BudgetHold, Cost, Purpose } from "../../shared/domain";
import type { Db } from "../db";

/**
 * What one request reserves, in USD. A settlement replaces it with the recorded cost, so for a priced call it only decides
 * whether the attempt may start. For a call of unknown cost it is the amount counted.
 *
 *   Claude (every task runs on claude-opus-5-5 through the Messages API in hosted mode). Experiment 8 measured a first tutor turn
 *   at $0.5575, later turns at $0.02 to $0.04 and a wrap-up at $0.1688 (docs/experiments/08-api-tutor.md, estimates at list
 *   price). $0.75 covers the largest of those. Interpretation, revision and the diagram summary are not measured on the API.
 *   Priced as `worstCaseUsd` prices a call (all of max_tokens spent, every input token a 1 hour cache write), a structured call
 *   with 50,000 input tokens comes to $0.75. Resource search adds up to 5 web searches at $0.01 per call and up to 3
 *   continuations, each a request that reserves $1 again. These are estimates, not upper bounds: the same worst case is $1.23 for a tutor turn with
 *   experiment 8's 69,251-token context and $4.81 for a resource search with 100,000, and reserving that much would refuse a
 *   learner's turn with a quarter of their $5 unused.
 *   Jev: TypeSafe has published no price, so every Jev call's cost is unknown and this figure is what it counts. $0.001 is a
 *   placeholder until Derek has a price.
 */
export const ESTIMATE_USD: Readonly<Record<Purpose, number>> = {
  boundary: 0.001,
  frame_change: 0.001,
  claim_check: 0.001,
  interpretation: 0.75,
  claim_revision: 0.75,
  resource_search: 1,
  tutor_turn: 0.75,
  wrap_up: 0.5,
  diagram_summary: 0.75,
};

/** The call the usage page's "held" asks about: a learner's next tutor turn. */
const PROBE: Purpose = "tutor_turn";

/** Calls neither cap holds: finishing a review (see the header). */
const UNCAPPED: ReadonlySet<Purpose> = new Set<Purpose>(["wrap_up"]);

export type BudgetLimits = {
  /** Per user per month. Null: no per-user cap. */
  readonly userUsd: number | null;
  /** All users together per month. Null: no total cap. */
  readonly totalUsd: number | null;
};

export type BudgetOptions = {
  readonly limits: BudgetLimits;
  /** The stop switch, asked before every request, so flipping it needs no restart. Requests already sent finish. */
  readonly stopped: () => boolean;
  readonly now?: () => number;
};

export type Reservation = { readonly id: string; readonly micros: number };
export type Admission = { readonly kind: "reserved"; readonly reservation: Reservation } | { readonly kind: "held"; readonly hold: BudgetHold };

export type Budget = {
  reserve(userId: UserId, purpose: Purpose, key: MemoKey): Admission;
  /** Record a request's known cost the moment it is read, so it counts before the attempt settles. An unknown cost changes nothing. */
  price(reservation: Reservation, cost: Cost): void;
  /** Run it inside the transaction that records the attempt's usage event. */
  settle(reservation: Reservation, cost: Cost): void;
  allowance(userId: UserId): Allowance;
  /** At boot, before any request: settle the holds a previous process left, with a usage event of unknown cost for each attempt. Returns how many attempts. */
  reconcileInterrupted(): number;
};

/** The reason a reconciled usage event gives for its unknown cost. */
export const INTERRUPTED = "the process ended before the call finished, so it may have been billed";

const MICROS = 1_000_000;
const toMicros = (usd: number): number => Math.round(usd * MICROS);

/** The calendar month in UTC, "YYYY-MM". */
export function periodOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** When the month that holds `ms` ends, in UTC. */
export function periodEndMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function createBudget(db: Db, opts: BudgetOptions): Budget {
  const now = opts.now ?? Date.now;
  const userCap = opts.limits.userUsd === null ? null : toMicros(opts.limits.userUsd);
  const totalCap = opts.limits.totalUsd === null ? null : toMicros(opts.limits.totalUsd);
  const spent = "COALESCE(SUM(COALESCE(settled_micros, priced_micros, reserved_micros)), 0) AS used FROM budget_holds";
  const q = {
    userUsed: db.sql.query<{ used: number }, [string, string]>(`SELECT ${spent} WHERE period = ? AND user_id = ?`),
    totalUsed: db.sql.query<{ used: number }, [string]>(`SELECT ${spent} WHERE period = ?`),
    insert: db.sql.query(`INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    price: db.sql.query(`UPDATE budget_holds SET priced_micros = ? WHERE id = ? AND settled_micros IS NULL`),
    settle: db.sql.query(`UPDATE budget_holds SET settled_micros = ?, settled_ms = ? WHERE id = ? AND settled_micros IS NULL`),
    interrupted: db.sql.query<{ user_id: string; memo_key: string; provider: string; model: string; purpose: string; started: number; next: number }, []>(
      `SELECT h.user_id, h.memo_key, i.provider, i.model, i.purpose, MIN(h.reserved_ms) AS started,
              (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM usage_events u WHERE u.user_id = h.user_id AND u.memo_key = h.memo_key) AS next
       FROM budget_holds h JOIN memo_inputs i ON i.user_id = h.user_id AND i.key = h.memo_key
       WHERE h.settled_micros IS NULL GROUP BY h.user_id, h.memo_key`,
    ),
    insertInterrupted: db.sql.query(
      `INSERT INTO usage_events (id, user_id, memo_key, capture_id, attempt_no, provider, model, purpose, outcome, cost_kind, cost_reason, started_ms, duration_ms)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'aborted', 'unknown', ?, ?, 0)`,
    ),
    settleInterrupted: db.sql.query(`UPDATE budget_holds SET settled_micros = COALESCE(priced_micros, reserved_micros), settled_ms = ? WHERE user_id = ? AND memo_key = ? AND settled_micros IS NULL`),
  };

  /** Why an attempt for `purpose` that would add `micros` to this month is refused, or null when it may start. */
  function holdFor(userId: UserId, atMs: number, purpose: Purpose, micros: number): BudgetHold | null {
    if (opts.stopped()) return { reason: "stopped" };
    if (UNCAPPED.has(purpose)) return null;
    const period = periodOf(atMs);
    const resetsAtMs = periodEndMs(atMs);
    if (userCap !== null) {
      const used = q.userUsed.get(period, userId)!.used;
      if (used + micros > userCap) return { reason: "user_budget", resetsAtMs, usedUp: used >= userCap };
    }
    if (totalCap !== null) {
      const used = q.totalUsed.get(period)!.used;
      if (used + micros > totalCap) return { reason: "total_budget", resetsAtMs, usedUp: used >= totalCap };
    }
    return null;
  }

  return {
    reserve(userId, purpose, key) {
      return db.sql.transaction((): Admission => {
        const at = now();
        const micros = toMicros(ESTIMATE_USD[purpose]);
        const hold = holdFor(userId, at, purpose, micros);
        if (hold !== null) return { kind: "held", hold };
        const id = `hold_${crypto.randomUUID()}`;
        q.insert.run(id, userId, periodOf(at), purpose, key, micros, Math.round(at));
        return { kind: "reserved", reservation: { id, micros } };
      }).immediate();
    },

    price(reservation, cost) {
      if (cost.kind !== "unknown") q.price.run(toMicros(cost.usd), reservation.id);
    },

    settle(reservation, cost) {
      q.settle.run(cost.kind === "unknown" ? reservation.micros : toMicros(cost.usd), Math.round(now()), reservation.id);
    },

    allowance(userId) {
      const at = now();
      return {
        usedUsd: q.userUsed.get(periodOf(at), userId)!.used / MICROS,
        limitUsd: opts.limits.userUsd,
        resetsAtMs: periodEndMs(at),
        held: holdFor(userId, at, PROBE, toMicros(ESTIMATE_USD[PROBE])),
      };
    },

    reconcileInterrupted() {
      return db.sql.transaction((): number => {
        const at = Math.round(now());
        const attempts = q.interrupted.all();
        for (const a of attempts) {
          q.insertInterrupted.run(stableId("use", a.user_id, a.memo_key, a.next), a.user_id, a.memo_key, a.next, a.provider, a.model, a.purpose, INTERRUPTED, a.started);
          q.settleInterrupted.run(at, a.user_id, a.memo_key);
        }
        return attempts.length;
      }).immediate();
    },
  };
}
