/**
 * Local learning record. Owns: notes (generated content), note_edits (user),
 * note_evidence, observations (proposed status), observation_decisions (user:
 * dispute resolutions, overrides), link_suggestions, link_decisions (user),
 * saved_reviews (review_id, bundle_hash).
 *
 * Per-actor tables, merged at read (separate-before-serializing): the save
 * derivation writes only generated columns; the user writes only *_edits /
 * *_decisions. Nothing a job or the tutor produces can reach a user table, so a
 * late or repeated save can't overwrite Derek's edits (R8 "my notes").
 *
 * R15: every row ID is stableId(...) of what it names; save is
 * INSERT … ON CONFLICT(id) DO UPDATE SET <generated columns only>, one transaction.
 * "Pending save" isn't a blob: the inputs (turns, wrap-up memo) are already
 * durable; pending = review ended ∧ saved_reviews.bundle_hash ≠ hash(current bundle).
 * Retry = call save again.
 *
 * Usage:
 *   const r = record.save(reviewId);          // { kind: "saved" } | { kind: "save_failed", retryable }
 *   record.editNote(noteId, "my wording");
 *   record.resolveDispute(obsId, "it_was_my_gap");
 */
import type { ConceptId, EvidenceId, LinkId, NoteId, ObservationId, ReviewId } from "../../shared/ids";
import type {
  AssessableClaim, LinkDecision, Note, Observation, ObservationStatus, SaveResult, SubjectLinkSuggestion, Turn,
} from "../../shared/domain";
import type { WrapUpOutput } from "../review/tutor";
import type { Db, ModuleSchema } from "../db";

export const recordSchema: ModuleSchema = { module: "record", version: 1, ddl: [/* see header */] };

export type RecordBundle = {
  readonly hash: string;
  readonly notes: readonly Omit<Note, "userEdit">[];
  readonly observations: readonly Omit<Observation, "status" | "clampedFrom" | "dispute" | "corrections">[];
  readonly links: readonly SubjectLinkSuggestion[];
  readonly evidence: readonly EvidenceId[];
};

export type RecordView = {
  readonly notes: readonly Note[];
  readonly observations: readonly Observation[]; // status = clamp(override ?? proposed)
  readonly links: readonly (SubjectLinkSuggestion & { decision: LinkDecision })[];
  readonly unavailableEvidence: readonly EvidenceId[]; // deleted by user: shown as such, never as a working link
};

export type LearningRecord = {
  save(reviewId: ReviewId): Promise<SaveResult>;
  view(filter: { reviewId?: ReviewId; conceptId?: ConceptId }): RecordView;
  editNote(id: NoteId, text: string): void;
  deleteNote(id: NoteId): void; // removes note_evidence rows ⇒ snapshots become sweepable (R16)
  decideLink(id: LinkId, decision: LinkDecision): void;
  /** R14: the ONLY producer of resolved_by_learner. */
  resolveDispute(id: ObservationId, outcome: "learner_was_right" | "it_was_my_gap"): void;
  /** User correction of a status. Still clamped (R12/R13 hold even against overrides — open question). */
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

/**
 * Pure. Learner segments are VERBATIM learner turn text (author "learner",
 * turnId set); tutor segments come from the wrap-up summary (author "tutor");
 * cited source passages are author "source". Attribution is structural, not
 * something the model labels.
 */
export function buildBundle(reviewId: ReviewId, turns: readonly Turn[], claims: readonly AssessableClaim[], wrapUp: WrapUpOutput): RecordBundle {
  throw new Error("not implemented");
}
