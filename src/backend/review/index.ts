/**
 * Invites + reviews, flows C (bottom half) and D (W7). Owns: invite_answers,
 * reviews (FrozenScope snapshot, written once), review_turns (append-only).
 *
 * R9: "Starting a review doesn't stop capture, and stopping capture doesn't end a review."
 * A dependency fact: this module never imports evidence/, and evidence/ never
 * imports this module (test/boundaries.test.ts). Readers get capture data
 * through the deps below.
 *
 *   const opts = reviews.options(captureId);                       // ready | processing | nothing_to_review
 *   const r = reviews.start(captureId, "prepared_only", reviewId); // reviewId minted by the app
 *   for await (const ev of reviews.turn(reviewId, turnId, act)) send(ev);
 */
import type { CaptureId, ChunkRevisionId, ReviewId, TurnId } from "../../shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkRevision, Claim, EvidenceBundle, InviteAnswer, InviteState, LearnerAct, ReviewOptions,
  ReviewView, Seq, StartChoice, StartResult, TurnEvent,
} from "../../shared/domain";
import type { Material } from "../../shared/time";
import type { Db } from "../db";
import type { Lookup } from "../providers/memo";
import type { TutorInput, TutorOutput, WrapUpInput, WrapUpOutput } from "./tutor";

export type Reviews = {
  invite(captureId: CaptureId): InviteState;
  /**
   * User fact.
   * R5: "Choosing Later never cancels preparation."
   * `later` and `wait` change only invite state. `review_now` / `stop_early` go through start().
   */
  answerInvite(captureId: CaptureId, answer: InviteAnswer): InviteState;
  /** "Review now always available": callable any time, regardless of invite state. */
  options(captureId: CaptureId): ReviewOptions;
  /**
   * Idempotent on the app-minted reviewId: a retried start returns the stored scope.
   *   stop_early → stopEarly(pending unreviewed chunks) first.
   *   scope = unreviewed ∧ finished chunk revisions; claims = assessableIn(material)
   * R10: "A review never starts with zero supported claims in scope."
   * Claims empty → nothing_to_review, and no review row is written.
   */
  start(captureId: CaptureId, choice: StartChoice, reviewId: ReviewId): StartResult;
  /**
   * TODO pseudocode (header-first, SYNTHESIS graft 1):
   *   append learner turn (idempotent on turnId; committed BEFORE any model call) → yield learner_turn_stored
   *   state = reviewState(...); allowed = allowedMoves(state)
   *   ctl = AbortController; buf = ""; gated = false
   *   lookup = await runTutor(input, onDelta, ctl.signal) where onDelta(d):
   *     buf += d
   *     if !gated: header = parseMoveHeader(buf); if header pending: return
   *       if !validateMove(header, input).ok: ctl.abort(); return          // nothing was spoken
   *       gated = true; yield move; forward the text after the header line
   *     else: yield say_delta(d); yield sentence for every completed sentence
   *   aborted on an invalid header → one repair attempt with repairNote set (a new memo key)
   *   still invalid → code-authored fallback move (close_thread or wrap_up), never a stuck review
   *   memo hit on a resent turn → yield the stored move, then its sentences
   *   append tutor turn (id = stableId("turn", reviewId, turnId, "tutor")) → yield turn_complete
   */
  turn(reviewId: ReviewId, turnId: TurnId, act: LearnerAct): AsyncIterable<TurnEvent>;
  view(reviewId: ReviewId): ReviewView;
};

export function createReviews(db: Db, deps: {
  currentChunks(captureId: CaptureId): readonly ChunkRevision[];
  prep(id: ChunkRevisionId): ChunkPrep;
  stopEarly(captureId: CaptureId, ids: readonly ChunkRevisionId[]): Seq;
  assessableIn(captureId: CaptureId, material: Material): readonly AssessableClaim[];
  claimsIn(captureId: CaptureId, material: Material): readonly Claim[];
  bundle(material: Material): EvidenceBundle;
  watchedSeconds(captureId: CaptureId): number;
  runTutor(input: TutorInput, streamTo: (delta: string) => void, signal: AbortSignal): Promise<Lookup<TutorOutput>>;
  runWrapUp(input: WrapUpInput): Promise<Lookup<WrapUpOutput>>;
  nextSeq(): Seq;
}): Reviews {
  throw new Error("not implemented");
}
