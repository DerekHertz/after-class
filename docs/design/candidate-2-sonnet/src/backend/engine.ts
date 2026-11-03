// backend/engine.ts -- composition root of the backend logic. `Engine` (shared/api/contract) is Handlers + settle/close, so every route is
// implemented here exactly once and the HTTP server, tests and the replay sample all drive the same object.
//
// Concurrency model (per "separate-before-serializing-shared-state"): there is almost no shared mutable state to serialize.
//   - extension writes only its own append-only event log
//   - the boundary stage is the sole writer of a capture's open chunk -> one async queue PER CAPTURE (KeyedQueue); nothing else locks anything
//   - job results are fenced in SQL (R8), not by in-memory locks
//   - review turns are append-only, per review; the tutor loop for one review runs one turn at a time (queue per reviewId)
//   - invite state is a fold over an append-only log two actors append to
import type { Engine } from "../shared/api/contract";
import type { Deps } from "./deps";

/**
 * pseudocode of the three handlers with real logic here; the rest are one-liners into store/pipeline/review:
 *
 * "capture.ingest"(req):
 *   r = store.capture.append(req.events)                                  // ONE tx: log + spans + evidence materialization
 *   if r.newTranscriptEvidence > 0 || r.newFrames.length > 0 || events contain control{stop}:
 *        boundaryQueue.for(captureId).run(() => advanceBoundaries(d, captureId, { flush: stopSeen }))     // fire-and-forget; ack does not wait
 *   push capture_view to subscribers
 *   return { ackedThrough: r.ackedThrough, needBytes: r.needBytes, rejected: r.rejected }
 *
 * "prep.status"(req):   views.prep(store.jobs.prepInputs(id), foldInvites(store.timeline.inviteLog(id)), reviewReadiness(...))
 *
 * "review.begin"(req):  beginReview(d, ...)  (review/session.ts)       "review.turn": reviewTurn(d, req, ctx.signal)
 *
 * boot: store.jobs.requeueExpired(); runner.start(); for every capture with an open chunk -> advanceBoundaries (cursor resumes; cache makes re-judging free)
 * retention: setInterval(24h) store.retention.expireUncited(now, cfg.retention.uncitedTtlMs)   // the ONLY expiry caller; no route exposes it
 */
export async function createEngine(d: Deps): Promise<Engine> {
  throw new Error("not implemented");
}
