/**
 * Experiment 2, the Jev boundary and visual lab: label format, split rule, stored-judgment format and scoring.
 * Pure: no file, network or clock access, so everything here is a function of its arguments. The protocol that
 * defines every measurement is docs/experiments/02-jev-lab.md; the numbers below are the ones it names.
 *
 * The four clauses are fixed (docs/flows/after-class.md, "Experiments and pass bars"):
 *   "≥70% of labeled boundaries detected within ±60s; ≤1 false close per 15 min; ≤1 important visual step lost per
 *   lecture; ≥50% duplicates dropped."
 * Budget: "~2400 Jev calls (Amendment 3; ~800 until then), max 3 tuning rounds, tune on first halves, score once on held-out second halves".
 */
import type { BoundaryWindow, ChunkProvenance, Verdict } from "../src/shared/domain";
import type { CaptureId, EvidenceId, WindowId } from "../src/shared/ids";
import { Material } from "../src/shared/time";
import { THRESHOLDS } from "../src/backend/providers/jev-tasks";
import type { SegmentationConfig } from "../src/backend/segmentation";
import { planChunks } from "../src/backend/segmentation";
import type { ArmQuestions } from "./jev-lab-arm";

export type Origin = "fixture" | "live";
export type Phase = "tune" | "score";
export type Half = "first" | "second";
export type BarVerdict = "PASS" | "FAIL" | "NOT MEASURED";

// ───────────────────────────── fixed by the bar text and the budget ─────────────────────────────

export const BAR_RECALL = "≥70% of labeled boundaries detected within ±60s";
export const BAR_FALSE_CLOSES = "≤1 false close per 15 min";
export const BAR_VISUAL_STEPS = "≤1 important visual step lost per lecture";
export const BAR_DUPLICATES = "≥50% duplicates dropped";
export const BUDGET_TEXT = "~2400 Jev calls (Amendment 3; ~800 until then), max 3 tuning rounds, tune on first halves, score once on held-out second halves";

export const TOLERANCE_S = 60;
export const RECALL_MIN = 0.7;
export const FALSE_CLOSE_WINDOW_S = 15 * 60;
export const FALSE_CLOSES_MAX_PER_WINDOW = 1;
export const STEPS_LOST_MAX_PER_LECTURE = 1;
export const DUPLICATES_DROPPED_MIN = 0.5;
export const MAX_TUNE_ROUNDS = 3;
/** A hard ceiling that includes retries. 800 until experiment 2 Amendment 3 (Derek, 2026-11-05), which sets 2400 for the 43-clip set. */
export const BUDGET_CALLS = 2400;

// ───────────────────────────── PROPOSED definitions (docs/experiments/02-jev-lab.md, "Decisions for Derek") ─────────────────────────────
// Each is a one-line edit after Derek's OK. None is tuned afterwards.

/** A labeled visual step at media time s is shown by the candidate frames in [s, s + this) of its own half. */
export const PROPOSED_STEP_CATCH_S = 30;
/** A duplicate label with no frame id resolves to the nearest candidate frame within this many seconds. */
export const PROPOSED_DUPLICATE_MATCH_S = 2;
/** Float slack for the inclusive ±60 s test; media times are decimal seconds. */
const EPS = 1e-9;

// ───────────────────────────── labels ─────────────────────────────

export type LabelItem = { readonly mediaS: number; readonly note: string; readonly confirmed: boolean; readonly cue?: string };
export type DuplicateMember = { readonly mediaS: number; readonly frameId?: string; readonly videoId?: string };
export type DuplicateGroup = { readonly note: string; readonly confirmed: boolean; readonly cue?: string; readonly frames: readonly DuplicateMember[] };
export type SpanS = { readonly start: number; readonly end: number };

/** Schema 1: a lecture is one video. Still fully supported: it is a lecture of one video. */
export type LabelFile = {
  readonly schemaVersion: 1;
  readonly status: "draft" | "signed_off";
  readonly signedOffBy: string | null;
  readonly signedOffAt: string | null;
  readonly description?: string;
  readonly draftNote?: string;
  readonly lecture: { readonly captureId: string; readonly videoId: string; readonly title?: string; readonly spanS: SpanS };
  readonly boundaries: readonly LabelItem[];
  readonly visualSteps: readonly LabelItem[];
  readonly duplicateGroups: readonly DuplicateGroup[];
};

/** Schema 2 (Amendment 1): a lecture is the set of clips of one capture, in watch order. Every time is (videoId, mediaS). */
export type LabelFileV2 = {
  readonly schemaVersion: 2;
  readonly status: "draft" | "signed_off";
  readonly signedOffBy: string | null;
  readonly signedOffAt: string | null;
  readonly description?: string;
  readonly draftNote?: string;
  readonly lecture: { readonly captureId: string; readonly videos: readonly { readonly videoId: string; readonly title?: string; readonly spanS: SpanS }[] };
  readonly boundaries: readonly (LabelItem & { readonly videoId: string })[];
  readonly visualSteps: readonly (LabelItem & { readonly videoId: string })[];
  readonly duplicateGroups: readonly (Omit<DuplicateGroup, "frames"> & { readonly frames: readonly (DuplicateMember & { readonly videoId: string })[] })[];
};

export type AnyLabelFile = LabelFile | LabelFileV2;

export type LabelResult = { readonly ok: true; readonly labels: AnyLabelFile } | { readonly ok: false; readonly errors: readonly string[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isText = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

/** Every problem at once, each naming the field, so Derek can fix a label file in one pass. A misspelled key is an error, never ignored. */
export function validateLabels(input: unknown): LabelResult {
  const errors: string[] = [];
  const err = (path: string, msg: string) => void errors.push(`${path}: ${msg}`);
  const unknownKeys = (path: string, o: Record<string, unknown>, allowed: readonly string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  };

  if (!isObj(input)) return { ok: false, errors: ["labels: expected a JSON object"] };
  unknownKeys("labels", input, ["schemaVersion", "status", "signedOffBy", "signedOffAt", "description", "draftNote", "lecture", "boundaries", "visualSteps", "duplicateGroups"]);
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) err("schemaVersion", `expected 1 or 2, got ${JSON.stringify(input.schemaVersion)}`);
  const v2 = input.schemaVersion === 2;
  const status = input.status;
  if (status !== "draft" && status !== "signed_off") err("status", `expected "draft" or "signed_off", got ${JSON.stringify(status)}`);
  if (input.description !== undefined && typeof input.description !== "string") err("description", "expected a string");
  if (input.draftNote !== undefined && typeof input.draftNote !== "string") err("draftNote", "expected a string");

  if (status === "signed_off") {
    if (!isText(input.signedOffBy)) err("signedOffBy", "a signed_off file needs the name of the person who signed it off");
    if (!isText(input.signedOffAt) || !/^\d{4}-\d{2}-\d{2}/.test(input.signedOffAt) || Number.isNaN(Date.parse(input.signedOffAt))) err("signedOffAt", "a signed_off file needs an ISO date such as 2026-11-05");
  } else if (status === "draft") {
    if (input.signedOffBy !== null) err("signedOffBy", `a draft must have null here, got ${JSON.stringify(input.signedOffBy)}`);
    if (input.signedOffAt !== null) err("signedOffAt", `a draft must have null here, got ${JSON.stringify(input.signedOffAt)}`);
  }

  // Schema 1 has one span; schema 2 has one span per video, keyed by videoId.
  let span: SpanS | null = null;
  const spans = new Map<string, SpanS>();
  const spanOk = (path: string, s: unknown): SpanS | null => {
    if (!isObj(s) || !isNum(s.start) || !isNum(s.end) || s.start < 0 || !(s.end > s.start)) {
      err(path, "expected {start, end} in media seconds with 0 <= start < end");
      return null;
    }
    return { start: s.start, end: s.end };
  };
  const lecture = input.lecture;
  if (!isObj(lecture)) err("lecture", "expected an object");
  else if (v2) {
    unknownKeys("lecture", lecture, ["captureId", "videos"]);
    if (!isText(lecture.captureId)) err("lecture.captureId", "expected a non-empty string");
    if (!Array.isArray(lecture.videos) || lecture.videos.length === 0) err("lecture.videos", "expected a non-empty array: the clips of the capture in watch order");
    else {
      lecture.videos.forEach((v: unknown, i) => {
        const path = `lecture.videos[${i}]`;
        if (!isObj(v)) return err(path, "expected an object");
        unknownKeys(path, v, ["videoId", "title", "spanS"]);
        if (!isText(v.videoId)) err(`${path}.videoId`, "expected a non-empty string");
        else if (spans.has(v.videoId)) err(`${path}.videoId`, `${v.videoId} is listed twice; each clip appears once, in watch order`);
        if (v.title !== undefined && typeof v.title !== "string") err(`${path}.title`, "expected a string");
        const sp = spanOk(`${path}.spanS`, v.spanS);
        if (sp !== null && isText(v.videoId) && !spans.has(v.videoId)) spans.set(v.videoId, sp);
      });
    }
  } else {
    unknownKeys("lecture", lecture, ["captureId", "videoId", "title", "spanS"]);
    if (!isText(lecture.captureId)) err("lecture.captureId", "expected a non-empty string");
    if (!isText(lecture.videoId)) err("lecture.videoId", "expected a non-empty string");
    if (lecture.title !== undefined && typeof lecture.title !== "string") err("lecture.title", "expected a string");
    span = spanOk("lecture.spanS", lecture.spanS);
  }

  /** Schema 2 times are checked against the span of the item's own video. */
  const checkTime = (path: string, t: unknown, o: Record<string, unknown>) => {
    let within: SpanS | null = span;
    let label = "the lecture span";
    if (v2) {
      if (!isText(o.videoId)) err(`${path}.videoId`, "expected the id of one of lecture.videos");
      else if (!spans.has(o.videoId)) err(`${path}.videoId`, `${o.videoId} is not one of lecture.videos (${[...spans.keys()].join(", ")})`);
      within = isText(o.videoId) ? (spans.get(o.videoId) ?? null) : null;
      label = `the span of video ${String(o.videoId)}`;
    }
    if (!isNum(t) || t < 0) err(`${path}.mediaS`, `expected media seconds >= 0, got ${JSON.stringify(t)}`);
    else if (within !== null && (t < within.start || t >= within.end)) err(`${path}.mediaS`, `${t} lies outside ${label} [${within.start}, ${within.end}) (the span is half-open)`);
  };
  const checkCommon = (path: string, o: Record<string, unknown>) => {
    if (typeof o.note !== "string") err(`${path}.note`, "expected a string (it may be empty)");
    if (typeof o.confirmed !== "boolean") err(`${path}.confirmed`, "expected true or false");
    else if (!o.confirmed && status === "signed_off") err(`${path}.confirmed`, "unconfirmed in a signed_off file; confirm it or delete it before signing off");
    if (o.cue !== undefined && typeof o.cue !== "string") err(`${path}.cue`, "expected a string");
  };
  const items = (name: "boundaries" | "visualSteps") => {
    const list = input[name];
    if (!Array.isArray(list)) return err(name, "expected an array (it may be empty)");
    list.forEach((it: unknown, i) => {
      const path = `${name}[${i}]`;
      if (!isObj(it)) return err(path, "expected an object");
      unknownKeys(path, it, v2 ? ["videoId", "mediaS", "note", "confirmed", "cue"] : ["mediaS", "note", "confirmed", "cue"]);
      checkTime(path, it.mediaS, it);
      checkCommon(path, it);
    });
  };
  items("boundaries");
  items("visualSteps");

  const groups = input.duplicateGroups;
  if (!Array.isArray(groups)) err("duplicateGroups", "expected an array (it may be empty)");
  else {
    groups.forEach((g: unknown, i) => {
      const path = `duplicateGroups[${i}]`;
      if (!isObj(g)) return err(path, "expected an object");
      unknownKeys(path, g, ["note", "confirmed", "cue", "frames"]);
      checkCommon(path, g);
      if (!Array.isArray(g.frames) || g.frames.length < 2) return err(`${path}.frames`, "expected at least 2 frames: a group of one has no duplicate");
      g.frames.forEach((f: unknown, k) => {
        const fp = `${path}.frames[${k}]`;
        if (!isObj(f)) return err(fp, "expected an object");
        unknownKeys(fp, f, v2 ? ["videoId", "mediaS", "frameId"] : ["mediaS", "frameId"]);
        checkTime(fp, f.mediaS, f);
        if (f.frameId !== undefined && !isText(f.frameId)) err(`${fp}.frameId`, "expected a non-empty string when present");
      });
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, labels: input as unknown as AnyLabelFile };
}

// ───────────────────────────── the split ─────────────────────────────

/** First half is [span.start, T), second half is [T, span.end), with T the midpoint of the lecture span. A label at exactly T is in the second half. */
export const splitPoint = (span: SpanS): number => span.start + (span.end - span.start) / 2;

export function halfOf(timeS: number, span: SpanS): Half | null {
  if (timeS < span.start || timeS >= span.end) return null;
  return timeS < splitPoint(span) ? "first" : "second";
}

export const halfRange = (span: SpanS, half: Half): SpanS => (half === "first" ? { start: span.start, end: splitPoint(span) } : { start: splitPoint(span), end: span.end });

// ───────────────────────────── a lecture as a set of clips (Amendment 1) ─────────────────────────────

/** A position in a lecture: media seconds of one clip. Distance across clips is undefined. */
export type Place = { readonly videoId: string; readonly mediaS: number };

export type Clip = { readonly videoId: string; readonly spanS: SpanS; readonly watchedS: number };

/** Amendment 1, PROPOSED: the id of a lecture. One video keeps the schema 1 id, so a one-video lecture is the same lecture in either schema. */
export function lectureIdOfLabels(labels: AnyLabelFile): string {
  if (labels.schemaVersion === 1) return `${labels.lecture.captureId}/${labels.lecture.videoId}`;
  const [first, ...rest] = labels.lecture.videos;
  return rest.length === 0 ? `${labels.lecture.captureId}/${first!.videoId}` : `${labels.lecture.captureId}/set:${first!.videoId}+${rest.length}`;
}

/** Labels and clips in one shape for both schemas. A schema 1 file is a lecture of one video. */
export type LabelView = {
  readonly captureId: string;
  readonly clips: readonly { readonly videoId: string; readonly title?: string; readonly spanS: SpanS }[];
  readonly boundaries: readonly (LabelItem & { readonly videoId: string })[];
  readonly visualSteps: readonly (LabelItem & { readonly videoId: string })[];
  readonly duplicateGroups: readonly (Omit<DuplicateGroup, "frames"> & { readonly frames: readonly (DuplicateMember & { readonly videoId: string })[] })[];
};

export function viewOf(labels: AnyLabelFile): LabelView {
  if (labels.schemaVersion === 2) return { captureId: labels.lecture.captureId, clips: labels.lecture.videos, boundaries: labels.boundaries, visualSteps: labels.visualSteps, duplicateGroups: labels.duplicateGroups };
  const { captureId, videoId, title, spanS } = labels.lecture;
  const at = <T extends object>(x: T) => ({ ...x, videoId });
  return {
    captureId,
    clips: [{ videoId, ...(title !== undefined ? { title } : {}), spanS }],
    boundaries: labels.boundaries.map(at),
    visualSteps: labels.visualSteps.map(at),
    duplicateGroups: labels.duplicateGroups.map((g) => ({ ...g, frames: g.frames.map(at) })),
  };
}

/**
 * The tune and held-out split of one lecture.
 * One clip: the schema 1 rule, the midpoint of the span (adopted definition 9).
 * Two or more clips (Amendment 1, replaces definition 9 for sets): the clip JOIN nearest the midpoint of the total
 * watched time, in watch order, ties to the earlier join. The clips before it are the tune half, the clips after it the
 * held-out half; no clip is cut.
 */
export type Splitter = {
  readonly kind: "midpoint" | "join";
  /** Index of the first clip of the held-out half; 0 for a midpoint split (nothing is a join). */
  readonly joinIndex: number;
  /** For a join split: total watched seconds, their midpoint, and the watched seconds before and after the join. */
  readonly totalS: number;
  readonly midpointS: number;
  readonly beforeS: number;
  readonly afterS: number;
  readonly clips: readonly Clip[];
  halfOf(videoId: string, mediaS: number): Half | null;
  /** The part of this clip that belongs to `half`, or null when the clip is wholly in the other half. */
  rangeOf(videoId: string, half: Half): SpanS | null;
  clipsIn(half: Half): readonly Clip[];
};

export function makeSplitter(clips: readonly Clip[]): Splitter {
  if (clips.length === 0) throw new RangeError("a lecture has at least one clip");
  const index = new Map(clips.map((c, i) => [c.videoId, i] as const));
  if (clips.length === 1) {
    const only = clips[0]!;
    return {
      kind: "midpoint", joinIndex: 0, totalS: only.watchedS, midpointS: splitPoint(only.spanS), beforeS: 0, afterS: 0, clips,
      halfOf: (v, t) => (v === only.videoId ? halfOf(t, only.spanS) : null),
      rangeOf: (v, h) => (v === only.videoId ? halfRange(only.spanS, h) : null),
      clipsIn: () => [only],
    };
  }
  const total = clips.reduce((a, c) => a + c.watchedS, 0);
  const mid = total / 2;
  let joinIndex = 1;
  let best = Number.POSITIVE_INFINITY;
  let before = 0;
  let cumulative = 0;
  for (let j = 1; j < clips.length; j++) {
    cumulative += clips[j - 1]!.watchedS;
    const d = Math.abs(cumulative - mid);
    if (d < best - EPS) {
      best = d;
      joinIndex = j;
      before = cumulative;
    }
  }
  const halfOfClip = (v: string): Half | null => {
    const i = index.get(v);
    return i === undefined ? null : i < joinIndex ? "first" : "second";
  };
  const clipOf = (v: string) => clips[index.get(v) ?? -1];
  return {
    kind: "join", joinIndex, totalS: total, midpointS: mid, beforeS: before, afterS: total - before, clips,
    halfOf: (v, t) => {
      const c = clipOf(v);
      return c === undefined || t < c.spanS.start || t >= c.spanS.end ? null : halfOfClip(v);
    },
    rangeOf: (v, h) => (halfOfClip(v) === h ? clipOf(v)!.spanS : null),
    clipsIn: (h) => clips.filter((c) => halfOfClip(c.videoId) === h),
  };
}

// ───────────────────────────── verdicts from stored probabilities ─────────────────────────────

export type Thresholds = { readonly yesAtOrAbove: number; readonly noAtOrBelow: number };
export const DEFAULT_THRESHOLDS: Thresholds = { yesAtOrAbove: THRESHOLDS.yesAtOrAbove, noAtOrBelow: THRESHOLDS.noAtOrBelow };

/** The product's toVerdict with the thresholds as a parameter; a test pins it to the product at the defaults. */
export function verdictAt(p: number | null, t: Thresholds): Verdict {
  if (p === null || !Number.isFinite(p)) return "uncertain";
  if (p >= t.yesAtOrAbove) return "yes";
  if (p <= t.noAtOrBelow) return "no";
  return "uncertain";
}

// ───────────────────────────── matching ─────────────────────────────

export type Matching = {
  readonly pairs: readonly (readonly [label: number, detection: number])[];
  readonly missedLabels: readonly number[];
  readonly falseCloses: readonly number[];
};

/**
 * One-to-one: each label takes at most one detection and each detection serves at most one label, so a second close
 * beside a matched label is a false close. Inclusive: |detection - label| of exactly `tolS` matches. The sweep is
 * optimal for equal tolerances on one line (it takes the earliest usable detection for the earliest label).
 */
export function matchBoundaries(labels: readonly number[], detections: readonly number[], tolS = TOLERANCE_S): Matching {
  const L = [...labels].sort((a, b) => a - b);
  const D = [...detections].sort((a, b) => a - b);
  const used = new Set<number>();
  const pairs: [number, number][] = [];
  const missedLabels: number[] = [];
  let j = 0;
  for (const l of L) {
    while (j < D.length && D[j]! < l - tolS - EPS) j++;
    if (j < D.length && D[j]! <= l + tolS + EPS) {
      pairs.push([l, D[j]!]);
      used.add(j);
      j++;
    } else missedLabels.push(l);
  }
  return { pairs, missedLabels, falseCloses: D.filter((_, i) => !used.has(i)) };
}

export type PlacedMatching = {
  readonly pairs: readonly (readonly [label: Place, detection: Place])[];
  readonly missedLabels: readonly Place[];
  readonly falseCloses: readonly Place[];
};

/**
 * Amendment 1: the same one-to-one, inclusive +-60 s matching, run separately inside each clip. A label and a detection
 * in different clips never match: the distance between them is undefined. Outputs are in watch order, then by time.
 */
export function matchPlaced(labels: readonly Place[], detections: readonly Place[], clipOrder: readonly string[], tolS = TOLERANCE_S): PlacedMatching {
  const pairs: [Place, Place][] = [];
  const missedLabels: Place[] = [];
  const falseCloses: Place[] = [];
  const videos = [...new Set([...clipOrder, ...labels.map((l) => l.videoId), ...detections.map((d) => d.videoId)])];
  for (const videoId of videos) {
    const m = matchBoundaries(labels.filter((l) => l.videoId === videoId).map((l) => l.mediaS), detections.filter((d) => d.videoId === videoId).map((d) => d.mediaS), tolS);
    const at = (mediaS: number): Place => ({ videoId, mediaS });
    pairs.push(...m.pairs.map(([l, d]): [Place, Place] => [at(l), at(d)]));
    missedLabels.push(...m.missedLabels.map(at));
    falseCloses.push(...m.falseCloses.map(at));
  }
  return { pairs, missedLabels, falseCloses };
}

export function falseClosesPerWindow(falseCloses: number, watchedS: number): { readonly rate: number | null; readonly pass: boolean | null } {
  if (!(watchedS > 0)) return { rate: null, pass: null };
  return { rate: (falseCloses * FALSE_CLOSE_WINDOW_S) / watchedS, pass: falseCloses * FALSE_CLOSE_WINDOW_S <= FALSE_CLOSES_MAX_PER_WINDOW * watchedS + EPS };
}

/** Nearest rank: the value at ceil(p/100 * n) in ascending order. Report only; no target exists. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

// ───────────────────────────── stored results (JSONL) ─────────────────────────────

export type WindowRecord = {
  readonly id: string;
  readonly captureId: string;
  readonly ordinal: number;
  readonly startS: number;
  readonly endS: number;
  readonly newPassages: readonly string[];
  readonly contextPassages: readonly string[];
  readonly frames: readonly string[];
  readonly newMaterial: readonly (readonly [string, readonly (readonly [number, number])[]])[];
  readonly watchedSecondsAtEnd: number;
  /**
   * Amendment 1: the clip this window belongs to, and `startS`/`endS` are in that clip. A window whose new material spans a
   * clip join belongs to the clip where its new material ends (PROPOSED). Absent in records written before the amendment.
   */
  readonly videoId?: string;
};
export type FrameRecord = { readonly id: string; readonly mediaS: number; readonly hasBefore: boolean; readonly videoId?: string };

type LectureCommon = {
  readonly t: "lecture";
  readonly lectureId: string;
  readonly labelsFile: string;
  readonly labelsSha256: string;
  readonly captureId: string;
  readonly captureStopped: boolean;
  readonly half: Half;
  readonly windows: readonly WindowRecord[];
  readonly frames: readonly FrameRecord[];
};
export type ClipRecord = { readonly videoId: string; readonly sourceId: string; readonly spanS: SpanS; readonly watched: readonly (readonly [number, number])[] };

/** One video: the record as written before Amendment 1, so old results still parse and score the same. */
export type LectureRecordV1 = LectureCommon & {
  readonly videoId: string;
  readonly sourceId: string;
  readonly spanS: SpanS;
  readonly watched: readonly (readonly [number, number])[];
};
/** A set of clips in watch order. Windows and frames are those of the scored half only; the clips are all of them, so the split can be recomputed. */
export type LectureRecordSet = LectureCommon & { readonly clips: readonly ClipRecord[] };
export type LectureRecord = LectureRecordV1 | LectureRecordSet;

export const clipsOf = (l: LectureRecord): readonly ClipRecord[] => ("clips" in l ? l.clips : [{ videoId: l.videoId, sourceId: l.sourceId, spanS: l.spanS, watched: l.watched }]);

export const watchedIn = (watched: readonly (readonly [number, number])[], range: SpanS): number => {
  let sum = 0;
  for (const [a, b] of watched) sum += Math.max(0, Math.min(b, range.end) - Math.max(a, range.start));
  return sum;
};

/** The split of a stored lecture, recomputed from its clips: the same function the run used. */
export const splitterOf = (l: LectureRecord): Splitter => makeSplitter(clipsOf(l).map((c) => ({ videoId: c.videoId, spanS: c.spanS, watchedS: watchedIn(c.watched, c.spanS) })));

export type CallRecord = { readonly startedAtMs: number; readonly durationMs: number; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly ok: boolean };

export type JudgmentRecord = {
  readonly t: "judgment";
  readonly lectureId: string;
  /** The clip the window or frame belongs to (Amendment 1). */
  readonly videoId?: string;
  readonly purpose: "boundary" | "frame_change";
  readonly subject: string;
  readonly key: string;
  readonly model: string;
  readonly questionVersion: string;
  readonly reused: boolean;
  readonly calls: readonly CallRecord[];
  readonly p: Readonly<Record<string, number | null>>;
  readonly error: string | null;
};

/** Experiment 6 only: present when a run is an optimizer arm's. Experiment 2's header has none of these keys. */
export type ArmInfo = {
  readonly arm?: string;
  /** Present only when the question wording differs from the product's. */
  readonly questions?: ArmQuestions;
  /** A scored arm run: which tune round it used and why (decision 5). */
  readonly selectedRound?: number;
  readonly selectionReason?: string;
};

export type RunHeader = ArmInfo & {
  readonly t: "header";
  readonly version: 1;
  readonly runId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly origin: Origin;
  readonly model: string;
  readonly config: SegmentationConfig;
  readonly thresholds: Thresholds;
};
export type RunEnd = { readonly t: "end"; readonly newCalls: number; readonly judgments: number };

export type ParsedResults = { readonly header: RunHeader; readonly lectures: readonly LectureRecord[]; readonly judgments: readonly JudgmentRecord[]; readonly end: RunEnd };

export const serializeResults = (r: ParsedResults): string => [r.header, ...r.lectures, ...r.judgments, r.end].map((x) => JSON.stringify(x)).join("\n") + "\n";

/** Refuses a file that is not a complete run, so a partial run can never be read as a result. */
export function parseResults(text: string): ParsedResults {
  const rows = text.split("\n").filter((l) => l.trim() !== "").map((l, i) => {
    try {
      return JSON.parse(l) as { t?: string };
    } catch {
      throw new Error(`results line ${i + 1} is not JSON`);
    }
  });
  const header = rows[0] as RunHeader | undefined;
  if (header?.t !== "header" || header.version !== 1) throw new Error("results file does not start with a version 1 header");
  const end = rows[rows.length - 1] as RunEnd | undefined;
  if (end?.t !== "end") throw new Error("results file has no end record: the run did not complete, so it is not a result");
  const lectures = rows.filter((r): r is LectureRecord => r.t === "lecture");
  const judgments = rows.filter((r): r is JudgmentRecord => r.t === "judgment");
  for (const l of lectures) {
    const have = new Set(judgments.filter((j) => j.lectureId === l.lectureId).map((j) => `${j.purpose}:${j.subject}`));
    for (const w of l.windows) if (!have.has(`boundary:${w.id}`)) throw new Error(`results file is missing the judgment of window ${w.id} of ${l.lectureId}`);
    for (const f of l.frames) if (f.hasBefore && !have.has(`frame_change:${f.id}`)) throw new Error(`results file is missing the judgment of frame ${f.id} of ${l.lectureId}`);
  }
  return { header, lectures, judgments, end };
}

// ───────────────────────────── detection ─────────────────────────────

export type Detection = { readonly timeS: number; readonly provenance: ChunkProvenance; readonly windowId: string; readonly videoId?: string };

const windowOf = (w: WindowRecord): BoundaryWindow => ({
  id: w.id as WindowId,
  captureId: w.captureId as CaptureId,
  ordinal: w.ordinal,
  newPassages: w.newPassages as unknown as BoundaryWindow["newPassages"],
  contextPassages: w.contextPassages as unknown as readonly EvidenceId[],
  frames: w.frames as unknown as readonly EvidenceId[],
  newMaterial: Material.fromCanonical(w.newMaterial),
  watchedSecondsAtEnd: w.watchedSecondsAtEnd,
});

export type StoredJudgment = { readonly p: Readonly<Record<string, number | null>>; readonly error: string | null };

/**
 * A detected boundary is a chunk the real planChunks closes with provenance "boundary" or "boundary_revised" (Jev said
 * new concept and stopping point). Its time is the media start of the first window of the next chunk, or the end of the
 * last window when nothing follows. Time-cap and session-end closes are not Jev's and are not detections.
 * A failed judgment reads as uncertain, which routes to "continue" (flow B).
 */
export function detectBoundaries(
  windows: readonly WindowRecord[],
  judgmentOf: (windowId: string) => StoredJudgment | undefined,
  thresholds: Thresholds,
  cfg: SegmentationConfig,
  stopped: boolean,
): readonly Detection[] {
  const ordered = [...windows].sort((a, b) => a.ordinal - b.ordinal);
  const real = ordered.map(windowOf);
  const plan = planChunks(
    real,
    (w) => {
      const j = judgmentOf(w.id);
      if (j === undefined) return "pending";
      if (j.error !== null) return "failed";
      const pNewConcept = j.p.new_concept ?? null;
      const pStoppingPoint = j.p.stopping_point ?? null;
      return { windowId: w.id, newConcept: verdictAt(pNewConcept, thresholds), stoppingPoint: verdictAt(pStoppingPoint, thresholds), pNewConcept, pStoppingPoint, questionVersion: "lab" };
    },
    stopped,
    cfg,
  );
  const out: Detection[] = [];
  for (const chunk of plan.closed) {
    if (chunk.provenance !== "boundary" && chunk.provenance !== "boundary_revised") continue;
    const lastId = chunk.windows[chunk.windows.length - 1]!;
    const at = ordered.findIndex((w) => w.id === lastId);
    const next = ordered[at + 1];
    const placed = next ?? ordered[at]!;
    out.push({ timeS: next ? next.startS : ordered[at]!.endS, provenance: chunk.provenance, windowId: next ? next.id : lastId, ...(placed.videoId !== undefined ? { videoId: placed.videoId } : {}) });
  }
  return out.sort((a, b) => a.timeS - b.timeS);
}

// ───────────────────────────── visual steps and duplicates ─────────────────────────────

export type FrameView = { readonly id: string; readonly mediaS: number; readonly dropped: boolean; readonly videoId?: string };

export function framesView(lecture: LectureRecord, judgments: ReadonlyMap<string, StoredJudgment>, thresholds: Thresholds): readonly FrameView[] {
  const clips = clipsOf(lecture);
  return [...lecture.frames]
    .sort((a, b) => a.mediaS - b.mediaS || (a.id < b.id ? -1 : 1))
    .map((f) => {
      const j = f.hasBefore ? judgments.get(`frame_change:${f.id}`) : undefined;
      const dropped = j !== undefined && j.error === null && verdictAt(j.p.teaching_change ?? null, thresholds) === "no";
      return { id: f.id, mediaS: f.mediaS, dropped, videoId: f.videoId ?? clips[0]!.videoId };
    });
}

export type StepOutcome = { readonly mediaS: number; readonly lost: boolean; readonly reason: "no candidate frame" | "every candidate frame dropped" | "kept"; readonly videoId?: string };

/** Lost when no candidate frame lies in [s, s + PROPOSED_STEP_CATCH_S) of the same half, or every one of them was dropped. */
export function stepOutcomes(steps: readonly number[], frames: readonly FrameView[], range: SpanS): readonly StepOutcome[] {
  return steps.map((s) => {
    const carriers = frames.filter((f) => f.mediaS >= s && f.mediaS < s + PROPOSED_STEP_CATCH_S && f.mediaS < range.end);
    if (carriers.length === 0) return { mediaS: s, lost: true, reason: "no candidate frame" } as const;
    return carriers.every((f) => f.dropped) ? ({ mediaS: s, lost: true, reason: "every candidate frame dropped" } as const) : ({ mediaS: s, lost: false, reason: "kept" } as const);
  });
}

/** Amendment 1: a step is shown only by frames of its own clip; the clip's range in the scored half is its own. */
export function stepOutcomesPlaced(steps: readonly Place[], frames: readonly FrameView[], rangeOf: (videoId: string) => SpanS | null): readonly (StepOutcome & Place)[] {
  return steps.flatMap((s) => {
    const range = rangeOf(s.videoId);
    return range === null ? [] : [{ ...stepOutcomes([s.mediaS], frames.filter((f) => f.videoId === s.videoId), range)[0]!, videoId: s.videoId }];
  });
}

export type DuplicateOutcome = { readonly mediaS: number; readonly dropped: boolean; readonly resolved: boolean; readonly videoId?: string };

/** Where Amendment 1 members live: each member is scored in its own clip's part of the scored half, and "earliest" is in watch order. */
export type DuplicateScope = { readonly clipOrder: readonly string[]; readonly rangeOf: (videoId: string) => SpanS | null };

/**
 * Every member of a group but its earliest is a duplicate. Only duplicates inside `range` are scored; an unresolvable one
 * counts as not dropped. With a `scope` (members carry a videoId) the earliest is by (clip, media time), a member
 * resolves only to a frame of its own clip, and the range is the clip's own.
 */
export function duplicateOutcomes(groups: readonly DuplicateGroup[], frames: readonly FrameView[], range: SpanS, scope?: DuplicateScope): readonly DuplicateOutcome[] {
  const rank = (m: DuplicateMember) => scope?.clipOrder.indexOf(m.videoId ?? "") ?? 0;
  const out: DuplicateOutcome[] = [];
  for (const g of groups) {
    const members = [...g.frames].sort((a, b) => rank(a) - rank(b) || a.mediaS - b.mediaS);
    for (const m of members.slice(1)) {
      const within = scope ? scope.rangeOf(m.videoId ?? "") : range;
      if (within === null || m.mediaS < within.start || m.mediaS >= within.end) continue;
      const own = m.videoId === undefined ? frames : frames.filter((f) => f.videoId === m.videoId);
      const byId = m.frameId === undefined ? undefined : frames.find((f) => f.id === m.frameId);
      let hit: FrameView | undefined = byId;
      if (hit === undefined) {
        for (const f of own) {
          const d = Math.abs(f.mediaS - m.mediaS);
          if (d <= PROPOSED_DUPLICATE_MATCH_S + EPS && (hit === undefined || d < Math.abs(hit.mediaS - m.mediaS))) hit = f;
        }
      }
      out.push({ mediaS: m.mediaS, dropped: hit?.dropped ?? false, resolved: hit !== undefined, ...(m.videoId !== undefined ? { videoId: m.videoId } : {}) });
    }
  }
  return out;
}

// ───────────────────────────── report ─────────────────────────────

export type LabelInfo = { readonly file: string; readonly sha256: string; readonly labels: AnyLabelFile };
/** What round selection compares (experiment 6, decision 5); null means the clause was not measured. */
export type ReportMetrics = { readonly recallMatched: number; readonly recallLabeled: number; readonly falseCloses: number | null };
export type Report = { readonly text: string; readonly overall: "PASS" | "FAIL" | "NOT PASSED"; readonly exitCode: 0 | 1; readonly bars: readonly { readonly name: string; readonly verdict: BarVerdict }[]; readonly metrics: ReportMetrics };

const fmt = (x: number) => String(Number(x.toFixed(3)));
const pct = (num: number, den: number) => `${fmt((num / den) * 100)}%`;

const insideWatched = (watched: readonly (readonly [number, number])[], t: number) => watched.some(([a, b]) => t >= a && t < b);

type LectureScore = {
  readonly id: string;
  /** True for two or more clips: positions print with their clip number, and the first-window exclusion applies. */
  readonly set: boolean;
  readonly clipNo: (videoId: string) => number;
  readonly splitter: Splitter;
  readonly half: Half;
  readonly labeledBoundaries: readonly Place[];
  readonly excludedBoundaries: readonly Place[];
  readonly undetectable: readonly Place[];
  readonly detections: readonly (Detection & { readonly videoId: string })[];
  readonly matching: PlacedMatching;
  readonly watchedS: number;
  readonly steps: readonly (StepOutcome & Place)[];
  readonly duplicates: readonly DuplicateOutcome[];
};

/**
 * PROPOSED (Amendment 1): a boundary no model could detect is not in the recall denominator. A detection is the start of a
 * window that follows another window of the same half, so a label inside the FIRST window of a half has nothing before it
 * to close. That is the case for the split join, which starts the held-out half. Applies to sets of two or more clips only;
 * a one-video lecture keeps the schema 1 numbers.
 */
export const isInFirstWindow = (label: Place, first: { readonly videoId: string; readonly endS: number } | undefined): boolean => first !== undefined && label.videoId === first.videoId && label.mediaS < first.endS;

function scoreLecture(lecture: LectureRecord, labels: AnyLabelFile, results: ParsedResults): LectureScore {
  const view = viewOf(labels);
  const clips = clipsOf(lecture);
  const splitter = splitterOf(lecture);
  const set = clips.length > 1;
  const clipOrder = clips.map((c) => c.videoId);
  const clipNo = (videoId: string) => clipOrder.indexOf(videoId) + 1;
  const inHalf = (p: Place) => splitter.halfOf(p.videoId, p.mediaS) === lecture.half;
  const watchedOf = new Map(clips.map((c) => [c.videoId, c.watched] as const));
  const windowVideo = new Map(lecture.windows.map((w) => [w.id, w.videoId ?? clips[0]!.videoId] as const));
  const judged = new Map(results.judgments.filter((j) => j.lectureId === lecture.lectureId).map((j) => [`${j.purpose}:${j.subject}`, { p: j.p, error: j.error }] as const));

  const detections = detectBoundaries(lecture.windows, (id) => judged.get(`boundary:${id}`), results.header.thresholds, results.header.config, lecture.captureStopped)
    .map((d) => ({ ...d, videoId: windowVideo.get(d.windowId)! }))
    .filter((d) => inHalf({ videoId: d.videoId, mediaS: d.timeS }));
  const allLabeled = view.boundaries.map((b): Place => ({ videoId: b.videoId, mediaS: b.mediaS })).filter(inHalf);
  const watchedLabeled = allLabeled.filter((p) => insideWatched(watchedOf.get(p.videoId) ?? [], p.mediaS));
  const firstWindow = [...lecture.windows].sort((a, b) => a.ordinal - b.ordinal)[0];
  const undetectable = set && firstWindow ? watchedLabeled.filter((p) => isInFirstWindow(p, { videoId: firstWindow.videoId ?? clips[0]!.videoId, endS: firstWindow.endS })) : [];
  const labeledBoundaries = watchedLabeled.filter((p) => !undetectable.includes(p));

  const frames = framesView(lecture, judged, results.header.thresholds);
  const rangeOf = (videoId: string) => splitter.rangeOf(videoId, lecture.half);
  return {
    id: lecture.lectureId,
    set,
    clipNo,
    splitter,
    half: lecture.half,
    labeledBoundaries,
    excludedBoundaries: allLabeled.filter((p) => !insideWatched(watchedOf.get(p.videoId) ?? [], p.mediaS)),
    undetectable,
    detections,
    matching: matchPlaced(labeledBoundaries, detections.map((d) => ({ videoId: d.videoId, mediaS: d.timeS })), clipOrder),
    watchedS: splitter.clipsIn(lecture.half).reduce((a, c) => a + watchedIn(watchedOf.get(c.videoId)!, rangeOf(c.videoId)!), 0),
    steps: stepOutcomesPlaced(view.visualSteps.filter(inHalf), frames, rangeOf),
    duplicates: duplicateOutcomes(view.duplicateGroups, frames, { start: 0, end: 0 }, { clipOrder, rangeOf }),
  };
}

/** R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero." Tokens come from the stored calls; cost is never invented. */
function usageLines(results: ParsedResults): string[] {
  const fresh = results.judgments.filter((j) => !j.reused);
  const reused = results.judgments.length - fresh.length;
  const calls = fresh.flatMap((j) => j.calls.map((c) => ({ ...c, purpose: j.purpose })));
  const sum = (pick: (c: CallRecord) => number | null) => calls.reduce((a, c) => a + (pick(c) ?? 0), 0);
  const unknown = (pick: (c: CallRecord) => number | null) => calls.filter((c) => pick(c) === null).length;
  const ms = (xs: readonly number[]) => (xs.length === 0 ? "n/a" : `p50 ${fmt(percentile(xs, 50)!)} ms, p95 ${fmt(percentile(xs, 95)!)} ms (n=${xs.length})`);
  const lines = [
    "Usage (this run, measured; Jev reports tokens only, so cost is unknown):",
    `  calls ${calls.length} (boundary ${calls.filter((c) => c.purpose === "boundary").length}, frame change ${calls.filter((c) => c.purpose === "frame_change").length}, failed ${calls.filter((c) => !c.ok).length}); judgments reused from earlier calls ${reused}`,
    `  input tokens ${sum((c) => c.inputTokens)} (${unknown((c) => c.inputTokens)} call(s) without a count), output tokens ${sum((c) => c.outputTokens)} (${unknown((c) => c.outputTokens)} call(s) without a count)`,
    "  cost unknown",
    `Latency (report only, no target): all calls ${ms(calls.map((c) => c.durationMs))}`,
    `  boundary ${ms(calls.filter((c) => c.purpose === "boundary").map((c) => c.durationMs))}`,
    `  frame change ${ms(calls.filter((c) => c.purpose === "frame_change").map((c) => c.durationMs))}`,
  ];
  return lines;
}

function lectureLines(l: LectureRecord): string[] {
  const clips = clipsOf(l);
  const tail = `scored ${l.half} half; labels ${l.labelsFile} sha256 ${l.labelsSha256.slice(0, 12)}`;
  if (clips.length === 1) {
    const span = clips[0]!.spanS;
    return [`Lecture ${l.lectureId}: span [${fmt(span.start)}, ${fmt(span.end)}), split at ${fmt(splitPoint(span))}, ${tail}`];
  }
  const sp = splitterOf(l);
  const nos = (h: Half) => sp.clipsIn(h).map((c) => clips.findIndex((x) => x.videoId === c.videoId) + 1);
  const range = (h: Half) => `clips ${nos(h)[0]}-${nos(h).at(-1)}`;
  return [
    `Lecture ${l.lectureId}: ${clips.length} clips in watch order, split at the join before clip ${sp.joinIndex + 1} (watched ${fmt(sp.beforeS)} s before it and ${fmt(sp.afterS)} s after; the midpoint of ${fmt(sp.totalS)} s is ${fmt(sp.midpointS)} s), tune ${range("first")}, held-out ${range("second")}, ${tail}`,
    ...clips.map((c, i) => `  clip ${i + 1}: ${c.videoId}, span [${fmt(c.spanS.start)}, ${fmt(c.spanS.end)}), watched ${fmt(watchedIn(c.watched, c.spanS))} s`),
  ];
}

export function buildReport({ results, labels }: { readonly results: ParsedResults; readonly labels: readonly LabelInfo[] }): Report {
  const { header } = results;
  const scores = results.lectures.map((lecture) => {
    const info = labels.find((l) => lectureIdOfLabels(l.labels) === lecture.lectureId);
    if (!info) throw new Error(`no label file was supplied for ${lecture.lectureId}`);
    if (info.sha256 !== lecture.labelsSha256) throw new Error(`${info.file} has changed since the run (sha256 ${info.sha256.slice(0, 12)}, the run used ${lecture.labelsSha256.slice(0, 12)}); a result is only valid for the labels it was run on`);
    return scoreLecture(lecture, info.labels, results);
  });
  const scope = header.phase === "score" ? "held-out second halves (scored once)" : `first halves (tuning round ${header.round} of ${MAX_TUNE_ROUNDS}; not a result)`;

  const labeled = scores.reduce((a, s) => a + s.labeledBoundaries.length, 0);
  const matched = scores.reduce((a, s) => a + s.matching.pairs.length, 0);
  const recall: Block =
    labeled === 0
      ? { name: "recall", title: "Boundary recall", bar: BAR_RECALL, verdict: "NOT MEASURED", lines: ["Measured: no labeled boundary lies in the scored half of any lecture, so recall cannot be computed."] }
      : {
          name: "recall", title: "Boundary recall", bar: BAR_RECALL, verdict: matched * 10 >= RECALL_MIN * 10 * labeled - EPS ? "PASS" : "FAIL",
          lines: [
            `Measured: ${matched}/${labeled} labeled boundaries detected within ±${TOLERANCE_S}s = ${pct(matched, labeled)}.`,
            ...scores.flatMap((s) => [
              `  ${s.id}: ${s.matching.pairs.length}/${s.labeledBoundaries.length} detected; missed at ${list(s, s.matching.missedLabels)}`,
              ...(s.excludedBoundaries.length > 0 ? [`  ${s.id}: ${s.excludedBoundaries.length} label(s) at ${list(s, s.excludedBoundaries)} lie outside watched time and are not scored`] : []),
              ...(s.undetectable.length > 0 ? [`  ${s.id}: ${s.undetectable.length} label(s) at ${list(s, s.undetectable)} lie in the first window of the ${s.half} half, so no model could detect them (PROPOSED rule, Amendment 1); excluded from the denominator`] : []),
            ]),
          ],
        };

  const poolable = scores.filter((s) => s.labeledBoundaries.length > 0);
  const closes = poolable.reduce((a, s) => a + s.matching.falseCloses.length, 0);
  const watchedS = poolable.reduce((a, s) => a + s.watchedS, 0);
  const rate = falseClosesPerWindow(closes, watchedS);
  const falseCloses: Block =
    poolable.length === 0 || rate.pass === null
      ? { name: "false closes", title: "False closes", bar: BAR_FALSE_CLOSES, verdict: "NOT MEASURED", lines: ["Measured: no lecture has both labeled boundaries and watched time in the scored half, so false closes cannot be told from true ones."] }
      : {
          name: "false closes", title: "False closes", bar: BAR_FALSE_CLOSES, verdict: rate.pass ? "PASS" : "FAIL",
          lines: [
            `Measured: ${closes} false close(s) in ${fmt(watchedS)} s watched = ${fmt(rate.rate!)} per ${FALSE_CLOSE_WINDOW_S / 60} min.`,
            ...poolable.map((s) => `  ${s.id}: ${s.detections.length} Jev close(s), ${s.matching.falseCloses.length} false at ${list(s, s.matching.falseCloses)} in ${fmt(s.watchedS)} s watched`),
            ...scores.filter((s) => s.labeledBoundaries.length === 0).map((s) => `  ${s.id}: no labeled boundary in this half, excluded from this measure`),
          ],
        };

  const stepped = scores.filter((s) => s.steps.length > 0);
  const lostMost = Math.max(0, ...stepped.map((s) => s.steps.filter((x) => x.lost).length));
  const visual: Block =
    stepped.length === 0
      ? { name: "visual steps", title: "Visual steps", bar: BAR_VISUAL_STEPS, verdict: "NOT MEASURED", lines: ["Measured: no important visual step is labeled in the scored half of any lecture."] }
      : {
          name: "visual steps", title: "Visual steps", bar: BAR_VISUAL_STEPS, verdict: lostMost <= STEPS_LOST_MAX_PER_LECTURE ? "PASS" : "FAIL",
          lines: [
            `Measured: most lost in one lecture ${lostMost} (limit ${STEPS_LOST_MAX_PER_LECTURE}); this is the scored half only, not a whole lecture.`,
            ...stepped.map((s) => `  ${s.id}: ${s.steps.filter((x) => x.lost).length}/${s.steps.length} lost${s.steps.some((x) => x.lost) ? ` (${s.steps.filter((x) => x.lost).map((x) => `${at(s, x)} ${x.reason}`).join("; ")})` : ""}`),
            ...scores.filter((s) => s.steps.length === 0).map((s) => `  ${s.id}: no visual step labeled in this half, excluded from this measure`),
          ],
        };

  const dups = scores.flatMap((s) => s.duplicates);
  const dropped = dups.filter((d) => d.dropped).length;
  const unresolved = dups.filter((d) => !d.resolved).length;
  const duplicates: Block =
    dups.length === 0
      ? { name: "duplicates", title: "Duplicates", bar: BAR_DUPLICATES, verdict: "NOT MEASURED", lines: ["Measured: no labeled duplicate lies in the scored half of any lecture."] }
      : {
          name: "duplicates", title: "Duplicates", bar: BAR_DUPLICATES, verdict: dropped >= DUPLICATES_DROPPED_MIN * dups.length - EPS ? "PASS" : "FAIL",
          lines: [
            `Measured: ${dropped}/${dups.length} labeled duplicates dropped = ${pct(dropped, dups.length)}${unresolved > 0 ? `; ${unresolved} matched no candidate frame and count as not dropped` : ""}.`,
            ...scores.filter((s) => s.duplicates.length > 0).map((s) => `  ${s.id}: ${s.duplicates.filter((d) => d.dropped).length}/${s.duplicates.length} dropped`),
          ],
        };

  const blocks = [recall, falseCloses, visual, duplicates];
  const failed = blocks.filter((b) => b.verdict === "FAIL").map((b) => b.name);
  const notMeasured = blocks.filter((b) => b.verdict === "NOT MEASURED").map((b) => b.name);
  const overall = failed.length > 0 ? "FAIL" : notMeasured.length > 0 ? "NOT PASSED" : "PASS";
  const reasons = [failed.length > 0 ? `failed: ${failed.join(", ")}` : "", notMeasured.length > 0 ? `not measured: ${notMeasured.join(", ")}` : ""].filter(Boolean);

  const out: string[] = [
    `Jev lab report ${header.runId}`,
    `Data origin: ${header.origin}`,
    `Scope: ${scope}`,
    `Model: ${header.model}`,
    `Config: ${Object.entries(header.config).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `Thresholds: yes at or above ${header.thresholds.yesAtOrAbove}, no at or below ${header.thresholds.noAtOrBelow}`,
    ...(header.questions === undefined
      ? []
      : [
          "Questions (this arm's wording, which differs from the product's):",
          `  newConcept: ${JSON.stringify(header.questions.newConcept)}`,
          `  stoppingPoint: ${JSON.stringify(header.questions.stoppingPoint)}`,
          `  teachingChange: ${JSON.stringify(header.questions.teachingChange)}`,
        ]),
    ...(header.arm === undefined ? [] : [`Arm: ${header.arm}`]),
    ...(header.selectedRound === undefined ? [] : [`Selected round: ${header.selectedRound} of this arm's tune rounds (${header.selectionReason ?? "no reason recorded"})`]),
    `Budget: "${BUDGET_TEXT}"`,
    ...results.lectures.flatMap(lectureLines),
    "",
  ];
  for (const b of blocks) out.push(`${b.title}: ${b.verdict}`, `Bar: "${b.bar}"`, ...b.lines, "");
  out.push(...usageLines(results), "");
  out.push(`${header.phase === "score" ? "OVERALL" : "OVERALL (tuning round, not a result)"}: ${overall}${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""}`);
  out.push(`Not shown by this lab: model accuracy beyond this label set, other lectures, other machines, learning effectiveness. Labels are Derek's judgment.`);

  const text = out.map((l) => (l === "" ? l : `[${header.origin}] ${l}`)).join("\n") + "\n";
  return { text, overall, exitCode: overall === "PASS" ? 0 : 1, bars: blocks.map((b) => ({ name: b.name, verdict: b.verdict })), metrics: { recallMatched: matched, recallLabeled: labeled, falseCloses: rate.pass === null ? null : closes } };
}

type Block = { readonly name: string; readonly title: string; readonly bar: string; readonly verdict: BarVerdict; readonly lines: readonly string[] };
/** A position as the report prints it: seconds for a one-video lecture, clip number and seconds for a set. */
const at = (s: LectureScore, p: Place) => (s.set ? `clip ${s.clipNo(p.videoId)} ${fmt(p.mediaS)}s` : `${fmt(p.mediaS)}s`);
const list = (s: LectureScore, xs: readonly Place[]) => (xs.length === 0 ? "none" : xs.map((x) => at(s, x)).join(", "));
