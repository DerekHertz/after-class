/**
 * Usage ledger reads (W5). memo.ts is the only writer of usage_events, inside
 * each attempt's transaction; this file only reads. A ledger belongs to one user
 * and reads only that user's events.
 *
 * R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
 * Summaries total per cost kind and report unknown as a count with usd null, never as $0.
 * A summary also carries the user's allowance for the month when a budget runs (see budget.ts).
 */
import type { MemoKey } from "../../shared/ids";
import type { Cost, Provider, Purpose, UsageEvent, UsageSummary } from "../../shared/domain";
import type { UserDb } from "../db";
import type { Budget } from "./budget";

type Filter = { readonly sinceMs?: number; readonly purpose?: Purpose };

/**
 * One pipeline stage. Known money is kept per cost kind, because a notional
 * Claude figure is not spend and must not be added to a measured one. Calls
 * with unknown cost are counted, never priced.
 */
export type StageUsage = {
  readonly purpose: Purpose;
  readonly provider: Provider;
  readonly calls: number;
  readonly errors: number;
  readonly aborted: number;
  readonly unknownCostCalls: number;
  /** Null for a kind this stage made no calls of, so a total never shows $0.00 for money nobody measured. */
  readonly usd: Readonly<Record<Exclude<Cost["kind"], "unknown">, number | null>>;
  /** Sums over calls that reported tokens; null when none did. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
};

export type Ledger = {
  summary(filter?: Filter): UsageSummary;
  /** Per-stage totals, one row per purpose that has events. */
  stages(filter?: Filter): readonly StageUsage[];
  list(filter: { readonly memoKey?: MemoKey; readonly limit: number }): readonly UsageEvent[];
};

const COST_KINDS = ["measured", "notional", "estimated", "unknown"] as const;
const PURPOSES = ["boundary", "frame_change", "claim_check", "interpretation", "claim_revision", "resource_search", "tutor_turn", "wrap_up", "diagram_summary", "cache_keepalive"] as const satisfies readonly Purpose[];

type Row = {
  id: string; memo_key: string; attempt_no: number; provider: Provider; model: string; purpose: Purpose; outcome: UsageEvent["outcome"];
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
  cost_kind: Cost["kind"]; cost_usd: number | null; cost_basis: string | null; cost_reason: string | null;
  started_ms: number; duration_ms: number;
};

function costOf(r: Row): Cost {
  switch (r.cost_kind) {
    case "measured":
      return { kind: "measured", usd: r.cost_usd! };
    case "notional":
      return { kind: "notional", usd: r.cost_usd!, basis: "claude_subscription" };
    case "estimated":
      return { kind: "estimated", usd: r.cost_usd!, basis: r.cost_basis! };
    case "unknown":
      return { kind: "unknown", reason: r.cost_reason! };
  }
}

export function createLedger(db: UserDb, budget: Budget | null = null): Ledger {
  const where = (f: Filter | undefined) => {
    const clauses: string[] = ["user_id = ?"];
    const args: (string | number)[] = [db.userId];
    if (f?.sinceMs !== undefined) {
      clauses.push("started_ms >= ?");
      args.push(f.sinceMs);
    }
    if (f?.purpose !== undefined) {
      clauses.push("purpose = ?");
      args.push(f.purpose);
    }
    return { sql: `WHERE ${clauses.join(" AND ")}`, args };
  };

  function summary(filter?: Filter): UsageSummary {
    const w = where(filter);
    const kinds = db.sql
      .query<{ cost_kind: Cost["kind"]; calls: number; usd: number | null }, (string | number)[]>(
        `SELECT cost_kind, COUNT(*) AS calls, SUM(cost_usd) AS usd FROM usage_events ${w.sql} GROUP BY cost_kind`,
      )
      .all(...w.args);
    const purposes = db.sql
      .query<{ purpose: Purpose; calls: number; errors: number; unknown_cost: number }, (string | number)[]>(
        `SELECT purpose, COUNT(*) AS calls, COUNT(*) FILTER (WHERE outcome = 'error') AS errors, COUNT(*) FILTER (WHERE cost_kind = 'unknown') AS unknown_cost
         FROM usage_events ${w.sql} GROUP BY purpose`,
      )
      .all(...w.args);

    const byKind = Object.fromEntries(
      COST_KINDS.map((k) => {
        const row = kinds.find((r) => r.cost_kind === k);
        return [k, { calls: row?.calls ?? 0, usd: k === "unknown" ? null : (row?.usd ?? null) }];
      }),
    ) as UsageSummary["byKind"];
    const byPurpose = Object.fromEntries(
      PURPOSES.map((p) => {
        const row = purposes.find((r) => r.purpose === p);
        return [p, { calls: row?.calls ?? 0, errors: row?.errors ?? 0, unknownCost: row?.unknown_cost ?? 0 }];
      }),
    ) as UsageSummary["byPurpose"];
    return { byKind, byPurpose, allowance: budget === null ? null : budget.allowance(db.userId) };
  }

  function stages(filter?: Filter): readonly StageUsage[] {
    const w = where(filter);
    const rows = db.sql
      .query<
        {
          purpose: Purpose; provider: Provider; cost_kind: Cost["kind"]; calls: number; errors: number; aborted: number;
          usd: number | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
        },
        (string | number)[]
      >(
        `SELECT purpose, provider, cost_kind, COUNT(*) AS calls,
                COUNT(*) FILTER (WHERE outcome = 'error') AS errors, COUNT(*) FILTER (WHERE outcome = 'aborted') AS aborted, SUM(cost_usd) AS usd,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens
         FROM usage_events ${w.sql} GROUP BY purpose, provider, cost_kind`,
      )
      .all(...w.args);

    const out = new Map<Purpose, { provider: Provider; calls: number; errors: number; aborted: number; unknown: number; usd: Record<"measured" | "notional" | "estimated", number | null>; tokens: [number | null, number | null, number | null] }>();
    const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);
    for (const r of rows) {
      const s = out.get(r.purpose) ?? { provider: r.provider, calls: 0, errors: 0, aborted: 0, unknown: 0, usd: { measured: null, notional: null, estimated: null }, tokens: [null, null, null] as [number | null, number | null, number | null] };
      s.calls += r.calls;
      s.errors += r.errors;
      s.aborted += r.aborted;
      if (r.cost_kind === "unknown") s.unknown += r.calls;
      else s.usd[r.cost_kind] = (s.usd[r.cost_kind] ?? 0) + (r.usd ?? 0);
      s.tokens = [add(s.tokens[0], r.input_tokens), add(s.tokens[1], r.output_tokens), add(s.tokens[2], r.cache_read_tokens)];
      out.set(r.purpose, s);
    }
    return PURPOSES.flatMap((p) => {
      const s = out.get(p);
      return s ? [{ purpose: p, provider: s.provider, calls: s.calls, errors: s.errors, aborted: s.aborted, unknownCostCalls: s.unknown, usd: s.usd, inputTokens: s.tokens[0], outputTokens: s.tokens[1], cacheReadTokens: s.tokens[2] }] : [];
    });
  }

  function list(filter: { readonly memoKey?: MemoKey; readonly limit: number }): readonly UsageEvent[] {
    const columns = `id, memo_key, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens, cache_read_tokens,
      cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms`;
    const rows = filter.memoKey
      ? db.sql
          .query<Row, [string, string, number]>(`SELECT ${columns} FROM usage_events WHERE user_id = ? AND memo_key = ? ORDER BY started_ms DESC, attempt_no DESC LIMIT ?`)
          .all(db.userId, filter.memoKey, filter.limit)
      : db.sql
          .query<Row, [string, number]>(`SELECT ${columns} FROM usage_events WHERE user_id = ? ORDER BY started_ms DESC, id DESC LIMIT ?`)
          .all(db.userId, filter.limit);
    return rows.map((r) => ({
      id: r.id as UsageEvent["id"],
      provider: r.provider,
      model: r.model,
      purpose: r.purpose,
      memoKey: r.memo_key as MemoKey,
      attemptNo: r.attempt_no,
      outcome: r.outcome,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cost: costOf(r),
      startedAtMs: r.started_ms,
      durationMs: r.duration_ms,
    }));
  }

  return { summary, stages, list };
}
