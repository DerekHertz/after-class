// core/invite.ts -- review invitations (flow C). Two actors append (pipeline: chunk closes;
// learner: choices), so the state is a FOLD over an append-only log, never a mutated row.
//
// R5 (Later never cancels preparation) is a type fact: chooseLater/chooseWait return
// Transition<InviteState, never>. Only chooseStopEarly can emit a CancelScope command.
import type { CancelScope } from "../domain/job";
import type { ChunkId, ReviewId } from "../domain/ids";
import type { CloseProvenance, InviteReason } from "../domain/chunk";
import type { Transition } from "./transition";
import type { Readiness } from "./prep";

export type InviteEntry =
  | { readonly tag: "chunk_closed"; readonly chunkId: ChunkId; readonly provenance: CloseProvenance; readonly watchedMs: number; readonly atWall: number }
  | { readonly tag: "learner_chose"; readonly choice: "now" | "later" | "wait" | "stop_early"; readonly atWall: number };

export type InviteState =
  | { readonly tag: "none" }
  | { readonly tag: "invited"; readonly reason: InviteReason; readonly chunks: readonly ChunkId[] }
  | { readonly tag: "waiting" }   // learner chose to wait; UI shows "Processing" (estimate only when reliable)
  | { readonly tag: "later" };

export interface InvitePolicy {
  readonly timeCapMinWatchedMs: number; // ~15 min since last invite or Later
}
export const DEFAULT_INVITE_POLICY: InvitePolicy = { timeCapMinWatchedMs: 15 * 60_000 };

/**
 * pure fold; pseudocode:
 *   watchedSince = 0; state = none
 *   for e of log:
 *     chunk_closed:  watchedSince += e.watchedMs
 *                    if e.provenance == 'boundary' (incl. boundary_revised false): state = invited(reason 'boundary'); watchedSince = 0
 *                    elif e.provenance == 'time' and watchedSince >= policy.timeCapMinWatchedMs: invited('time_cap_15min'); watchedSince = 0
 *                    elif e.provenance == 'session_end': no invite (capture ended; review remains available on demand)
 *     learner_chose: now -> none, watchedSince = 0 ; later -> later (watchedSince = 0, next invite at next boundary close) ;
 *                    wait -> waiting ; stop_early -> none
 *   "Review now" is ALWAYS available regardless of state (it is not an invite state, it's an endpoint).
 */
export function foldInvites(log: readonly InviteEntry[], policy: InvitePolicy): InviteState {
  throw new Error("not implemented");
}

/** R5: no command can come out. */
export function chooseLater(s: InviteState): Transition<InviteState, never> {
  throw new Error("not implemented");
}
export function chooseWait(s: InviteState): Transition<InviteState, never> {
  throw new Error("not implemented");
}

export type StopEarlyCommand =
  | { readonly tag: "cancel_pending"; readonly scope: CancelScope }
  | { readonly tag: "begin_review_from_prepared" };

/**
 * Stop early: cancel pending jobs in scope (their late results are fenced, R8), keep every finished claim,
 * then try to freeze a review from what is prepared. The cancellation scope is exactly the unfinished chunks
 * not already reviewed; chunks that are prepared are untouched.
 */
export function chooseStopEarly(s: InviteState, readiness: Readiness, reviewId: ReviewId): Transition<InviteState, StopEarlyCommand> {
  throw new Error("not implemented");
}
