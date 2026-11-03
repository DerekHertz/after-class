// providers/jev/questions.ts -- the ONE versioned module for Jev wording, criteria and thresholds (spec: "keep in one versioned module").
// Changing any string or number below requires bumping QUESTION_SET_VERSION: judgments are cached by (input hash, stamp).
import type { Verdict } from "../../../shared/domain/judgment";
import type { BoundaryInput, ClaimCheckInput, FrameChangeInput } from "../ports";
import type { JevRequest } from "./wire";

export const QUESTION_SET_VERSION = "qs-1";

/** Proposals, to be tuned on held-out clips (spec: "do not pick final thresholds without representative tests"). */
export const THRESHOLDS = { yesAtOrAbove: 0.65, noAtOrBelow: 0.35 } as const;

/** p in (no, yes) band => 'uncertain'. null (error) => 'uncertain'. Never 'no' by default. */
export function verdictOf(p: number | null): Verdict {
  throw new Error("not implemented");
}

export const WORDING = {
  newConcept:
    "Apply state.criteria.new_concept to state.passage. Does the passage begin a materially different concept from the one developed in state.context? " +
    "Continuing, elaborating, restating or giving an example of the current concept is NOT a new concept.",
  stoppingPoint:
    "Apply state.criteria.stopping_point to state.context. Has the explanation in state.context reached a coherent stopping point? " +
    "A step, example or qualification that is introduced but not finished means NO.",
  frameChange:
    "Apply state.criteria.teaching_change to IMG_BEFORE and IMG_AFTER, with state.nearby_captions. Does the change add teaching content " +
    "(a new equation, diagram, written step, code line)? Cursor motion, animation, camera or lighting changes, and duplicates mean NO.",
  claimSupport:
    "Apply state.criteria.support to state.claim. Do state.passages (and any referenced image) support the claim in its stated scope? " +
    "Contradicted or merely unsupported means NO.",
} as const;

/** Both boundary questions share ONE state and are independent of each other (spec: questions in one call must not depend on one another). */
export function buildBoundaryRequest(i: BoundaryInput, model: string): JevRequest {
  throw new Error("not implemented");
  // state: { criteria: {...}, context: [{n, text}], passage: [{n, text}], gaps_before: [...] , IMG_k refs inline when frames.length > 0 }
  // questions: { new_concept: {type:'noul', instructions: WORDING.newConcept}, stopping_point: {type:'noul', instructions: WORDING.stoppingPoint} }
}
export function buildFrameChangeRequest(i: FrameChangeInput, model: string): JevRequest {
  throw new Error("not implemented"); // assets: IMG_BEFORE, IMG_AFTER (both must be referenced in state/instructions or Jev rejects the request)
}
export function buildClaimCheckRequest(i: ClaimCheckInput, model: string): JevRequest {
  throw new Error("not implemented");
}
