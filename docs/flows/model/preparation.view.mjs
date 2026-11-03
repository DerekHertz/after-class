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
  if (v.question[1] !== 0) return "Question open";
  return v.paused[1] === 0 ? "Reviewing" : "Question paused";
};

export const title = "After Class preparation and review";

export const state = (v) => ({
  Capture: CAPTURE[v.capture],
  Preparation: preparation(v),
  Review: review(v),
});

const STEPS = {
  YouStartCapture: "you start capture",
  YouWatchAPassage: "you watch a passage",
  CapturePauses: "capture pauses",
  YouResumeCapture: "you resume capture",
  YouStopCapture: "you stop capture",
  ChunkClosesAtABoundary: "a chunk closes at a topic boundary",
  ChunkHitsTheTimeCap: "a chunk hits the time cap",
  AgentWritesAClaim: "the agent writes a claim",
  AgentRevisesAClaim: "the agent revises a claim",
  ResourceSearchStarts: "a resource search starts",
  ResourceSearchEnds: "the resource search ends",
  YouChooseLater: "you choose Later",
  YouChooseWait: "you choose wait",
  YouStartAReview: "you press Review now",
  YouPressReviewNowWithNothingSupported: "you press Review now [nothing supported]",
  YouRewatchOrRetry: "you rewatch or retry",
  YouStopEarly: "you choose Stop early",
  TutorAsksAboutAClaim: "the tutor asks about a claim",
  TutorResumesThePausedQuestion: "the claim passes again and the question resumes",
  ALateResultArrives: "a late result is logged",
  YouAnswer: "you answer",
  YouEndTheReview: "you end the review",
};

export const step = (action, from, to) => {
  if (action === "JevChecksAClaim" || action === "JevRechecksAClaim") {
    const became = (s) => Object.keys(to.status).some((k) => to.status[k] === s && from.status[k] !== s);
    if (became("revising")) return "Jev says no and the claim gets its one revision";
    if (became("unverified")) return "Jev says no again and the claim is unverified";
    return "Jev passes a claim";
  }
  if (action === "ALaterWindowMovesABoundary") {
    return from.question[1] !== 0 && to.question[1] === 0
      ? "a later window moves a boundary and the tutor says why the question paused"
      : "a later window moves a boundary";
  }
  return STEPS[action] ?? action;
};
