/**
 * Every Jev question in the product, in one versioned module (W5):
 *
 *   boundaryTask     flow B: new concept? + stopping point?  (one request, two questions)
 *   frameChangeTask  flow B: does the before→after change add teaching content?
 *   claimSupportTask flow C: does this evidence support the claim in its stated scope?
 *
 * Verdict mapping is the only place probabilities become yes/no/uncertain.
 * Errors never become "no": a throwing attempt is retried up to maxAttempts,
 * then the memo marks the key failed and the CALLER's derivation maps failed →
 * uncertain (boundary: continue; frame: keep; claim: revise/unverified).
 */
import { z } from "zod";
import type { BoundaryJudgment, BoundaryWindow, ClaimDraft, Frame, Passage, Verdict } from "../../shared/domain";
import { canonicalJson } from "../../shared/ids";
import type { IdPart } from "../../shared/ids";
import { ProviderError } from "./memo";
import type { Task, UsageReport } from "./memo";
import { imageFormat } from "./jev";
import type { JevAnswer, JevClient, JevImage, JevQuestion } from "./jev";

// The API rejects short ids: "jev-1.13" and "jev-1.14" are 400 "Unknown model"; "jev-1.13.0", "jev-1.14.0" and "jev-latest" work (checked 2026-11-03).
export const JEV_MODEL = "jev-1.13.0";

/** Starting values, tuned on held-out clips (flow B note). Part of every task's version. */
export const THRESHOLDS = { yesAtOrAbove: 0.7, noAtOrBelow: 0.3 } as const;

export function toVerdict(p: number | null): Verdict {
  if (p === null || !Number.isFinite(p)) return "uncertain";
  if (p >= THRESHOLDS.yesAtOrAbove) return "yes";
  if (p <= THRESHOLDS.noAtOrBelow) return "no";
  return "uncertain";
}

/**
 * All question wording. Bump a task's `version` when its text changes: the
 * version is part of the memo key, so old judgments stay readable and new
 * wording is never served from them.
 */
export const QUESTIONS = {
  boundary: {
    version: "1",
    newConcept:
      "Does state.passage begin a materially different concept from state.context? Answer no if it continues, elaborates, or gives an example of the same concept.",
    stoppingPoint:
      "Has the explanation in state.context reached a coherent stopping point before state.passage? Answer no if a step, example, or qualification is unfinished.",
  },
  frameChange: {
    version: "1",
    teachingChange:
      "Does the change from state.before to state.after add teaching content (a new written step, equation, diagram element, code edit, or slide)? Answer no for cursor, camera or presenter motion or duplicate content.",
  },
  claimSupport: {
    version: "1",
    supported:
      "Does state.evidence support state.claim within its stated scope? Treat state.assumptions as labelled assumptions, not as evidence. Answer no if the evidence contradicts the claim, does not address it, or supports only a narrower claim.",
  },
} as const;

/** Question wording as an input (experiment 6 arms). Omitted everywhere in the product, which uses QUESTIONS as written. */
export type BoundaryQuestions = { readonly newConcept: string; readonly stoppingPoint: string };
export type FrameChangeQuestions = { readonly teachingChange: string };

const sha16 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);

/**
 * The wording version of a task: the product's own wording keeps its version ("1"); any other wording is
 * `arm-<first 16 hex of sha256 of the wording text>`, so changed wording can never share a key with other wording.
 */
export function boundaryWordingVersion(q?: BoundaryQuestions): string {
  if (q === undefined || (q.newConcept === QUESTIONS.boundary.newConcept && q.stoppingPoint === QUESTIONS.boundary.stoppingPoint)) return QUESTIONS.boundary.version;
  return `arm-${sha16(canonicalJson({ newConcept: q.newConcept, stoppingPoint: q.stoppingPoint }))}`;
}
export function frameChangeWordingVersion(q?: FrameChangeQuestions): string {
  if (q === undefined || q.teachingChange === QUESTIONS.frameChange.teachingChange) return QUESTIONS.frameChange.version;
  return `arm-${sha16(canonicalJson({ teachingChange: q.teachingChange }))}`;
}

const MAX_ATTEMPTS = 3;
const thresholdTag = `${THRESHOLDS.yesAtOrAbove}/${THRESHOLDS.noAtOrBelow}`;
const versionOf = (wording: string) => `${wording}@${thresholdTag}`;

type FrameWithBytes = { readonly frame: Frame; readonly bytes: () => Uint8Array };

/** Inputs carry evidence CONTENT; canonicalInput hashes evidence IDs (content hashes) and never bytes. */
export type BoundaryInput = {
  readonly window: BoundaryWindow;
  readonly newPassages: readonly Passage[];
  readonly contextPassages: readonly Passage[];
  readonly frames: readonly FrameWithBytes[];
};

export type FrameChangeInput = {
  readonly before: FrameWithBytes | null; // null ⇒ first frame of the source: keep without a call
  readonly after: FrameWithBytes;
  readonly nearbyPassages: readonly Passage[]; // watched passages within ±15 s media
};

export type ClaimSupportInput = {
  readonly claim: ClaimDraft;
  readonly passages: readonly Passage[]; // exactly the cited passages
  readonly frames: readonly FrameWithBytes[]; // exactly the cited frames
};

const ids = (xs: readonly { readonly id: string }[]): IdPart => xs.map((x) => x.id);
const frameIds = (xs: readonly FrameWithBytes[]): IdPart => xs.map((f) => f.frame.id);

const timed = (p: Passage) => ({ t: Math.round(p.interval.start * 10) / 10, text: p.text });

function image(ref: string, f: FrameWithBytes): JevImage {
  const bytes = f.bytes();
  const format = imageFormat(bytes);
  if (format === null) throw new ProviderError(`frame ${f.frame.id} is neither JPEG nor PNG`, null, false);
  return { ref, format, bytes, width: f.frame.width, height: f.frame.height };
}

const noul = (instructions: string): JevQuestion => ({ type: "noul", instructions });

/** A question that did not come back as a probability is no information, never a "no". */
function probability(a: JevAnswer | undefined): number | null {
  return a?.type === "noul" && Number.isFinite(a.p) ? a.p : null;
}

const verdictSchema = z.enum(["yes", "no", "uncertain"]);
const probabilitySchema = z.number().min(0).max(1).nullable();

const boundaryOutputSchema = z.object({
  windowId: z.string(),
  newConcept: verdictSchema,
  stoppingPoint: verdictSchema,
  pNewConcept: probabilitySchema,
  pStoppingPoint: probabilitySchema,
  questionVersion: z.string(),
});

const claimOutputSchema = z.object({ verdict: verdictSchema, p: probabilitySchema });

/**
 * state = { context: [{t, text}], passage: [{t, text}], frames: ["frame_0", …] }
 * Both questions share one request, so the pair costs one round trip and one copy of the state.
 */
export function boundaryTask(jev: JevClient, questions?: BoundaryQuestions): Task<BoundaryInput, BoundaryJudgment> {
  const wording = `boundary.${boundaryWordingVersion(questions)}`;
  const text = questions ?? QUESTIONS.boundary;
  return {
    provider: "jev",
    purpose: "boundary",
    model: JEV_MODEL,
    version: versionOf(wording),
    maxAttempts: MAX_ATTEMPTS,
    canonicalInput: (i) => ({ window: i.window.id, new: ids(i.newPassages), context: ids(i.contextPassages), frames: frameIds(i.frames) }),
    async attempt(i, ctx) {
      const images = i.frames.map((f, n) => image(`frame_${n}`, f));
      const { answers, usage } = await jev.ask(
        {
          model: JEV_MODEL,
          state: { context: i.contextPassages.map(timed), passage: i.newPassages.map(timed), frames: images.map((m) => m.ref) },
          questions: {
            new_concept: noul(text.newConcept),
            stopping_point: noul(text.stoppingPoint),
          },
          images,
        },
        ctx.signal,
      );
      const pNewConcept = probability(answers.new_concept);
      const pStoppingPoint = probability(answers.stopping_point);
      return {
        output: {
          windowId: i.window.id,
          newConcept: toVerdict(pNewConcept),
          stoppingPoint: toVerdict(pStoppingPoint),
          pNewConcept,
          pStoppingPoint,
          questionVersion: wording,
        },
        usage,
      };
    },
    decode: (stored) => boundaryOutputSchema.parse(stored) as BoundaryJudgment,
  };
}

const NO_CALL: UsageReport = {
  model: JEV_MODEL,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: null,
  cost: { kind: "unknown", reason: "no provider call was made" },
};

/**
 * state = { before: "frame_before", after: "frame_after", captions: [{t,text}] }
 * Caller maps yes→kept, no→dropped, uncertain/failed→uncertain (kept): "Uncertain visual → keep the frame."
 * The first frame of a source has nothing to compare with and resolves to uncertain without a call.
 */
export function frameChangeTask(jev: JevClient, questions?: FrameChangeQuestions): Task<FrameChangeInput, Verdict> {
  const text = questions ?? QUESTIONS.frameChange;
  return {
    provider: "jev",
    purpose: "frame_change",
    model: JEV_MODEL,
    version: versionOf(`frame_change.${frameChangeWordingVersion(questions)}`),
    maxAttempts: MAX_ATTEMPTS,
    canonicalInput: (i) => ({ before: i.before?.frame.id ?? null, after: i.after.frame.id, nearby: ids(i.nearbyPassages) }),
    async attempt(i, ctx) {
      if (i.before === null) return { output: "uncertain", usage: NO_CALL };
      const images = [image("frame_before", i.before), image("frame_after", i.after)];
      const { answers, usage } = await jev.ask(
        {
          model: JEV_MODEL,
          state: { before: "frame_before", after: "frame_after", captions: i.nearbyPassages.map(timed) },
          questions: { teaching_change: noul(text.teachingChange) },
          images,
        },
        ctx.signal,
      );
      return { output: toVerdict(probability(answers.teaching_change)), usage };
    },
    decode: (stored) => verdictSchema.parse(stored),
  };
}

/**
 * R3: "A claim can be used to judge my answers only if it passed the evidence check."
 * state = { claim, assumptions, evidence: [{id, t, text}], frames: ["frame_0", …] }
 */
export function claimSupportTask(jev: JevClient): Task<ClaimSupportInput, { readonly verdict: Verdict; readonly p: number | null }> {
  return {
    provider: "jev",
    purpose: "claim_check",
    model: JEV_MODEL,
    version: versionOf(`claim_check.${QUESTIONS.claimSupport.version}`),
    maxAttempts: MAX_ATTEMPTS,
    canonicalInput: (i) => ({
      claim: { text: i.claim.text, evidence: i.claim.evidence, visualDependent: i.claim.visualDependent, assumptions: i.claim.assumptions },
      passages: ids(i.passages),
      frames: frameIds(i.frames),
    }),
    async attempt(i, ctx) {
      const images = i.frames.map((f, n) => image(`frame_${n}`, f));
      const { answers, usage } = await jev.ask(
        {
          model: JEV_MODEL,
          state: {
            claim: i.claim.text,
            assumptions: i.claim.assumptions,
            evidence: i.passages.map((p) => ({ id: p.id, ...timed(p) })),
            frames: images.map((m) => m.ref),
          },
          questions: { supported: noul(QUESTIONS.claimSupport.supported) },
          images,
        },
        ctx.signal,
      );
      const p = probability(answers.supported);
      return { output: { verdict: toVerdict(p), p }, usage };
    },
    decode: (stored) => claimOutputSchema.parse(stored),
  };
}
