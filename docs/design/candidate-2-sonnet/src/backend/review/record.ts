// review/record.ts -- end of review: observations (clamped) + notes + link suggestions -> one idempotent save (flow D bottom).
import type { Deps } from "../deps";
import type { ReviewId } from "../../shared/domain/ids";
import type { SaveState } from "../../shared/domain/record";

/**
 * pseudocode:
 *   turns = store.review.turns(reviewId)
 *   asked = main questions in the log (questionId set)               // every asked question gets an observation, even if the model omits it
 *   proposals = answered questions only ? await claude.proposeObservations(...) : []     // nothing to propose for all-skipped reviews
 *   for q of asked:
 *       p  = proposals.find(q) ?? { questionId:q, status:'not_assessed', citedLearnerTurns:[], rationale:'no proposal' }
 *       cl = clampObservation(p, turns)                              // R12, R13: code-owned ceiling from the turn log
 *       obs = { id: observationIdFor(reviewId, q), status: cl.status, proposed: p.status, clampedBy: cl.clampedBy, dispute: from log, ... }
 *   notes: summary + per-question learner explanation (author 'learner', verbatim learner turns) + tutor notes (author 'tutor'), ids = noteIdFor(reviewId, subject)
 *   links: claude.draftRecord suggestions -> GraphLink{ status:'suggested', evidence }, ids = linkIdFor(...)
 *   draft = { reviewId, notes, observations, links, coverageNote }
 *   try   { return store.review.commitRecord(draft) }                  // R15: same draft twice => same rows; learner edits (user_text) untouched
 *   catch (e) { return store.review.keepPending(draft, String(e)) }    // shown in UI; retryReviewSave re-runs commitRecord with the SAME draft
 */
export async function finalizeRecord(d: Deps, reviewId: ReviewId): Promise<SaveState> {
  throw new Error("not implemented");
}

export async function retryReviewSave(d: Deps, reviewId: ReviewId): Promise<SaveState> {
  throw new Error("not implemented"); // reads pending draft; commitRecord; never rebuilds (no second tutor call, no new ids)
}

