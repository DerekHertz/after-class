/**
 * Invites + reviews (flows C bottom half and D). Owns: invite_answers,
 * reviews (FrozenScope snapshot, written once), review_turns (append-only).
 *
 * R9 is a dependency fact: this module never imports evidence's write API, and
 * evidence never imports this module. Starting a review can't stop capture;
 * stopping capture can't end a review.
 * R5/R6 are dependency facts too: preparation and the scheduler don't import
 * this module, so Later and resource state cannot reach demand or readiness.
 *
 * Usage (routes):
 *   const opts = reviews.options(captureId);                 // ready | processing | nothing_to_review
 *   const r = reviews.start(captureId, "prepared_only", reqId); // { kind:"started", reviewId } | nothing_to_review
 *   for await (const ev of reviews.turn(reviewId, clientTurnId, { kind: "answer", text, modality: "speech" })) send(ev);
 */
import type { CaptureId, ChunkRevisionId, ReviewId } from "../../shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkProvenance, ChunkRevision, Claim, EvidenceBundle, FrozenScope, InviteAnswer,
  InviteState, LearnerAct, Observation, ReviewOptions, Seq, StartChoice, Turn,
} from "../../shared/domain";
import type { Material } from "../../shared/time";
import type { TutorStreamEvent } from "../../shared/wire";
import type { Db, ModuleSchema } from "../db";
import type { Lookup } from "../providers/memo";
import type { ReviewState, TutorInput, TutorOutput, WrapUpInput, WrapUpOutput } from "./tutor";

export const reviewSchema: ModuleSchema = { module: "review", version: 1, ddl: [/* invite_answers, reviews, review_turns */] };

export type StartResult =
  | { kind: "started"; reviewId: ReviewId; scope: FrozenScope }
  | Extract<ReviewOptions, { kind: "nothing_to_review" }>;

export type ReviewView = {
  readonly reviewId: ReviewId;
  readonly scope: FrozenScope;
  readonly state: ReviewState;
  readonly turns: readonly Turn[];
  readonly observations: readonly Observation[]; // live-derived; final after wrap-up
  readonly saved: "unsaved" | "saved" | "save_pending"; // derived: ended ∧ saved bundle hash ≠ current
};

export type Reviews = {
  invite(captureId: CaptureId): InviteState;
  /** User fact. `later` and `wait` change only invite state (R5). `review_now`/`stop_early` call start(). */
  answerInvite(captureId: CaptureId, answer: InviteAnswer): InviteState;
  /** "Review now always available": callable any time, regardless of invite state. */
  options(captureId: CaptureId): ReviewOptions;
  /**
   * Idempotent on (captureId, clientRequestId).
   *   stop_early → preparation.stopEarly(pending unreviewed chunks) first.
   *   scope = unreviewed ∧ finished chunk revisions; claims = assessableIn(material)
   *   claims empty → nothing_to_review, no review row (R10)
   */
  start(captureId: CaptureId, choice: StartChoice, clientRequestId: string): StartResult;
  /**
   * Append the learner turn (idempotent on clientTurnId), derive state + allowed
   * moves, run tutorTask through memo with streamTo, validate, one repair
   * attempt, append the tutor turn. Learner turn is committed BEFORE the model
   * call, so a failed call never loses what the learner said.
   */
  turn(reviewId: ReviewId, clientTurnId: string, act: LearnerAct): AsyncIterable<TutorStreamEvent>;
  view(reviewId: ReviewId): ReviewView;
};

export function createReviews(db: Db, deps: {
  currentChunks(captureId: CaptureId): readonly ChunkRevision[];
  prep(id: ChunkRevisionId): ChunkPrep;
  stopEarly(ids: readonly ChunkRevisionId[]): Seq;
  assessableIn(captureId: CaptureId, material: Material): readonly AssessableClaim[];
  claimsIn(captureId: CaptureId, material: Material): readonly Claim[];
  bundle(material: Material): EvidenceBundle;
  watchedSeconds(captureId: CaptureId): number;
  runTutor(input: TutorInput, streamTo: (delta: string) => void): Promise<Lookup<TutorOutput>>;
  runWrapUp(input: WrapUpInput): Promise<Lookup<WrapUpOutput>>;
  nextSeq(): Seq;
}): Reviews {
  throw new Error("not implemented");
}

// ───────────────────────── pure core (review/core.ts) ───────────────────────

export type InviteEvent =
  | { kind: "chunk_closed"; seq: Seq; provenance: ChunkProvenance; chunk: ChunkRevisionId; watchedS: number }
  | { kind: "answer"; seq: Seq; answer: InviteAnswer; watchedS: number }
  | { kind: "review_started"; seq: Seq };

/**
 * Flow C invite policy as a fold.
 *   boundary close                         → invited; mark = watchedS
 *   time close, watchedS − mark ≥ 900      → invited; mark = watchedS
 *   boundary_revised / session_end         → unchanged (revision isn't a new topic close; stop shows Review now in the popup)
 *   later                                  → "later"; mark = watchedS   (next invite at next boundary close)
 *   wait                                   → "waiting"
 *   review_now / stop_early / review_started → "none"
 */
export function foldInvites(events: readonly InviteEvent[], timeInviteGapS: number): InviteState {
  throw new Error("not implemented");
}

/**
 * Flow C: "Freeze review scope = prepared chunks now".
 * unreviewed = current closed revisions whose material is not ⊆ ∪ material of ended reviews' scopes.
 * Returns null when no supported claim exists (R10 is enforced by the NonEmpty in FrozenScope).
 */
export function freezeScope(
  unreviewed: readonly { rev: ChunkRevision; prep: ChunkPrep }[],
  assessable: (m: Material) => readonly AssessableClaim[],
  gaps: (m: Material) => EvidenceBundle["gaps"],
  seq: Seq,
): FrozenScope | null {
  throw new Error("not implemented");
}

/** Corrections inside a frozen scope: claims usable at start that no longer are, or whose text changed, or new usable claims in scope material. */
export function corrections(reviewId: ReviewId, scope: FrozenScope, usableNow: readonly AssessableClaim[], disclosedIds: ReadonlySet<string>): import("./tutor").Correction[] {
  throw new Error("not implemented");
}
