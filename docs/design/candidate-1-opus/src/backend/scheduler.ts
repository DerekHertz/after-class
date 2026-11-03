/**
 * Demand-driven scheduler. There is NO job table and no queue to keep in sync.
 *
 *   pump():
 *     for each active capture:
 *       segmentation.sync(c)            → new chunk revisions + boundary-window demand
 *       evidence.frameDemand(c)         → frame-change judgments
 *       preparation.demand(c)           → interpretation / check / revise / recheck / resources
 *     dispatch items whose key is not inflight, ≤ limits per provider
 *     on each completion → pump() again (debounced 50 ms)
 *
 * Why this is safe:
 *  - Demand is a pure function of facts + memo. Running pump twice demands the
 *    same keys; memo.run is single-flight per key. Idempotent by construction.
 *  - Crash: restart and pump. Finished keys hit the memo; the rest re-run.
 *  - Cancellation: preparation.stopEarly writes a fact; the next demand excludes
 *    those items, and the scheduler aborts inflight items whose key is no longer
 *    demanded (saves money; correctness doesn't depend on the abort landing).
 *  - Later never cancels (R5): invite answers aren't an input to demand() at all.
 *
 * Priority: boundary windows > frame judgments > claim checks/revisions >
 * interpretation > resource search (resources never block, R6).
 */
import type { MemoKey } from "../shared/ids";
import type { Purpose } from "../shared/domain";

export type WorkItem = {
  readonly key: MemoKey;
  readonly purpose: Purpose;
  readonly provider: "jev" | "claude";
  run(signal: AbortSignal): Promise<unknown>; // = memo.run(task, input, { signal })
};

export type SchedulerLimits = { readonly jev: number; readonly claude: number }; // starting values: 4, 2

export type Scheduler = {
  pump(): void;
  inflight(): readonly { key: MemoKey; purpose: Purpose; startedAtMs: number }[];
  /** Processing estimate: only when ≥ 5 completed samples for every pending purpose (flow C "only when reliable"). */
  estimateSeconds(pending: readonly Purpose[]): number | null;
  stop(): Promise<void>;
};

export function createScheduler(sources: readonly (() => readonly WorkItem[])[], limits: SchedulerLimits): Scheduler {
  throw new Error("not implemented");
}
