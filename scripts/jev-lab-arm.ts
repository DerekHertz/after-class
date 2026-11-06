/**
 * Experiment 6, the lab side of an optimizer arm (docs/experiments/06-model-optimized-jev.md, decisions 4 and 5).
 *
 * An arm config is the ONLY thing an optimizer may change (decision 4): the wording of the three bool questions, the
 * Jev verdict thresholds and the segmentation defaults. It has exactly these keys, so a proposal that touches the model,
 * the routing table, the labels, the split, the scoring or the frame sampler is refused by shape, not by a list of bans.
 * Question types stay bool: there is no type field to change.
 *
 * This module has no file or network access and imports nothing from jev-lab.ts (which imports it).
 */
import { QUESTIONS } from "../src/backend/providers/jev-tasks";
import type { BoundaryQuestions, FrameChangeQuestions } from "../src/backend/providers/jev-tasks";
import type { SegmentationConfig } from "../src/backend/segmentation";
import type { Report, Thresholds } from "./jev-lab-score";

export const ARM_KIND = "jev-arm-config";
export const MAX_WORDING_CHARS = 600;
export const ARM_NAME = /^[A-Za-z0-9-]+$/;

export type ArmQuestions = { readonly newConcept: string; readonly stoppingPoint: string; readonly teachingChange: string };

export type ArmConfig = {
  readonly schemaVersion: 1;
  readonly kind: typeof ARM_KIND;
  readonly questions: ArmQuestions;
  readonly thresholds: Thresholds;
  readonly segmentation: SegmentationConfig;
};

/** The product's wording, as the baseline arm and the starting point of every arm. */
export const PRODUCT_QUESTIONS: ArmQuestions = {
  newConcept: QUESTIONS.boundary.newConcept,
  stoppingPoint: QUESTIONS.boundary.stoppingPoint,
  teachingChange: QUESTIONS.frameChange.teachingChange,
};

export const isProductWording = (q: ArmQuestions): boolean =>
  q.newConcept === PRODUCT_QUESTIONS.newConcept && q.stoppingPoint === PRODUCT_QUESTIONS.stoppingPoint && q.teachingChange === PRODUCT_QUESTIONS.teachingChange;

export const boundaryQuestionsOf = (q: ArmQuestions): BoundaryQuestions => ({ newConcept: q.newConcept, stoppingPoint: q.stoppingPoint });
export const frameQuestionsOf = (q: ArmQuestions): FrameChangeQuestions => ({ teachingChange: q.teachingChange });

/** The numeric ranges `resolveTuning` enforces (jev-lab.ts uses these same predicates). */
export const segmentationInRange = (c: SegmentationConfig): boolean =>
  c.windowNewS > 0 && c.contextS >= 0 && c.timeCapS > c.windowNewS && Number.isInteger(c.maxFramesPerWindow) && c.maxFramesPerWindow >= 0 && c.maxFramesPerWindow <= 4;
export const thresholdsInRange = (t: Thresholds): boolean => t.noAtOrBelow >= 0 && t.noAtOrBelow < t.yesAtOrAbove && t.yesAtOrAbove <= 1;

const TOP_KEYS = ["schemaVersion", "kind", "questions", "thresholds", "segmentation"] as const;
const QUESTION_KEYS = ["newConcept", "stoppingPoint", "teachingChange"] as const;
const THRESHOLD_KEYS = ["yesAtOrAbove", "noAtOrBelow"] as const;
const SEGMENTATION_KEYS = ["windowNewS", "contextS", "timeCapS", "maxFramesPerWindow", "reviseOnNextNoNo"] as const;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export type ArmResult = { readonly ok: true; readonly config: ArmConfig } | { readonly ok: false; readonly errors: readonly string[] };

export function validateArmConfig(x: unknown): ArmResult {
  if (!isObject(x)) return { ok: false, errors: ["an arm config must be a JSON object"] };
  const errors: string[] = [];
  const exact = (where: string, o: Record<string, unknown>, keys: readonly string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${where}${k} is not allowed: an optimizer may change only the three question wordings, the thresholds and the segmentation (decision 4)`);
    for (const k of keys) if (!(k in o)) errors.push(`${where}${k} is missing`);
  };
  exact("", x, TOP_KEYS);
  if (x.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (x.kind !== ARM_KIND) errors.push(`kind must be "${ARM_KIND}"`);

  const q = x.questions;
  if (!isObject(q)) errors.push("questions must be an object");
  else {
    exact("questions.", q, QUESTION_KEYS);
    for (const k of QUESTION_KEYS) {
      const v = q[k];
      if (k in q && (typeof v !== "string" || v.trim() === "")) errors.push(`questions.${k} must be a non-empty string`);
      else if (typeof v === "string" && v.length > MAX_WORDING_CHARS) errors.push(`questions.${k} is ${v.length} characters; at most ${MAX_WORDING_CHARS}`);
    }
  }

  const t = x.thresholds;
  if (!isObject(t)) errors.push("thresholds must be an object");
  else {
    exact("thresholds.", t, THRESHOLD_KEYS);
    for (const k of THRESHOLD_KEYS) if (k in t && !isNum(t[k])) errors.push(`thresholds.${k} must be a number`);
    if (isNum(t.yesAtOrAbove) && isNum(t.noAtOrBelow) && !thresholdsInRange({ yesAtOrAbove: t.yesAtOrAbove, noAtOrBelow: t.noAtOrBelow })) errors.push("thresholds out of range: 0 <= noAtOrBelow < yesAtOrAbove <= 1");
  }

  const s = x.segmentation;
  if (!isObject(s)) errors.push("segmentation must be an object");
  else {
    exact("segmentation.", s, SEGMENTATION_KEYS);
    for (const k of SEGMENTATION_KEYS.filter((k) => k !== "reviseOnNextNoNo")) if (k in s && !isNum(s[k])) errors.push(`segmentation.${k} must be a number`);
    if ("reviseOnNextNoNo" in s && typeof s.reviseOnNextNoNo !== "boolean") errors.push("segmentation.reviseOnNextNoNo must be true or false");
    if (SEGMENTATION_KEYS.every((k) => (k === "reviseOnNextNoNo" ? typeof s[k] === "boolean" : isNum(s[k]))) && !segmentationInRange(s as unknown as SegmentationConfig)) {
      errors.push("segmentation out of range: windowNewS > 0, contextS >= 0, timeCapS > windowNewS, maxFramesPerWindow an integer 0 to 4");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const qs = q as Record<string, string>;
  const ts = t as Record<string, number>;
  const sg = s as Record<string, number | boolean>;
  return {
    ok: true,
    config: {
      schemaVersion: 1,
      kind: ARM_KIND,
      questions: { newConcept: qs.newConcept!, stoppingPoint: qs.stoppingPoint!, teachingChange: qs.teachingChange! },
      thresholds: { yesAtOrAbove: ts.yesAtOrAbove!, noAtOrBelow: ts.noAtOrBelow! },
      segmentation: { windowNewS: sg.windowNewS as number, contextS: sg.contextS as number, timeCapS: sg.timeCapS as number, maxFramesPerWindow: sg.maxFramesPerWindow as number, reviseOnNextNoNo: sg.reviseOnNextNoNo as boolean },
    },
  };
}

/** The starting config: experiment 2's final state (its last tune round's thresholds and segmentation) with the product wording. */
export function armConfigFromBaseline(lastTune: { readonly config: SegmentationConfig; readonly thresholds: Thresholds }): ArmConfig {
  const c = lastTune.config;
  return {
    schemaVersion: 1,
    kind: ARM_KIND,
    questions: { ...PRODUCT_QUESTIONS },
    thresholds: { yesAtOrAbove: lastTune.thresholds.yesAtOrAbove, noAtOrBelow: lastTune.thresholds.noAtOrBelow },
    segmentation: { windowNewS: c.windowNewS, contextS: c.contextS, timeCapS: c.timeCapS, maxFramesPerWindow: c.maxFramesPerWindow, reviseOnNextNoNo: c.reviseOnNextNoNo },
  };
}

// ───────────────────────────── round selection (decision 5) ─────────────────────────────

export type RoundReport = { readonly round: number; readonly report: Report };
export type Selection = { readonly round: number; readonly reason: string };

const passes = (r: Report) => r.bars.filter((b) => b.verdict === "PASS").length;
const recallOf = (r: Report) => (r.metrics.recallLabeled === 0 ? -1 : r.metrics.recallMatched / r.metrics.recallLabeled);
const closesOf = (r: Report) => r.metrics.falseCloses ?? Number.POSITIVE_INFINITY;

/**
 * Decision 5: among an arm's tune rounds (first-half reports only), the round that passes the most of the four bar
 * clauses; ties go to the higher boundary recall, then fewer false closes, then the earlier round. Pure: it reads
 * nothing but the reports it is given, so the held-out half cannot influence it.
 */
export function selectRound(reports: readonly RoundReport[]): Selection {
  if (reports.length === 0) throw new Error("selectRound needs at least one tune round");
  const sorted = [...reports].sort((a, b) => a.round - b.round);
  const better = (a: RoundReport, b: RoundReport) => {
    const d = passes(b.report) - passes(a.report) || recallOf(b.report) - recallOf(a.report) || closesOf(a.report) - closesOf(b.report);
    return d !== 0 && !Number.isNaN(d) ? d : a.round - b.round;
  };
  const ranked = [...sorted].sort(better);
  const best = ranked[0]!;
  const second = ranked[1];
  const cell = (r: RoundReport) => {
    const m = r.report.metrics;
    return `round ${r.round}: ${passes(r.report)} of 4 clauses pass, recall ${m.recallLabeled === 0 ? "not measured" : `${m.recallMatched}/${m.recallLabeled}`}, false closes ${m.falseCloses ?? "not measured"}`;
  };
  let decided = "only round";
  if (second !== undefined) {
    decided =
      passes(best.report) !== passes(second.report) ? "most clauses passed"
      : recallOf(best.report) !== recallOf(second.report) ? "tie on clauses passed, higher boundary recall"
      : closesOf(best.report) !== closesOf(second.report) ? "tie on clauses passed and recall, fewer false closes"
      : "tie on clauses passed, recall and false closes, earlier round";
  }
  return { round: best.round, reason: `${decided}; compared on first-half reports: ${sorted.map(cell).join("; ")}` };
}
