/**
 * Demand-driven scheduler (W10, composition phase). There is NO job table.
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
 *  - Demand is a pure function of facts + memo; memo.run is single-flight per key.
 *  - Crash: restart and pump. Finished keys hit the memo; the rest re-run.
 *  - Cancellation: stopEarly writes a fact; the next demand excludes those items,
 *    and the scheduler aborts inflight items no longer demanded.
 *  - R5: "Choosing Later never cancels preparation." This file never imports review/.
 *
 * Priority: boundary windows > frame judgments > claim checks/revisions >
 * interpretation > resource search.
 * R6: "A pending resource search never blocks a review that is otherwise ready."
 */
import type { MemoKey } from "../shared/ids";
import type { Provider, Purpose } from "../shared/domain";

export type WorkItem = {
  readonly key: MemoKey;
  readonly purpose: Purpose;
  readonly provider: Provider;
  run(signal: AbortSignal): Promise<unknown>; // = memo.run(task, input, { signal })
};

export type SchedulerLimits = { readonly jev: number; readonly claude: number }; // starting values: 4, 2

export type Scheduler = {
  pump(): void;
  inflight(): readonly { readonly key: MemoKey; readonly purpose: Purpose; readonly startedAtMs: number }[];
  /** Processing estimate only when ≥ 5 completed samples for every pending purpose (flow C "estimate only when reliable"). */
  estimateSeconds(pending: readonly Purpose[]): number | null;
  stop(): Promise<void>;
};

export function createScheduler(sources: readonly (() => readonly WorkItem[])[], limits: SchedulerLimits): Scheduler {
  throw new Error("not implemented");
}
