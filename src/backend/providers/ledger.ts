/**
 * Usage ledger reads (W5). memo.ts is the only writer of usage_events, inside
 * each attempt's transaction; this file only reads.
 *
 * R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
 * Summaries total per cost kind and report unknown as a count with usd null, never as $0.
 */
import type { MemoKey } from "../../shared/ids";
import type { Purpose, UsageEvent, UsageSummary } from "../../shared/domain";
import type { Db } from "../db";

export type Ledger = {
  summary(filter?: { readonly sinceMs?: number; readonly purpose?: Purpose }): UsageSummary;
  list(filter: { readonly memoKey?: MemoKey; readonly limit: number }): readonly UsageEvent[];
};

export function createLedger(db: Db): Ledger {
  throw new Error("not implemented");
}
