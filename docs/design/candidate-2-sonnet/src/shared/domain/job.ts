// domain/job.ts -- jobs and the fence that implements R8.
//
// Every paid/slow unit of work is a Job row with a natural JobKey (UNIQUE): enqueue is
// INSERT OR IGNORE, so a crash-and-retry of the enqueuer can't duplicate work, and
// a restart re-claims 'running' rows whose lease expired.
//
// R8 fence, in ONE place (store/jobs.applyResult): a result is applied iff
//     job.cancelledAt == null  AND  job.state == 'running'  AND  target still current.
// Otherwise it is written to `stale_results` (diagnostics) and returned as { applied:false }.
// "Target still current" is DERIVED: for chunk-scoped jobs, job.contentKey is still the
// contentKey of the chunk's latest revision; for claim jobs, claim.versions.length matches.
import { z } from "zod";
import { CaptureId, ChunkId, ClaimId, ContentKey, JobId, JobKey, ReviewId } from "./ids";

// Boundary and frame judgments are NOT jobs: they run inline in the per-capture boundary stage
// (ordered, cheap, cached by input hash, re-derived from the cursor after a crash), so they need no fence.
// Jobs exist for work that can be cancelled or made outdated while in flight (R8).
export const JobKind = z.enum([
  "interpret",       // [agent] chunk -> claims
  "claim_check",     // [Jev]   claim version -> support verdict
  "claim_revise",    // [agent] one revision
  "resource_search", // [agent] later; never on the review-readiness path (R6)
]);
export type JobKind = z.infer<typeof JobKind>;

export type JobTarget =
  | { readonly kind: "chunk"; readonly chunkId: ChunkId; readonly contentKey: ContentKey }
  | { readonly kind: "claim"; readonly claimId: ClaimId; readonly contentKey: ContentKey; readonly version: 1 | 2 };

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  readonly id: JobId;
  readonly key: JobKey;
  readonly kind: JobKind;
  readonly captureId: CaptureId;
  readonly target: JobTarget;
  readonly state: JobState;
  readonly attempts: number; // bounded; "uncapped spend" is not "unbounded retries" (spec)
  readonly cancelledAt: number | null;
  readonly leaseUntil: number | null;
}

export type StaleReason = "cancelled" | "outdated_target" | "not_running";
export type ApplyOutcome =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: StaleReason };

/** What Stop early / revision cancels. A scope is a set of chunk slots of one capture. */
export interface CancelScope {
  readonly captureId: CaptureId;
  readonly chunkIds: readonly ChunkId[];
  /** audit */
  readonly by: { readonly kind: "stop_early"; readonly reviewId?: ReviewId } | { readonly kind: "boundary_revision" };
}
