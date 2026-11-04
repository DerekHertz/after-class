/**
 * Experiment 2, the Jev boundary and visual lab: label format, split rule, stored-judgment format and scoring.
 * Pure: no file, network or clock access, so everything here is a function of its arguments. The protocol that
 * defines every measurement is docs/experiments/02-jev-lab.md; the numbers below are the ones it names.
 *
 * The four clauses are fixed (docs/flows/after-class.md, "Experiments and pass bars"):
 *   "≥70% of labeled boundaries detected within ±60s; ≤1 false close per 15 min; ≤1 important visual step lost per
 *   lecture; ≥50% duplicates dropped."
 * Budget: "~800 Jev calls, max 3 tuning rounds, tune on first halves, score once on held-out second halves".
 */
import type { BoundaryWindow, ChunkProvenance, Verdict } from "../src/shared/domain";
import type { CaptureId, EvidenceId, WindowId } from "../src/shared/ids";
import { Material } from "../src/shared/time";
import { THRESHOLDS } from "../src/backend/providers/jev-tasks";
import type { SegmentationConfig } from "../src/backend/segmentation";
import { planChunks } from "../src/backend/segmentation/core";

export type Origin = "fixture" | "live";
export type Phase = "tune" | "score";
export type Half = "first" | "second";
export type BarVerdict = "PASS" | "FAIL" | "NOT MEASURED";

// ───────────────────────────── fixed by the bar text and the budget ─────────────────────────────

export const BAR_RECALL = "≥70% of labeled boundaries detected within ±60s";
export const BAR_FALSE_CLOSES = "≤1 false close per 15 min";
export const BAR_VISUAL_STEPS = "≤1 important visual step lost per lecture";
export const BAR_DUPLICATES = "≥50% duplicates dropped";
export const BUDGET_TEXT = "~800 Jev calls, max 3 tuning rounds, tune on first halves, score once on held-out second halves";

export const TOLERANCE_S = 60;
export const RECALL_MIN = 0.7;
export const FALSE_CLOSE_WINDOW_S = 15 * 60;
export const FALSE_CLOSES_MAX_PER_WINDOW = 1;
export const STEPS_LOST_MAX_PER_LECTURE = 1;
export const DUPLICATES_DROPPED_MIN = 0.5;
export const MAX_TUNE_ROUNDS = 3;
/** "~800": read as a hard ceiling that includes retries. PROPOSED, needs Derek's OK before any paid call. */
export const BUDGET_CALLS = 800;

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
export type DuplicateMember = { readonly mediaS: number; readonly frameId?: string };
export type DuplicateGroup = { readonly note: string; readonly confirmed: boolean; readonly cue?: string; readonly frames: readonly DuplicateMember[] };
export type SpanS = { readonly start: number; readonly end: number };

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

export type LabelResult = { readonly ok: true; readonly labels: LabelFile } | { readonly ok: false; readonly errors: readonly string[] };

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
  if (input.schemaVersion !== 1) err("schemaVersion", `expected 1, got ${JSON.stringify(input.schemaVersion)}`);
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

  let span: SpanS | null = null;
  const lecture = input.lecture;
  if (!isObj(lecture)) err("lecture", "expected an object");
  else {
    unknownKeys("lecture", lecture, ["captureId", "videoId", "title", "spanS"]);
    if (!isText(lecture.captureId)) err("lecture.captureId", "expected a non-empty string");
    if (!isText(lecture.videoId)) err("lecture.videoId", "expected a non-empty string");
    if (lecture.title !== undefined && typeof lecture.title !== "string") err("lecture.title", "expected a string");
    const s = lecture.spanS;
    if (!isObj(s) || !isNum(s.start) || !isNum(s.end) || s.start < 0 || !(s.end > s.start)) err("lecture.spanS", "expected {start, end} in media seconds with 0 <= start < end");
    else span = { start: s.start, end: s.end };
  }

  const checkTime = (path: string, t: unknown) => {
    if (!isNum(t) || t < 0) err(`${path}.mediaS`, `expected media seconds >= 0, got ${JSON.stringify(t)}`);
    else if (span !== null && (t < span.start || t >= span.end)) err(`${path}.mediaS`, `${t} lies outside the lecture span [${span.start}, ${span.end}) (the span is half-open)`);
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
      unknownKeys(path, it, ["mediaS", "note", "confirmed", "cue"]);
      checkTime(path, it.mediaS);
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
        unknownKeys(fp, f, ["mediaS", "frameId"]);
        checkTime(fp, f.mediaS);
        if (f.frameId !== undefined && !isText(f.frameId)) err(`${fp}.frameId`, "expected a non-empty string when present");
      });
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, labels: input as unknown as LabelFile };
}

// ───────────────────────────── the split ─────────────────────────────

/** First half is [span.start, T), second half is [T, span.end), with T the midpoint of the lecture span. A label at exactly T is in the second half. */
export const splitPoint = (span: SpanS): number => span.start + (span.end - span.start) / 2;

export function halfOf(timeS: number, span: SpanS): Half | null {
  if (timeS < span.start || timeS >= span.end) return null;
  return timeS < splitPoint(span) ? "first" : "second";
}

export const halfRange = (span: SpanS, half: Half): SpanS => (half === "first" ? { start: span.start, end: splitPoint(span) } : { start: splitPoint(span), end: span.end });

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
};
export type FrameRecord = { readonly id: string; readonly mediaS: number; readonly hasBefore: boolean };

export type LectureRecord = {
  readonly t: "lecture";
  readonly lectureId: string;
  readonly labelsFile: string;
  readonly labelsSha256: string;
  readonly captureId: string;
  readonly videoId: string;
  readonly sourceId: string;
  readonly spanS: SpanS;
  readonly half: Half;
  readonly captureStopped: boolean;
  readonly watched: readonly (readonly [number, number])[];
  readonly windows: readonly WindowRecord[];
  readonly frames: readonly FrameRecord[];
};

export type CallRecord = { readonly startedAtMs: number; readonly durationMs: number; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly ok: boolean };

export type JudgmentRecord = {
  readonly t: "judgment";
  readonly lectureId: string;
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

export type RunHeader = {
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

export type Detection = { readonly timeS: number; readonly provenance: ChunkProvenance; readonly windowId: string };

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
    out.push({ timeS: next ? next.startS : ordered[at]!.endS, provenance: chunk.provenance, windowId: next ? next.id : lastId });
  }
  return out.sort((a, b) => a.timeS - b.timeS);
}

// ───────────────────────────── visual steps and duplicates ─────────────────────────────

export type FrameView = { readonly id: string; readonly mediaS: number; readonly dropped: boolean };

export function framesView(lecture: LectureRecord, judgments: ReadonlyMap<string, StoredJudgment>, thresholds: Thresholds): readonly FrameView[] {
  return [...lecture.frames]
    .sort((a, b) => a.mediaS - b.mediaS || (a.id < b.id ? -1 : 1))
    .map((f) => {
      const j = f.hasBefore ? judgments.get(`frame_change:${f.id}`) : undefined;
      const dropped = j !== undefined && j.error === null && verdictAt(j.p.teaching_change ?? null, thresholds) === "no";
      return { id: f.id, mediaS: f.mediaS, dropped };
    });
}

export type StepOutcome = { readonly mediaS: number; readonly lost: boolean; readonly reason: "no candidate frame" | "every candidate frame dropped" | "kept" };

/** Lost when no candidate frame lies in [s, s + PROPOSED_STEP_CATCH_S) of the same half, or every one of them was dropped. */
export function stepOutcomes(steps: readonly number[], frames: readonly FrameView[], range: SpanS): readonly StepOutcome[] {
  return steps.map((s) => {
    const carriers = frames.filter((f) => f.mediaS >= s && f.mediaS < s + PROPOSED_STEP_CATCH_S && f.mediaS < range.end);
    if (carriers.length === 0) return { mediaS: s, lost: true, reason: "no candidate frame" } as const;
    return carriers.every((f) => f.dropped) ? ({ mediaS: s, lost: true, reason: "every candidate frame dropped" } as const) : ({ mediaS: s, lost: false, reason: "kept" } as const);
  });
}

export type DuplicateOutcome = { readonly mediaS: number; readonly dropped: boolean; readonly resolved: boolean };

/** Every member of a group but its earliest is a duplicate. Only duplicates inside `range` are scored; an unresolvable one counts as not dropped. */
export function duplicateOutcomes(groups: readonly DuplicateGroup[], frames: readonly FrameView[], range: SpanS): readonly DuplicateOutcome[] {
  const out: DuplicateOutcome[] = [];
  for (const g of groups) {
    const members = [...g.frames].sort((a, b) => a.mediaS - b.mediaS);
    for (const m of members.slice(1)) {
      if (m.mediaS < range.start || m.mediaS >= range.end) continue;
      const byId = m.frameId === undefined ? undefined : frames.find((f) => f.id === m.frameId);
      let hit: FrameView | undefined = byId;
      if (hit === undefined) {
        for (const f of frames) {
          const d = Math.abs(f.mediaS - m.mediaS);
          if (d <= PROPOSED_DUPLICATE_MATCH_S + EPS && (hit === undefined || d < Math.abs(hit.mediaS - m.mediaS))) hit = f;
        }
      }
      out.push({ mediaS: m.mediaS, dropped: hit?.dropped ?? false, resolved: hit !== undefined });
    }
  }
  return out;
}

// ───────────────────────────── report ─────────────────────────────

export type LabelInfo = { readonly file: string; readonly sha256: string; readonly labels: LabelFile };
export type Report = { readonly text: string; readonly overall: "PASS" | "FAIL" | "NOT PASSED"; readonly exitCode: 0 | 1; readonly bars: readonly { readonly name: string; readonly verdict: BarVerdict }[] };

const fmt = (x: number) => String(Number(x.toFixed(3)));
const pct = (num: number, den: number) => `${fmt((num / den) * 100)}%`;

function watchedIn(watched: readonly (readonly [number, number])[], range: SpanS): number {
  let sum = 0;
  for (const [a, b] of watched) sum += Math.max(0, Math.min(b, range.end) - Math.max(a, range.start));
  return sum;
}
const insideWatched = (watched: readonly (readonly [number, number])[], t: number) => watched.some(([a, b]) => t >= a && t < b);

type LectureScore = {
  readonly id: string;
  readonly range: SpanS;
  readonly labeledBoundaries: readonly number[];
  readonly excludedBoundaries: readonly number[];
  readonly detections: readonly Detection[];
  readonly matching: Matching;
  readonly watchedS: number;
  readonly steps: readonly StepOutcome[];
  readonly duplicates: readonly DuplicateOutcome[];
};

function scoreLecture(lecture: LectureRecord, labels: LabelFile, results: ParsedResults): LectureScore {
  const range = halfRange(lecture.spanS, lecture.half);
  const inHalf = (t: number) => t >= range.start && t < range.end;
  const judged = new Map(results.judgments.filter((j) => j.lectureId === lecture.lectureId).map((j) => [`${j.purpose}:${j.subject}`, { p: j.p, error: j.error }] as const));
  const detections = detectBoundaries(lecture.windows, (id) => judged.get(`boundary:${id}`), results.header.thresholds, results.header.config, lecture.captureStopped).filter((d) => inHalf(d.timeS));
  const allLabeled = labels.boundaries.map((b) => b.mediaS).filter(inHalf);
  const labeledBoundaries = allLabeled.filter((t) => insideWatched(lecture.watched, t));
  const frames = framesView(lecture, judged, results.header.thresholds);
  return {
    id: lecture.lectureId,
    range,
    labeledBoundaries,
    excludedBoundaries: allLabeled.filter((t) => !insideWatched(lecture.watched, t)),
    detections,
    matching: matchBoundaries(labeledBoundaries, detections.map((d) => d.timeS)),
    watchedS: watchedIn(lecture.watched, range),
    steps: stepOutcomes(labels.visualSteps.map((s) => s.mediaS).filter(inHalf), frames, range),
    duplicates: duplicateOutcomes(labels.duplicateGroups, frames, range),
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

export function buildReport({ results, labels }: { readonly results: ParsedResults; readonly labels: readonly LabelInfo[] }): Report {
  const { header } = results;
  const scores = results.lectures.map((lecture) => {
    const info = labels.find((l) => `${l.labels.lecture.captureId}/${l.labels.lecture.videoId}` === lecture.lectureId);
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
              `  ${s.id}: ${s.matching.pairs.length}/${s.labeledBoundaries.length} detected; missed at ${list(s.matching.missedLabels)}`,
              ...(s.excludedBoundaries.length > 0 ? [`  ${s.id}: ${s.excludedBoundaries.length} label(s) at ${list(s.excludedBoundaries)} lie outside watched time and are not scored`] : []),
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
            ...poolable.map((s) => `  ${s.id}: ${s.detections.length} Jev close(s), ${s.matching.falseCloses.length} false at ${list(s.matching.falseCloses)} in ${fmt(s.watchedS)} s watched`),
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
            ...stepped.map((s) => `  ${s.id}: ${s.steps.filter((x) => x.lost).length}/${s.steps.length} lost${s.steps.some((x) => x.lost) ? ` (${s.steps.filter((x) => x.lost).map((x) => `${fmt(x.mediaS)}s ${x.reason}`).join("; ")})` : ""}`),
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
    `Budget: "${BUDGET_TEXT}"`,
    ...results.lectures.map((l) => `Lecture ${l.lectureId}: span [${fmt(l.spanS.start)}, ${fmt(l.spanS.end)}), split at ${fmt(splitPoint(l.spanS))}, scored ${l.half} half; labels ${l.labelsFile} sha256 ${l.labelsSha256.slice(0, 12)}`),
    "",
  ];
  for (const b of blocks) out.push(`${b.title}: ${b.verdict}`, `Bar: "${b.bar}"`, ...b.lines, "");
  out.push(...usageLines(results), "");
  out.push(`${header.phase === "score" ? "OVERALL" : "OVERALL (tuning round, not a result)"}: ${overall}${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""}`);
  out.push(`Not shown by this lab: model accuracy beyond this label set, other lectures, other machines, learning effectiveness. Labels are Derek's judgment.`);

  const text = out.map((l) => (l === "" ? l : `[${header.origin}] ${l}`)).join("\n") + "\n";
  return { text, overall, exitCode: overall === "PASS" ? 0 : 1, bars: blocks.map((b) => ({ name: b.name, verdict: b.verdict })) };
}

type Block = { readonly name: string; readonly title: string; readonly bar: string; readonly verdict: BarVerdict; readonly lines: readonly string[] };
const list = (xs: readonly number[]) => (xs.length === 0 ? "none" : xs.map((x) => `${fmt(x)}s`).join(", "));
