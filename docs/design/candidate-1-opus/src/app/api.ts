/**
 * Review app client. Same origin as the backend; token injected into the served HTML.
 *
 * Call sites (App.tsx):
 *   const opts = await api.reviewOptions(captureId);
 *   if (opts.kind === "ready") nav(`/review/${(await api.startReview(captureId, "prepared_only")).reviewId}`);
 *   for await (const ev of api.sendTurn(reviewId, { kind: "answer", text, modality: "speech" })) {
 *     if (ev.type === "sentence") speak(ev.text);          // tutor stops when Web Speech onspeechstart fires
 *   }
 *   const saved = await api.save(reviewId);                 // save_failed → show pending + Retry (same call)
 *
 * Unsent learner turns are kept in IndexedDB under their clientTurnId until the
 * backend echoes `learner_turn_stored`; resend is idempotent.
 */
import type { CaptureId, ReviewId } from "../shared/ids";
import type { LearnerAct, ReviewOptions, SaveResult, StartChoice, UsageSummary } from "../shared/domain";
import type { TutorStreamEvent } from "../shared/wire";

export type Api = {
  reviewOptions(captureId: CaptureId): Promise<ReviewOptions>;
  startReview(captureId: CaptureId, choice: StartChoice): Promise<{ kind: "started"; reviewId: ReviewId } | Extract<ReviewOptions, { kind: "nothing_to_review" }>>;
  sendTurn(reviewId: ReviewId, act: LearnerAct): AsyncIterable<TutorStreamEvent>;
  save(reviewId: ReviewId): Promise<SaveResult>;
  usage(): Promise<UsageSummary>;
};

export function createApi(token: string): Api {
  throw new Error("not implemented");
}
