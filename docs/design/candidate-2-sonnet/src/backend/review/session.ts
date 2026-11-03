// review/session.ts -- review shell (flow D): learner turn in -> stored -> core decides -> tutor streamed out.
// Tutor PROPOSES, core/review GATES, store PERSISTS. Capture is never touched here (R9: no import of capture code).
import type { Deps } from "../deps";
import type { CaptureId, ReviewId } from "../../shared/domain/ids";
import type { ReviewStartView, TutorStreamEvent } from "../../shared/api/views";
import type { ReqOf } from "../../shared/api/contract";

/**
 * begin pseudocode (idempotent on reviewId):
 *   if store.review.load(reviewId): return the stored start view
 *   if mode == 'stop_early': t = chooseStopEarly(...); runner.cancel(t scope)        // finished claims kept; late results fenced (R8)
 *   readiness = reviewReadiness(store.jobs.prepInputs(captureId))
 *   ready      -> startReview(...) -> store.review.create(state); append invite_log 'learner_chose now'; return started
 *   processing -> { kind:'processing', pending, estimateMs }    // UI offers wait / stop early
 *   nothing    -> { kind:'nothing_to_review', gaps, unverified-with-evidence, canRetry }   // does NOT start (R10)
 *   begin stores NO tutor text. The first move (open recall, no recap) is produced by `reviewTurn` when the app sends a 'continue' turn
 *   right after `started`: one path for every tutor move, including the first.
 */
export async function beginReview(d: Deps, captureId: CaptureId, reviewId: ReviewId, mode: "now" | "stop_early"): Promise<ReviewStartView> {
  throw new Error("not implemented");
}

/**
 * turn pseudocode:
 *   stored = store.review.appendTurn(learnerTurn)          // idempotent on turnId; a retried POST finds it already stored
 *   if it already had a tutor reply logged after it: replay that reply from the log (no second paid call)
 *   t = onLearnerTurn(state, stored, now); store.review.saveState(...)
 *   for cmd of t.commands:
 *     need_tutor_move(intent):
 *        for attempt in 1..2:                                     // one silent re-ask on a gate rejection
 *          for await ev of providers.claude.tutorTurn(input(intent, askableClaims(state), turns), ctx):
 *             header   -> g = acceptTutorMove(state, ev.proposal-with-empty-say); if !g.ok: abort; record reason; continue outer attempt
 *             say_delta-> yield { tag:'say_delta' } (sentence-complete chunks for TTS)
 *             done     -> store tutor turn (gate-approved fields only); update state (mainAsked, openQuestion, detour proposal)
 *        both attempts rejected -> code-authored fallback move (offer wrap or next main): the model cannot wedge the review
 *     start_detour(consent) -> only reachable from the learner's accept turn (R11); if detour.needsPendingResource: offer wait vs continue on lecture evidence
 *     offer_wrap -> yield phase 'wrap_offered'
 *     finalize_record -> finalizeRecord(d, reviewId); yield save state
 *   Learner barge-in = the HTTP request is aborted (ctx.signal) -> child killed -> partial usage ledgered as 'cancelled'; the half-spoken
 *   tutor turn is stored with its spoken prefix only.
 */
export async function* reviewTurn(d: Deps, req: ReqOf<"review.turn">, signal: AbortSignal): AsyncGenerator<TutorStreamEvent> {
  throw new Error("not implemented");
}

/** Pipeline -> review: a chunk this review pinned was revised. Calls core/review.applyCorrection; the next tutor move discloses it. */
export function notifyCorrection(d: Deps, reviewId: ReviewId, n: import("../../shared/core/review").CorrectionNotice): void {
  throw new Error("not implemented");
}
