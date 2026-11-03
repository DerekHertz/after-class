// app/useReviewSession.ts -- one hook owning the review conversation state in the browser.
// The browser holds NO authority: the log of turns lives on the backend; this hook mirrors it and sends learner actions.
import type { ReviewId, TurnId } from "../shared/domain/ids";
import type { LearnerTurnKind } from "../shared/domain/review";
import type { ReviewView, TutorStreamEvent } from "../shared/api/views";

export interface ReviewSession {
  readonly view: ReviewView | null;
  readonly streaming: boolean;
  /** pending-save banner source: SaveState.pending with Retry */
  readonly retrySave: () => Promise<void>;
  /**
   * Allocates the TurnId HERE (crypto.randomUUID) before POSTing, so a network retry re-sends the same id and the backend stores the
   * learner turn once. Consumes the TutorStreamEvent stream; `say_delta` goes to SpeechOut. Calling send() while streaming == barge-in:
   * abort the previous request, then send.
   */
  readonly send: (kind: LearnerTurnKind, text: string, viaSpeech: boolean) => Promise<TurnId>;
  readonly onEvent: (e: TutorStreamEvent) => void;
}
export function useReviewSession(reviewId: ReviewId): ReviewSession {
  throw new Error("not implemented");
}
