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
 * that saves a review is not held by either cap when the review holds tutoring the caps admitted and charged. The stop switch
 * still holds it, and it still reserves, settles and counts toward the month like any other call, so a finished review can take
 * a month past its cap by one wrap-up. The fact that makes a review real is a paid tutor request, not a learner act: every
 * request names the review it is for (`review`), its hold records it, and `PAID_TUTOR_HOLD` says which holds are tutoring that
 * counts (a tutor turn of any move, a hint or an explanation included, admitted under the caps and charged). Starting a review,
 * answering in it and ending it cost nothing, so none of them can open the exemption. Once a user is capped no new tutor request
 * is admitted, so a capped user cannot mint a review that qualifies: each uncapped wrap-up is paid for by a capped tutor turn,
 * and one review passes the caps for at most `WRAP_UPS_PER_REVIEW` wrap-up requests. A wrap-up that names no review, whose review
 * has no paid tutoring, or that has used up its requests is capped like any other call.
 */
import { stableId } from "../../shared/ids";
import type { MemoKey, UserId } from "../../shared/ids";
import type { Allowance, BudgetHold, Cost, Purpose } from "../../shared/domain";
import type { Db } from "../db";

/**
 * What one request reserves, in USD. A settlement replaces it with the recorded cost, so for a priced call it only decides
 * whether the attempt may start. For a call of unknown cost it is the amount counted.
 *
 *   Claude (the Messages API in hosted mode; the tutor and wrap-up on claude-sonnet-5-5 unless AFTERCLASS_TUTOR_MODEL=opus, every
 *   other task on claude-opus-5-5). Experiment 8 measured, on Opus with the 1 hour cache, a first tutor turn at $0.5575, later turns
 *   at $0.02 to $0.04 and a wrap-up at $0.1688 (docs/experiments/08-api-tutor.md, estimates at list price). Of that first turn,
 *   $0.5540 was writing 69,251 tokens at 2 times the input price. A review's first turn now writes them at 1.25 times, but the turn
 *   after a long pause writes them at 2 times again (`tutorCache` in review/tutor.ts), so $0.75 still covers that turn on Opus, and
 *   on Sonnet ($0.2770 for the write) with room. Interpretation, revision and the diagram summary are not measured on the API.
 *   Priced as `worstCaseUsd` prices a call (all of max_tokens spent, every input token a 1 hour cache write), a structured call
 *   with 50,000 input tokens comes to $0.75 at max_tokens 16,000. Interpretation streams with max_tokens 32,000 (STREAM_MAX_TOKENS), so
 *   the same formula gives 32,000 x $20 per million (Opus) = $0.64 plus (50,000 + 4,096 allowance) x $8 per million (1 hour write) =
 *   $0.432768, $1.072768, reserved as $1.08. Resource search adds up to 5 web searches at $0.01 per call and up to 3
 *   continuations, each a request that reserves $1 again. These are estimates, not upper bounds: the same worst case is $1.23 for a tutor turn with
 *   experiment 8's 69,251-token context and $4.81 for a resource search with 100,000, and reserving that much would refuse a
 *   learner's turn with a quarter of their $5 unused.
 *   Jev: $0.042 per million input tokens, output free (`JEV_INPUT_NANOUSD_PER_TOKEN` in jev.ts). The measured calls of a 13.6 minute
 *   lecture ran 420 to 10,632 input tokens, so $0.00002 to $0.00045 each. $0.0005 covers the largest of them. A Jev response
 *   with tokens settles at its priced amount, so this figure is only counted for one that reported none. It is also the bound
 *   when a process ends before a response was read: that call settles at this reservation with an unknown cost (R17), which
 *   understates a call over about 11,900 input tokens. Once a response's usage is read its price is stored, so a later crash settles at it.
 */
export const ESTIMATE_USD: Readonly<Record<Purpose, number>> = {
  boundary: 0.0005,
  frame_change: 0.0005,
  claim_check: 0.0005,
  interpretation: 1.08,
  claim_revision: 0.75,
  resource_search: 1,
  tutor_turn: 0.75,
  wrap_up: 0.5,
  diagram_summary: 0.75,
};

/** The call the usage page's "held" asks about: a learner's next tutor turn. */
const PROBE: Purpose = "tutor_turn";

/**
 * Wrap-up requests one review may send (see the header). The wrap-up task makes up to 3 attempts per run and a failed save is
 * retried once with a new run, so 6 lets a real review finish after one failed save and no more.
 */
export const WRAP_UPS_PER_REVIEW = 6;

/** SQL over `budget_holds h`: a hold that is tutoring the learner got, admitted by the caps (a hold exists only when they admitted it) and charged. */
export const PAID_TUTOR_HOLD = "h.purpose = 'tutor_turn' AND h.settled_micros > 0";

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
  /** `review`: the review the request is for. A wrap-up of a review with paid tutoring may pass the caps (see the header). Anything else is capped. */
  reserve(userId: UserId, purpose: Purpose, key: MemoKey, review?: string): Admission;
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
/**
 * A cost or reservation in whole micro-dollars, rounded up: the smallest whole number of micros whose dollar value, as a double,
 * is not below `usd`. So a settled amount is never below the cost recorded for it and at most one micro above it, with no
 * tolerance: a cost that is already a whole number of micros (`jevCost` makes Jev's one) comes back as exactly those micros.
 */
function costMicros(usd: number): number {
  const r = Math.round(usd * MICROS);
  return r / MICROS >= usd ? r : r + 1;
}

/**
 * A cap in whole micro-dollars, rounded down, so a cap is never raised: the largest whole number of micros whose dollar value is
 * not above `usd`. A cost is rounded the other way, because a cap that admitted more than it was set to is the weaker check.
 */
function capMicros(usd: number): number {
  const r = Math.round(usd * MICROS);
  return r / MICROS <= usd ? r : r - 1;
}

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
  const userCap = opts.limits.userUsd === null ? null : capMicros(opts.limits.userUsd);
  const totalCap = opts.limits.totalUsd === null ? null : capMicros(opts.limits.totalUsd);
  const spent = "COALESCE(SUM(COALESCE(settled_micros, priced_micros, reserved_micros)), 0) AS used FROM budget_holds";
  const q = {
    userUsed: db.sql.query<{ used: number }, [string, string]>(`SELECT ${spent} WHERE period = ? AND user_id = ?`),
    totalUsed: db.sql.query<{ used: number }, [string]>(`SELECT ${spent} WHERE period = ?`),
    insert: db.sql.query(`INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms, review_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    wrapUpsOf: db.sql.query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM budget_holds WHERE user_id = ? AND review_id = ? AND purpose = 'wrap_up'`),
    paidTutoringOf: db.sql.query<{ n: number }, [string, string]>(`SELECT 1 AS n FROM budget_holds h WHERE h.user_id = ? AND h.review_id = ? AND ${PAID_TUTOR_HOLD} LIMIT 1`),
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
  function holdFor(userId: UserId, atMs: number, purpose: Purpose, micros: number, exempt = false): BudgetHold | null {
    if (opts.stopped()) return { reason: "stopped" };
    if (exempt) return null;
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
    reserve(userId, purpose, key, review) {
      return db.sql.transaction((): Admission => {
        const at = now();
        const micros = costMicros(ESTIMATE_USD[purpose]);
        const finishes = purpose === "wrap_up" && review !== undefined && q.paidTutoringOf.get(userId, review) !== null && q.wrapUpsOf.get(userId, review)!.n < WRAP_UPS_PER_REVIEW;
        const hold = holdFor(userId, at, purpose, micros, finishes);
        if (hold !== null) return { kind: "held", hold };
        const id = `hold_${crypto.randomUUID()}`;
        q.insert.run(id, userId, periodOf(at), purpose, key, micros, Math.round(at), review ?? null);
        return { kind: "reserved", reservation: { id, micros } };
      }).immediate();
    },

    price(reservation, cost) {
      if (cost.kind !== "unknown") q.price.run(costMicros(cost.usd), reservation.id);
    },

    settle(reservation, cost) {
      q.settle.run(cost.kind === "unknown" ? reservation.micros : costMicros(cost.usd), Math.round(now()), reservation.id);
    },

    allowance(userId) {
      const at = now();
      return {
        usedUsd: q.userUsed.get(periodOf(at), userId)!.used / MICROS,
        limitUsd: opts.limits.userUsd,
        resetsAtMs: periodEndMs(at),
        held: holdFor(userId, at, PROBE, costMicros(ESTIMATE_USD[PROBE])),
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
