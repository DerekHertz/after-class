const review = (v) => {
  if (v.review === "ended") return "Review ended";
  if (v.detour === "offered") return "Detour offered";
  if (v.detour === "waiting") return "Waiting for a resource";
  if (v.detour === "on") return "On a detour";
  return v.question === 0 ? "Reviewing" : "Question open";
};

const NOTE = { none: "No note yet", pending: "Save pending", saved: "Note saved", deleted: "Note deleted" };
const EVIDENCE = { kept: "Evidence kept", expired: "Evidence expired", "deleted by me": "Evidence deleted by me" };

export const title = "After Class review record";

export const state = (v) => ({
  Review: review(v),
  Note: NOTE[v.note],
  Evidence: EVIDENCE[v.evidence],
});

const STEPS = {
  ResourceSearchEnds: "the resource search ends",
  TutorAsksAboutAClaim: "the tutor asks about a claim",
  YouAnswer: "you answer",
  YouSkip: "you skip",
  YouDispute: "you dispute the interpretation",
  TutorOffersADetour: "the tutor offers a detour",
  YouAcceptTheDetour: "you say yes",
  YouDeclineTheDetour: "you say no",
  YouContinueOnLectureEvidence: "you continue on lecture evidence",
  TheDetourEnds: "the detour ends",
  YouRetryTheSave: "you retry the save",
  YouDeleteTheNote: "you delete the note",
  YouDeleteTheEvidence: "you delete the evidence",
  RawEvidenceExpires: "the evidence expires",
  Done: "nothing left to do",
};

export const step = (action, from, to) => {
  if (action === "YouSettleTheDispute") {
    const gap = Object.values(to.obs).filter((o) => o === "resolved gap").length >
      Object.values(from.obs).filter((o) => o === "resolved gap").length;
    return gap ? "you settle the dispute as a gap" : "you settle the dispute as not a gap";
  }
  if (action === "YouEndTheReview") {
    return to.note === "saved" ? "you end the review and it saves" : "you end the review and the save fails";
  }
  return STEPS[action] ?? action;
};
