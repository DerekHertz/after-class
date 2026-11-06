/**
 * Experiment 6, stage 6 (docs/experiments/06-model-optimized-jev.md): the optimizer runner. One `propose` is ONE optimizer
 * round's proposal for ONE arm: a Claude model (Opus or Fable) reads a first-half-only prompt built from the approved
 * template (docs/experiments/exp6-optimizer-prompt.md) and answers with a new arm config (decision 4: the three question
 * wordings, the thresholds, the segmentation). Jev is NOT re-run here; `jev-lab run --phase tune --arm ... --arm-config`
 * does that, with its own rails.
 *
 *   bun run scripts/jev-lab-optimize.ts propose --data <assembledDir> --labels <signed.json> --lab <labRoot> --arm <name>
 *       --model claude-opus-5-5|claude-fable-5-1 --out <dir> --from-results <tune results.jsonl> [--from-results ...]
 *       [--baseline-state <state.json>]      (round 1: experiment 2's final state)
 *       [--previous <proposal dir> ...]      (rounds 2 and 3: the earlier rounds' output dirs, in round order)
 *       [--heldout-report <score-1.report.txt>]   (required with --live-claude: its lines are scanned for in every prompt)
 *       [--dry-run]                          (build the real prompt, run the guard, write prompt.txt; no call, no ledger)
 *       [--exp7 [--approved-template <file>]]  (experiment 7: the six wordings; the draft template is dry-run only, a live run needs an
 *                                              approved copy with the matching SHA, --out under <lab>/exp7, Claude ceiling 80 in <lab>/exp7)
 *       [--live-claude --max-claude-calls N --claude-ledger <dir>]   (--claude-ledger is required live and must be the parent of --out)
 *
 * Claude is reached only through `jev-lab-propose`'s rails (the product's createClaudeCli, the same flags and env
 * stripping, the same persisted ledger and call floor, BUDGET_CLAUDE_CALLS). Nothing here makes a Jev call or reads a key
 * file. Before ANY call the whole prompt is scanned for held-out material; a hit stops the run with nothing sent.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { ClaudeCli, SpawnFn } from "../src/backend/providers/claude";
import type { Passage } from "../src/shared/domain";
import type { EvidenceId } from "../src/shared/ids";
import { lectureWork, loadLabels, openCapture, readState, reportFromFile } from "./jev-lab";
import { ARM7_KIND, ARM_KIND, ARM_NAME, PRODUCT_QUESTIONS, armConfigFromBaseline, exp7ConfigFromArm, validateArmConfig, validateExp7ArmConfig } from "./jev-lab-arm";
import type { ArmConfig, Exp7ArmConfig } from "./jev-lab-arm";
import { routeWithFraming } from "../src/backend/segmentation/core";
import { PROPOSED_MODELS, ProposeRefusal, attemptCall, checkCommon, openSession, parseMaxClaudeCalls, readClips, refuse, writeMeta } from "./jev-lab-propose";
import type { ClipEvidence } from "./jev-lab-propose";
import {
  MAX_TUNE_ROUNDS, PROPOSED_DUPLICATE_MATCH_S, PROPOSED_STEP_CATCH_S, TOLERANCE_S, clipsOf, detectBoundaries, lectureIdOfLabels, parseResults, splitterOf, verdictAt, viewOf,
} from "./jev-lab-score";
import type { LabelInfo, LectureRecord, Origin, ParsedResults, Report } from "./jev-lab-score";

export { ProposeRefusal };

// ───────────────────────────── the approved template ─────────────────────────────

export const TEMPLATE_DOC = "docs/experiments/exp6-optimizer-prompt.md";
export const TEMPLATE_BEGIN = "<!-- BEGIN APPROVED TEMPLATE -->\n";
export const TEMPLATE_END = "<!-- END APPROVED TEMPLATE -->";
/** SHA-256 of the template text Derek approved on 2026-11-05 (the text between the markers, final newline included). */
export const APPROVED_TEMPLATE_SHA256 = "a10cf915d4b789951c10174e19f58574830e8fb85c747ffd142142e31ca81492";
/**
 * Experiment 7 (docs/experiments/07-jev-saves-the-tutor.md, prerequisite 2). The template there is a DRAFT: dry runs fill it,
 * a live run is refused unless `--approved-template <file>` holds a copy of its text, between the APPROVED markers, whose
 * SHA-256 is APPROVED_EXP7_TEMPLATE_SHA256. That constant is null until Derek approves a text; then a change records its SHA.
 */
export const TEMPLATE7_DOC = "docs/experiments/exp7-optimizer-prompt.md";
export const TEMPLATE7_DRAFT_BEGIN = "<!-- BEGIN DRAFT TEMPLATE -->\n";
export const TEMPLATE7_DRAFT_END = "<!-- END DRAFT TEMPLATE -->";
export const APPROVED_EXP7_TEMPLATE_SHA256: string | null = null;
/** Experiment 7's Claude ceiling (Budget: wording rounds and tutor interpretation, 80 in all), counted in its own ledger, never in data/lab/propose. */
export const EXP7_BUDGET_CLAUDE_CALLS = 80;
export const DRAFT_BANNER = "DRAFT — not approved by Derek; no live call may use it until an approved copy with matching SHA exists.";
export const OPTIMIZE_SYSTEM = "You tune a yes/no model's configuration for a study tool. You answer with one JSON object and nothing else.";

const repoRoot = resolve(import.meta.dir, "..");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The template, read from the doc at run time; a doc whose template text is not the approved one is refused. */
export function loadTemplate(root = repoRoot): string {
  const doc = readFileSync(join(root, TEMPLATE_DOC), "utf8");
  const a = doc.indexOf(TEMPLATE_BEGIN);
  const b = doc.indexOf(TEMPLATE_END);
  if (a < 0 || b < a) return refuse(`${TEMPLATE_DOC} has no BEGIN/END template markers`);
  const text = doc.slice(a + TEMPLATE_BEGIN.length, b);
  if (sha256(text) !== APPROVED_TEMPLATE_SHA256) refuse(`the template in ${TEMPLATE_DOC} is not the text Derek approved on 2026-11-05 (sha256 ${sha256(text)}); a changed template needs his new approval`);
  return text;
}

/**
 * The experiment 7 template. Dry runs (and offline scripted runs) may use the draft in the doc. A live run needs an approved
 * copy, `approvedPath`, whose text between the APPROVED markers hashes to APPROVED_EXP7_TEMPLATE_SHA256; an approved copy
 * given to any run must match too. Returns the text and whether it is the approved one.
 */
export function loadTemplate7(root: string, opts: { readonly live: boolean; readonly approvedPath?: string }): { readonly text: string; readonly approved: boolean } {
  if (opts.approvedPath !== undefined) {
    const doc = readFileSync(resolve(opts.approvedPath), "utf8");
    const a = doc.indexOf(TEMPLATE_BEGIN);
    const b = doc.indexOf(TEMPLATE_END);
    if (a < 0 || b < a) return refuse(`${opts.approvedPath} has no BEGIN/END APPROVED TEMPLATE markers`);
    const text = doc.slice(a + TEMPLATE_BEGIN.length, b);
    if (APPROVED_EXP7_TEMPLATE_SHA256 === null) refuse("no experiment 7 optimizer template is approved yet (APPROVED_EXP7_TEMPLATE_SHA256 is not set); a changed or new template needs Derek's approval");
    if (sha256(text) !== APPROVED_EXP7_TEMPLATE_SHA256) refuse(`${opts.approvedPath} is not the experiment 7 template Derek approved (sha256 ${sha256(text)}); a changed template needs his new approval`);
    return { text, approved: true };
  }
  if (opts.live) refuse("a live experiment 7 run needs --approved-template <file>: the draft template in " + TEMPLATE7_DOC + " is not approved by Derek, and no live call may use it");
  const doc = readFileSync(join(root, TEMPLATE7_DOC), "utf8");
  const a = doc.indexOf(TEMPLATE7_DRAFT_BEGIN);
  const b = doc.indexOf(TEMPLATE7_DRAFT_END);
  if (a < 0 || b < a) return refuse(`${TEMPLATE7_DOC} has no BEGIN/END DRAFT TEMPLATE markers`);
  return { text: doc.slice(a + TEMPLATE7_DRAFT_BEGIN.length, b), approved: false };
}

/** `## B. Preprocessing during viewing`: its code block and its routing table, copied from the flow doc, never retyped. */
export function loadFlowB(root = repoRoot): string {
  const lines = readFileSync(join(root, "docs/flows/after-class.md"), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("## B. Preprocessing during viewing"));
  if (start < 0) return refuse("docs/flows/after-class.md has no '## B. Preprocessing during viewing' section");
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end);
  const open = section.findIndex((l) => l.startsWith("```"));
  const close = section.findIndex((l, i) => i > open && l.startsWith("```"));
  if (open < 0 || close < 0) return refuse("section B of the flow doc has no code block");
  const table = section.slice(close + 1).filter((l) => l.startsWith("|"));
  if (table.length < 3) return refuse("section B of the flow doc has no routing table");
  return [...section.slice(open, close + 1), "", ...table].join("\n");
}

// ───────────────────────────── the held-out guard ─────────────────────────────

/** Everything the held-out half is made of, as strings a prompt could carry. */
export type HeldOut = {
  readonly clipNumbers: readonly number[];
  readonly videoIds: readonly string[];
  readonly sourceIds: readonly string[];
  /** Titles that no first-half clip has (a title in both halves, like "Introduction", says nothing about the held-out half). */
  readonly titles: readonly string[];
  readonly windowIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly passages: readonly string[];
  readonly labels: readonly { readonly videoId: string; readonly clipNumber: number; readonly mediaS: number }[];
  /** Lines of experiment 2's held-out report. */
  readonly reportLines: readonly string[];
  /** Fractions (2/5, 387/424) and decimals (0.559) written in experiment 2's held-out report. */
  readonly reportNumbers: readonly string[];
};
/** What the prompt may legitimately repeat from the held-out side, because the first half has it too. */
export type GuardAllow = { readonly firstHalfPassages: readonly string[]; readonly allowedLines: ReadonlySet<string>; readonly allowedNumbers: ReadonlySet<string> };
export type GuardHit = { readonly kind: string; readonly detail: string };

export const SHINGLE = 40;
export const MIN_REPORT_LINE = 12;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const untag = (line: string) => squash(line.replace(/^\[(?:fixture|live)\]\s*/, ""));
export const reportLinesOf = (text: string): readonly string[] => text.split("\n").map(untag).filter((l) => l.length >= MIN_REPORT_LINE);
/** Number tokens the guard compares: fractions and decimals (plain integers are everywhere: seconds, clip numbers). */
export const numberTokens = (text: string): readonly string[] => [...new Set(text.match(/(?<![\d.\/])(?:\d+\/\d+|\d+\.\d+)(?![\d])/g) ?? [])];
const timeForms = (t: number) => [...new Set([String(t), t.toFixed(1), t.toFixed(0), String(Number(t.toFixed(2)))])];
const hasToken = (line: string, tok: string) => new RegExp(`(^|[^0-9.])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9]|\\.[0-9])`).test(line);

/**
 * Scans the FULL prompt text (and any retry text) for held-out material. Returns every hit; an empty list means nothing
 * was found. A passage shingle that the first half also contains is not a hit (a repeated phrase tells nothing about the
 * held-out half); likewise a title and a report line the first half or the template carries too.
 */
export function scanForHeldOut(prompt: string, h: HeldOut, allow: GuardAllow): readonly GuardHit[] {
  const hits: GuardHit[] = [];
  for (const id of h.videoIds) if (id !== "" && prompt.includes(id)) hits.push({ kind: "videoId", detail: `held-out clip videoId ${id}` });
  for (const id of h.sourceIds) if (id !== "" && prompt.includes(id)) hits.push({ kind: "sourceId", detail: `held-out clip sourceId ${id}` });
  for (const t of h.titles) if (t !== "" && prompt.includes(t)) hits.push({ kind: "title", detail: `title ${JSON.stringify(t)}, which only held-out clips have` });
  for (const id of h.windowIds) if (id !== "" && prompt.includes(id)) hits.push({ kind: "windowId", detail: `held-out window id ${id}` });
  for (const id of h.evidenceIds) if (id !== "" && prompt.includes(id)) hits.push({ kind: "evidenceId", detail: `held-out frame or passage id ${id}` });

  const flat = squash(prompt);
  const seen = new Set<string>();
  for (let i = 0; i + SHINGLE <= flat.length; i++) seen.add(flat.slice(i, i + SHINGLE));
  const inFirst = new Set<string>();
  for (const p of allow.firstHalfPassages.map(squash)) for (let i = 0; i + SHINGLE <= p.length; i++) inFirst.add(p.slice(i, i + SHINGLE));
  h.passages.forEach((raw, k) => {
    const p = squash(raw);
    for (let i = 0; i + SHINGLE <= p.length; i++) {
      const s = p.slice(i, i + SHINGLE);
      if (seen.has(s) && !inFirst.has(s)) {
        hits.push({ kind: "passage", detail: `held-out passage #${k + 1} (${SHINGLE}+ characters of it are in the prompt)` });
        return;
      }
    }
  });

  const lines = prompt.split("\n");
  for (const n of h.clipNumbers) {
    if (new RegExp(`\\bclip\\s+${n}\\b`, "i").test(prompt)) hits.push({ kind: "clipNumber", detail: `a reference to held-out clip ${n}` });
  }
  for (const l of h.labels) {
    const clipRef = new RegExp(`\\bclip\\s+${l.clipNumber}\\b`, "i");
    for (const line of lines) {
      if ((line.includes(l.videoId) || clipRef.test(line)) && timeForms(l.mediaS).some((t) => hasToken(line, t))) {
        hits.push({ kind: "labelTime", detail: `a held-out label time ${l.mediaS} s paired with held-out clip ${l.clipNumber} (${l.videoId})` });
        break;
      }
    }
  }
  for (const line of h.reportLines) if (!allow.allowedLines.has(line) && flat.includes(line)) hits.push({ kind: "heldOutReport", detail: `a line of experiment 2's held-out report: ${JSON.stringify(line.slice(0, 80))}` });
  const inPrompt = new Set(numberTokens(prompt));
  for (const n of h.reportNumbers) if (inPrompt.has(n) && !allow.allowedNumbers.has(n)) hits.push({ kind: "heldOutNumber", detail: `the number ${n}, which experiment 2's held-out report has and the first-half bars, template and flow B do not` });
  return hits;
}

// ───────────────────────────── inputs: tune results, labels, rounds ─────────────────────────────

const canon = (c: ArmConfig | Exp7ArmConfig) => JSON.stringify({ q: c.questions, t: c.thresholds, s: c.segmentation });
const isRec = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

type Loaded = { readonly path: string; readonly results: ParsedResults; readonly report: Report };
export type PreviousRound = { readonly round: number; readonly rationale: string; readonly config: ArmConfig | Exp7ArmConfig; readonly report: Report };

export type OptimizeInputs = {
  readonly dataDir: string;
  readonly labelFile: string;
  readonly labDir: string;
  readonly arm: string;
  readonly fromResults: readonly string[];
  readonly baselineStatePath?: string;
  readonly previousDirs: readonly string[];
  readonly heldOutReportPath?: string;
  /** Experiment 7 mode: the six wordings, the exp7 template and ledger. Off (default): experiment 6, unchanged. */
  readonly exp7?: boolean;
  /** Experiment 7: a copy of the approved template (see loadTemplate7). Needed for a live run. */
  readonly approvedTemplatePath?: string;
};

export type RoundContext = {
  readonly round: number;
  readonly origin: Origin;
  readonly config: ArmConfig | Exp7ArmConfig;
  readonly exp7?: true;
  readonly current: Loaded;
  readonly previous: readonly PreviousRound[];
  readonly info: LabelInfo;
};

const headerConfig = (r: ParsedResults): ArmConfig => ({
  schemaVersion: 1, kind: ARM_KIND, questions: r.header.questions ?? PRODUCT_QUESTIONS, thresholds: r.header.thresholds,
  segmentation: r.header.config,
});

/** The tune results named by --from-results, read and checked the same way for experiment 6 and 7. */
function loadTuneRuns(inp: OptimizeInputs, info: LabelInfo): { readonly loaded: Loaded[]; readonly origin: Origin } {
  if (!ARM_NAME.test(inp.arm)) refuse(`--arm must be letters, digits and dashes, got "${inp.arm}"`);
  if (inp.fromResults.length === 0) refuse("propose needs at least one --from-results <tune results.jsonl>");
  if (info.labels.status !== "signed_off") refuse(`${info.file} is not signed off; the optimizer only sees Derek's signed labels`);
  const loaded: Loaded[] = inp.fromResults.map((p) => {
    const path = resolve(p);
    let results: ParsedResults;
    try {
      results = parseResults(readFileSync(path, "utf8"));
    } catch (e) {
      return refuse(`cannot read ${p} as a complete tune run: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (results.header.phase !== "tune") refuse(`${p} is a score run (phase "${results.header.phase}"); an optimizer prompt is built only from tune runs, never from a held-out scoring`);
    return { path, results, report: reportFromFile(path, [inp.labelFile]) };
  });
  const origins = [...new Set(loaded.map((l) => l.results.header.origin))];
  if (origins.length > 1) refuse(`--from-results mixes data origins (${origins.join(", ")})`);
  const origin = origins[0]!;
  if (loaded.some((l) => l.results.lectures.length !== 1 || l.results.lectures[0]!.lectureId !== lectureIdOfLabels(info.labels))) refuse("a tune results file does not hold exactly the lecture of --labels");
  if (loaded.some((l) => l.results.lectures[0]!.half !== "first")) refuse("a tune results file holds a half other than the first");
  return { loaded, origin };
}

/** Works out which round this is and what the current configuration and its first-half report are, refusing every inconsistent combination. */
export function resolveRound(inp: OptimizeInputs, info: LabelInfo): RoundContext {
  if (inp.exp7 === true) return resolveRound7(inp, info);
  const { loaded, origin } = loadTuneRuns(inp, info);

  const armRuns = loaded.filter((l) => l.results.header.arm === inp.arm).sort((a, b) => a.results.header.round - b.results.header.round);
  const baseline = loaded.filter((l) => l.results.header.arm === undefined);
  const other = loaded.filter((l) => l.results.header.arm !== undefined && l.results.header.arm !== inp.arm);
  if (other.length > 0) refuse(`--from-results has a run of arm "${other[0]!.results.header.arm}", not of --arm ${inp.arm}`);

  const runsDir = join(resolve(inp.labDir), "exp6", inp.arm, origin);
  const onDisk = existsSync(join(runsDir, "runs")) ? readdirSync(join(runsDir, "runs")).filter((f) => /^tune-\d+\.jsonl$/.test(f)).length : 0;
  if (existsSync(join(runsDir, "runs", "score-1.jsonl"))) refuse(`arm ${inp.arm} was already scored on the held-out half; nothing is proposed after that`);
  const scoreState = existsSync(join(runsDir, "state.json")) ? readState(runsDir).scoreStatus : "none";
  if (scoreState !== "none") refuse(`arm ${inp.arm}'s held-out scoring is ${scoreState}; nothing is proposed after that`);
  if (onDisk !== armRuns.length) refuse(`arm ${inp.arm} has ${onDisk} tune round(s) in ${runsDir} but --from-results names ${armRuns.length} of this arm's; pass every round's tune results, in order`);
  armRuns.forEach((r, i) => {
    if (r.results.header.round !== i + 1) refuse(`the arm's tune results must be rounds 1 to ${armRuns.length} in order; got round ${r.results.header.round} at position ${i + 1}`);
  });
  const round = armRuns.length + 1;
  if (round > MAX_TUNE_ROUNDS) refuse(`arm ${inp.arm} has used its ${MAX_TUNE_ROUNDS} tune rounds; there is no round ${round}`);

  if (round === 1) {
    if (armRuns.length !== 0 || baseline.length !== 1) refuse("round 1 takes exactly one --from-results: experiment 2's tune results of the baseline's final configuration");
    if (inp.previousDirs.length > 0) refuse("round 1 has no earlier proposals; --previous is for rounds 2 and 3");
    if (inp.baselineStatePath === undefined) refuse("round 1 needs --baseline-state <experiment 2's state.json>");
    const sp = resolve(inp.baselineStatePath);
    if (basename(sp) !== "state.json") refuse(`--baseline-state must be a state.json file, got ${basename(sp)}`);
    const last = readState(dirname(sp)).lastTune;
    if (last === null) refuse("the baseline state has no last tune round");
    const config = armConfigFromBaseline(last);
    const cur = baseline[0]!;
    if (cur.results.header.round !== last.round || canon(headerConfig(cur.results)) !== canon(config)) {
      refuse(`the --from-results run is not the baseline's final configuration: the baseline state's last tune is round ${last.round}, the run is round ${cur.results.header.round} (its config or thresholds differ)`);
    }
    return { round, origin, config, current: cur, previous: [], info };
  }

  if (baseline.length > 0) refuse(`round ${round} takes only arm ${inp.arm}'s own tune results, not experiment 2's`);
  if (inp.previousDirs.length !== armRuns.length) refuse(`round ${round} needs --previous for each of the ${armRuns.length} earlier proposal dir(s), in round order; got ${inp.previousDirs.length}`);
  const previous = inp.previousDirs.map((d, i): PreviousRound => {
    const dir = resolve(d);
    const cfgPath = join(dir, "arm-config.json");
    const ratPath = join(dir, "rationale.txt");
    if (!existsSync(cfgPath) || !existsSync(ratPath)) return refuse(`${d} has no arm-config.json and rationale.txt (a complete proposal dir of this tool)`);
    const checked = validateArmConfig(JSON.parse(readFileSync(cfgPath, "utf8")));
    if (!checked.ok) return refuse(`${cfgPath} is not a valid arm config: ${checked.errors.join("; ")}`);
    const run = armRuns[i]!;
    if (canon(checked.config) !== canon(headerConfig(run.results))) refuse(`${cfgPath} is not the config that round ${i + 1}'s tune run used; the proposal dirs and the tune results must match round for round`);
    return { round: i + 1, rationale: readFileSync(ratPath, "utf8").trim(), config: checked.config, report: run.report };
  });
  const last = previous[previous.length - 1]!;
  return { round, origin, config: last.config, current: armRuns[armRuns.length - 1]!, previous, info };
}

const headerConfig7 = (r: ParsedResults): Exp7ArmConfig => ({ schemaVersion: 1, kind: ARM7_KIND, questions: r.header.exp7!.questions, thresholds: r.header.thresholds, segmentation: r.header.config });

/**
 * Experiment 7 rounds. Round 1 takes exactly one --from-results: an experiment 2 or 6 tune run (no experiment 7 wordings);
 * its wording, thresholds and segmentation are the start, with the draft wording of the three new questions. Rounds 2 and 3
 * take this arm's own experiment 7 tune runs in <lab>/exp7/<arm>/<origin> and the earlier proposal dirs, as for experiment 6.
 */
function resolveRound7(inp: OptimizeInputs, info: LabelInfo): RoundContext {
  const { loaded, origin } = loadTuneRuns(inp, info);
  const armRuns = loaded.filter((l) => l.results.header.exp7 !== undefined).sort((a, b) => a.results.header.round - b.results.header.round);
  const baseline = loaded.filter((l) => l.results.header.exp7 === undefined);
  const wrongArm = armRuns.find((l) => l.results.header.arm !== inp.arm);
  if (wrongArm !== undefined) refuse(`--from-results has an experiment 7 run of arm "${String(wrongArm.results.header.arm)}", not of --arm ${inp.arm}`);

  const runsDir = join(resolve(inp.labDir), "exp7", inp.arm, origin);
  const onDisk = existsSync(join(runsDir, "runs")) ? readdirSync(join(runsDir, "runs")).filter((f) => /^tune-\d+\.jsonl$/.test(f)).length : 0;
  if (existsSync(join(runsDir, "runs", "score-1.jsonl"))) refuse(`experiment 7 arm ${inp.arm} was already scored on the held-out half; nothing is proposed after that`);
  const scoreState = existsSync(join(runsDir, "state.json")) ? readState(runsDir).scoreStatus : "none";
  if (scoreState !== "none") refuse(`experiment 7 arm ${inp.arm}'s held-out scoring is ${scoreState}; nothing is proposed after that`);
  if (onDisk !== armRuns.length) refuse(`experiment 7 arm ${inp.arm} has ${onDisk} tune round(s) in ${runsDir} but --from-results names ${armRuns.length} of this arm's; pass every round's tune results, in order`);
  armRuns.forEach((r, i) => {
    if (r.results.header.round !== i + 1) refuse(`the arm's tune results must be rounds 1 to ${armRuns.length} in order; got round ${r.results.header.round} at position ${i + 1}`);
  });
  const round = armRuns.length + 1;
  if (round > MAX_TUNE_ROUNDS) refuse(`experiment 7 arm ${inp.arm} has used its ${MAX_TUNE_ROUNDS} tune rounds; there is no round ${round}`);

  if (round === 1) {
    if (baseline.length !== 1 || loaded.length !== 1) refuse("experiment 7 round 1 takes exactly one --from-results: an experiment 2 or 6 tune run (the configuration to start from)");
    if (inp.previousDirs.length > 0) refuse("round 1 has no earlier proposals; --previous is for rounds 2 and 3");
    const cur = baseline[0]!;
    const config = exp7ConfigFromArm({ schemaVersion: 1, kind: ARM_KIND, questions: cur.results.header.questions ?? PRODUCT_QUESTIONS, thresholds: cur.results.header.thresholds, segmentation: cur.results.header.config });
    return { round, origin, config, exp7: true, current: cur, previous: [], info };
  }

  if (baseline.length > 0) refuse(`round ${round} takes only arm ${inp.arm}'s own experiment 7 tune results, not an experiment 2 or 6 run`);
  if (inp.previousDirs.length !== armRuns.length) refuse(`round ${round} needs --previous for each of the ${armRuns.length} earlier proposal dir(s), in round order; got ${inp.previousDirs.length}`);
  const previous = inp.previousDirs.map((d, i): PreviousRound => {
    const dir = resolve(d);
    const cfgPath = join(dir, "arm-config.json");
    const ratPath = join(dir, "rationale.txt");
    if (!existsSync(cfgPath) || !existsSync(ratPath)) return refuse(`${d} has no arm-config.json and rationale.txt (a complete proposal dir of this tool)`);
    const checked = validateExp7ArmConfig(JSON.parse(readFileSync(cfgPath, "utf8")));
    if (!checked.ok) return refuse(`${cfgPath} is not a valid experiment 7 config: ${checked.errors.join("; ")}`);
    const run = armRuns[i]!;
    if (canon(checked.config) !== canon(headerConfig7(run.results))) refuse(`${cfgPath} is not the config that round ${i + 1}'s tune run used; the proposal dirs and the tune results must match round for round`);
    return { round: i + 1, rationale: readFileSync(ratPath, "utf8").trim(), config: checked.config, report: run.report };
  });
  const last = previous[previous.length - 1]!;
  return { round, origin, config: last.config, exp7: true, current: armRuns[armRuns.length - 1]!, previous, info };
}

// ───────────────────────────── the prompt, filled ─────────────────────────────

const num = (x: number) => String(Number(x.toFixed(2)));
const secs = (x: number) => `${num(x)} s`;
const p2 = (p: number | null | undefined) => (p === null || p === undefined ? "n/a" : String(Number(p.toFixed(3))));

/** The four bars and their numbers, from a tune report: no lecture header (it names every clip), no usage block. */
export function barsOf(report: Report): string {
  return barsOfText(report.text) ?? refuse("a tune report has no bars block to quote");
}

/** The bars block of any report text (recall to OVERALL, no lecture header, no usage), or null when the text has none. */
export function barsOfText(text: string): string | null {
  const lines = text.split("\n");
  const from = lines.findIndex((l) => /\] Boundary recall: /.test(l));
  const to = lines.findIndex((l, i) => i > from && /\] Usage \(/.test(l));
  const overall = lines.find((l) => /\] OVERALL/.test(l));
  if (from < 0 || to < 0 || overall === undefined) return null;
  return [...lines.slice(from, to), overall].filter((l) => l.trim() !== "").map((l) => l.replace(/^\[(?:fixture|live)\] /, "")).join("\n");
}

const route = (nc: string, sp: string): string =>
  nc === "yes" && sp === "yes" ? "close the chunk at the boundary"
  : nc === "no" && sp === "yes" ? "soft pause inside the topic, no close"
  : nc === "yes" && sp === "no" ? "no close, re-check on the next window"
  : "continue collecting";

type TunePieces = {
  readonly firstClips: readonly ClipEvidence[];
  readonly firstNumbers: ReadonlyMap<string, number>;
  readonly sections: { readonly transcript: string; readonly windows: string; readonly frames: string; readonly labels: string };
  readonly firstPassages: readonly string[];
  readonly nClips: number;
  readonly mClips: number;
};

/** Per clip, window, frame and label sections of the FIRST half only. Held-out clips, windows, frames and labels are never read here. */
function tunePieces(ctx: Pick<RoundContext, "current" | "info">, clips: readonly ClipEvidence[], lecture: LectureRecord, contextRange: (ids: readonly string[]) => string, exp7 = false): TunePieces {
  const splitter = splitterOf(lecture);
  const order = clipsOf(lecture).map((c) => c.videoId);
  const numberOf = (v: string) => order.indexOf(v) + 1;
  const firstIds = new Set(splitter.clipsIn("first").map((c) => c.videoId));
  const firstClips = order.filter((v) => firstIds.has(v)).map((v) => clips.find((c) => c.videoId === v)).filter((c): c is ClipEvidence => c !== undefined);
  const inFirst = (videoId: string, t: number) => splitter.halfOf(videoId, t) === "first";
  const view = viewOf(ctx.info.labels);

  const rangeOf = (v: string) => splitter.rangeOf(v, "first");
  const firstPassages = firstClips.flatMap((c) => {
    const r = rangeOf(c.videoId);
    return r === null ? [] : c.passages.filter((p) => p.start >= r.start && p.start < r.end).map((p) => ({ ...p, videoId: c.videoId }));
  });
  const transcript = firstClips.flatMap((c) => {
    const mine = firstPassages.filter((p) => p.videoId === c.videoId);
    return [`Clip ${numberOf(c.videoId)}: ${c.title === null ? "(untitled)" : JSON.stringify(c.title)}`, ...mine.map((p) => `  [${secs(p.start)} to ${secs(p.end)}] ${p.text}`), ""];
  });

  const results = ctx.current.results;
  const thresholds = results.header.thresholds;
  const judged = new Map(results.judgments.map((j) => [`${j.purpose}:${j.subject}`, j.p] as const));
  const pOf = (purpose: "boundary" | "frame_change" | "frame_relevance", id: string) => judged.get(`${purpose}:${id}`);
  const routing = exp7 ? ({ lessonFramingCloses: true } as const) : undefined;
  const closeBefore = new Set(
    detectBoundaries(lecture.windows, (id) => {
      const p = pOf("boundary", id);
      return p === undefined ? undefined : { p, error: null };
    }, thresholds, results.header.config, lecture.captureStopped, routing).map((d) => d.windowId),
  );
  const boundaries = view.boundaries.filter((b) => inFirst(b.videoId, b.mediaS));
  const windows = [...lecture.windows].sort((a, b) => a.ordinal - b.ordinal).map((w) => {
    const v = w.videoId ?? order[0]!;
    const p = pOf("boundary", w.id);
    const nc = verdictAt(p?.new_concept ?? null, thresholds);
    const sp = verdictAt(p?.stopping_point ?? null, thresholds);
    const near = boundaries.filter((b) => b.videoId === v && Math.abs(b.mediaS - w.startS) <= TOLERANCE_S + 1e-9).sort((a, b) => Math.abs(a.mediaS - w.startS) - Math.abs(b.mediaS - w.startS))[0];
    if (exp7) {
      const lfP = p?.lesson_framing;
      const lf = lfP === undefined ? undefined : verdictAt(lfP, thresholds);
      const lfText = lf === undefined ? "p(lesson framing) not measured yet (no Jev call has asked it on this window)" : `p(lesson framing) ${p2(lfP)} = ${lf}`;
      const routed = routeWithFraming(nc, sp, lf, { lessonFramingCloses: true }) === "close" ? `close the chunk at the boundary${nc === "yes" && sp === "yes" ? "" : " (new concept yes and lesson framing yes)"}` : route(nc, sp);
      return `clip ${numberOf(v)}; new passage ${num(w.startS)} to ${num(w.endS)} s; context ${contextRange(w.contextPassages)}; p(new concept) ${p2(p?.new_concept)} = ${nc}; p(stopping point) ${p2(p?.stopping_point)} = ${sp}; ${lfText}; routed: ${routed}; a chunk closes before this window: ${closeBefore.has(w.id) ? "yes" : "no"}; labeled boundary within ${TOLERANCE_S} s: ${near === undefined ? "no" : `yes (at ${num(near.mediaS)} s)`}`;
    }
    return `clip ${numberOf(v)}; new passage ${num(w.startS)} to ${num(w.endS)} s; context ${contextRange(w.contextPassages)}; p(new concept) ${p2(p?.new_concept)} = ${nc}; p(stopping point) ${p2(p?.stopping_point)} = ${sp}; routed: ${route(nc, sp)}; a chunk closes before this window: ${closeBefore.has(w.id) ? "yes" : "no"}; labeled boundary within ${TOLERANCE_S} s: ${near === undefined ? "no" : `yes (at ${num(near.mediaS)} s)`}`;
  });

  const steps = view.visualSteps.filter((s) => inFirst(s.videoId, s.mediaS));
  const groups = view.duplicateGroups
    .map((g) => ({ ...g, frames: [...g.frames].filter((f) => inFirst(f.videoId, f.mediaS)).sort((a, b) => order.indexOf(a.videoId) - order.indexOf(b.videoId) || a.mediaS - b.mediaS) }))
    .filter((g) => g.frames.length >= 2);
  const keptOnly = (f: { readonly id: string; readonly hasBefore: boolean }) => !exp7 || !f.hasBefore || verdictAt(pOf("frame_change", f.id)?.teaching_change ?? null, thresholds) !== "no";
  const frames = [...lecture.frames].filter(keptOnly).sort((a, b) => order.indexOf(a.videoId ?? "") - order.indexOf(b.videoId ?? "") || a.mediaS - b.mediaS).map((f) => {
    const v = f.videoId ?? order[0]!;
    const p = f.hasBefore ? pOf("frame_change", f.id) : undefined;
    const verdict = f.hasBefore ? verdictAt(p?.teaching_change ?? null, thresholds) : "no before-frame";
    const step = steps.find((s) => s.videoId === v && f.mediaS >= s.mediaS && f.mediaS < s.mediaS + PROPOSED_STEP_CATCH_S);
    const dup = groups.some((g) => g.frames.slice(1).some((m) => m.videoId === v && (m.frameId === f.id || (m.frameId === undefined && Math.abs(m.mediaS - f.mediaS) <= PROPOSED_DUPLICATE_MATCH_S + 1e-9))));
    const label = [...(step ? [`visual step (labeled at ${num(step.mediaS)} s)`] : []), ...(dup ? ["duplicate of an earlier frame"] : [])];
    if (exp7) {
      const rp = pOf("frame_relevance", f.id);
      const rel = !f.hasBefore ? "frame relevance not asked (the first frame of a clip has no before-frame input in the lab; it is kept)" : rp === undefined ? "p(frame relevance) not measured yet (no Jev call has asked it on this frame)" : `p(frame relevance) ${p2(rp.refers_to_frame)} = ${verdictAt(rp.refers_to_frame ?? null, thresholds)} (frame ${verdictAt(rp.refers_to_frame ?? null, thresholds) === "no" ? "dropped" : "sent to the tutor"})`;
      return `clip ${numberOf(v)}; ${secs(f.mediaS)}; p(teaching change) ${p2(p?.teaching_change)}; verdict ${verdict} (dedupe: frame kept); ${rel}; Derek's label: ${label.length === 0 ? "neither" : label.join(" and ")}`;
    }
    return `clip ${numberOf(v)}; ${secs(f.mediaS)}; p(teaching change) ${p2(p?.teaching_change)}; verdict ${verdict} (frame ${verdict === "no" ? "dropped" : "kept"}); Derek's label: ${label.length === 0 ? "neither" : label.join(" and ")}`;
  });

  const note = (n: string) => (n.trim() === "" ? "" : ` (${n.trim()})`);
  const labels = [
    "Boundaries:", ...(boundaries.length === 0 ? ["  none"] : boundaries.map((b) => `  clip ${numberOf(b.videoId)}, ${secs(b.mediaS)}${note(b.note)}`)),
    "Visual steps:", ...(steps.length === 0 ? ["  none"] : steps.map((s) => `  clip ${numberOf(s.videoId)}, ${secs(s.mediaS)}${note(s.note)}`)),
    "Duplicate groups (the first frame is kept, the later ones are duplicates):",
    ...(groups.length === 0 ? ["  none"] : groups.map((g) => `  ${g.frames.map((f) => `clip ${numberOf(f.videoId)} ${secs(f.mediaS)}`).join("; ")}${note(g.note)}`)),
  ];

  const sections = {
    transcript: ["Transcripts of the tuning clips, in watch order (times are media seconds of the clip):", "", ...transcript].join("\n").trimEnd(),
    windows: ["Boundary windows of the tuning clips, with Jev's p values and verdicts at the current thresholds" + (exp7 ? " (routing: close on new concept and stopping point both yes, or new concept and lesson framing both yes):" : ":"), ...windows.map((w) => `- ${w}`)].join("\n"),
    frames: [exp7 ? "Kept frames of the tuning clips (frames the dedupe step did not drop):" : "Judged frames of the tuning clips:", ...(frames.length === 0 ? ["- none"] : frames.map((f) => `- ${f}`))].join("\n"),
    labels: ["Derek's verified labels for the tuning clips:", ...labels].join("\n"),
  };
  return { firstClips, firstNumbers: new Map(order.map((v, i) => [v, i + 1] as const)), sections, firstPassages: firstPassages.map((p) => p.text), nClips: firstClips.length, mClips: order.length };
}

/** The lab holds no claims (they come from the interpretation step, which has not run on these clips), so there is nothing to show; said plainly, never faked. */
export const claimRelevanceSection = (): string =>
  [
    "Claim-relevance items of the tuning clips:",
    "- none can be shown. Claims come from the interpretation step, which has not been run on these clips, so the lab holds no claims and no delta calls, and no Jev call has asked the claim-relevance question about any claim. There is no measured evidence for `claimRelevance` in this prompt; its current wording is the draft shown in the configuration above.",
  ].join("\n");

export type BuiltPrompt = { readonly prompt: string; readonly heldOut: HeldOut; readonly allow: GuardAllow; readonly forbiddenInWording: ForbiddenWording; readonly nClips: number; readonly mClips: number };
export type ForbiddenWording = { readonly titles: readonly string[]; readonly videoIds: readonly string[] };

/** Replaces one whole `<<...>>` line by `fill`; an empty fill drops the line and one blank line next to it. */
function fillLine(text: string, startsWith: string, fill: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(startsWith));
  if (at < 0) return refuse(`the template has no placeholder line starting ${startsWith}`);
  if (fill === "") lines.splice(at, at + 1 < lines.length && lines[at + 1] === "" ? 2 : 1);
  else lines.splice(at, 1, fill);
  return lines.join("\n");
}

/** Round-1 text for experiment 7, where the current report is an experiment 2 or 6 run that never saw the new questions. */
const EXP7_ROUND1_NOTE = "round 0: experiment 6's selected configuration, run before any lesson-framing or frame-relevance question was asked of Jev";

export function buildOptimizerPrompt(inp: OptimizeInputs, ctx: RoundContext, root = repoRoot, live = false): BuiltPrompt {
  const exp7 = ctx.exp7 === true;
  const template = exp7 ? loadTemplate7(root, { live, ...(inp.approvedTemplatePath === undefined ? {} : { approvedPath: inp.approvedTemplatePath }) }).text : loadTemplate(root);
  const lecture = ctx.current.results.lectures[0]!;
  const captureId = viewOf(ctx.info.labels).captureId;
  const { clips } = readClips(resolve(inp.dataDir), captureId);
  const cap = openCapture(resolve(inp.dataDir));
  let pieces: TunePieces;
  let heldWindows: { readonly ids: string[]; readonly evidence: string[] };
  try {
    const contextRange = (ids: readonly string[]) => {
      const found = cap.evidence.get(ids as readonly EvidenceId[]);
      const ps = ids.map((id) => found.get(id as EvidenceId)).filter((e): e is Passage => e?.kind === "passage");
      return ps.length === 0 ? "none" : `${num(Math.min(...ps.map((p) => p.interval.start)))} to ${num(Math.max(...ps.map((p) => p.interval.end)))} s`;
    };
    pieces = tunePieces(ctx, clips, lecture, contextRange, exp7);
    heldWindows = heldOutWindows(cap, ctx);
  } finally {
    cap.close();
  }

  const reports = ctx.previous.map(
    (p) => `Round ${p.round} proposal (what you or an earlier optimizer proposed), its rationale and its first-half result:\n  rationale: ${p.rationale}\n  configuration: ${JSON.stringify({ questions: p.config.questions, thresholds: p.config.thresholds, segmentation: p.config.segmentation })}\n  result: recall ${p.report.metrics.recallMatched}/${p.report.metrics.recallLabeled}, false closes ${p.report.metrics.falseCloses ?? "not measured"}, bars ${p.report.bars.map((b) => `${b.name} ${b.verdict}`).join(", ")}`,
  );
  const bars = barsOf(ctx.current.report);
  let text = template;
  text = fillLine(text, "<<flow B,", loadFlowB(root));
  text = fillLine(text, "<<the arm's current config", "```json\n" + JSON.stringify({ questions: ctx.config.questions, thresholds: ctx.config.thresholds, segmentation: ctx.config.segmentation }, null, 2) + "\n```");
  text = text.replace("<<N>>", String(pieces.nClips)).replace("<<M>>", String(pieces.mClips));
  text = fillLine(text, "<<the first-half report", `Report of the current configuration on the tuning clips (${exp7 && ctx.round === 1 ? EXP7_ROUND1_NOTE : `round ${ctx.round - 1 === 0 ? "0, the baseline" : String(ctx.round - 1)}`}):\n${bars}`);
  text = fillLine(text, "<<per clip, in watch order", pieces.sections.transcript);
  text = fillLine(text, "<<per boundary window", pieces.sections.windows);
  text = fillLine(text, exp7 ? "<<per kept frame" : "<<per judged frame", pieces.sections.frames);
  if (exp7) text = fillLine(text, "<<per claim-relevance item", claimRelevanceSection());
  text = fillLine(text, "<<Derek's verified labels", pieces.sections.labels);
  text = fillLine(text, "<<on rounds 2 and 3", ctx.previous.length === 0 ? "" : reports.join("\n\n"));
  if (/<<[^>]*>>/.test(text)) refuse("the template still has an unfilled placeholder");

  const heldOut = heldOutOf(ctx, clips, lecture, heldWindows, inp);
  const allowedLines = new Set([...reportLinesOf(template), ...reportLinesOf(bars), ...reportLinesOf(loadFlowB(root))]);
  // numbers the prompt may carry because they come from the first half or the config, not from the held-out report
  const configText = [ctx.config, ...ctx.previous.map((p) => p.config)].map((c) => JSON.stringify(c)).join("\n");
  const priorText = ctx.previous.map((p) => `${p.report.metrics.recallMatched}/${p.report.metrics.recallLabeled} ${barsOf(p.report)}`).join("\n");
  const allowedNumbers = new Set(numberTokens([template, bars, loadFlowB(root), configText, priorText].join("\n")));
  const allTitles = [...new Set([...clips.map((c) => c.title), ...viewOf(ctx.info.labels).clips.map((c) => c.title ?? null)].filter((t): t is string => t !== null && t.trim() !== ""))];
  return {
    prompt: text,
    heldOut,
    allow: { firstHalfPassages: pieces.firstPassages, allowedLines, allowedNumbers },
    forbiddenInWording: { titles: allTitles, videoIds: clips.map((c) => c.videoId) },
    nClips: pieces.nClips,
    mClips: pieces.mClips,
  };
}

// ───────────────────────────── the held-out side (used only to scan, never to build) ─────────────────────────────

function heldOutWindows(cap: ReturnType<typeof openCapture>, ctx: RoundContext): { ids: string[]; evidence: string[] } {
  const ids = new Set<string>();
  const evidence = new Set<string>();
  const configs = [ctx.current.results.header.config, ...ctx.previous.map((p) => p.config.segmentation), ctx.config.segmentation];
  const seen = new Set<string>();
  for (const cfg of configs) {
    if (seen.has(JSON.stringify(cfg))) continue;
    seen.add(JSON.stringify(cfg));
    const work = lectureWork(cap, ctx.info, cfg);
    for (const w of work.windows) {
      if (w.half !== "second") continue;
      ids.add(w.record.id);
      for (const e of [...w.record.newPassages, ...w.record.contextPassages, ...w.record.frames]) evidence.add(e);
    }
    for (const f of work.frames) if (f.half === "second") evidence.add(f.record.id);
  }
  return { ids: [...ids], evidence: [...evidence] };
}

function heldOutOf(ctx: RoundContext, clips: readonly ClipEvidence[], lecture: LectureRecord, w: { ids: string[]; evidence: string[] }, inp: OptimizeInputs): HeldOut {
  const splitter = splitterOf(lecture);
  const rec = clipsOf(lecture);
  const order = rec.map((c) => c.videoId);
  const firstIds = new Set(splitter.clipsIn("first").map((c) => c.videoId));
  const secondOnly = splitter.clipsIn("second").filter((c) => !firstIds.has(c.videoId));
  const firstTitles = new Set(clips.filter((c) => firstIds.has(c.videoId)).map((c) => c.title).filter((t): t is string => t !== null));
  const view = viewOf(ctx.info.labels);
  const heldClips = clips.filter((c) => secondOnly.some((s) => s.videoId === c.videoId));
  const passages = clips.flatMap((c) => {
    const r = splitter.rangeOf(c.videoId, "second");
    return r === null ? [] : c.passages.filter((p) => p.start >= r.start && p.start < r.end).map((p) => p.text);
  });
  const heldNumber = (v: string) => order.indexOf(v) + 1;
  const reportText = inp.heldOutReportPath === undefined ? "" : readFileSync(resolve(inp.heldOutReportPath), "utf8");
  return {
    clipNumbers: secondOnly.map((c) => heldNumber(c.videoId)),
    videoIds: secondOnly.map((c) => c.videoId),
    sourceIds: rec.filter((c) => secondOnly.some((s) => s.videoId === c.videoId)).map((c) => c.sourceId),
    titles: [...new Set(heldClips.map((c) => c.title).filter((t): t is string => t !== null && t.trim() !== "" && !firstTitles.has(t)))],
    windowIds: w.ids,
    evidenceIds: w.evidence,
    passages,
    labels: [
      ...view.boundaries, ...view.visualSteps, ...view.duplicateGroups.flatMap((g) => g.frames),
    ].filter((l) => secondOnly.some((s) => s.videoId === l.videoId)).map((l) => ({ videoId: l.videoId, clipNumber: heldNumber(l.videoId), mediaS: l.mediaS })),
    reportLines: reportLinesOf(reportText),
    // the report's results (its bars and OVERALL): its header and usage lines carry clip spans, latencies and token counts that merely coincide with first-half times
    reportNumbers: numberTokens(barsOfText(reportText) ?? ""),
  };
}

// ───────────────────────────── reply handling ─────────────────────────────

export type Proposal = { readonly config: ArmConfig | Exp7ArmConfig; readonly rationale: string };
export type ParsedProposal = { readonly ok: true; readonly value: Proposal } | { readonly ok: false; readonly error: string };
const MM_SS = /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/;

/**
 * One JSON object (one code fence allowed): `rationale` plus a body that `validateArmConfig` accepts once `rationale` is
 * removed, and no question wording that names a clip title, a videoId or a mm:ss time of this lecture set. Nothing is repaired.
 */
export function parseProposal(text: string, forbidden: ForbiddenWording, exp7 = false): ParsedProposal {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  let raw: unknown;
  try {
    raw = JSON.parse(fenced ? fenced[1]! : text.trim());
  } catch (e) {
    return { ok: false, error: `the reply is not valid JSON (${e instanceof Error ? e.message : "parse error"}); it must be one JSON object and nothing else` };
  }
  if (!isRec(raw)) return { ok: false, error: "the reply must be one JSON object" };
  const { rationale, ...body } = raw;
  if (typeof rationale !== "string" || rationale.trim() === "") return { ok: false, error: "rationale must be a non-empty string" };
  const checked: ReturnType<typeof validateArmConfig> | ReturnType<typeof validateExp7ArmConfig> = exp7 ? validateExp7ArmConfig(body) : validateArmConfig(body);
  if (!checked.ok) return { ok: false, error: checked.errors.join("; ") };
  const errors: string[] = [];
  for (const [k, v] of Object.entries(checked.config.questions)) {
    for (const t of forbidden.titles) if (v.includes(t)) errors.push(`questions.${k} names a clip title ${JSON.stringify(t)}; question wording must not name this course, its clips, titles or times`);
    for (const id of forbidden.videoIds) if (v.includes(id)) errors.push(`questions.${k} contains a clip id (${id}); question wording must not name this course, its clips, titles or times`);
    if (MM_SS.test(v)) errors.push(`questions.${k} contains a mm:ss time; question wording must not name this course, its clips, titles or times`);
  }
  return errors.length > 0 ? { ok: false, error: errors.join("; ") } : { ok: true, value: { config: checked.config, rationale: rationale.trim() } };
}

// ───────────────────────────── propose ─────────────────────────────

export type OptimizeOptions = OptimizeInputs & {
  readonly model: string;
  readonly outDir: string;
  readonly live: boolean;
  readonly maxClaudeCalls?: number;
  readonly claudeLedger?: string;
  readonly client?: ClaudeCli;
  readonly spawn?: SpawnFn;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly ceiling?: number;
  readonly out?: (line: string) => void;
};
export type OptimizeOutcome = { readonly armConfigPath: string; readonly readmePath: string; readonly calls: number; readonly round: number; readonly proposal: Proposal };

const retryText = (prompt: string, reason: string) => `${prompt}\n\nYour previous reply was refused: ${reason}\nReply again with ONLY the corrected JSON object, in the same shape.`;

function readme(info: { model: string; effort: string; origin: Origin; arm: string; round: number; calls: number; status: string; rationale?: string; files: readonly string[]; guard: string; exp7?: boolean }): string {
  return [
    `# Optimizer proposal: arm ${info.arm}, round ${info.round}, by ${info.model}`,
    "",
    `A model's proposal (effort ${info.effort}), not Derek's labels, not a result. It limits itself to ${info.exp7 === true ? "the six question wordings, the thresholds and the segmentation, checked by \`validateExp7ArmConfig\`" : "decision 4 (the three question wordings, the thresholds, the segmentation), checked by \`validateArmConfig\`"}. Jev has not been run with it.`,
    "",
    ...(info.origin === "fixture" ? ["**Origin: fixture.** A scripted client answered, not a model. These are test files, not a proposal by the model named above.", ""] : []),
    `- Status: ${info.status}`,
    `- Claude calls made (retries included): ${info.calls}`,
    `- Held-out guard: ${info.guard}`,
    `- The prompt was built from the approved template (${info.exp7 === true ? "the approved copy of docs/experiments/exp7-optimizer-prompt.md" : "docs/experiments/exp6-optimizer-prompt.md"}) and the FIRST HALF only; no frame images were attached. Every prompt and response is stored verbatim in calls/ (secrets from the environment are replaced by [redacted]).`,
    ...(info.rationale === undefined ? [] : ["", "Rationale (the model's, verbatim):", "", info.rationale]),
    "",
    "Files:",
    ...info.files.map((f) => `- ${f}`),
    "",
  ].join("\n");
}

export type DryRunOptions = OptimizeInputs & { readonly model: string; readonly outDir: string };
export type DryRunOutcome = { readonly promptPath: string; readonly guardPath: string; readonly readmePath: string; readonly round: number; readonly hits: readonly GuardHit[]; readonly promptChars: number };

/**
 * `--dry-run`: builds the real prompt and runs the guard; writes prompt.txt, guard.json and README.md. Makes no call, needs
 * no --live-claude or --max-claude-calls, builds no client and never touches the Claude ledger. A guard hit still writes
 * the files (for inspection; prompt.txt then holds the held-out material that was found) and then refuses.
 */
export function dryRunRound(opts: DryRunOptions): DryRunOutcome {
  if (!(PROPOSED_MODELS as readonly string[]).includes(opts.model)) refuse(`--model must be one of ${PROPOSED_MODELS.join(", ")}, got "${opts.model}"`);
  const outDir = resolve(opts.outDir);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) refuse(`--out ${outDir} is not empty`);
  const data = resolve(opts.dataDir);
  if (outDir === data || outDir.startsWith(data + sep)) refuse(`--out ${outDir} is inside the data dir; the data dir is never written`);
  const info = loadLabels([resolve(opts.labelFile)])[0]!;
  const ctx = resolveRound(opts, info);
  const built = buildOptimizerPrompt(opts, ctx, repoRoot, false);
  const hits = scanForHeldOut(built.prompt, built.heldOut, built.allow);
  mkdirSync(outDir, { recursive: true });
  const exp7 = opts.exp7 === true;
  const promptPath = join(outDir, "prompt.txt");
  const guardPath = join(outDir, "guard.json");
  const readmePath = join(outDir, "README.md");
  // An experiment 7 dry run uses the draft template unless an approved copy is given: its file says so on top (the guard scanned the prompt without the banner).
  const drafted = exp7 && opts.approvedTemplatePath === undefined;
  writeFileSync(promptPath, drafted ? `${DRAFT_BANNER}\n\n${built.prompt}` : built.prompt);
  writeFileSync(guardPath, JSON.stringify({ dryRun: true, passed: hits.length === 0, hits, heldOutReportScanned: opts.heldOutReportPath !== undefined }, null, 2) + "\n");
  writeFileSync(readmePath, [
    `# Optimizer dry run${exp7 ? " (experiment 7)" : ""}: arm ${opts.arm}, round ${ctx.round}, for ${opts.model}`, "",
    ...(drafted ? [`**${DRAFT_BANNER}**`, ""] : []),
    "No Claude call was made and the Claude ledger was not touched. This is the prompt the live run would send, and the held-out guard's verdict on it.", "",
    `- Guard: ${hits.length === 0 ? "passed" : `REFUSED: ${hits.map((h) => h.detail).join("; ")}`}`,
    `- Held-out report scanned: ${opts.heldOutReportPath === undefined ? "NO (no --heldout-report given; a live run requires it)" : "yes"}`,
    `- Prompt: ${built.prompt.length} characters, ${built.nClips} of ${built.mClips} clips`, "",
    "Files:", "- prompt.txt", "- guard.json", "",
  ].join("\n"));
  if (hits.length > 0) refuse(`held-out guard: the prompt contains held-out material: ${hits.map((h) => h.detail).join("; ")} (nothing was sent; see ${guardPath})`);
  return { promptPath, guardPath, readmePath, round: ctx.round, hits, promptChars: built.prompt.length };
}

/** Experiment 7's own Claude ledger: ceiling 80, and never above it (the command line has no flag for it; `ceiling` is a test seam that may only lower it). */
function exp7Ceiling(opts: { readonly ceiling?: number }): number {
  if (opts.ceiling !== undefined && opts.ceiling > EXP7_BUDGET_CLAUDE_CALLS) refuse(`the experiment 7 Claude ceiling is ${EXP7_BUDGET_CLAUDE_CALLS}; a higher ceiling (${opts.ceiling}) is refused`);
  return opts.ceiling ?? EXP7_BUDGET_CLAUDE_CALLS;
}

/**
 * Experiment 7 counts its Claude calls in its own ledger, <lab>/exp7 (the doc: "experiment 6's ledger, capped at 250, has 67 left
 * and is not used"): --out must be a direct child of it, and a live run's --claude-ledger must be it.
 */
function checkExp7Ledger(opts: OptimizeOptions, outDir: string): void {
  const ledger = join(resolve(opts.labDir), "exp7");
  if (dirname(outDir) !== ledger) refuse(`an experiment 7 --out must be a directory directly inside ${ledger}, the experiment 7 Claude ledger; experiment 6's data/lab/propose ledger is not used (07 doc, Budget)`);
  if (opts.live && opts.claudeLedger !== undefined && resolve(opts.claudeLedger) !== ledger) refuse(`--claude-ledger ${opts.claudeLedger} must be ${ledger}, experiment 7's own ledger`);
}

export async function proposeRound(opts: OptimizeOptions): Promise<OptimizeOutcome> {
  const { effort, origin } = checkCommon({ model: opts.model, outDir: opts.outDir, live: opts.live, ...(opts.maxClaudeCalls === undefined ? {} : { maxClaudeCalls: opts.maxClaudeCalls }), ...(opts.client === undefined ? {} : { client: opts.client }) });
  if (opts.live && opts.heldOutReportPath === undefined) refuse("a live run needs --heldout-report <experiment 2's score-1.report.txt>: its lines are scanned for in every prompt");
  const outDir = resolve(opts.outDir);
  const ceiling = opts.exp7 === true ? exp7Ceiling(opts) : opts.ceiling;
  if (opts.exp7 === true) checkExp7Ledger(opts, outDir);
  if (opts.live) {
    if (opts.claudeLedger === undefined) refuse("a live run needs --claude-ledger <dir>, the parent of --out that holds claude-state.live.json, so these calls count against the shared 250-call cap");
    if (opts.exp7 !== true && resolve(opts.claudeLedger) !== dirname(outDir)) {
      refuse(`--claude-ledger ${opts.claudeLedger} must be the parent of --out (${dirname(outDir)}), so that this run's calls count in the same ledger and call floor as the labelers'`);
    }
  }
  const labels = loadLabels([resolve(opts.labelFile)]);
  const info = labels[0]!;
  const ctx = resolveRound(opts, info);
  const built = buildOptimizerPrompt(opts, ctx, repoRoot, opts.live);
  const first = scanForHeldOut(built.prompt, built.heldOut, built.allow);

  const { session: s, cleanup } = openSession(
    { model: opts.model, outDir, live: opts.live, effort, ...(opts.maxClaudeCalls === undefined ? {} : { maxClaudeCalls: opts.maxClaudeCalls }), ...(opts.client === undefined ? {} : { client: opts.client }), ...(opts.spawn ? { spawn: opts.spawn } : {}), ...(opts.env ? { env: opts.env } : {}), ...(opts.now ? { now: opts.now } : {}), ...(ceiling === undefined ? {} : { ceiling }), ...(opts.out ? { out: opts.out } : {}), ledgerDir: opts.claudeLedger ?? dirname(outDir) },
    effort, origin, 1, resolve(opts.dataDir),
  );
  const readmePath = join(outDir, "README.md");
  const armConfigPath = join(outDir, "arm-config.json");
  const base = { model: opts.model, effort, origin, arm: opts.arm, round: ctx.round, ...(opts.exp7 === true ? { exp7: true } : {}) };
  const files = ["arm-config.json (jev-arm-config, validated; give it to `jev-lab run --phase tune --arm-config`)", "rationale.txt", "guard.json", "calls/<n>.prompt.txt, calls/<n>.response.txt, calls/<n>.meta.json"];
  const guardNote = (hits: readonly GuardHit[]) => (hits.length === 0 ? "passed before every call (first-half inputs only, scanned for held-out ids, titles, passages, label times, report lines)" : `REFUSED: ${hits.map((h) => h.detail).join("; ")}`);
  s.say(`optimizer round ${ctx.round} for arm ${opts.arm} with ${opts.model} (effort ${effort}): ${built.nClips} of ${built.mClips} clips in the prompt`);
  try {
    if (first.length > 0) {
      writeFileSync(join(outDir, "guard.json"), JSON.stringify({ passed: false, hits: first }, null, 2) + "\n");
      refuse(`held-out guard: the prompt contains held-out material and nothing was sent: ${first.map((h) => h.detail).join("; ")}`);
    }
    writeFileSync(join(outDir, "guard.json"), JSON.stringify({ passed: true, hits: [] }, null, 2) + "\n");
    let reason = "";
    let prompt = built.prompt;
    for (const attempt of [1, 2]) {
      if (attempt === 2) {
        prompt = retryText(built.prompt, reason);
        const again = scanForHeldOut(prompt, built.heldOut, built.allow);
        if (again.length > 0) refuse(`held-out guard on the retry prompt: nothing more was sent: ${again.map((h) => h.detail).join("; ")}`);
      }
      const r = await attemptCall(s, { kind: "optimize", system: OPTIMIZE_SYSTEM, prompt, images: [], attempt });
      if (r.ok) {
        const parsed = parseProposal(r.text, built.forbiddenInWording, opts.exp7 === true);
        if (parsed.ok) {
          const proposal = parsed.value;
          writeFileSync(armConfigPath, JSON.stringify(JSON.parse(s.redact(JSON.stringify(proposal.config))), null, 2) + "\n");
          writeFileSync(join(outDir, "rationale.txt"), s.redact(proposal.rationale) + "\n");
          writeFileSync(readmePath, readme({ ...base, calls: s.n, status: "COMPLETE", rationale: s.redact(proposal.rationale), files, guard: guardNote([]) }));
          s.say(`wrote ${armConfigPath} after ${s.n} Claude call(s). A model's proposal: not a result; run it with jev-lab run --phase tune --arm ${opts.arm} --arm-config.`);
          return { armConfigPath, readmePath, calls: s.n, round: ctx.round, proposal };
        }
        reason = parsed.error;
        r.meta.refusedReason = s.redact(reason);
        writeMeta(s, r.n, r.meta);
      } else reason = r.error;
      s.say(`call ${r.n} (attempt ${attempt}) refused: ${s.redact(reason).slice(0, 200)}`);
    }
    return refuse(`the optimizer's reply was refused twice and is not retried again; last reason: ${s.redact(reason).slice(0, 400)}`);
  } catch (e) {
    const hits = first.length > 0 ? first : [];
    writeFileSync(readmePath, readme({ ...base, calls: s.n, status: `INCOMPLETE: ${s.redact(e instanceof Error ? e.message : String(e))}. No arm-config.json was written; the calls made are stored in calls/.`, files: files.slice(1), guard: guardNote(hits) }));
    throw e;
  } finally {
    cleanup();
  }
}

// ───────────────────────────── command line ─────────────────────────────

async function cli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      data: { type: "string" }, labels: { type: "string" }, lab: { type: "string" }, arm: { type: "string" }, model: { type: "string" }, out: { type: "string" },
      "from-results": { type: "string", multiple: true }, "baseline-state": { type: "string" }, previous: { type: "string", multiple: true }, "heldout-report": { type: "string" },
      "dry-run": { type: "boolean" }, "live-claude": { type: "boolean" }, "max-claude-calls": { type: "string" }, "claude-ledger": { type: "string" }, exp7: { type: "boolean" }, "approved-template": { type: "string" },
    },
  });
  if (command !== "propose") return usage("the only command is propose");
  if (!values.data || !values.labels || !values.lab || !values.arm || !values.model || !values.out) return usage("propose needs --data, --labels, --lab, --arm, --model and --out");
  if (values["dry-run"] === true) {
    if (values["live-claude"] || values["max-claude-calls"] !== undefined || values["claude-ledger"]) return usage("--dry-run makes no call and never touches the ledger; do not combine it with --live-claude, --max-claude-calls or --claude-ledger");
    const r = dryRunRound({
      dataDir: resolve(values.data), labelFile: resolve(values.labels), labDir: resolve(values.lab), arm: values.arm, model: values.model, outDir: resolve(values.out),
      fromResults: values["from-results"] ?? [], previousDirs: values.previous ?? [],
      ...(values["baseline-state"] ? { baselineStatePath: values["baseline-state"] } : {}),
      ...(values["heldout-report"] ? { heldOutReportPath: values["heldout-report"] } : {}),
      ...(values.exp7 === true ? { exp7: true } : {}), ...(values["approved-template"] ? { approvedTemplatePath: values["approved-template"] } : {}),
    });
    console.log(`[dry-run] round ${r.round}: guard passed, prompt ${r.promptChars} characters, wrote ${r.promptPath}; no Claude call was made`);
    return 0;
  }
  const max = values["max-claude-calls"] === undefined ? undefined : parseMaxClaudeCalls(values["max-claude-calls"]);
  await proposeRound({
    dataDir: resolve(values.data), labelFile: resolve(values.labels), labDir: resolve(values.lab), arm: values.arm, model: values.model, outDir: resolve(values.out),
    fromResults: values["from-results"] ?? [], previousDirs: values.previous ?? [], live: values["live-claude"] === true,
    ...(values["baseline-state"] ? { baselineStatePath: values["baseline-state"] } : {}),
    ...(values["heldout-report"] ? { heldOutReportPath: values["heldout-report"] } : {}),
    ...(values.exp7 === true ? { exp7: true } : {}), ...(values["approved-template"] ? { approvedTemplatePath: values["approved-template"] } : {}),
    ...(max === undefined ? {} : { maxClaudeCalls: max }),
    ...(values["claude-ledger"] ? { claudeLedger: resolve(values["claude-ledger"]) } : {}),
  });
  return 0;
}

function usage(message: string): number {
  console.error(`jev-lab-optimize: ${message}`);
  return 2;
}

if (import.meta.main) {
  void cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`jev-lab-optimize: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
