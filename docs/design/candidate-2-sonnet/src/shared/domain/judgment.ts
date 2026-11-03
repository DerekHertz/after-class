// domain/judgment.ts -- what Jev answered, in domain terms (no wire shapes).
import { z } from "zod";
import { EvidenceId, JudgmentId, WindowId } from "./ids";

/**
 * 'uncertain' is a first-class value, and PROVIDER ERRORS ARE 'uncertain'.
 * Routing code coerces it with `asYes` (below): the single place where
 * "uncertain/error => treat as continue" is decided (flow B).
 */
export type Verdict = "yes" | "no" | "uncertain";
export const asYes = (v: Verdict): boolean => v === "yes";

/** One answered noul question: the raw probability stays attached to the verdict for inspection. */
export interface Answer {
  readonly verdict: Verdict;
  /** null when the call errored; never invented. */
  readonly probability: number | null;
}

/** Stamp that makes a judgment reusable only when the question wording, thresholds and model match. */
export interface JudgmentStamp {
  readonly questionSet: string; // providers/jev/questions.ts QUESTION_SET_VERSION
  readonly model: string;       // as returned by Jev ("jev-1.13.0"), not as requested
}

export interface BoundaryJudgment {
  readonly id: JudgmentId;
  readonly windowId: WindowId;
  /** exact inputs (flow/PRD: "inspectable Jev preprocessing inputs") */
  readonly input: { readonly context: readonly EvidenceId[]; readonly passage: readonly EvidenceId[]; readonly frames: readonly EvidenceId[] };
  readonly newConcept: Answer;
  readonly stoppingPoint: Answer;
  readonly stamp: JudgmentStamp;
  readonly cached: boolean;
}

export interface FrameChangeJudgment {
  readonly id: JudgmentId;
  readonly before: EvidenceId;
  readonly after: EvidenceId;
  readonly addsTeachingContent: Answer;
  readonly stamp: JudgmentStamp;
}

export interface ClaimCheckJudgment {
  readonly id: JudgmentId;
  readonly supported: Answer;
  readonly stamp: JudgmentStamp;
}

export const JudgmentKind = z.enum(["boundary", "frame_change", "claim_check"]);
export type JudgmentKind = z.infer<typeof JudgmentKind>;
