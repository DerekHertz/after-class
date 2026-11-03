const CAPTURE = {
  "not started": "Not capturing",
  capturing: "Capturing",
  paused: "Capture paused",
  stopped: "Capture stopped",
};

const PENDING = new Set(["queued", "checking", "revising", "rechecking"]);

const preparation = (v) => {
  if (v.closed.length === 0) return "Nothing closed yet";
  return Object.values(v.status).some((s) => PENDING.has(s)) ? "Preparing" : "Prepared";
};

const review = (v) => {
  if (v.review === "nothing to review") return "Nothing to review";
  if (v.review === "none") return "No review";
  return v.question[1] === 0 ? "Reviewing" : "Question open";
};

export const title = "After Class preparation and review";

export const state = (v) => ({
  Capture: CAPTURE[v.capture],
  Preparation: preparation(v),
  Review: review(v),
});

const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

const STEPS = {
  YouStartCapture: "you start capture",
  YouWatchAPassage: "you watch a passage",
  CapturePauses: "capture pauses",
  YouResumeCapture: "you resume capture",
  YouStopCapture: "you stop capture",
  ChunkClosesAtABoundary: "a chunk closes at a topic boundary",
  ChunkHitsTheTimeCap: "a chunk hits the time cap",
  ALaterWindowMovesABoundary: "a later window moves a boundary",
  AgentWritesAClaim: "the agent writes a claim",
  AgentRevisesAClaim: "the agent revises a claim",
  JevRechecksAClaim: "Jev checks the revised claim",
  ResourceSearchStarts: "a resource search starts",
  ResourceSearchEnds: "the resource search ends",
  YouChooseLater: "you choose Later",
  YouChooseWait: "you choose wait",
  YouStartAReview: "you press Review now",
  YouPressReviewNowWithNothingSupported: "you press Review now [nothing supported]",
  YouRewatchOrRetry: "you rewatch or retry",
  YouStopEarly: "you choose Stop early",
  TutorAsksAboutAClaim: "the tutor asks about a claim",
  YouAnswer: "you answer",
  YouEndTheReview: "you end the review",
};

export const step = (action, from, to) => {
  if (action === "JevChecksAClaim") {
    const failed = Object.keys(to.status).some((k) => to.status[k] === "revising" && from.status[k] !== "revising");
    return failed ? "Jev says a claim is not supported" : "Jev says a claim is supported";
  }
  if (action === "ALateResultArrives") {
    return changed(from.status, to.status) ? "an outdated result lands on a claim" : "a cancelled result is logged";
  }
  return STEPS[action] ?? action;
};
