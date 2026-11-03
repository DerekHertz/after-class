// core/routing.ts -- boundary routing + chunk timeline reducer (flow B). Pure.
//
// Jev answers two independent questions; code owns everything else: the table, the time cap,
// the soft-pause preference, pending-boundary rechecks, carry-over and "video end never closes".
import { asYes, type Answer } from "../domain/judgment";
import type { BoundaryRow, ChunkTimeline, CloseProvenance, WindowSpec } from "../domain/chunk";
import type { ChunkId } from "../domain/ids";
import type { Transition } from "./transition";

export interface RoutingPolicy {
  readonly timeCapMs: number; // ~8 min watched
}
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = { timeCapMs: 8 * 60_000 };

/**
 * The 2x2 table, written as DATA so the exhaustive Record type is the compiler-checked source of truth.
 * `uncertain` and provider errors never reach here as such: rowOf coerces them with asYes().
 */
const TABLE: Record<"yes/yes" | "no/yes" | "yes/no" | "no/no", BoundaryRow> = {
  "yes/yes": "close_at_boundary",
  "no/yes": "soft_pause",
  "yes/no": "flag_recheck",
  "no/no": "continue",
};

export function rowOf(newConcept: Answer, stopping: Answer): BoundaryRow {
  const k = `${asYes(newConcept.verdict) ? "yes" : "no"}/${asYes(stopping.verdict) ? "yes" : "no"}` as const;
  return TABLE[k];
}

export type TimelineEvent =
  | { readonly tag: "window_judged"; readonly window: WindowSpec; readonly newConcept: Answer; readonly stoppingPoint: Answer;
      readonly firstViewSeq: number; readonly lastViewSeq: number }
  | { readonly tag: "source_ended" }       // flow B: video end does NOT close; next clip's first window decides
  | { readonly tag: "session_stopped" };   // close the open chunk, provenance "session end"

export type ChunkCommand =
  | { readonly tag: "close_chunk"; readonly chunkId: ChunkId; readonly provenance: CloseProvenance; readonly lastViewSeq: number; readonly watchedMs: number }
  | { readonly tag: "log_invite_candidate"; readonly chunkId: ChunkId; readonly provenance: CloseProvenance; readonly watchedMs: number };

/**
 * pseudocode  (P = the new passage, c = window's first viewSeq of P)
 *
 * window_judged:
 *   open  = tl.open ?? newOpen(tl.nextOrdinal, firstViewSeq = c)
 *   row   = rowOf(newConcept, stoppingPoint)
 *
 *   // 1. a recheck flagged on the PREVIOUS window resolves now, whatever this window says (bounded to one window)
 *   if open.pendingBoundary != null:
 *       cutAt = open.pendingBoundary - 1
 *       open  = { ...open, pendingBoundary: null }
 *       if asYes(stoppingPoint):  -> closeAt(open, cutAt, 'boundary'); P seeds the carry-over chunk with the flagged passage; return
 *
 *   switch row:
 *     close_at_boundary: closeAt(open, c - 1, 'boundary');  next open chunk := P;  emit invite candidate
 *     soft_pause:        open += P; open.softPauses.push(c - 1)
 *     flag_recheck:      open += P; open.pendingBoundary = c
 *     continue:          open += P
 *
 *   // 2. time cap, evaluated AFTER the table (a boundary close already reset the clock)
 *   if open.watchedMs >= policy.timeCapMs:
 *       cut = max(open.softPauses where > open.firstViewSeq) ?? open.lastViewSeq      // preferred cut point
 *       closeAt(open, cut, 'time')
 *       carry = open.ledger entries with startViewSeq > cut      // evidence after the soft pause rolls into the next chunk
 *       next open chunk := carry (watchedMs = sum of carry)
 *
 * source_ended:   unchanged state, no commands.
 * session_stopped: if open has >= 1 evidence: closeAt(open, open.lastViewSeq, 'session_end'); tl.open = null
 *
 * closeAt(open, cutViewSeq, prov): emits close_chunk{lastViewSeq: cutViewSeq} (+ log_invite_candidate);
 *   the shell turns close_chunk into a ChunkRevision, computes ContentKey, enqueues the interpret job
 *   (cache hit => no job) and appends to the invite log. Invite policy is NOT decided here (core/invite.ts).
 */
export function stepTimeline(
  tl: ChunkTimeline,
  ev: TimelineEvent,
  policy: RoutingPolicy,
): Transition<ChunkTimeline, ChunkCommand> {
  throw new Error("not implemented");
}

/**
 * Later evidence says a CLOSED boundary was wrong (flow D, "boundary revised mid-review").
 * Bounded to one revision per chunk. Produces a new ChunkRevision (new ContentKey) -> old jobs become
 * outdated, prep re-queued for the NEW key only; the review (if any) is told via a CorrectionNotice.
 * Policy placeholder: a window right after a close, whose newConcept is 'no' with p <= REVISE_P and
 * stoppingPoint 'no', says the explanation continued across the cut.
 */
export function proposeBoundaryRevision(
  closedChunk: { readonly chunkId: ChunkId; readonly revisions: number; readonly lastViewSeq: number },
  following: { readonly newConcept: Answer; readonly stoppingPoint: Answer; readonly passageLastViewSeq: number },
): { readonly newLastViewSeq: number } | null {
  throw new Error("not implemented");
}
