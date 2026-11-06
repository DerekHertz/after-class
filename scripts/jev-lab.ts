/**
 * Experiment 2, the Jev boundary and visual lab (docs/experiments/02-jev-lab.md is the protocol).
 *
 *   bun run scripts/jev-lab.ts draft-labels --data <dir> --capture <id> [--video <id>] --out <file> [--force]
 *   bun run scripts/jev-lab.ts draft-labels-set --data <dir> --capture <id> --out <file> [--force]
 *   bun run scripts/jev-lab.ts split   [--data <dir>] --labels <file>...      (--data is needed for a set of clips)
 *   bun run scripts/jev-lab.ts plan    --data <dir> --labels <file>... [--arm-config <file> [--lab <dir> --arm <name>]]
 *   bun run scripts/jev-lab.ts run     --data <dir> --lab <dir> --labels <file>... --phase tune|score [tuning flags]
 *                                      [--live --max-calls <n> [--keys <path>]]
 *   experiment 6 arm run: run ... --arm <name> --phase tune --arm-config <file>   (directory <lab>/exp6/<arm>/<origin>)
 *                         run ... --arm <name> --phase score                      (scores the arm's selected round)
 *   bun run scripts/jev-lab.ts report  --results <file> --labels <file>...
 *   bun run scripts/jev-lab.ts rescore --results <file> --labels <file>... [--expect <report.txt>]
 *
 * Everything reads a scratch copy of <data>/afterclass.sqlite, so the real data dir is never written. `run` makes no
 * Jev call unless --live, a 0600 keys file with TYPESAFE_API_KEY, --max-calls within the budget and signed_off labels
 * all hold. Without --live it uses a deterministic fake and everything it prints is tagged [fixture].
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { EvidenceStoreWithProbe } from "../src/backend/evidence";
import { readKeys } from "../src/backend/main";
import { createJevClient } from "../src/backend/providers/jev";
import type { JevAnswer, JevClient, JevRequest } from "../src/backend/providers/jev";
import { JEV_MODEL, boundaryTask, boundaryWordingVersion, frameChangeTask, frameChangeWordingVersion } from "../src/backend/providers/jev-tasks";
import type { BoundaryInput, FrameChangeInput } from "../src/backend/providers/jev-tasks";
import { ProviderError } from "../src/backend/providers/memo";
import type { Task } from "../src/backend/providers/memo";
import { SEGMENTATION_DEFAULTS } from "../src/backend/segmentation";
import type { SegmentationConfig } from "../src/backend/segmentation";
import { buildWindows } from "../src/backend/segmentation";
import type { BoundaryWindow, Evidence, Frame, Passage } from "../src/shared/domain";
import { canonicalJson, stableId } from "../src/shared/ids";
import type { CaptureId, EvidenceId, MemoKey, SourceId } from "../src/shared/ids";
import { Material } from "../src/shared/time";
import { ARM_NAME, PRODUCT_QUESTIONS, boundaryQuestionsOf, frameQuestionsOf, isProductWording, segmentationInRange, selectRound, thresholdsInRange, validateArmConfig } from "./jev-lab-arm";
import type { ArmConfig, ArmQuestions } from "./jev-lab-arm";
import { scratchCopy } from "./probe-export";
import {
  BUDGET_CALLS, BUDGET_TEXT, DEFAULT_THRESHOLDS, MAX_TUNE_ROUNDS, buildReport, isInFirstWindow, lectureIdOfLabels, makeSplitter, parseResults, serializeResults, validateLabels, viewOf, watchedIn,
} from "./jev-lab-score";
import type {
  CallRecord, ClipRecord, FrameRecord, Half, JudgmentRecord, LabelFile, LabelFileV2, LabelInfo, LectureRecord, Origin, ParsedResults, Phase, Place, Report, RunHeader, Splitter, Thresholds, WindowRecord,
} from "./jev-lab-score";

/** A guard that stopped the lab before a call. The message never contains a key. */
export class LabRefusal extends Error {
  override readonly name = "LabRefusal";
}

function refuse(message: string): never {
  throw new LabRefusal(message);
}

export const DEFAULT_KEYS_PATH = join(homedir(), ".config", "afterclass", "keys.env");

// ───────────────────────────── labels ─────────────────────────────

export function loadLabels(files: readonly string[]): readonly LabelInfo[] {
  if (files.length === 0) refuse("no label file given; pass --labels <file>");
  const infos = files.map((file): LabelInfo => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return refuse(`cannot read label file ${file}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return refuse(`${file} is not valid JSON`);
    }
    const checked = validateLabels(json);
    if (!checked.ok) return refuse(`${file} is not a valid label file:\n${checked.errors.map((e) => `  ${e}`).join("\n")}`);
    return { file: basename(file), sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"), labels: checked.labels };
  });
  const ids = infos.map(lectureIdOf);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) refuse(`two label files name the lecture ${dup}`);
  if (infos.some((i) => i.labels.schemaVersion === 2)) {
    // Amendment 1: a set is the clips of one capture, so a run holding a set holds one capture, and no clip is in two lectures.
    const captures = [...new Set(infos.map((i) => viewOf(i.labels).captureId))];
    if (captures.length > 1) refuse(`a run holds the lecture set of one capture; these label files name ${captures.length} captures: ${captures.join(", ")}`);
    const seen = new Map<string, string>();
    for (const info of infos) {
      for (const c of viewOf(info.labels).clips) {
        const other = seen.get(c.videoId);
        if (other !== undefined) refuse(`video ${c.videoId} is in two label files (${other} and ${info.file}); a clip belongs to one lecture`);
        seen.set(c.videoId, info.file);
      }
    }
  }
  return infos;
}

export const lectureIdOf = (info: LabelInfo): string => lectureIdOfLabels(info.labels);

/** Counts the labels of each half through the lecture's own splitter, so `split`, `plan` and the report agree on which half a label is in. */
function labelCounts(info: LabelInfo, sp: Splitter, half: Half) {
  const view = viewOf(info.labels);
  const order = view.clips.map((c) => c.videoId);
  const inHalf = (p: Place) => sp.halfOf(p.videoId, p.mediaS) === half;
  const later = view.duplicateGroups.flatMap((g) => [...g.frames].sort((x, y) => order.indexOf(x.videoId) - order.indexOf(y.videoId) || x.mediaS - y.mediaS).slice(1));
  const boundaries = view.boundaries.filter(inHalf);
  const starts = boundaries.filter((b) => {
    const at = order.indexOf(b.videoId);
    return at > 0 && b.mediaS - view.clips[at]!.spanS.start < SEGMENTATION_DEFAULTS.windowNewS;
  });
  return { boundaries, starts: starts.length, steps: view.visualSteps.filter(inHalf).length, duplicates: later.filter(inHalf).length };
}

/**
 * The tune and held-out counts per lecture. A lecture of one video is split at the midpoint of its span (no capture
 * needed); a set of clips is split at a clip join by watched seconds, which only the capture knows, so it needs `dataDir`.
 */
export function describeSplit(infos: readonly LabelInfo[], dataDir?: string): string[] {
  const lines: string[] = [];
  let cap: OpenCapture | null = null;
  try {
    for (const info of infos) {
      const view = viewOf(info.labels);
      const head = `${lectureIdOf(info)} (${info.file}, status ${info.labels.status})`;
      if (view.clips.length === 1) {
        const { spanS } = view.clips[0]!;
        const sp = makeSplitter([{ videoId: view.clips[0]!.videoId, spanS, watchedS: 0 }]);
        const T = sp.midpointS;
        const a = labelCounts(info, sp, "first");
        const b = labelCounts(info, sp, "second");
        lines.push(
          `${head}: span [${spanS.start}, ${spanS.end}), split at ${T}`,
          `  tune (first half, [${spanS.start}, ${T})): ${a.boundaries.length} boundaries, ${a.steps} visual steps, ${a.duplicates} duplicates`,
          `  held-out (second half, [${T}, ${spanS.end})): ${b.boundaries.length} boundaries, ${b.steps} visual steps, ${b.duplicates} duplicates`,
        );
        continue;
      }
      if (dataDir === undefined) refuse(`${info.file} is a set of ${view.clips.length} clips: its split counts watched seconds, which only the capture knows. Pass --data <dir>`);
      cap ??= openCapture(dataDir);
      const clips = clipRecords(cap, info);
      const sp = splitOf(clips);
      const a = labelCounts(info, sp, "first");
      const b = labelCounts(info, sp, "second");
      const names = (h: Half) => `clips ${clips.findIndex((c) => c.videoId === sp.clipsIn(h)[0]!.videoId) + 1}-${clips.findIndex((c) => c.videoId === sp.clipsIn(h).at(-1)!.videoId) + 1}`;
      const secs = (n: number) => Number(n.toFixed(3));
      lines.push(
        `${head}: ${clips.length} clips in watch order, ${secs(sp.totalS)} s watched`,
        ...clips.map((c, i) => `  clip ${i + 1}: ${c.videoId}, span [${c.spanS.start}, ${c.spanS.end}), watched ${secs(watchedIn(c.watched, c.spanS))} s`),
        `  split at the join before clip ${sp.joinIndex + 1}: the join nearest the watched-time midpoint ${secs(sp.midpointS)} s, with ${secs(sp.beforeS)} s watched before it and ${secs(sp.afterS)} s after`,
        `  tune (first half, ${names("first")}): ${a.boundaries.length} boundaries (${a.starts} at a clip start), ${a.steps} visual steps, ${a.duplicates} duplicates`,
        `  held-out (second half, ${names("second")}): ${b.boundaries.length} boundaries (${b.starts} at a clip start), ${b.steps} visual steps, ${b.duplicates} duplicates`,
        "  a boundary label inside the first window of a half cannot be detected and is excluded from recall (PROPOSED, Amendment 1); `plan` counts them",
      );
    }
  } finally {
    cap?.close();
  }
  return lines;
}

const splitOf = (clips: readonly ClipRecord[]): Splitter => makeSplitter(clips.map((c) => ({ videoId: c.videoId, spanS: c.spanS, watchedS: watchedIn(c.watched, c.spanS) })));

// ───────────────────────────── the capture, read-only ─────────────────────────────

type OpenCapture = { readonly evidence: EvidenceStoreWithProbe; readonly frameInputs: FrameChangeInput[]; readonly dataDir: string; close(): void };

/** The evidence store over a scratch copy of the database. No provider is built: a frame-change "run" only records its input. */
export function openCapture(dataDir: string): OpenCapture {
  const scratch = scratchCopy(dataDir);
  const db = openDb(scratch.path);
  const frameInputs: FrameChangeInput[] = [];
  const keyOf = (input: FrameChangeInput): MemoKey => stableId("key", "frame_change", "lab", input.after.frame.id);
  const evidence = createEvidence(db, dataDir, {
    lookupFrameChange: (input) => ({ kind: "missing", key: keyOf(input) }),
    runFrameChange: (input) => {
      frameInputs.push(input);
      return Promise.resolve(undefined);
    },
    frameChangeKey: keyOf,
    onChange: () => {},
  });
  return {
    evidence, frameInputs, dataDir,
    close: () => {
      db.close();
      rmSync(scratch.dir, { recursive: true, force: true });
    },
  };
}

type WindowWork = { readonly record: WindowRecord; readonly input: BoundaryInput; readonly half: Half };
type FrameWork = { readonly record: FrameRecord; readonly input: FrameChangeInput | null; readonly half: Half };
type Head<T> = T extends unknown ? Omit<T, "half" | "windows" | "frames"> : never;
type LectureWork = {
  readonly info: LabelInfo;
  readonly record: Head<LectureRecord>;
  readonly clips: readonly ClipRecord[];
  readonly splitter: Splitter;
  readonly windows: readonly WindowWork[];
  readonly frames: readonly FrameWork[];
};

const passageOf = (e: Evidence | { readonly kind: "deleted" } | undefined): e is Passage => e?.kind === "passage";
const frameOf = (e: Evidence | { readonly kind: "deleted" } | undefined): e is Frame => e?.kind === "frame";

/**
 * The clips of one lecture from the capture: each clip's source and watched intervals. A set must be listed in the
 * capture's watch order, because the product folds windows in watch order and the join rule depends on it.
 */
export function clipRecords(cap: OpenCapture, info: LabelInfo): ClipRecord[] {
  const view = viewOf(info.labels);
  const captureId = view.captureId as CaptureId;
  const capture = cap.evidence.captureView(captureId);
  const watched = cap.evidence.watchedMaterial(captureId);
  const clips = view.clips.map((c): ClipRecord => {
    const sourceId = stableId("src", "youtube", c.videoId);
    if (!capture.sources.some((s) => s.id === sourceId)) refuse(`capture ${view.captureId} has no source for video ${c.videoId}; check the label file's lecture`);
    return { videoId: c.videoId, sourceId, spanS: c.spanS, watched: Material.get(watched, sourceId as SourceId).intervals().map((i): [number, number] => [i.start, i.end]) };
  });
  if (clips.length > 1) {
    const listed = new Set(clips.map((c) => c.videoId));
    const inWatchOrder = capture.sources.map((s) => s.videoId).filter((v) => listed.has(v));
    if (inWatchOrder.join(",") !== clips.map((c) => c.videoId).join(",")) {
      refuse(`${info.file} lists its clips as ${clips.map((c) => c.videoId).join(", ")}, but the capture was watched in the order ${inWatchOrder.join(", ")}; a set is listed in watch order`);
    }
  }
  return clips;
}

/**
 * The real windowing (buildWindows, with the run's config) over the whole capture, then the windows and frames of one lecture.
 * One clip: a window is the lecture's when its first new passage is, as before Amendment 1. Two or more clips: a window is
 * the lecture's when its last new passage is in one of the clips, and it belongs to that clip (PROPOSED): a window that
 * spans a join is the first window of the clip it ends in, so "the next clip's first window decides" is that window.
 */
export function lectureWork(cap: OpenCapture, info: LabelInfo, cfg: SegmentationConfig): LectureWork {
  const view = viewOf(info.labels);
  const captureId = view.captureId as CaptureId;
  const clips = clipRecords(cap, info);
  const splitter = splitOf(clips);
  const set = clips.length > 1;
  const clipOfSource = new Map(clips.map((c) => [c.sourceId as string, c] as const));

  const order = cap.evidence.watchOrder(captureId);
  const windows: WindowWork[] = [];
  for (const w of buildWindows(captureId, order, cfg)) {
    const decisive = set ? w.newPassages[w.newPassages.length - 1]! : w.newPassages[0];
    const own = cap.evidence.get([decisive]).get(decisive);
    if (!passageOf(own)) continue;
    const clip = clipOfSource.get(own.sourceId);
    if (clip === undefined) continue;
    const intervals = Material.get(w.newMaterial, clip.sourceId as SourceId).intervals();
    const startS = Math.min(...intervals.map((i) => i.start));
    const half = splitter.halfOf(clip.videoId, startS);
    if (half === null) continue;
    windows.push({ half, input: boundaryInputOf(cap.evidence, w), record: windowRecord(w, startS, Math.max(...intervals.map((i) => i.end)), clip.videoId) });
  }

  cap.frameInputs.length = 0;
  for (const item of cap.evidence.frameDemand(captureId)) void item.run(new AbortController().signal);
  const inputOf = new Map(cap.frameInputs.map((i) => [i.after.frame.id as string, i] as const));
  const frames: FrameWork[] = [];
  for (const f of order.frameCandidates) {
    const clip = clipOfSource.get(f.sourceId);
    if (clip === undefined) continue;
    const half = splitter.halfOf(clip.videoId, f.mediaS);
    if (half === null) continue;
    const input = inputOf.get(f.id) ?? null;
    frames.push({ half, input, record: { id: f.id, mediaS: f.mediaS, hasBefore: input !== null, videoId: clip.videoId } });
  }

  const common = { t: "lecture", lectureId: lectureIdOf(info), labelsFile: info.file, labelsSha256: info.sha256, captureId: view.captureId, captureStopped: order.status.state === "stopped" } as const;
  const record: Head<LectureRecord> =
    info.labels.schemaVersion === 1
      ? { ...common, videoId: clips[0]!.videoId, sourceId: clips[0]!.sourceId, spanS: clips[0]!.spanS, watched: clips[0]!.watched }
      : { ...common, clips };
  return { info, record, clips, splitter, windows, frames };
}

function windowRecord(w: BoundaryWindow, startS: number, endS: number, videoId: string): WindowRecord {
  return {
    id: w.id, captureId: w.captureId, ordinal: w.ordinal, startS, endS, newPassages: w.newPassages, contextPassages: w.contextPassages, frames: w.frames,
    newMaterial: Material.canonical(w.newMaterial), watchedSecondsAtEnd: w.watchedSecondsAtEnd, videoId,
  };
}

/** As the backend builds it (main.ts boundaryInput), so the lab sends what the product sends. */
function boundaryInputOf(evidence: EvidenceStoreWithProbe, window: BoundaryWindow): BoundaryInput {
  const found = evidence.get([...window.newPassages, ...window.contextPassages, ...window.frames]);
  const passages = (ids: readonly EvidenceId[]) => ids.map((id) => found.get(id)).filter(passageOf);
  return {
    window,
    newPassages: passages(window.newPassages),
    contextPassages: passages(window.contextPassages),
    frames: window.frames.map((id) => found.get(id)).filter(frameOf).map((frame) => ({
      frame,
      bytes: () => {
        const bytes = evidence.frameBytes(frame.id);
        if (bytes === null) throw new ProviderError(`frame bytes unavailable for ${frame.id}`, null, false);
        return bytes;
      },
    })),
  };
}

// ───────────────────────────── tasks, keys, cache ─────────────────────────────

const refusingJev: JevClient = {
  ask: () => Promise.reject(new LabRefusal("this code path must not call Jev")),
};

type Tasks = {
  readonly boundary: Task<BoundaryInput, unknown>;
  readonly frame: Task<FrameChangeInput, unknown>;
  /** The wording versions: "1" for the product's wording, `arm-<hash>` for any other, and part of every key. */
  readonly boundaryVersion: string;
  readonly frameVersion: string;
};
const tasksOver = (jev: JevClient, questions?: ArmQuestions): Tasks => {
  const b = questions === undefined ? undefined : boundaryQuestionsOf(questions);
  const f = questions === undefined ? undefined : frameQuestionsOf(questions);
  return { boundary: boundaryTask(jev, b), frame: frameChangeTask(jev, f), boundaryVersion: boundaryWordingVersion(b), frameVersion: frameChangeWordingVersion(f) };
};

/**
 * Independent of the thresholds (the product folds them into the task version): the lab stores raw p and applies thresholds when it scores.
 * The wording version is in the key, so a judgment made with other wording is never served; the product's wording is "1", as it always was.
 */
export const boundaryKey = (t: Tasks, i: BoundaryInput) => stableId("key", "jev-lab", "boundary", t.boundaryVersion, JEV_MODEL, t.boundary.canonicalInput(i));
export const frameKey = (t: Tasks, i: FrameChangeInput) => stableId("key", "jev-lab", "frame_change", t.frameVersion, JEV_MODEL, t.frame.canonicalInput(i));

/** Deterministic stand-in used without --live: the answer is a hash of the request, so it is repeatable and means nothing. */
export function deterministicFakeJev(): JevClient {
  return {
    async ask<Q extends string>(req: JevRequest<Q>) {
      const answers = {} as Record<Q, JevAnswer>;
      for (const id of Object.keys(req.questions) as Q[]) {
        const digest = new Bun.CryptoHasher("sha256").update(canonicalJson({ q: id, state: req.state as never })).digest();
        answers[id] = { type: "noul", p: ((digest[0]! << 8) | digest[1]!) / 65535 };
      }
      return { answers, usage: { model: req.model, inputTokens: Math.ceil(JSON.stringify(req.state).length / 4), outputTokens: 2, cacheReadTokens: null, cost: { kind: "unknown", reason: "fake client" } } };
    },
  };
}

// ───────────────────────────── persisted state ─────────────────────────────

export type LabState = {
  readonly version: 1;
  readonly callsUsed: number;
  readonly tuneRounds: number;
  readonly lastTune: { readonly round: number; readonly config: SegmentationConfig; readonly thresholds: Thresholds } | null;
  readonly scoreStatus: "none" | "in_progress" | "complete";
};

const EMPTY_STATE: LabState = { version: 1, callsUsed: 0, tuneRounds: 0, lastTune: null, scoreStatus: "none" };

const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

function validState(x: unknown): x is LabState {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  const lt = s.lastTune as Record<string, unknown> | null | undefined;
  const lastTuneOk = lt === null || (typeof lt === "object" && lt !== undefined && isCount(lt.round) && typeof lt.config === "object" && lt.config !== null && typeof lt.thresholds === "object" && lt.thresholds !== null);
  return s.version === 1 && isCount(s.callsUsed) && isCount(s.tuneRounds) && lastTuneOk && (s.scoreStatus === "none" || s.scoreStatus === "in_progress" || s.scoreStatus === "complete");
}

export function readState(dir: string): LabState {
  const path = join(dir, "state.json");
  if (!existsSync(path)) return EMPTY_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LabRefusal(`${path} is not valid JSON; refusing to guess the lab's counters. Restore it or ask Derek.`);
  }
  if (!validState(parsed)) throw new LabRefusal(`${path} is malformed (not a version 1 lab state); refusing to guess the lab's counters. Restore it or ask Derek.`);
  return parsed;
}

/**
 * state.json is the only counter, so deleting it must not reset the rails: what the run directory itself proves
 * (tune and score result files, cached judgments) sets a floor under the counters.
 */
function withFloors(dir: string, state: LabState, cachedJudgments: number): LabState {
  const runs = join(dir, "runs");
  const files = existsSync(runs) ? readdirSync(runs) : [];
  const tuneFiles = files.filter((f) => /^tune-\d+\.jsonl$/.test(f)).length;
  const scored = files.includes("score-1.jsonl");
  return {
    ...state,
    tuneRounds: Math.max(state.tuneRounds, tuneFiles),
    callsUsed: Math.max(state.callsUsed, cachedJudgments),
    scoreStatus: scored ? "complete" : state.scoreStatus,
  };
}

function writeState(dir: string, state: LabState): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `state.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, join(dir, "state.json"));
}

/**
 * Experiment 6 total (decision 6 and its Amendment 2, docs/experiments/06-model-optimized-jev.md): a hard 5,000 Jev
 * calls across every arm directory under <lab>/exp6/, retries included, on top of the per-directory BUDGET_CALLS.
 */
export const EXP6_BUDGET_CALLS = 5000;

/**
 * Calls already used by the OTHER arm directories of this origin: each one's state.json counter under the same floors
 * `withFloors` applies, so deleting an arm's state.json cannot lower the total.
 */
function exp6UsedByOthers(labDir: string, arm: string, origin: Origin): number {
  const root = join(labDir, "exp6");
  if (!existsSync(root)) return 0;
  let used = 0;
  for (const name of readdirSync(root)) {
    if (name === arm) continue;
    const d = join(root, name, origin);
    if (existsSync(d)) used += withFloors(d, readState(d), readCache(d).size).callsUsed;
  }
  return used;
}

function readCache(dir: string): Map<string, JudgmentRecord> {
  const path = join(dir, "judgments.jsonl");
  const out = new Map<string, JudgmentRecord>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim() !== "") out.set((JSON.parse(line) as JudgmentRecord).key, JSON.parse(line) as JudgmentRecord);
  return out;
}

function appendCache(dir: string, j: JudgmentRecord): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "judgments.jsonl"), JSON.stringify(j) + "\n");
}

// ───────────────────────────── guards ─────────────────────────────

/** Tune runs may touch only first halves and score runs only second halves. */
export function assertPhaseHalf(phase: Phase, items: readonly { readonly half: Half }[]): void {
  const want: Half = phase === "tune" ? "first" : "second";
  const bad = items.find((i) => i.half !== want);
  if (bad) refuse(`a ${phase} run may only use ${want} halves, but its work includes a ${bad.half}-half item; nothing was sent`);
}

export type Overrides = Partial<SegmentationConfig> & Partial<Thresholds>;
const CONFIG_KEYS = ["windowNewS", "contextS", "timeCapS", "maxFramesPerWindow", "reviseOnNextNoNo"] as const;
const THRESHOLD_KEYS = ["yesAtOrAbove", "noAtOrBelow"] as const;

/** Only the named knobs can change; anything else is off limits by protocol. */
export function resolveTuning(overrides: Overrides): { readonly config: SegmentationConfig; readonly thresholds: Thresholds } {
  const unknown = Object.keys(overrides).filter((k) => !(CONFIG_KEYS as readonly string[]).includes(k) && !(THRESHOLD_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) refuse(`${unknown.join(", ")} is not a tuning knob; allowed: ${[...CONFIG_KEYS, ...THRESHOLD_KEYS].join(", ")}`);
  const config: SegmentationConfig = { ...SEGMENTATION_DEFAULTS, ...pick(overrides, CONFIG_KEYS) };
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...pick(overrides, THRESHOLD_KEYS) };
  if (!segmentationInRange(config)) {
    refuse("tuning config out of range: windowNewS > 0, contextS >= 0, timeCapS > windowNewS, maxFramesPerWindow an integer 0 to 4");
  }
  if (!thresholdsInRange(thresholds)) refuse("thresholds out of range: 0 <= noAtOrBelow < yesAtOrAbove <= 1");
  return { config, thresholds };
}

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// ───────────────────────────── plan ─────────────────────────────

export type Plan = { readonly lines: readonly string[]; readonly tuneRoundCalls: number; readonly scoreCalls: number; readonly overBudget: boolean };

/** Counts the calls a run would make from the real windowing and the real frame inputs. Opens no client; makes no call. */
export function planLab(opts: { readonly dataDir: string; readonly labelFiles: readonly string[]; readonly armConfig?: ArmConfig; readonly cacheDir?: string }): Plan {
  const infos = loadLabels(opts.labelFiles);
  const cap = openCapture(opts.dataDir);
  try {
    const tasks = tasksOver(refusingJev, opts.armConfig?.questions);
    const cfg = opts.armConfig?.segmentation ?? SEGMENTATION_DEFAULTS;
    // An arm's own stored judgments (same wording version, same window ids) cost nothing; everything else is new.
    const cached = opts.armConfig !== undefined && opts.cacheDir !== undefined ? new Set(readCache(opts.cacheDir).keys()) : new Set<string>();
    const lines: string[] = ["Jev lab plan: counts only, no call is made."];
    if (opts.armConfig !== undefined) {
      lines.push(
        `Arm config: windowNewS=${cfg.windowNewS}, contextS=${cfg.contextS}, timeCapS=${cfg.timeCapS}, maxFramesPerWindow=${cfg.maxFramesPerWindow}, reviseOnNextNoNo=${cfg.reviseOnNextNoNo}; wording versions boundary ${tasks.boundaryVersion}, frame change ${tasks.frameVersion}` +
          `${isProductWording(opts.armConfig.questions) ? " (the product's wording)" : " (changed wording: every window and frame-change judgment of it is new)"}; ${cached.size} judgment(s) already stored for this arm`,
      );
    }
    let tune = 0;
    let score = 0;
    for (const info of infos) {
      const w = lectureWork(cap, info, cfg);
      const keys = (half: Half) => ({
        windows: new Set(w.windows.filter((x) => x.half === half).map((x) => boundaryKey(tasks, x.input)).filter((k) => !cached.has(k))).size,
        frames: new Set(w.frames.filter((x) => x.half === half && x.input !== null).map((x) => frameKey(tasks, x.input!)).filter((k) => !cached.has(k))).size,
      });
      const a = keys("first");
      const b = keys("second");
      tune += a.windows + a.frames;
      score += b.windows + b.frames;
      const set = w.clips.length > 1;
      const clipsOfHalf = (h: Half) => `${set ? ` (clips ${w.clips.findIndex((c) => c.videoId === w.splitter.clipsIn(h)[0]!.videoId) + 1}-${w.clips.findIndex((c) => c.videoId === w.splitter.clipsIn(h).at(-1)!.videoId) + 1})` : ""}`;
      lines.push(`${lectureIdOf(info)}: first half${clipsOfHalf("first")} ${a.windows} windows + ${a.frames} frame calls; second half${clipsOfHalf("second")} ${b.windows} windows + ${b.frames} frame calls (${opts.armConfig === undefined ? "default config" : "arm config, new calls only"})`);
      if (set) lines.push(...setPlanLines(info, w));
    }
    const minimum = tune + score;
    const worst = MAX_TUNE_ROUNDS * tune + score;
    lines.push(
      `One tune round (first halves, nothing cached): ${tune} calls`,
      `The scored run (second halves): ${score} calls`,
      `One tune round plus the scored run: ${minimum} of ${BUDGET_CALLS} budgeted: ${minimum > BUDGET_CALLS ? "OVER BUDGET" : "within budget"}`,
      `Worst case, ${MAX_TUNE_ROUNDS} tune rounds that each change windowNewS or contextS (every window re-judged) plus the scored run: ${worst}${worst > BUDGET_CALLS ? ` (over ${BUDGET_CALLS}: the run counter would refuse the call that crosses it)` : ""}`,
      "A round that changes only thresholds, timeCapS, maxFramesPerWindow or reviseOnNextNoNo reuses stored judgments only where the window ids are unchanged; retries add calls.",
      `Budget: "${BUDGET_TEXT}"`,
    );
    return { lines, tuneRoundCalls: tune, scoreCalls: score, overBudget: minimum > BUDGET_CALLS };
  } finally {
    cap.close();
  }
}

/** Where a set splits and what that does to its boundary labels, exactly: from the real windows, not an estimate. */
function setPlanLines(info: LabelInfo, w: LectureWork): string[] {
  const sp = w.splitter;
  const view = viewOf(info.labels);
  const secs = (n: number) => Number(n.toFixed(3));
  const lines = [`  split at the join before clip ${sp.joinIndex + 1} (watched ${secs(sp.beforeS)} s before, ${secs(sp.afterS)} s after, midpoint of ${secs(sp.totalS)} s is ${secs(sp.midpointS)} s)`];
  for (const half of ["first", "second"] as const) {
    const first = w.windows.filter((x) => x.half === half).sort((x, y) => x.record.ordinal - y.record.ordinal)[0]?.record;
    const labels = view.boundaries.filter((b) => sp.halfOf(b.videoId, b.mediaS) === half);
    const starts = labels.filter((b) => {
      const at = view.clips.findIndex((c) => c.videoId === b.videoId);
      return at > 0 && b.mediaS - view.clips[at]!.spanS.start < SEGMENTATION_DEFAULTS.windowNewS;
    });
    const excluded = labels.filter((b) => isInFirstWindow(b, first === undefined ? undefined : { videoId: first.videoId!, endS: first.endS }));
    lines.push(`  ${half} half: ${labels.length} boundary labels (${starts.length} at a clip start), ${excluded.length} in the half's first window and excluded from recall (PROPOSED, Amendment 1)`);
  }
  return lines;
}

// ───────────────────────────── run ─────────────────────────────

export type RunOptions = {
  readonly dataDir: string;
  readonly labDir: string;
  readonly labelFiles: readonly string[];
  readonly phase: Phase;
  readonly live: boolean;
  readonly maxCalls?: number;
  readonly keysPath?: string;
  readonly overrides?: Overrides;
  /** Experiment 6: the arm's name (directory <lab>/exp6/<arm>/<origin>) and, for a tune round, its config file's content. */
  readonly arm?: string;
  readonly armConfig?: ArmConfig;
  /** Offline seams. `client` is used only without --live; `fetch` reaches the real adapter only with --live. */
  readonly client?: JevClient;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly retryDelayMs?: (failures: number) => number;
  readonly out?: (line: string) => void;
};

export type RunOutcome = { readonly report: Report; readonly resultsPath: string; readonly reportPath: string; readonly newCalls: number };

const sleep = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms)));

export async function runLab(opts: RunOptions): Promise<RunOutcome> {
  let secret: string | null = null;
  const redact = (s: string) => (secret === null ? s : s.split(secret).join("[redacted]"));
  const say = (line: string) => opts.out?.(redact(line));
  try {
    return await runGuarded(opts, (key) => void (secret = key), redact, say);
  } catch (e) {
    if (e instanceof LabRefusal) throw new LabRefusal(redact(e.message));
    throw new Error(redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  }
}

async function runGuarded(opts: RunOptions, hold: (key: string) => void, redact: (s: string) => string, say: (line: string) => void): Promise<RunOutcome> {
  if (opts.phase !== "tune" && opts.phase !== "score") refuse(`--phase must be tune or score, got ${String(opts.phase)}`);
  const infos = loadLabels(opts.labelFiles);
  const origin: Origin = opts.live ? "live" : "fixture";
  const arm = opts.arm;
  if (arm !== undefined && !ARM_NAME.test(arm)) refuse(`--arm must be letters, digits and dashes, got "${arm}"`);
  if (arm === undefined && opts.armConfig !== undefined) refuse("--arm-config needs --arm <name>");
  const dir = arm === undefined ? join(opts.labDir, origin) : join(opts.labDir, "exp6", arm, origin);
  let state = withFloors(dir, readState(dir), readCache(dir).size);
  const hasKnobs = opts.overrides !== undefined && Object.keys(opts.overrides).length > 0;

  if (opts.phase === "score") {
    if (hasKnobs) refuse(arm === undefined ? "a scored run takes no tuning flags: it uses the config of the last tune round" : "a scored run takes no tuning flags: it uses the arm's selected tune round");
    if (opts.armConfig !== undefined) refuse("a scored run takes no --arm-config: it uses the arm's selected tune round");
    if (state.scoreStatus === "complete") refuse("the held-out half was already scored once; it is never scored again. Read it back with: rescore --results <file> --labels <files>");
    if (state.lastTune === null) refuse("no tune round has run yet; run a tune round first (a tune round with the defaults counts as one)");
    const unsigned = infos.filter((i) => i.labels.status !== "signed_off");
    if (unsigned.length > 0) refuse(`the scored run needs signed_off labels; not signed off: ${unsigned.map((i) => i.file).join(", ")}`);
  } else {
    if (arm !== undefined) {
      if (hasKnobs) refuse("an arm run takes its tuning from --arm-config, not from the per-knob tuning flags; nothing was sent");
      if (opts.armConfig === undefined) refuse("an arm tune round needs --arm-config <file>; nothing was sent");
    }
    if (state.scoreStatus === "complete") refuse("the held-out half was already scored; tuning after seeing it would tune on the held-out data. Read it back with: rescore --results <file> --labels <files>");
    if (state.tuneRounds >= MAX_TUNE_ROUNDS) refuse(`${MAX_TUNE_ROUNDS} tuning rounds are already used; there is no fourth`);
  }

  let apiKey: string | null = null;
  if (opts.live) {
    const unsigned = infos.filter((i) => i.labels.status !== "signed_off");
    if (unsigned.length > 0) refuse(`a live run needs signed_off labels; not signed off: ${unsigned.map((i) => i.file).join(", ")}`);
    if (opts.maxCalls === undefined) refuse("a live run needs --max-calls <n>");
    if (!Number.isInteger(opts.maxCalls) || opts.maxCalls < 1 || opts.maxCalls > BUDGET_CALLS) refuse(`--max-calls must be an integer from 1 to ${BUDGET_CALLS}, got ${String(opts.maxCalls)}`);
    const keysPath = opts.keysPath ?? DEFAULT_KEYS_PATH;
    if (!existsSync(keysPath)) refuse(`no keys file at ${keysPath}; a live run needs TYPESAFE_API_KEY there`);
    try {
      apiKey = readKeys(keysPath).TYPESAFE_API_KEY ?? null;
    } catch (e) {
      refuse(e instanceof Error ? e.message : "cannot read the keys file");
    }
    if (apiKey === null) refuse(`${keysPath} has no TYPESAFE_API_KEY; a live run needs it`);
    hold(apiKey!);
  }

  let questions: ArmQuestions = PRODUCT_QUESTIONS;
  let selected: { readonly round: number; readonly reason: string } | null = null;
  let tuning: { readonly config: SegmentationConfig; readonly thresholds: Thresholds };
  if (opts.phase === "tune") {
    if (arm === undefined) tuning = resolveTuning(opts.overrides ?? {});
    else {
      const checked = validateArmConfig(opts.armConfig);
      if (!checked.ok) return refuse(`the arm config is refused:\n${checked.errors.map((e) => `  ${e}`).join("\n")}`);
      questions = checked.config.questions;
      tuning = { config: checked.config.segmentation, thresholds: checked.config.thresholds };
    }
  } else if (arm === undefined) tuning = { config: state.lastTune!.config, thresholds: state.lastTune!.thresholds };
  else {
    // Decision 5: the arm is scored on its selected tune round, picked from the first-half reports alone.
    const runs = join(dir, "runs");
    const rounds = (existsSync(runs) ? readdirSync(runs) : []).flatMap((f) => (/^tune-(\d+)\.jsonl$/.test(f) ? [Number(/^tune-(\d+)\.jsonl$/.exec(f)![1])] : []));
    if (rounds.length === 0) refuse("no tune round results are stored for this arm; run a tune round first");
    const stored = rounds.map((n) => ({ round: n, results: parseResults(readFileSync(join(runs, `tune-${n}.jsonl`), "utf8")), report: reportFromFile(join(runs, `tune-${n}.jsonl`), opts.labelFiles) }));
    selected = selectRound(stored.map((r) => ({ round: r.round, report: r.report })));
    const header = stored.find((r) => r.round === selected!.round)!.results.header;
    tuning = { config: header.config, thresholds: header.thresholds };
    questions = header.questions ?? PRODUCT_QUESTIONS;
  }
  const { config, thresholds } = tuning;
  const round = opts.phase === "tune" ? state.tuneRounds + 1 : 1;
  const runId = `${opts.phase}-${round}`;
  const now = opts.now ?? Date.now;

  const calls: { current: CallRecord[]; p: Record<string, number | null> } = { current: [], p: {} };
  const inner: JevClient = opts.live ? createJevClient({ apiKey: apiKey!, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) : (opts.client ?? deterministicFakeJev());
  let runCalls = 0;
  const jev: JevClient = {
    async ask<Q extends string>(req: JevRequest<Q>, signal: AbortSignal) {
      if (state.callsUsed >= BUDGET_CALLS) refuse(`the lab's ${BUDGET_CALLS}-call budget is spent (${state.callsUsed} used); no further call is made`);
      if (arm !== undefined) {
        const total = exp6UsedByOthers(opts.labDir, arm, origin) + state.callsUsed;
        if (total >= EXP6_BUDGET_CALLS) refuse(`the experiment 6 budget of ${EXP6_BUDGET_CALLS} Jev calls across the arm directories is spent (${total} used); no further call is made`);
      }
      if (opts.maxCalls !== undefined && runCalls >= opts.maxCalls) refuse(`--max-calls ${opts.maxCalls} reached; aborting before the next call`);
      state = { ...state, callsUsed: state.callsUsed + 1 };
      writeState(dir, state);
      runCalls++;
      const startedAtMs = now();
      try {
        const res = await inner.ask(req, signal);
        calls.current.push({ startedAtMs, durationMs: Math.max(0, now() - startedAtMs), inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, ok: true });
        for (const id of Object.keys(res.answers) as Q[]) {
          const a = res.answers[id];
          calls.p[id] = a.type === "noul" && Number.isFinite(a.p) ? a.p : null;
        }
        return res;
      } catch (e) {
        const usage = e instanceof ProviderError ? e.usage : null;
        calls.current.push({ startedAtMs, durationMs: Math.max(0, now() - startedAtMs), inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, ok: false });
        throw e;
      }
    },
  };
  const tasks = tasksOver(jev, arm === undefined ? undefined : questions);

  const cap = openCapture(opts.dataDir);
  try {
    const lectures = infos.map((info) => lectureWork(cap, info, config));
    const want: Half = opts.phase === "tune" ? "first" : "second";
    const work = lectures.map((l) => ({ ...l, windows: l.windows.filter((w) => w.half === want), frames: l.frames.filter((f) => f.half === want) }));
    assertPhaseHalf(opts.phase, work.flatMap((l) => [...l.windows, ...l.frames]));

    const cache = readCache(dir);
    const subjects = work.flatMap((l) => [
      ...l.windows.map((w) => ({ lecture: l, videoId: w.record.videoId!, purpose: "boundary" as const, subject: w.record.id, key: boundaryKey(tasks, w.input), run: () => judgeBoundary(w.input) })),
      ...l.frames.flatMap((f) => (f.input === null ? [] : [{ lecture: l, videoId: f.record.videoId!, purpose: "frame_change" as const, subject: f.record.id, key: frameKey(tasks, f.input), run: () => judgeFrame(f.input!) }])),
    ]);
    const needed = new Set(subjects.filter((s) => !cache.has(s.key)).map((s) => s.key)).size;
    if (opts.live) {
      if (needed > opts.maxCalls!) refuse(`this run needs ${needed} new calls and --max-calls is ${opts.maxCalls}; no call was made`);
      if (state.callsUsed + needed > BUDGET_CALLS) refuse(`this run needs ${needed} new calls and ${state.callsUsed} of ${BUDGET_CALLS} are used; no call was made`);
      if (arm !== undefined) {
        const used = exp6UsedByOthers(opts.labDir, arm, origin) + state.callsUsed;
        if (used + needed > EXP6_BUDGET_CALLS) refuse(`this run needs ${needed} new calls and ${used} of ${EXP6_BUDGET_CALLS} are used across the experiment 6 arm directories; no call was made`);
      }
    }

    if (opts.phase === "score") {
      state = { ...state, scoreStatus: "in_progress" };
      writeState(dir, state);
    }

    const attempt = async <I>(task: Task<I, unknown>, input: I): Promise<{ readonly calls: CallRecord[]; readonly p: Record<string, number | null>; readonly error: string | null }> => {
      calls.current = [];
      calls.p = {};
      for (let n = 1; n <= task.maxAttempts; n++) {
        try {
          await task.attempt(input, { signal: new AbortController().signal, streamTo: null });
          return { calls: calls.current, p: calls.p, error: null };
        } catch (e) {
          if (e instanceof LabRefusal) throw e;
          if (e instanceof ProviderError && e.retryable && n < task.maxAttempts) {
            await sleep((opts.retryDelayMs ?? ((k: number) => Math.min(30_000, 1000 * 2 ** (k - 1))))(n));
            continue;
          }
          return { calls: calls.current, p: calls.p, error: redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
        }
      }
      return { calls: calls.current, p: calls.p, error: "no attempt was made" };
    };
    const judgeBoundary = (i: BoundaryInput) => attempt(tasks.boundary, i);
    const judgeFrame = (i: FrameChangeInput) => attempt(tasks.frame, i);

    const judgments: JudgmentRecord[] = [];
    let newCalls = 0;
    for (const s of subjects) {
      const hit = cache.get(s.key);
      if (hit) {
        judgments.push({ ...hit, lectureId: s.lecture.record.lectureId, videoId: s.videoId, reused: true });
        continue;
      }
      const done = await s.run();
      const record: JudgmentRecord = {
        t: "judgment", lectureId: s.lecture.record.lectureId, videoId: s.videoId, purpose: s.purpose, subject: s.subject, key: s.key, model: JEV_MODEL,
        questionVersion: s.purpose === "boundary" ? tasks.boundaryVersion : tasks.frameVersion, reused: false, calls: done.calls, p: done.p, error: done.error,
      };
      newCalls += done.calls.length;
      if (record.error === null) {
        appendCache(dir, record);
        cache.set(s.key, record);
      }
      judgments.push(record);
    }

    const failed = judgments.filter((j) => j.error !== null);
    if (failed.length > 0) {
      throw new LabRefusal(
        `${failed.length} of ${judgments.length} judgments failed (first: ${failed[0]!.error}); nothing was scored and no ${opts.phase === "tune" ? "tuning round" : "scoring"} was used up. ` +
          `Run the same command again: only the failed judgments are retried, the rest are reused. If the same one keeps failing, stop and ask Derek.`,
      );
    }

    const header: RunHeader = {
      t: "header", version: 1, runId, phase: opts.phase, round, origin, model: JEV_MODEL, config, thresholds,
      ...(arm === undefined ? {} : { arm }),
      ...(arm !== undefined && !isProductWording(questions) ? { questions } : {}),
      ...(selected === null ? {} : { selectedRound: selected.round, selectionReason: selected.reason }),
    };
    const results: ParsedResults = {
      header,
      lectures: work.map((l): LectureRecord => ({ ...l.record, half: want, windows: l.windows.map((w) => w.record), frames: l.frames.map((f) => f.record) }) as LectureRecord),
      judgments,
      end: { t: "end", newCalls, judgments: judgments.length },
    };
    mkdirSync(join(dir, "runs"), { recursive: true });
    const resultsPath = join(dir, "runs", `${runId}.jsonl`);
    writeFileSync(resultsPath, serializeResults(results));
    const report = reportFromFile(resultsPath, opts.labelFiles);
    const reportPath = join(dir, "runs", `${runId}.report.txt`);
    writeFileSync(reportPath, report.text);

    state = opts.phase === "tune" ? { ...state, tuneRounds: round, lastTune: { round, config, thresholds } } : { ...state, scoreStatus: "complete" };
    writeState(dir, state);
    for (const line of report.text.split("\n")) if (line !== "") say(line);
    return { report, resultsPath, reportPath, newCalls };
  } finally {
    cap.close();
  }
}

/** The only path from stored judgments to a report: `run` and `rescore` both use it, so they cannot differ. */
export function reportFromFile(resultsPath: string, labelFiles: readonly string[]): Report {
  return buildReport({ results: parseResults(readFileSync(resultsPath, "utf8")), labels: loadLabels(labelFiles) });
}

// ───────────────────────────── draft labels ─────────────────────────────

/** Cues for a draft only. Constants of a starting point Derek corrects, not of any measurement. */
export const DRAFT_PAUSE_S = 3;
export const DRAFT_MIN_SPACING_S = 60;
export const DRAFT_SIZE_CHANGE = 0.15;

export function draftLabels(opts: { readonly dataDir: string; readonly captureId: string; readonly videoId?: string; readonly outPath: string; readonly force?: boolean }): { readonly path: string; readonly notes: readonly string[] } {
  if (existsSync(opts.outPath) && !opts.force) refuse(`${opts.outPath} already exists; labels are Derek's work, so it is not overwritten (pass --force to replace it)`);
  const cap = openCapture(opts.dataDir);
  try {
    const bundle = cap.evidence.captureBundle(opts.captureId as CaptureId);
    const view = cap.evidence.captureView(opts.captureId as CaptureId);
    if (bundle.watched.length === 0) refuse(`capture ${opts.captureId} has no watched time; is the id right?`);
    const watchedOf = (sourceId: string) => (bundle.watched.find((w) => w.sourceId === sourceId)?.intervals ?? []).reduce((a, [s, e]) => a + (e - s), 0);
    const withVideo = view.sources.map((s) => ({ ...s, watchedS: watchedOf(s.id) })).filter((s) => s.watchedS > 0);
    const source = opts.videoId !== undefined ? withVideo.find((s) => s.videoId === opts.videoId) : [...withVideo].sort((a, b) => b.watchedS - a.watchedS)[0];
    if (!source) return refuse(opts.videoId !== undefined ? `capture ${opts.captureId} has no watched video ${opts.videoId}; it has: ${withVideo.map((s) => s.videoId).join(", ")}` : "the capture has no watched source");
    const notes = withVideo.length > 1 && opts.videoId === undefined ? [`the capture has ${withVideo.length} watched videos; drafted ${source.videoId} (most watched). Others: ${withVideo.filter((s) => s.id !== source.id).map((s) => s.videoId).join(", ")}. Pass --video <id> for another, one file per lecture.`] : [];

    const intervals = bundle.watched.find((w) => w.sourceId === source.id)!.intervals;
    const spanS = { start: Math.min(...intervals.map(([a]) => a)), end: Math.max(...intervals.map(([, b]) => b)) };
    const within = (a: number, b: number) => intervals.some(([s, e]) => a >= s && b <= e);

    const passages = bundle.passages.filter((p) => p.sourceId === source.id).sort((a, b) => a.start - b.start);
    const pauses = passages.slice(1).flatMap((p, i) => {
      const len = p.start - passages[i]!.end;
      return len >= DRAFT_PAUSE_S && within(passages[i]!.end, p.start) ? [{ at: p.start, len }] : [];
    });
    const kept: { at: number; len: number }[] = [];
    for (const c of [...pauses].sort((a, b) => b.len - a.len || a.at - b.at)) if (kept.every((k) => Math.abs(k.at - c.at) >= DRAFT_MIN_SPACING_S)) kept.push(c);

    const frames = bundle.frames.filter((f) => f.sourceId === source.id && f.file !== null && existsSync(f.file)).sort((a, b) => a.mediaS - b.mediaS);
    const bytes = frames.map((f) => {
      const raw = readFileSync(f.file!);
      return { f, size: raw.length, hash: new Bun.CryptoHasher("sha256").update(raw).digest("hex") };
    });
    const steps = bytes.flatMap((b, i) => (i > 0 && b.hash !== bytes[i - 1]!.hash && Math.abs(b.size - bytes[i - 1]!.size) / bytes[i - 1]!.size >= DRAFT_SIZE_CHANGE ? [{ mediaS: b.f.mediaS, cue: `frame whose JPEG size differs ${fmtPct(Math.abs(b.size - bytes[i - 1]!.size) / bytes[i - 1]!.size)} from the previous candidate frame: a cheap change cue, not a judgment` }] : []));
    const byHash = new Map<string, typeof bytes>();
    for (const b of bytes) byHash.set(b.hash, [...(byHash.get(b.hash) ?? []), b]);
    const groups = [...byHash.values()].filter((g) => g.length >= 2);

    const draft: LabelFile = {
      schemaVersion: 1,
      status: "draft",
      signedOffBy: null,
      signedOffAt: null,
      description: "DRAFT labels. Not Derek's labels until he corrects them and signs off.",
      draftNote: `This is a draft starting point built deterministically from the capture, not truth. No model was used. Boundary candidates are caption pauses of at least ${DRAFT_PAUSE_S}s (the longest in each ${DRAFT_MIN_SPACING_S}s stretch). Visual step candidates are frames whose JPEG size jumped by ${DRAFT_SIZE_CHANGE * 100}% or more. Duplicate candidates are frames with byte-identical JPEGs only; near-identical frames are not computed because no image decoder is available, so add those by hand. Every item is unconfirmed: set confirmed to true for each you agree with, delete or add the rest, then set status, signedOffBy and signedOffAt.`,
      lecture: { captureId: opts.captureId, videoId: source.videoId, ...(source.title ? { title: source.title } : {}), spanS },
      boundaries: kept.sort((a, b) => a.at - b.at).map((k) => ({ mediaS: k.at, note: "candidate topic boundary", confirmed: false, cue: `caption pause of ${Number(k.len.toFixed(1))}s before this point` })),
      visualSteps: steps.map((s) => ({ mediaS: s.mediaS, note: "candidate visual step", confirmed: false, cue: s.cue })),
      duplicateGroups: groups.map((g) => ({ note: "candidate duplicate group", confirmed: false, cue: "byte-identical JPEG files", frames: g.map((b) => ({ mediaS: b.f.mediaS, frameId: b.f.id })) })),
    };
    const checked = validateLabels(draft);
    if (!checked.ok) throw new Error(`draft-labels produced an invalid file: ${checked.errors.join("; ")}`);
    mkdirSync(dirname(resolve(opts.outPath)), { recursive: true });
    writeFileSync(opts.outPath, JSON.stringify(draft, null, 2) + "\n");
    return { path: opts.outPath, notes: [...notes, `${draft.boundaries.length} boundary, ${draft.visualSteps.length} visual step and ${draft.duplicateGroups.length} duplicate-group candidates, all unconfirmed`] };
  } finally {
    cap.close();
  }
}

/** Amendment 1, the labeling rule for a visual step (Derek's words, verbatim). A draft cue only suggests; it never decides. */
export const VISUAL_STEP_RULE = "A visual step is when the actual slide content changes (new text or a new figure shown on screen). The same slide staying up across several transcript passages is not a new step.";

/**
 * One draft for a whole capture (Amendment 1): the clips in watch order, a boundary candidate at the start of every clip
 * after the first (no candidate inside a clip: the join is the boundary), and the visual step and duplicate candidates of
 * `draft-labels`, with frames compared only with the previous frame of their own clip. Every item is unconfirmed.
 */
export function draftLabelsSet(opts: { readonly dataDir: string; readonly captureId: string; readonly outPath: string; readonly force?: boolean }): { readonly path: string; readonly notes: readonly string[] } {
  if (existsSync(opts.outPath) && !opts.force) refuse(`${opts.outPath} already exists; labels are Derek's work, so it is not overwritten (pass --force to replace it)`);
  const cap = openCapture(opts.dataDir);
  try {
    const bundle = cap.evidence.captureBundle(opts.captureId as CaptureId);
    const view = cap.evidence.captureView(opts.captureId as CaptureId);
    const clips = view.sources.flatMap((source) => {
      const intervals = bundle.watched.find((w) => w.sourceId === source.id)?.intervals ?? [];
      return intervals.length === 0 ? [] : [{ source, spanS: { start: Math.min(...intervals.map(([a]) => a)), end: Math.max(...intervals.map(([, b]) => b)) } }];
    });
    if (clips.length === 0) refuse(`capture ${opts.captureId} has no watched time; is the id right?`);
    const clipNo = new Map(clips.map((c, i) => [c.source.id as string, i] as const));

    const frames = bundle.frames
      .filter((f) => clipNo.has(f.sourceId) && f.file !== null && existsSync(f.file))
      .sort((a, b) => clipNo.get(a.sourceId)! - clipNo.get(b.sourceId)! || a.mediaS - b.mediaS);
    const bytes = frames.map((f) => {
      const raw = readFileSync(f.file!);
      return { f, videoId: clips[clipNo.get(f.sourceId)!]!.source.videoId, size: raw.length, hash: new Bun.CryptoHasher("sha256").update(raw).digest("hex") };
    });
    const steps = bytes.flatMap((b, i) => {
      const prev = bytes[i - 1];
      if (prev === undefined || prev.f.sourceId !== b.f.sourceId || b.hash === prev.hash || Math.abs(b.size - prev.size) / prev.size < DRAFT_SIZE_CHANGE) return [];
      return [{ videoId: b.videoId, mediaS: b.f.mediaS, change: Math.abs(b.size - prev.size) / prev.size }];
    });
    const byHash = new Map<string, typeof bytes>();
    for (const b of bytes) byHash.set(b.hash, [...(byHash.get(b.hash) ?? []), b]);
    const groups = [...byHash.values()].filter((g) => g.length >= 2);

    const draft: LabelFileV2 = {
      schemaVersion: 2,
      status: "draft",
      signedOffBy: null,
      signedOffAt: null,
      description: "DRAFT labels. Not Derek's labels until he corrects them and signs off.",
      draftNote:
        "This is a draft starting point built deterministically from the capture, not truth. No model was used. The lecture is the set of clips of this capture in watch order, so the boundaries are the joins between clips: " +
        "there is one candidate at the start of every clip after the first, and none inside a clip. " +
        `${VISUAL_STEP_RULE} Visual step candidates are frames whose JPEG size jumped by ${DRAFT_SIZE_CHANGE * 100}% or more against the previous candidate frame of the same clip; that is a cheap cue and only a suggestion, so confirm only the changes of slide content. ` +
        "Duplicate candidates are frames with byte-identical JPEGs only (a group may span clips); near-identical frames are not computed because no image decoder is available, so add those by hand. " +
        "Every item is unconfirmed: set confirmed to true for each you agree with, delete or add the rest, then set status, signedOffBy and signedOffAt.",
      lecture: { captureId: opts.captureId, videos: clips.map((c) => ({ videoId: c.source.videoId, ...(c.source.title ? { title: c.source.title } : {}), spanS: c.spanS })) },
      boundaries: clips.slice(1).map((c, i) => ({ videoId: c.source.videoId, mediaS: c.spanS.start, note: "candidate clip join", confirmed: false, cue: `start of clip ${i + 2}: the product treats the next clip's first window as the decision point` })),
      visualSteps: steps.map((s) => ({
        videoId: s.videoId, mediaS: s.mediaS, note: "candidate visual step", confirmed: false,
        cue: `frame whose JPEG size differs ${fmtPct(s.change)} from the previous candidate frame of this clip: a suggestion only, not a judgment. A visual step is when the actual slide content changes (new text or a new figure shown on screen), not when the same slide stays up`,
      })),
      duplicateGroups: groups.map((g) => ({ note: "candidate duplicate group", confirmed: false, cue: "byte-identical JPEG files", frames: g.map((b) => ({ videoId: b.videoId, mediaS: b.f.mediaS, frameId: b.f.id })) })),
    };
    const checked = validateLabels(draft);
    if (!checked.ok) throw new Error(`draft-labels-set produced an invalid file: ${checked.errors.join("; ")}`);
    mkdirSync(dirname(resolve(opts.outPath)), { recursive: true });
    writeFileSync(opts.outPath, JSON.stringify(draft, null, 2) + "\n");
    return { path: opts.outPath, notes: [`${clips.length} clip(s) in watch order; ${draft.boundaries.length} join, ${draft.visualSteps.length} visual step and ${draft.duplicateGroups.length} duplicate-group candidates, all unconfirmed`] };
  } finally {
    cap.close();
  }
}

const fmtPct = (x: number) => `${Number((x * 100).toFixed(0))}%`;

// ───────────────────────────── command line ─────────────────────────────

const tag = (origin: Origin, lines: readonly string[]) => lines.map((l) => (l === "" ? l : `[${origin}] ${l}`)).join("\n");

async function cli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      data: { type: "string" }, capture: { type: "string" }, video: { type: "string" }, out: { type: "string" }, force: { type: "boolean" },
      labels: { type: "string", multiple: true }, lab: { type: "string" }, phase: { type: "string" }, live: { type: "boolean" }, "max-calls": { type: "string" },
      keys: { type: "string" }, origin: { type: "string", default: "fixture" }, results: { type: "string" }, expect: { type: "string" },
      "window-new-s": { type: "string" }, "context-s": { type: "string" }, "time-cap-s": { type: "string" }, "max-frames-per-window": { type: "string" },
      "revise-on-next-no-no": { type: "string" }, "yes-at": { type: "string" }, "no-at": { type: "string" },
      arm: { type: "string" }, "arm-config": { type: "string" },
    },
  });
  if (values.origin !== "fixture" && values.origin !== "live") return usage("--origin must be fixture or live");
  const origin: Origin = values.origin;
  const labels = values.labels ?? [];
  const num = (name: string, v: string | undefined) => (v === undefined ? undefined : Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : refuse(`--${name} must be a number, got "${v}"`));

  const readArmConfig = (): ArmConfig | undefined => {
    if (values["arm-config"] === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(resolve(values["arm-config"]), "utf8"));
    } catch {
      return refuse(`cannot read ${values["arm-config"]} as JSON`);
    }
    const checked = validateArmConfig(json);
    if (!checked.ok) return refuse(`${values["arm-config"]} is not a valid arm config:\n${checked.errors.map((e) => `  ${e}`).join("\n")}`);
    return checked.config;
  };

  switch (command) {
    case "draft-labels": {
      if (!values.data || !values.capture || !values.out) return usage("draft-labels needs --data, --capture and --out");
      const done = draftLabels({ dataDir: resolve(values.data), captureId: values.capture, outPath: resolve(values.out), ...(values.video ? { videoId: values.video } : {}), ...(values.force ? { force: true } : {}) });
      console.log(tag(origin, [`Wrote a DRAFT label file to ${done.path}. It is a starting point for Derek to correct, not truth.`, ...done.notes.map((n) => `note: ${n}`)]));
      return 0;
    }
    case "draft-labels-set": {
      if (!values.data || !values.capture || !values.out) return usage("draft-labels-set needs --data, --capture and --out");
      const done = draftLabelsSet({ dataDir: resolve(values.data), captureId: values.capture, outPath: resolve(values.out), ...(values.force ? { force: true } : {}) });
      console.log(tag(origin, [`Wrote a DRAFT label file for the whole capture to ${done.path}. It is a starting point for Derek to correct, not truth.`, ...done.notes.map((n) => `note: ${n}`)]));
      return 0;
    }
    case "split": {
      if (labels.length === 0) return usage("split needs --labels <file>");
      console.log(tag(origin, ["Tune and held-out split (a one-video lecture splits at the midpoint of its span, a set of clips at the clip join nearest the midpoint of its watched time; the first half is tune, the second is held-out, scored once):", ...describeSplit(loadLabels(labels), values.data ? resolve(values.data) : undefined)]));
      return 0;
    }
    case "plan": {
      if (!values.data || labels.length === 0) return usage("plan needs --data and --labels <file>");
      const armConfig = readArmConfig();
      const cacheDir = armConfig !== undefined && values.lab !== undefined && values.arm !== undefined ? join(resolve(values.lab), "exp6", values.arm, origin) : undefined;
      const plan = planLab({ dataDir: resolve(values.data), labelFiles: labels, ...(armConfig ? { armConfig } : {}), ...(cacheDir ? { cacheDir } : {}) });
      console.log(tag(origin, plan.lines));
      return plan.overBudget ? 1 : 0;
    }
    case "run": {
      if (!values.data || !values.lab || labels.length === 0 || (values.phase !== "tune" && values.phase !== "score")) return usage("run needs --data, --lab, --labels <file> and --phase tune|score");
      const overrides: Overrides = {
        ...(values["window-new-s"] !== undefined ? { windowNewS: num("window-new-s", values["window-new-s"])! } : {}),
        ...(values["context-s"] !== undefined ? { contextS: num("context-s", values["context-s"])! } : {}),
        ...(values["time-cap-s"] !== undefined ? { timeCapS: num("time-cap-s", values["time-cap-s"])! } : {}),
        ...(values["max-frames-per-window"] !== undefined ? { maxFramesPerWindow: num("max-frames-per-window", values["max-frames-per-window"])! } : {}),
        ...(values["revise-on-next-no-no"] !== undefined ? { reviseOnNextNoNo: values["revise-on-next-no-no"] === "true" } : {}),
        ...(values["yes-at"] !== undefined ? { yesAtOrAbove: num("yes-at", values["yes-at"])! } : {}),
        ...(values["no-at"] !== undefined ? { noAtOrBelow: num("no-at", values["no-at"])! } : {}),
      };
      const maxCalls = num("max-calls", values["max-calls"]);
      const armConfig = readArmConfig();
      const done = await runLab({
        dataDir: resolve(values.data), labDir: resolve(values.lab), labelFiles: labels, phase: values.phase, live: values.live === true, overrides,
        ...(values.arm !== undefined ? { arm: values.arm } : {}), ...(armConfig ? { armConfig } : {}),
        ...(maxCalls !== undefined ? { maxCalls } : {}), ...(values.keys ? { keysPath: resolve(values.keys) } : {}), out: (l) => console.log(l),
      });
      console.log(`results ${done.resultsPath}\nreport ${done.reportPath}`);
      return values.phase === "score" ? done.report.exitCode : 0;
    }
    case "report":
    case "rescore": {
      if (!values.results || labels.length === 0) return usage(`${command} needs --results <file> and --labels <file>`);
      const report = reportFromFile(resolve(values.results), labels);
      process.stdout.write(report.text);
      if (values.expect) {
        if (readFileSync(resolve(values.expect), "utf8") !== report.text) {
          console.error(`MISMATCH: the rescored report differs from ${values.expect}`);
          return 1;
        }
        console.error(`rescore matches ${values.expect} byte for byte`);
      }
      return report.exitCode;
    }
    default:
      return usage("commands: draft-labels, draft-labels-set, split, plan, run, report, rescore");
  }
}

function usage(message: string): number {
  console.error(`jev-lab: ${message}`);
  return 2;
}

if (import.meta.main) {
  void cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`jev-lab: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
