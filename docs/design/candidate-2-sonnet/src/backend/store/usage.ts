// store/usage.ts -- owner: providers workstream. Sole writer of usage_events (append-only).
//
//   usage_events(id PK, at, provider, model, stage, capture_id, review_id, job_id, attempt, outcome,
//                in_tok, out_tok, cache_read, cache_write, latency_ms, cost_kind, cost_usd, price_basis, live_scope)
//   CHECK ((cost_kind = 'unknown') = (cost_usd IS NULL))          -- R17 in the schema
import type { CostTotal, UsageEvent, UsageStage } from "../../shared/domain/usage";
import type { Db } from "./db";

export interface UsageFilter {
  readonly captureId?: string;
  readonly reviewId?: string;
  readonly sinceWall?: number;
  readonly stage?: UsageStage;
}

export interface UsageRepo {
  append(e: UsageEvent): void;
  /** SUM(cost_usd) over known only, COUNT(*) FILTER (cost_kind='unknown') for unknown: the two never merge */
  summary(f: UsageFilter): { readonly total: CostTotal; readonly byStage: Readonly<Record<UsageStage, CostTotal>> };
  list(f: UsageFilter, limit: number): readonly UsageEvent[];
}

export function createUsageRepo(db: Db): UsageRepo {
  throw new Error("not implemented");
}
