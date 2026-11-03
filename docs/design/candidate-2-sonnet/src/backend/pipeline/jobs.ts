// pipeline/jobs.ts -- bounded-concurrency job runner for preparation work. Knows nothing about claims: it leases a job,
// runs the handler registered for its kind, and hands the result to store.jobs.applyResult (the R8 fence).
import type { Deps } from "../deps";
import type { CancelScope, Job, JobKind } from "../../shared/domain/job";
import type { JobResult } from "../store/jobs";

/** `{ [K in JobKind]: ... }`: adding a JobKind without a handler is a compile error (no hand-synced list). */
export type JobHandlers = { readonly [K in JobKind]: (job: Job, signal: AbortSignal) => Promise<JobResult> };

export interface JobRunner {
  /** requeueExpired() once (crash recovery), then loop leasing up to the concurrency limit; sleeps until wake() */
  start(): void;
  wake(): void;
  /** store.jobs.cancel(scope) THEN abort in-flight handlers of the returned ids (kills `claude` children). Order matters: DB first, so a result racing the abort is already fenced. */
  cancel(scope: CancelScope): void;
  idle(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * runOne pseudocode:
 *   job = store.jobs.lease(kinds, leaseMs); if !job return false
 *   ac  = new AbortController(); inFlight.set(job.id, ac)
 *   try   { result = await handlers[job.kind](job, ac.signal) }
 *   catch { result = ac.signal.aborted ? null : { kind:'failed', retryable: attempts < max, detail } }
 *   if result: outcome = store.jobs.applyResult(job.id, result)       // stale => logged in stale_results, nothing else changes
 *   finally inFlight.delete(job.id)
 *   attempts are bounded by cfg.jobs.maxAttempts: unlimited spend is not unlimited retry (spec)
 */
export function createJobRunner(d: Deps, handlers: JobHandlers): JobRunner {
  throw new Error("not implemented");
}
