// extension/popup/popup.ts -- capture controls and review invitations (PRD "use an extension for capture controls and invitations").
// Renders from a CaptureView + PrepView stream (events.subscribe); sends ToWorker messages. No business logic: every label is a field of a view.
//   shows: source title, caption status (+ "offer transcription" Accept / Continue with gap), frame health, ad playing, paused-by (user vs left page),
//          outbox queue ("Backend unreachable: 12 events queued"), invite: [Review now] [Later] [Wait] [Stop early]  (Review now always enabled)
//   "Review now" opens the review app tab at /review/<captureId>?begin=now&reviewId=<new uuid>; capture keeps running (R9).
export function mountPopup(root: HTMLElement): void {
  throw new Error("not implemented");
}
