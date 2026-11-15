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
 *
 * Derek, 2026-11-14, on whether his own account could "be considered an admin account with no cap": "yes build the admin account
 * too". An uncapped user is a property of the user row, not of a call: the budget is built with the Clerk user ids (`auth_subject`)
 * that are uncapped, and `UNCAPPED_USERS` selects their user ids from `users`. Such a user passes both caps, and their holds are
 * left out of the total sum, so their testing never uses up what friends share. Their holds are still written, settled and counted
 * in their own month, so their usage is recorded. The stop switch is asked first and still holds them. A subject that has not
 * signed in has no row yet and matches nobody, and local mode has no Clerk subject, so it is never uncapped.
 */
import { stableId } from "../../shared/ids";
import type { MemoKey, UserId } from "../../shared/ids";
import type { Allowance, BudgetHold, Cost, Purpose } from "../../shared/domain";
import type { Db } from "../db";
import { BUDGET_HOLDS_REVIEW_ID } from "../migrations-budget";

/**
 * What one request reserves, in USD. A settlement replaces it with the recorded cost, so for a priced call it only decides
 * whether the attempt may start. For a call of unknown cost it is the amount counted.
 *
 *   Claude (the Messages API in hosted mode; the tutor and wrap-up on claude-sonnet-5-5 unless AFTERCLASS_TUTOR_MODEL=opus, every
 *   other task on claude-opus-5-5). Experiment 8 measured, on Opus with the 1 hour cache, a first tutor turn at $0.5575, later turns
 *   at $0.02 to $0.04 and a wrap-up at $0.1688 (docs/experiments/08-api-tutor.md, estimates at list price). Of that first turn,
 *   $0.5540 was writing 69,251 tokens at 2 times the input price. A review's first turn now writes them at 1.25 times, but the turn
 *   after a long pause writes them at 2 times again (`tutorCache` in review/tutor.ts), so $0.75 covered that turn on Opus, and
 *   on Sonnet ($0.2770 for the write) with room, before the tutor's own estimate below was set from the Sonnet audit. Interpretation, revision and the diagram summary are not measured on the API.
 *   Tutor turn: reserved at an estimate of its own worst case, passed by the adapter as `estimateUsd` (`streamEstimateUsd` in providers/claude-api.ts,
 *   which is `estimateRequestUsd` on the request as sent). A flat figure cannot be right: the context has no ceiling and the model's rates
 *   differ by 2 times, so one figure is too low for a turn that writes a long lecture on Opus and too high for a short Sonnet one. The
 *   request is priced as `estimateRequestUsd` prices it (a byte counts as a token, plus REQUEST_OVERHEAD_TOKENS, plus the whole output limit,
 *   TUTOR_MAX_OUTPUT_TOKENS = 8,000 in review/tutor.ts) with every input token written to the cache at the lifetime the request sends,
 *   5 minutes (1.25 times) or, after a long pause, 1 hour (2 times). The lifetime is decided once, in `call`, right before `admit`, and
 *   the same value prices the reservation and goes in the request (`tutorCache.decide`), so the two cannot disagree. No warm cache is
 *   assumed: a read is cheaper than a write, but nothing here can know an entry is alive (a rejected or failed request starts nothing, an
 *   entry can be evicted early), so a reservation that counted one could settle above itself. The price is that a warm turn reserves
 *   what a first turn does. The "bytes are tokens" step is an estimate, not a proven bound: it holds for ordinary text (the audit measured
 *   0.5 tokens per byte) but was not shown for every input on the current models. Four concurrent turns hold four estimates.
 *   For the Fable audit's lecture (docs/trail/fable-e2e-2026-11-14-data.json; the system block of its 12 turns was 49,844 bytes, the
 *   prompts 1,317 to 7,483 bytes) on Sonnet: a first turn reserves $0.2181 and is refused above $4.7819 of a $5 cap, a later turn within 5
 *   minutes $0.2181 to $0.2336 (refused above $4.7664) and a turn after a long pause $0.3010 to $0.3257 (refused above $4.6743); on Opus
 *   $0.4363 (first, refused above $4.5637), $0.4363 to $0.4671 and $0.6021 to $0.6514. The measured turns spent $0.0126 to $0.0241. The
 *   old $0.75 refused from $4.25. A `claude -p` tutor turn reserves its estimate at the 1 hour rate (the CLI's cache lifetime is not
 *   known) but the CLI cannot enforce the 8,000 output limit or bound its context, so what it settles at can exceed it, uncapped; the
 *   usage page's "held" asks about ESTIMATE_USD.tutor_turn, an advisory figure that does not gate a request.
 *   Priced as `estimateRequestUsd` prices a call (all of max_tokens spent, every input token a 1 hour cache write), a structured call
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
  tutor_turn: 0.15,
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
/*
 * A review started before migration 006 has holds with no review id, so its paid tutoring cannot be tied to it. Such a review counts
 * as tutored when it has a stored tutor turn and the user paid for a tutor request between its start and the upgrade. The set is
 * closed at the upgrade, and each still passes the caps at most WRAP_UPS_PER_REVIEW times.
 */
export const PAID_TUTOR_HOLD = "h.purpose = 'tutor_turn' AND h.settled_micros > 0";

/** SQL over `users`, one `?` bound to the JSON array of uncapped Clerk user ids: the user ids that are uncapped. */
const UNCAPPED_USERS = "SELECT id FROM users WHERE auth_provider = 'clerk' AND auth_subject IN (SELECT value FROM json_each(?))";

export type BudgetLimits = {
  /** Per user per month. Null: no per-user cap. */
  readonly userUsd: number | null;
  /** All users together per month. Null: no total cap. */
  readonly totalUsd: number | null;
};

export type BudgetOptions = {
  readonly limits: BudgetLimits;
  /** Clerk user ids (`sub` of the session token) whose calls skip both caps and whose spend is left out of the total. Default: none. */
  readonly uncappedSubjects?: readonly string[];
  /** The stop switch, asked before every request, so flipping it needs no restart. Requests already sent finish. */
  readonly stopped: () => boolean;
  readonly now?: () => number;
};

export type Reservation = { readonly id: string; readonly micros: number };
export type Admission = { readonly kind: "reserved"; readonly reservation: Reservation } | { readonly kind: "held"; readonly hold: BudgetHold };

export type Budget = {
  /**
   * `review`: the review the request is for. A wrap-up of a review with paid tutoring may pass the caps (see the header). Anything else is capped.
   * `estimateUsd`: this request's own estimate, which replaces the purpose's flat `ESTIMATE_USD` when the adapter can price the request it is sending.
   */
  reserve(userId: UserId, purpose: Purpose, key: MemoKey, review?: string, estimateUsd?: number): Admission;
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
  const uncappedJson = JSON.stringify(opts.uncappedSubjects ?? []);
  const spent = "COALESCE(SUM(COALESCE(settled_micros, priced_micros, reserved_micros)), 0) AS used FROM budget_holds";
  const q = {
    userUsed: db.sql.query<{ used: number }, [string, string]>(`SELECT ${spent} WHERE period = ? AND user_id = ?`),
    userReserved: db.sql.query<{ held: number }, [string, string]>(
      `SELECT COALESCE(SUM(COALESCE(priced_micros, reserved_micros)), 0) AS held FROM budget_holds WHERE period = ? AND user_id = ? AND settled_micros IS NULL`,
    ),
    totalUsed: db.sql.query<{ used: number }, [string, string]>(`SELECT ${spent} WHERE period = ? AND user_id NOT IN (${UNCAPPED_USERS})`),
    isUncapped: db.sql.query<{ n: number }, [string, string]>(`SELECT 1 AS n FROM users WHERE id = ? AND id IN (${UNCAPPED_USERS})`),
    insert: db.sql.query(`INSERT INTO budget_holds (id, user_id, period, purpose, memo_key, reserved_micros, reserved_ms, review_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    wrapUpsOf: db.sql.query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM budget_holds WHERE user_id = ? AND review_id = ? AND purpose = 'wrap_up'`),
    paidTutoringOf: db.sql.query<{ n: number }, [string, string, string, string]>(
      `SELECT 1 AS n FROM budget_holds h WHERE h.user_id = ? AND h.review_id = ? AND ${PAID_TUTOR_HOLD}
       UNION ALL
       SELECT 1 AS n FROM reviews r
       WHERE r.user_id = ? AND r.id = ?
         AND r.started_ms < (SELECT applied_ms FROM schema_migrations WHERE id = '${BUDGET_HOLDS_REVIEW_ID}')
         AND EXISTS (SELECT 1 FROM review_turns t WHERE t.review_id = r.id AND t.actor = 'tutor')
         AND EXISTS (SELECT 1 FROM budget_holds h WHERE h.user_id = r.user_id AND h.review_id IS NULL AND ${PAID_TUTOR_HOLD}
                     AND h.reserved_ms >= r.started_ms AND h.reserved_ms < (SELECT applied_ms FROM schema_migrations WHERE id = '${BUDGET_HOLDS_REVIEW_ID}'))
       LIMIT 1`,
    ),
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
    if (exempt || q.isUncapped.get(userId, uncappedJson) !== null) return null;
    const period = periodOf(atMs);
    const resetsAtMs = periodEndMs(atMs);
    if (userCap !== null) {
      const used = q.userUsed.get(period, userId)!.used;
      if (used + micros > userCap) return { reason: "user_budget", resetsAtMs, usedUp: used >= userCap };
    }
    if (totalCap !== null) {
      const used = q.totalUsed.get(period, uncappedJson)!.used;
      if (used + micros > totalCap) return { reason: "total_budget", resetsAtMs, usedUp: used >= totalCap };
    }
    return null;
  }

  return {
    reserve(userId, purpose, key, review, estimateUsd) {
      return db.sql.transaction((): Admission => {
        const at = now();
        const micros = costMicros(estimateUsd ?? ESTIMATE_USD[purpose]);
        const finishes = purpose === "wrap_up" && review !== undefined && q.paidTutoringOf.get(userId, review, userId, review) !== null && q.wrapUpsOf.get(userId, review)!.n < WRAP_UPS_PER_REVIEW;
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
      const uncapped = q.isUncapped.get(userId, uncappedJson) !== null;
      return {
        usedUsd: q.userUsed.get(periodOf(at), userId)!.used / MICROS,
        reservedUsd: q.userReserved.get(periodOf(at), userId)!.held / MICROS,
        limitUsd: uncapped ? null : opts.limits.userUsd,
        uncapped,
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
