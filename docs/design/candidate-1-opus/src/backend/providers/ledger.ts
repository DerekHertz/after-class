/**
 * Usage ledger (R17). Written ONLY by memo.run, inside the attempt's transaction.
 *
 * SQL encodes "unknown is not zero":
 *   usage_events(…, cost_kind TEXT NOT NULL CHECK (cost_kind IN ('measured','notional','estimated','unknown')),
 *                   cost_usd REAL, CHECK ((cost_kind = 'unknown') = (cost_usd IS NULL)))
 * Summaries total per kind and report unknown as a count, never as $0.
 */
import type { Purpose, UsageEvent, UsageSummary } from "../../shared/domain";
import type { Db } from "../db";

export type Ledger = {
  /** Called by memo only. Idempotent on event.id (INSERT OR IGNORE). */
  recordInTx(event: UsageEvent): void;
  summary(filter?: { sinceMs?: number; purpose?: Purpose }): UsageSummary;
  list(filter: { memoKey?: string; limit: number }): readonly UsageEvent[];
};

export function createLedger(db: Db): Ledger {
  throw new Error("not implemented");
}
