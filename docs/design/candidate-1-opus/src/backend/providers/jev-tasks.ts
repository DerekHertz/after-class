/**
 * Every Jev question in the product, in one versioned module (spec: "Keep
 * wording, criteria, and thresholds in one versioned module"). Three tasks:
 *
 *   boundaryTask     flow B: new concept? + stopping point?  (one request, two questions)
 *   frameChangeTask  flow B: does the before→after change add teaching content?
 *   claimSupportTask flow C: does this evidence support the claim in its stated scope?
 *
 * Verdict mapping is the only place probabilities become yes/no/uncertain.
 * Errors never become "no" (spec): an attempt that throws is retried up to
 * maxAttempts, then the memo marks the key failed and the CALLER's derivation
 * maps `failed` → "uncertain" (boundary: continue; frame: keep; claim: revise/unverified).
 */
import type { BoundaryJudgment, BoundaryWindow, ClaimDraft, Frame, Passage, Verdict } from "../../shared/domain";
import type { Task } from "./memo";
import type { JevClient } from "./jev";

export const JEV_MODEL = "jev-1.13";

/** Starting values, tuned on held-out clips (flow B note). Part of every task's version. */
export const THRESHOLDS = { yesAtOrAbove: 0.7, noAtOrBelow: 0.3 } as const;

export function toVerdict(p: number | null): Verdict {
  if (p === null) return "uncertain";
  if (p >= THRESHOLDS.yesAtOrAbove) return "yes";
  if (p <= THRESHOLDS.noAtOrBelow) return "no";
  return "uncertain";
}

/** Inputs carry evidence CONTENT so the canonical key is a function of what Jev sees. */
export type BoundaryInput = {
  readonly window: BoundaryWindow;
  readonly newPassages: readonly Passage[];
  readonly contextPassages: readonly Passage[];
  readonly frames: readonly { frame: Frame; bytes: () => Uint8Array }[];
};

export type FrameChangeInput = {
  readonly before: { frame: Frame; bytes: () => Uint8Array } | null; // null ⇒ first frame of the source: keep without a call
  readonly after: { frame: Frame; bytes: () => Uint8Array };
  readonly nearbyPassages: readonly Passage[]; // watched passages within ±15 s media
};

export type ClaimSupportInput = {
  readonly claim: ClaimDraft;
  readonly passages: readonly Passage[]; // exactly the cited passages
  readonly frames: readonly { frame: Frame; bytes: () => Uint8Array }[]; // exactly the cited frames
};

/**
 * state = { context: [{t, text}], passage: [{t, text}], frames: ["frame_0", …] }
 * new_concept:   "Does state.passage begin a materially different concept from state.context?
 *                 Answer no if it continues, elaborates, or gives an example of the same concept."
 * stopping_point:"Has the explanation in state.context reached a coherent stopping point before
 *                 state.passage? Answer no if a step, example, or qualification is unfinished."
 */
export function boundaryTask(jev: JevClient): Task<BoundaryInput, BoundaryJudgment> {
  throw new Error("not implemented");
}

/**
 * state = { before: "frame_before", after: "frame_after", captions: [{t,text}] }
 * teaching_change: "Does the change from state.before to state.after add teaching content
 *                   (a new written step, equation, diagram element, code edit, or slide)?
 *                   Answer no for cursor/camera/presenter motion or duplicate content."
 * Output: Verdict. Caller maps yes→kept, no→dropped, uncertain/failed→uncertain (kept).
 */
export function frameChangeTask(jev: JevClient): Task<FrameChangeInput, Verdict> {
  throw new Error("not implemented");
}

/**
 * state = { claim, assumptions, evidence: [{id, t, text}], frames: [...] }
 * supported: "Does state.evidence support state.claim within its stated scope? Treat
 *             state.assumptions as labelled assumptions, not as evidence. Answer no if the
 *             evidence contradicts the claim, does not address it, or supports only a narrower claim."
 * Output: { verdict, p }.
 */
export function claimSupportTask(jev: JevClient): Task<ClaimSupportInput, { verdict: Verdict; p: number | null }> {
  throw new Error("not implemented");
}
