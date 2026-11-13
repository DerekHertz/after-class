/**
 * Budgets for paid calls (plan phase 7, step 1). memo.ts reserves before every attempt and settles after it; nothing else
 * writes budget_holds. One budget serves every user, because the monthly total sums all of them.
 *
 * Derek, amendment of 2026-11-13: "Every hosted call runs inside a per-user budget and a monthly total budget, and a stop
 * switch halts all paid calls." The amounts he set: "$5 per user and $50 total".
 * R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero." A settlement takes the cost the
 * usage event records, and an unknown cost keeps its reservation, so a call nobody priced still counts against the cap.
 *
 *   reserve   one IMMEDIATE transaction: the stop switch, then this user's month, then everyone's month, then the insert. The
 *             write lock is taken before the sums are read, so two attempts (in this process or another on the same file)
 *             cannot both take the last of a budget.
 *   settle    inside the transaction that records the attempt's usage event, so a hold is settled exactly when its event exists.
 *   crash     a hold never settled (a call still running, or a process that ended mid-call) counts at its reservation for the
 *             rest of its month. That call may have been billed and has no usage event, so its reservation is the only figure.
 *             It does not carry into the next month, because each month sums only its own holds.
 *
 * A call can cost more than its estimate. Its settlement then takes the month past the cap by the difference, and every
 * attempt after it is refused. So the cap can be passed by at most the overrun of the calls already running when it is reached.
 *
 * Derek, 2026-11-13, on a learner who reaches a cap mid-review: "i think it should be allowed to finish". So the wrap-up
 * that saves a review is never held by either cap. The stop switch still holds it, and it still reserves, settles and
 * counts toward the month like any other call, so a finished review can take a month past its cap by one wrap-up.
 */
import type { MemoKey, UserId } from "../../shared/ids";
import type { Allowance, BudgetHold, Cost, Purpose } from "../../shared/domain";
import type { Db } from "../db";

/**
 * What one attempt reserves, in USD. A settlement replaces it with the recorded cost, so for a priced call it only decides
 * whether the attempt may start. For a call of unknown cost it is the amount counted.
 *
 *   Claude (every task runs on claude-opus-5-5 through the Messages API in hosted mode). Experiment 8 measured a first tutor turn
 *   at $0.5575, later turns at $0.02 to $0.04 and a wrap-up at $0.1688 (docs/experiments/08-api-tutor.md, estimates at list
 *   price). $0.75 covers the largest of those. Interpretation, revision and the diagram summary are not measured on the API.
 *   Priced as `worstCaseUsd` prices a call (all of max_tokens spent, every input token a 1 hour cache write), a structured call
 *   with 50,000 input tokens comes to $0.75. Resource search adds up to 5 web searches at $0.01 per call and up to 3
 *   continuations, so it reserves $1. These are estimates, not upper bounds: the same worst case is $1.23 for a tutor turn with
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
  /** The stop switch, asked before every attempt, so flipping it needs no restart. Attempts already running finish. */
  readonly stopped: () => boolean;
  readonly now?: () => number;
};

export type Reservation = { readonly id: string; readonly micros: number };
export type Admission = { readonly kind: "reserved"; readonly reservation: Reservation } | { readonly kind: "held"; readonly hold: BudgetHold };

export type Budget = {
  reserve(userId: UserId, purpose: Purpose, key: MemoKey): Admission;
  /** Run it inside the transaction that records the attempt's usage event. */
  settle(reservation: Reservation, cost: Cost): void;
  allowance(userId: UserId): Allowance;
};

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
  const spent = "COALESCE(SUM(COALESCE(settled_micros, reserved_micros)), 0) AS used FROM budget_holds";
  const q = {
    userUsed: db.sql.query<{ used: number }, [string, string]>(`SELECT ${spent} WHERE period = ? AND user_id = ?`),
    totalUsed: db.sql.query<{ used: number }, [string]>(`SELECT ${spent} WHERE period = ?`),
    insert: db.sql.query(`INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    settle: db.sql.query(`UPDATE budget_holds SET settled_micros = ?, settled_ms = ? WHERE id = ? AND settled_micros IS NULL`),
  };

  /** Why an attempt for `purpose` that would add `micros` to this month is refused, or null when it may start. */
  function holdFor(userId: UserId, atMs: number, purpose: Purpose, micros: number): BudgetHold | null {
    if (opts.stopped()) return { reason: "stopped" };
    if (UNCAPPED.has(purpose)) return null;
    const period = periodOf(atMs);
    const resetsAtMs = periodEndMs(atMs);
    if (userCap !== null && q.userUsed.get(period, userId)!.used + micros > userCap) return { reason: "user_budget", resetsAtMs };
    if (totalCap !== null && q.totalUsed.get(period)!.used + micros > totalCap) return { reason: "total_budget", resetsAtMs };
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
  };
}
