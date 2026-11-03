/**
 * Review app client (W9). Same origin as the backend; the pairing token is
 * injected into the served HTML.
 *
 *   const opts = await api.reviewOptions(captureId);
 *   const start = await api.startReview(captureId, "prepared_only", randomId("rvw"));
 *   for await (const ev of api.sendTurn(reviewId, randomId("turn"), { kind: "answer", text, modality: "speech" })) {
 *     if (ev.type === "sentence") speak(ev.text);          // the tutor stops when Web Speech onspeechstart fires
 *   }
 *   const saved = await api.save(reviewId);                 // save_failed → show pending + Retry (same call)
 *
 * IDs are minted here, once per user act, and kept with unsent turns in
 * IndexedDB until the backend echoes `learner_turn_stored`, so a resend is the
 * same request (R15 for turns, not only for the final save).
 */
import type { CaptureId, ReviewId, TurnId } from "../shared/ids";
import type { LearnerAct, RecordView, ReviewOptions, ReviewView, SaveResult, StartChoice, StartResult, UsageSummary } from "../shared/domain";
import type { TutorStreamEvent } from "../shared/wire";

export type Api = {
  reviewOptions(captureId: CaptureId): Promise<ReviewOptions>;
  startReview(captureId: CaptureId, choice: StartChoice, reviewId: ReviewId): Promise<StartResult>;
  sendTurn(reviewId: ReviewId, turnId: TurnId, act: LearnerAct): AsyncIterable<TutorStreamEvent>;
  review(reviewId: ReviewId): Promise<ReviewView>;
  save(reviewId: ReviewId): Promise<SaveResult>;
  record(filter: { readonly reviewId?: ReviewId }): Promise<RecordView>;
  usage(): Promise<UsageSummary>;
};

export function createApi(token: string): Api {
  throw new Error("not implemented");
}
