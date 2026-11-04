/**
 * Experiment 2, the Jev boundary and visual lab (docs/experiments/02-jev-lab.md is the protocol).
 *
 *   bun run scripts/jev-lab.ts draft-labels --data <dir> --capture <id> [--video <id>] --out <file> [--force]
 *   bun run scripts/jev-lab.ts split   --labels <file>...
 *   bun run scripts/jev-lab.ts plan    --data <dir> --labels <file>...
 *   bun run scripts/jev-lab.ts run     --data <dir> --lab <dir> --labels <file>... --phase tune|score [tuning flags]
 *                                      [--live --max-calls <n> [--keys <path>]]
 *   bun run scripts/jev-lab.ts report  --results <file> --labels <file>...
 *   bun run scripts/jev-lab.ts rescore --results <file> --labels <file>... [--expect <report.txt>]
 *
 * Everything reads a scratch copy of <data>/afterclass.sqlite, so the real data dir is never written. `run` makes no
 * Jev call unless --live, a 0600 keys file with TYPESAFE_API_KEY, --max-calls within the budget and signed_off labels
 * all hold. Without --live it uses a deterministic fake and everything it prints is tagged [fixture].
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { EvidenceStoreWithProbe } from "../src/backend/evidence";
import { readKeys } from "../src/backend/main";
import { createJevClient } from "../src/backend/providers/jev";
import type { JevAnswer, JevClient, JevRequest } from "../src/backend/providers/jev";
import { JEV_MODEL, QUESTIONS, boundaryTask, frameChangeTask } from "../src/backend/providers/jev-tasks";
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
import { scratchCopy } from "./probe-export";
import {
  BUDGET_CALLS, BUDGET_TEXT, DEFAULT_THRESHOLDS, MAX_TUNE_ROUNDS, buildReport, halfOf, parseResults, serializeResults, splitPoint, validateLabels,
} from "./jev-lab-score";
import type { CallRecord, FrameRecord, Half, JudgmentRecord, LabelFile, LabelInfo, LectureRecord, Origin, ParsedResults, Phase, Report, RunHeader, Thresholds, WindowRecord } from "./jev-lab-score";

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
  return infos;
}

export const lectureIdOf = (info: LabelInfo): string => `${info.labels.lecture.captureId}/${info.labels.lecture.videoId}`;

export function describeSplit(infos: readonly LabelInfo[]): string[] {
  const lines: string[] = [];
  for (const info of infos) {
    const { spanS } = info.labels.lecture;
    const T = splitPoint(spanS);
    const count = (times: readonly number[], half: Half) => times.filter((t) => halfOf(t, spanS) === half).length;
    const b = info.labels.boundaries.map((x) => x.mediaS);
    const s = info.labels.visualSteps.map((x) => x.mediaS);
    const d = info.labels.duplicateGroups.flatMap((g) => [...g.frames].sort((x, y) => x.mediaS - y.mediaS).slice(1).map((m) => m.mediaS));
    lines.push(
      `${lectureIdOf(info)} (${info.file}, status ${info.labels.status}): span [${spanS.start}, ${spanS.end}), split at ${T}`,
      `  tune (first half, [${spanS.start}, ${T})): ${count(b, "first")} boundaries, ${count(s, "first")} visual steps, ${count(d, "first")} duplicates`,
      `  held-out (second half, [${T}, ${spanS.end})): ${count(b, "second")} boundaries, ${count(s, "second")} visual steps, ${count(d, "second")} duplicates`,
    );
  }
  return lines;
}

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
type LectureWork = {
  readonly info: LabelInfo;
  readonly record: Omit<LectureRecord, "half" | "windows" | "frames">;
  readonly windows: readonly WindowWork[];
  readonly frames: readonly FrameWork[];
};

const passageOf = (e: Evidence | { readonly kind: "deleted" } | undefined): e is Passage => e?.kind === "passage";
const frameOf = (e: Evidence | { readonly kind: "deleted" } | undefined): e is Frame => e?.kind === "frame";

/** The real windowing (buildWindows, with the run's config) over the whole capture, then the windows and frames of one lecture. */
export function lectureWork(cap: OpenCapture, info: LabelInfo, cfg: SegmentationConfig): LectureWork {
  const { captureId, videoId, spanS } = info.labels.lecture;
  const sourceId = stableId("src", "youtube", videoId);
  const view = cap.evidence.captureView(captureId as CaptureId);
  if (!view.sources.some((s) => s.id === sourceId)) refuse(`capture ${captureId} has no source for video ${videoId}; check the label file's lecture`);

  const order = cap.evidence.watchOrder(captureId as CaptureId);
  const watched = Material.get(cap.evidence.watchedMaterial(captureId as CaptureId), sourceId as SourceId).intervals().map((i): [number, number] => [i.start, i.end]);

  const windows: WindowWork[] = [];
  for (const w of buildWindows(captureId as CaptureId, order, cfg)) {
    const first = cap.evidence.get([w.newPassages[0]]).get(w.newPassages[0]);
    if (!passageOf(first) || first.sourceId !== sourceId) continue;
    const set = Material.get(w.newMaterial, sourceId as SourceId).intervals();
    const startS = Math.min(...set.map((i) => i.start));
    const half = halfOf(startS, spanS);
    if (half === null) continue;
    windows.push({ half, input: boundaryInputOf(cap.evidence, w), record: windowRecord(w, startS, Math.max(...set.map((i) => i.end))) });
  }

  cap.frameInputs.length = 0;
  for (const item of cap.evidence.frameDemand(captureId as CaptureId)) void item.run(new AbortController().signal);
  const inputOf = new Map(cap.frameInputs.map((i) => [i.after.frame.id as string, i] as const));
  const frames: FrameWork[] = [];
  for (const f of order.frameCandidates) {
    if (f.sourceId !== sourceId) continue;
    const half = halfOf(f.mediaS, spanS);
    if (half === null) continue;
    const input = inputOf.get(f.id) ?? null;
    frames.push({ half, input, record: { id: f.id, mediaS: f.mediaS, hasBefore: input !== null } });
  }

  return {
    info,
    record: {
      t: "lecture", lectureId: lectureIdOf(info), labelsFile: info.file, labelsSha256: info.sha256, captureId, videoId, sourceId,
      spanS, captureStopped: order.status.state === "stopped", watched,
    },
    windows,
    frames,
  };
}

function windowRecord(w: BoundaryWindow, startS: number, endS: number): WindowRecord {
  return {
    id: w.id, captureId: w.captureId, ordinal: w.ordinal, startS, endS, newPassages: w.newPassages, contextPassages: w.contextPassages, frames: w.frames,
    newMaterial: Material.canonical(w.newMaterial), watchedSecondsAtEnd: w.watchedSecondsAtEnd,
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

type Tasks = { readonly boundary: Task<BoundaryInput, unknown>; readonly frame: Task<FrameChangeInput, unknown> };
const tasksOver = (jev: JevClient): Tasks => ({ boundary: boundaryTask(jev), frame: frameChangeTask(jev) });

/** Independent of the thresholds (the product folds them into the task version): the lab stores raw p and applies thresholds when it scores. */
export const boundaryKey = (t: Tasks, i: BoundaryInput) => stableId("key", "jev-lab", "boundary", QUESTIONS.boundary.version, JEV_MODEL, t.boundary.canonicalInput(i));
export const frameKey = (t: Tasks, i: FrameChangeInput) => stableId("key", "jev-lab", "frame_change", QUESTIONS.frameChange.version, JEV_MODEL, t.frame.canonicalInput(i));

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

export function readState(dir: string): LabState {
  const path = join(dir, "state.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LabState) : EMPTY_STATE;
}

function writeState(dir: string, state: LabState): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `state.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, join(dir, "state.json"));
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
  if (!(config.windowNewS > 0) || !(config.contextS >= 0) || !(config.timeCapS > config.windowNewS) || !Number.isInteger(config.maxFramesPerWindow) || config.maxFramesPerWindow < 0 || config.maxFramesPerWindow > 4) {
    refuse("tuning config out of range: windowNewS > 0, contextS >= 0, timeCapS > windowNewS, maxFramesPerWindow an integer 0 to 4");
  }
  if (!(thresholds.noAtOrBelow >= 0 && thresholds.noAtOrBelow < thresholds.yesAtOrAbove && thresholds.yesAtOrAbove <= 1)) refuse("thresholds out of range: 0 <= noAtOrBelow < yesAtOrAbove <= 1");
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
export function planLab(opts: { readonly dataDir: string; readonly labelFiles: readonly string[] }): Plan {
  const infos = loadLabels(opts.labelFiles);
  const cap = openCapture(opts.dataDir);
  try {
    const tasks = tasksOver(refusingJev);
    const lines: string[] = ["Jev lab plan: counts only, no call is made."];
    let tune = 0;
    let score = 0;
    for (const info of infos) {
      const w = lectureWork(cap, info, SEGMENTATION_DEFAULTS);
      const keys = (half: Half) => ({
        windows: new Set(w.windows.filter((x) => x.half === half).map((x) => boundaryKey(tasks, x.input))).size,
        frames: new Set(w.frames.filter((x) => x.half === half && x.input !== null).map((x) => frameKey(tasks, x.input!))).size,
      });
      const a = keys("first");
      const b = keys("second");
      tune += a.windows + a.frames;
      score += b.windows + b.frames;
      lines.push(`${lectureIdOf(info)}: first half ${a.windows} windows + ${a.frames} frame calls; second half ${b.windows} windows + ${b.frames} frame calls (default config)`);
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
  const dir = join(opts.labDir, origin);
  let state = readState(dir);

  if (opts.phase === "score") {
    if (opts.overrides !== undefined && Object.keys(opts.overrides).length > 0) refuse("a scored run takes no tuning flags: it uses the config of the last tune round");
    if (state.scoreStatus === "complete") refuse("the held-out half was already scored once; it is never scored again. Read it back with: rescore --results <file> --labels <files>");
    if (state.lastTune === null) refuse("no tune round has run yet; run a tune round first (a tune round with the defaults counts as one)");
    const unsigned = infos.filter((i) => i.labels.status !== "signed_off");
    if (unsigned.length > 0) refuse(`the scored run needs signed_off labels; not signed off: ${unsigned.map((i) => i.file).join(", ")}`);
  } else if (state.tuneRounds >= MAX_TUNE_ROUNDS) refuse(`${MAX_TUNE_ROUNDS} tuning rounds are already used; there is no fourth`);

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

  const { config, thresholds } = opts.phase === "tune" ? resolveTuning(opts.overrides ?? {}) : { config: state.lastTune!.config, thresholds: state.lastTune!.thresholds };
  const round = opts.phase === "tune" ? state.tuneRounds + 1 : 1;
  const runId = `${opts.phase}-${round}`;
  const now = opts.now ?? Date.now;

  const calls: { current: CallRecord[]; p: Record<string, number | null> } = { current: [], p: {} };
  const inner: JevClient = opts.live ? createJevClient({ apiKey: apiKey!, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) : (opts.client ?? deterministicFakeJev());
  let runCalls = 0;
  const jev: JevClient = {
    async ask<Q extends string>(req: JevRequest<Q>, signal: AbortSignal) {
      if (state.callsUsed >= BUDGET_CALLS) refuse(`the lab's ${BUDGET_CALLS}-call budget is spent (${state.callsUsed} used); no further call is made`);
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
  const tasks = tasksOver(jev);

  const cap = openCapture(opts.dataDir);
  try {
    const lectures = infos.map((info) => lectureWork(cap, info, config));
    const want: Half = opts.phase === "tune" ? "first" : "second";
    const work = lectures.map((l) => ({ ...l, windows: l.windows.filter((w) => w.half === want), frames: l.frames.filter((f) => f.half === want) }));
    assertPhaseHalf(opts.phase, work.flatMap((l) => [...l.windows, ...l.frames]));

    const cache = readCache(dir);
    const subjects = work.flatMap((l) => [
      ...l.windows.map((w) => ({ lecture: l, purpose: "boundary" as const, subject: w.record.id, key: boundaryKey(tasks, w.input), run: () => judgeBoundary(w.input) })),
      ...l.frames.flatMap((f) => (f.input === null ? [] : [{ lecture: l, purpose: "frame_change" as const, subject: f.record.id, key: frameKey(tasks, f.input), run: () => judgeFrame(f.input!) }])),
    ]);
    const needed = new Set(subjects.filter((s) => !cache.has(s.key)).map((s) => s.key)).size;
    if (opts.live) {
      if (needed > opts.maxCalls!) refuse(`this run needs ${needed} new calls and --max-calls is ${opts.maxCalls}; no call was made`);
      if (state.callsUsed + needed > BUDGET_CALLS) refuse(`this run needs ${needed} new calls and ${state.callsUsed} of ${BUDGET_CALLS} are used; no call was made`);
    }

    state = opts.phase === "tune" ? { ...state, tuneRounds: round } : { ...state, scoreStatus: "in_progress" };
    writeState(dir, state);

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
        judgments.push({ ...hit, lectureId: s.lecture.record.lectureId, reused: true });
        continue;
      }
      const done = await s.run();
      const record: JudgmentRecord = {
        t: "judgment", lectureId: s.lecture.record.lectureId, purpose: s.purpose, subject: s.subject, key: s.key, model: JEV_MODEL,
        questionVersion: s.purpose === "boundary" ? QUESTIONS.boundary.version : QUESTIONS.frameChange.version, reused: false, calls: done.calls, p: done.p, error: done.error,
      };
      newCalls += done.calls.length;
      if (record.error === null) {
        appendCache(dir, record);
        cache.set(s.key, record);
      }
      judgments.push(record);
    }

    const header: RunHeader = { t: "header", version: 1, runId, phase: opts.phase, round, origin, model: JEV_MODEL, config, thresholds };
    const results: ParsedResults = {
      header,
      lectures: work.map((l): LectureRecord => ({ ...l.record, half: want, windows: l.windows.map((w) => w.record), frames: l.frames.map((f) => f.record) })),
      judgments,
      end: { t: "end", newCalls, judgments: judgments.length },
    };
    mkdirSync(join(dir, "runs"), { recursive: true });
    const resultsPath = join(dir, "runs", `${runId}.jsonl`);
    writeFileSync(resultsPath, serializeResults(results));
    const report = reportFromFile(resultsPath, opts.labelFiles);
    const reportPath = join(dir, "runs", `${runId}.report.txt`);
    writeFileSync(reportPath, report.text);

    state = opts.phase === "tune" ? { ...state, lastTune: { round, config, thresholds } } : { ...state, scoreStatus: "complete" };
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
    },
  });
  if (values.origin !== "fixture" && values.origin !== "live") return usage("--origin must be fixture or live");
  const origin: Origin = values.origin;
  const labels = values.labels ?? [];
  const num = (name: string, v: string | undefined) => (v === undefined ? undefined : Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : refuse(`--${name} must be a number, got "${v}"`));

  switch (command) {
    case "draft-labels": {
      if (!values.data || !values.capture || !values.out) return usage("draft-labels needs --data, --capture and --out");
      const done = draftLabels({ dataDir: resolve(values.data), captureId: values.capture, outPath: resolve(values.out), ...(values.video ? { videoId: values.video } : {}), ...(values.force ? { force: true } : {}) });
      console.log(tag(origin, [`Wrote a DRAFT label file to ${done.path}. It is a starting point for Derek to correct, not truth.`, ...done.notes.map((n) => `note: ${n}`)]));
      return 0;
    }
    case "split": {
      if (labels.length === 0) return usage("split needs --labels <file>");
      console.log(tag(origin, ["Tune and held-out split (first half of each lecture span is tune, second half is held-out, scored once):", ...describeSplit(loadLabels(labels))]));
      return 0;
    }
    case "plan": {
      if (!values.data || labels.length === 0) return usage("plan needs --data and --labels <file>");
      const plan = planLab({ dataDir: resolve(values.data), labelFiles: labels });
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
      const done = await runLab({
        dataDir: resolve(values.data), labDir: resolve(values.lab), labelFiles: labels, phase: values.phase, live: values.live === true, overrides,
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
      return usage("commands: draft-labels, split, plan, run, report, rescore");
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
