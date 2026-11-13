export const title = "Finishing and saving a review (code, not flow)";
const turn = (v) => {
  if (v.dropped) return "Finish confirmed, nothing happened";
  if (v.endTurn === "none") return v.settling ? "Reviewing, last reply settling" : "Reviewing";
  if (v.endTurn === "wrapped") return v.live === "streaming" ? "Review ended, request in flight" : v.live === "failed" ? "Review ended, last request failed" : "Review ended";
  if (v.live === "streaming") return "Finishing";
  if (v.live === "failed") return v.endTurn === "unsent" ? "Finish failed, not delivered" : "Finish failed after delivery";
  return v.endTurn === "unsent" ? "Finish not delivered" : "Finish delivered, no wrap-up";
};
const seen = (v) => ({ none: "no end", stored: "end stored", wrapped: "review ended" })[v.known];
const save = (v) => {
  if (v.saved === "saved") return "Saved";
  if (v.saving) return v.wrapMemo === "terminal" ? "Saving, failure cached" : "Saving";
  if (v.wrapMemo === "terminal") return "Save failed, failure cached";
  return v.saved === "save_pending" ? "Save pending" : "Not saved";
};
export const state = (v) => ({ Finish: turn(v), App: seen(v), Save: save(v), Screen: v.screen === "home" ? "Home" : "Review screen" });
const STEPS = {
  TroubleClears: "the model or network recovers", TroubleStarts: "the model or network starts failing", ThePreviousTurnSettles: "the last reply settles",
  TheEndRequestFails: "the request fails", TheBackendStoresYourEnd: "the backend stores your finish",
  TheWrapUpMoveFails: "the tutor's wrap-up fails", TheTutorWrapsUp: "the tutor wraps up",
  TheWrapUpCommitsButTheReplyIsLost: "the wrap-up is saved but the reply is lost",
  YouPressFinishAgain: "you press Finish again", YouPressRetrySave: "you press Retry save",
  YouGoHome: "you go home", YouOpenTheReviewFromHome: "you open the review from home", Done: null,
};
export const step = (a, from, to) => {
  if (a === "YouConfirmFinish") return to.dropped ? "you confirm Finish and nothing happens" : "you confirm Finish";
  if (a === "YouPressRetry") return to.live === "streaming" ? "you press Retry" : "you press Retry and nothing happens";
  if (a === "TheSaveRuns") return to.saved === "saved" ? "the save succeeds" : to.wrapMemo === from.wrapMemo ? "the save returns the cached failure" : "the save fails";
  if (a === "TheRequestAfterWrapUpEnds") return to.live === "failed" ? "the request after the wrap-up fails" : "the replay ends and the app saves";
  return a in STEPS ? STEPS[a] : a;
};
