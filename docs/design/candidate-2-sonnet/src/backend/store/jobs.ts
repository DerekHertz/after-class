// store/jobs.ts -- owner: prep workstream. Sole writer of: jobs, claims, claim_evidence, stale_results, resources.
//
//   jobs(id PK, key UNIQUE, kind, capture_id, target_json, state, attempts, cancelled_at, lease_until, created_at)
//   claims(id PK, content_key, ordinal, status, versions_json)            INDEX(content_key)
//   claim_evidence(claim_id, version, evidence_id)                         -- for R7 subset checks and R16 pins
//   stale_results(job_id, reason, payload_json, at)                        -- R8: late results are logged, never applied
//
// Single decision point for R8:  applyResult.  There is no other code path that writes a claim from a job result.
import type { CaptureId, ClaimId, ContentKey, JobId, JobKey } from "../../shared/domain/ids";
import type { ApplyOutcome, CancelScope, Job, JobKind, JobTarget } from "../../shared/domain/job";
import type { CheckOutcome, Claim, ClaimVersion } from "../../shared/domain/claim";
import type { ChunkPrepInput } from "../../shared/core/prep";
import type { Db } from "./db";

export interface EnqueueSpec {
  readonly kind: JobKind;
  readonly captureId: CaptureId;
  readonly target: JobTarget;
  /** extra material hashed into the JobKey (e.g. question-set version); same key => ignored */
  readonly inputs: string;
}

/** What a finished job hands back. Data only; the store decides what to do with it. */
export type JobResult =
  /** `invalid` = core/claimMachine.validateDraft failed (e.g. cites evidence outside the chunk): stored as 'unverified' with this reason, never silently repaired */
  | { readonly kind: "interpret"; readonly drafts: readonly { readonly version: ClaimVersion; readonly invalid: string | null }[] }
  | { readonly kind: "claim_check"; readonly claimId: ClaimId; readonly version: 1 | 2; readonly check: CheckOutcome }
  | { readonly kind: "claim_revise"; readonly claimId: ClaimId; readonly version: ClaimVersion }
  | { readonly kind: "failed"; readonly retryable: boolean; readonly detail: string };

export interface JobRepo {
  /** INSERT OR IGNORE on key. Returns the id of the existing or new job. */
  enqueue(spec: EnqueueSpec): JobId;
  /** atomically: pick oldest queued (by kind filter) whose lease is free; state=running; lease_until=now+lease; attempts++ */
  lease(kinds: readonly JobKind[], leaseMs: number): Job | null;
  /** crash recovery on boot: running rows with expired lease -> queued (attempts bounded, else failed) */
  requeueExpired(): number;

  /**
   * THE FENCE (R8). One tx:
   *   job = get(jobId)
   *   if job.cancelled_at != null           -> stale_results(reason 'cancelled'), return { applied:false }
   *   if job.state != 'running'             -> stale_results('not_running')
   *   if !targetStillCurrent(job.target)    -> stale_results('outdated_target')     // contentKey no longer the slot's latest, or claim version moved on
   *   else: claim = claimStep(claim, event); persist claim; enqueue follow-up commands (check / revise) via enqueue(); job.state = 'succeeded'
   * Stale results can never touch claims, review state, or notes (those are other repos' tables).
   */
  applyResult(jobId: JobId, r: JobResult): ApplyOutcome;

  /** Stop early / boundary revision: sets cancelled_at on every queued+running job in scope (in one tx) and returns running ids so the runner can abort them. */
  cancel(scope: CancelScope): readonly JobId[];

  claims(contentKey: ContentKey): readonly Claim[];
  /** reuse on rewatch: true iff interpretation already completed for this content under this PROCESSING_VERSION */
  isPrepared(contentKey: ContentKey): boolean;
  prepInputs(captureId: CaptureId): readonly ChunkPrepInput[];
  /** inserts claims for an interpret result; ids are claimIdFor(contentKey, ordinal): re-applying is a no-op */
  jobByKey(k: JobKey): Job | null;
}

export function createJobRepo(db: Db): JobRepo {
  throw new Error("not implemented");
}
