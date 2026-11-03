/**
 * Local learning record (W8). Owns: notes (generated), note_edits (user),
 * note_deletions (user), note_evidence, observations (proposed status),
 * observation_decisions (user: dispute resolutions, overrides),
 * link_suggestions, link_decisions (user), saved_reviews.
 *
 * Per-actor tables, merged at read: the save writes only generated columns;
 * the user writes only *_edits / *_deletions / *_decisions.
 * R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes."
 * Nothing a job or the tutor produces can reach a user table.
 *
 * R15: "Retrying a save never creates a duplicate record."
 * Every row ID is stableId(...) of what it names; save is
 * INSERT … ON CONFLICT(id) DO UPDATE SET <generated columns only>, one
 * transaction, skipping tombstoned notes. "Pending save" isn't a blob: the
 * inputs (turns, wrap-up memo) are already durable; pending = review ended ∧
 * no saved_reviews row with the current bundle hash. Retry = call save again.
 * While a review has no saved_reviews row, db.ts triggers hold its capture's
 * raw evidence (R16, pending saves count as citing).
 *
 *   const r = await record.save(reviewId);    // { kind: "saved" } | { kind: "save_failed", retryable }
 *   record.editNote(noteId, "my wording");
 *   record.resolveDispute(obsId, "it_was_my_gap");
 */
import type { ConceptId, EvidenceId, LinkId, NoteId, ObservationId, ReviewId } from "../../shared/ids";
import type { AssessableClaim, LinkDecision, ObservationStatus, RecordView, SaveResult, Turn } from "../../shared/domain";
import type { WrapUpOutput } from "../review/tutor";
import type { Db } from "../db";

export type LearningRecord = {
  save(reviewId: ReviewId): Promise<SaveResult>;
  view(filter: { readonly reviewId?: ReviewId; readonly conceptId?: ConceptId }): RecordView;
  editNote(id: NoteId, text: string): void;
  /** Tombstone in note_deletions; the snapshot it cited becomes sweepable (R16 trigger). */
  deleteNote(id: NoteId): void;
  decideLink(id: LinkId, decision: LinkDecision): void;
  /**
   * R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
   * The ONLY producer of resolved_by_learner.
   */
  resolveDispute(id: ObservationId, outcome: "learner_was_right" | "it_was_my_gap"): void;
  /** User correction of a status. Still clamped by clampStatus. */
  overrideObservation(id: ObservationId, status: ObservationStatus): void;
};

export function createRecord(db: Db, deps: {
  turns(reviewId: ReviewId): readonly Turn[];
  claims(reviewId: ReviewId): readonly AssessableClaim[];
  wrapUp(reviewId: ReviewId): Promise<WrapUpOutput>; // memo-backed; a retried save reuses the same proposal
  snapshotEvidenceInTx(ids: readonly EvidenceId[]): void;
}): LearningRecord {
  throw new Error("not implemented");
}
