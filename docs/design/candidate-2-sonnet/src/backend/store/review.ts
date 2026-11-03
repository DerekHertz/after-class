// store/review.ts -- owner: review workstream. Sole writer of: reviews, review_turns, observations, notes,
// graph_links, pending_saves. (Citations are written through RetentionRepo.cite inside commitRecord's tx.)
//
//   reviews(id PK, capture_id, scope_json (frozen), state_json, save_state_json, created_at)
//   review_turns(review_id, seq, id UNIQUE, actor, kind, question_id, text, json)   -- append-only; learner TurnId is allocated by the app => retry-safe
//   observations(id PK natural, review_id, question_id, claim_id, status, proposed, clamped_by, dispute_json, turns_json)
//   notes(id PK natural, review_id, author, generated, user_text NULL, ...)           -- generated vs user_text are separate columns
//   graph_links(id PK natural, ..., status)
//   pending_saves(review_id PK, draft_json, since, last_error)                        -- file mirror under <dataDir>/pending/ in case SQLite itself is the failure
import type { LearningRecordDraft, Note, GraphLink, SaveState } from "../../shared/domain/record";
import type { Observation, ReviewState, ReviewTurn, ReviewScope } from "../../shared/domain/review";
import type { CaptureId, LinkId, NoteId, ObservationId, ReviewId } from "../../shared/domain/ids";
import type { Db } from "./db";
import type { RetentionRepo } from "./capture";

export interface ReviewRepo {
  create(state: ReviewState): void;               // scope is written once and never updated (R7); state_json carries the mutable phase/claims
  load(id: ReviewId): ReviewState | null;
  saveState(id: ReviewId, state: ReviewState): void;

  /** idempotent on turn.id; assigns seq. Returns the stored turn (existing one on replay). */
  appendTurn(t: Omit<ReviewTurn, "seq">): ReviewTurn;
  turns(id: ReviewId): readonly ReviewTurn[];

  /**
   * R15. One tx: upsert observations/notes(generated only)/links by NATURAL id (ON CONFLICT DO UPDATE ... never touching user_text),
   * cite evidence via retention.cite, set save_state=saved, delete pending_saves row.
   * Called twice with the same draft => same rows. On exception: caller invokes keepPending.
   */
  commitRecord(draft: LearningRecordDraft): SaveState;
  keepPending(draft: LearningRecordDraft, error: string): SaveState;
  pending(): readonly { readonly reviewId: ReviewId; readonly draft: LearningRecordDraft; readonly since: number; readonly lastError: string }[];

  /** learner edits: write user_text only; delete = tombstone row + citations */
  editNote(id: NoteId, userText: string | null): void;
  deleteNote(id: NoteId): void;
  setLinkStatus(id: LinkId, status: GraphLink["status"], corrected?: { readonly to: GraphLink["to"] }): void;
  setDispute(id: ObservationId, d: Observation["dispute"]): void;

  record(captureId: CaptureId): { readonly notes: readonly Note[]; readonly observations: readonly Observation[]; readonly links: readonly GraphLink[]; readonly scopes: readonly ReviewScope[] };
}

export function createReviewRepo(db: Db, retention: RetentionRepo, dataDir: string): ReviewRepo {
  throw new Error("not implemented");
}
