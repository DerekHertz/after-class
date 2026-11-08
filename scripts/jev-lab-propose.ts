import type { LabelProposals, ProposedBoundary, ProposedFrame, ProposedGroup, ProposedStep, Rec } from "./jev-lab-proposal-schema";
import { BUDGET_CLAUDE_CALLS, CALL_TIMEOUT_MS, CHUNK_OVERLAP_FRAMES, COMPARE_FRAME_MATCH_S, COMPARE_TOLERANCE_BOUNDARY_S, COMPARE_TOLERANCE_STEP_S, EFFORTS, FRAME_TIME_EPS_S, MAX_FRAMES_PER_CALL, MERGE_TOLERANCE_S, PILOT_CALLS, PROPOSED_MODELS, PROPOSE_EFFORT, SECRET_ENV, isRec, isText, refuse, validateProposals } from "./jev-lab-proposal-schema";
/**
 * Experiment 6, stages 2-4 (docs/experiments/06-model-optimized-jev.md): ask a Claude model to PROPOSE labels for a
 * lecture set, the way the product sees it, for Derek to verify later. Proposals are not Derek's labels and not truth.
 *
 *   bun run scripts/jev-lab-propose.ts plan    --data <assembledDir> --capture <id> [--origin fixture|live]
 *   bun run scripts/jev-lab-propose.ts pilot   --model <id> --out <dir> [--data <dir> --capture <id>] [--live-claude --max-claude-calls <n>]
 *   bun run scripts/jev-lab-propose.ts propose --data <assembledDir> --capture <id> --model <id> --out <dir> [--live-claude --max-claude-calls <n>]
 *   bun run scripts/jev-lab-propose.ts compare --a <proposals.json> --b <proposals.json> --out <file> [--origin fixture|live]
 *
 * Claude is reached only through the product's own client (`createClaudeCli` in src/backend/providers/claude.ts:
 * `claude -p --restricted --tools Read ...`, the billing variables stripped from the child's environment, the frames
 * attached as copied image files). No call is made without `--live-claude` AND `--max-claude-calls N`; without them only an
 * injected scripted client (tests) runs. The data dir is read through a scratch copy and never written. This tool makes no
 * Jev call, reads no key file and has no network code of its own.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import type { ClaudeCli, ClaudeImage, ClaudeRequest, Effort, SpawnFn } from "../src/backend/providers/claude";
import { createClaudeCli } from "../src/backend/providers/claude";
import { QUESTIONS } from "../src/backend/providers/jev-tasks";
import type { UsageReport } from "../src/backend/providers/memo";
import type { CaptureId } from "../src/shared/ids";
import { provenanceLine, readProvenance } from "./assemble-capture";
import { openCapture } from "./jev-lab";
import { VISUAL_STEP_RULE } from "./jev-lab-draft";
import type { Origin } from "./jev-lab-score";
import { percentile } from "./jev-lab-score";

// ───────────────────────────── the evidence, per clip ─────────────────────────────

export type FrameRef = { readonly id: string; readonly mediaS: number; readonly file: string };
export type ClipEvidence = {
  readonly videoId: string;
  readonly title: string | null;
  /** The watched span of the clip: first to last watched second. */
  readonly spanS: { readonly start: number; readonly end: number };
  readonly passages: readonly { readonly start: number; readonly end: number; readonly text: string }[];
  readonly frames: readonly FrameRef[];
};

/**
 * The clips of a capture in WATCH order with their watched passages and the captured frames that have a file. Read through
 * a scratch copy of the database (`openCapture`); frame files are only read, so the data dir is never written.
 */
export function readClips(dataDir: string, captureId: string): { readonly clips: readonly ClipEvidence[]; readonly provenance: string | null } {
  const cap = openCapture(dataDir);
  try {
    const bundle = cap.evidence.captureBundle(captureId as CaptureId);
    const view = cap.evidence.captureView(captureId as CaptureId);
    const clips = view.sources.flatMap((source): ClipEvidence[] => {
      const intervals = bundle.watched.find((w) => w.sourceId === source.id)?.intervals ?? [];
      if (intervals.length === 0) return [];
      return [{
        videoId: source.videoId,
        title: source.title || null,
        spanS: { start: Math.min(...intervals.map(([a]) => a)), end: Math.max(...intervals.map(([, b]) => b)) },
        passages: bundle.passages.filter((p) => p.sourceId === source.id && p.text.trim() !== "").sort((a, b) => a.start - b.start || a.end - b.end).map((p) => ({ start: p.start, end: p.end, text: p.text })),
        frames: bundle.frames.filter((f) => f.sourceId === source.id && f.file !== null && existsSync(f.file)).sort((a, b) => a.mediaS - b.mediaS || a.id.localeCompare(b.id)).map((f) => ({ id: f.id, mediaS: f.mediaS, file: f.file! })),
      }];
    });
    if (clips.length === 0) refuse(`capture ${captureId} has no watched time; is the id right?`);
    const prov = readProvenance(dataDir);
    return { clips, provenance: prov === null ? null : provenanceLine(prov) };
  } finally {
    cap.close();
  }
}

// ───────────────────────────── chunking ─────────────────────────────

/** Index ranges [from, to) of frames, each at most `max` long, consecutive ranges sharing `overlap` frames. A clip without frames is one empty range. */
export function chunkRanges(n: number, max = MAX_FRAMES_PER_CALL, overlap = CHUNK_OVERLAP_FRAMES): readonly { readonly from: number; readonly to: number }[] {
  if (!(overlap >= 0 && overlap < max)) throw new RangeError("overlap must be below the chunk size");
  if (n <= max) return [{ from: 0, to: n }];
  const out: { from: number; to: number }[] = [];
  let from = 0;
  for (;;) {
    const to = Math.min(n, from + max);
    out.push({ from, to });
    if (to === n) return out;
    from = to - overlap;
  }
}

/** One Claude call's worth of one clip. */
export type ClipCall = {
  readonly clip: ClipEvidence;
  readonly clipNumber: number;
  readonly clipCount: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly frames: readonly FrameRef[];
  /** The first `overlapFrames` of `frames` were also in the previous call of this clip. */
  readonly overlapFrames: number;
  /** The part of the clip this call covers: the transcript passages that touch it are sent. */
  readonly rangeS: { readonly start: number; readonly end: number };
};

/** Every call of a lecture in watch order. A clip with neither passages nor frames has nothing to show and gets no call. */
export function callsOfClips(clips: readonly ClipEvidence[]): readonly ClipCall[] {
  return clips.flatMap((clip, i) => {
    if (clip.passages.length === 0 && clip.frames.length === 0) return [];
    const ranges = chunkRanges(clip.frames.length);
    return ranges.map((r, k): ClipCall => ({
      clip, clipNumber: i + 1, clipCount: clips.length, chunkIndex: k, chunkCount: ranges.length,
      frames: clip.frames.slice(r.from, r.to),
      overlapFrames: k === 0 ? 0 : ranges[k - 1]!.to - r.from,
      rangeS: { start: k === 0 ? clip.spanS.start : clip.frames[r.from]!.mediaS, end: k === ranges.length - 1 ? clip.spanS.end : clip.frames[r.to]!.mediaS },
    }));
  });
}

// ───────────────────────────── the prompt ─────────────────────────────

const num = (x: number) => String(Number(x.toFixed(2)));
const frameLabel = (f: FrameRef) => `frame ${f.id} at ${num(f.mediaS)} s`;

export const PROPOSE_SYSTEM =
  "You label lecture clips for a study tool. You answer with one JSON object and nothing else. When the message lists image files, you view each with the Read tool first.";

export function buildPrompt(call: ClipCall): string {
  const { clip } = call;
  const span = clip.spanS;
  const passages = clip.passages.filter((p) => p.end > call.rangeS.start && p.start < call.rangeS.end);
  const lines: string[] = [
    "You are proposing labels for one clip of a lecture, the way the After Class study tool sees it. Derek, who owns the lecture material, will check every proposal later. What you write is a PROPOSAL, not truth.",
    "",
    "You have NOT seen any Jev output and you have NOT seen any other model's labels. Decide from the transcript and the frames below only.",
    "",
    "The tool asks these questions about lecture material. Use their meaning when you decide:",
    `- New topic (state.passage is the transcript after a point, state.context is the explanation before it): "${QUESTIONS.boundary.newConcept}"`,
    `- Stopping point: "${QUESTIONS.boundary.stoppingPoint}"`,
    `- Frames (state.before and state.after are two consecutive captured frames): "${QUESTIONS.frameChange.teachingChange}"`,
    "",
    `Derek's rule for a visual step (verbatim): "${VISUAL_STEP_RULE}"`,
    "",
    `Clip ${call.clipNumber} of ${call.clipCount} of the lecture, watched in this order (videoId ${clip.videoId}${clip.title === null ? "" : `, title ${JSON.stringify(clip.title)}`}).`,
    `Watched span: ${num(span.start)} s to ${num(span.end)} s. Times are media seconds of this clip; every time you give must be at least ${num(span.start)} and below ${num(span.end)}.`,
    "Clip joins are added by code. Do NOT propose a boundary at the start of this clip or at its end; where one clip ends and the next begins is not yours to decide.",
  ];
  if (call.chunkCount > 1) {
    lines.push(
      "",
      `This clip has ${clip.frames.length} frames. They are sent in ${call.chunkCount} calls of at most ${MAX_FRAMES_PER_CALL} frames each, with ${CHUNK_OVERLAP_FRAMES} frames repeated between neighbouring calls. This is call ${call.chunkIndex + 1} of ${call.chunkCount}; it covers ${num(call.rangeS.start)} s to ${num(call.rangeS.end)} s of the clip.` +
        (call.overlapFrames > 0 ? ` The first ${call.overlapFrames} frames listed were also shown in the previous call; they are context.` : "") +
        " Propose items for the part you are shown. An item near a seam may be proposed by two calls; code merges those.",
    );
  }
  lines.push(
    "",
    "What to propose, for this clip only:",
    "1. Topic boundaries inside the clip: places where a materially different topic begins. Give mediaS and a one-sentence reason.",
    "2. Visual steps: the media time of a frame where the slide content changed under Derek's rule above. Give mediaS and a one-sentence reason.",
    "3. Duplicate groups: frames of this call that show the same content, so only the first would be kept. Give each group at least two frames, each by frameId and mediaS exactly as listed below, and a one-sentence reason.",
    "Use an empty array when there is none. Do not give an item you cannot justify from what is shown.",
    "",
    `Transcript passages (media seconds of this clip):`,
    ...(passages.length === 0 ? ["(no transcript passages in this part)"] : passages.map((p) => `[${p.start.toFixed(1)} s to ${p.end.toFixed(1)} s] ${p.text}`)),
    "",
  );
  if (call.frames.length === 0) lines.push("No frames were captured for this clip.");
  else
    lines.push(
      "Frames, each also attached as an image file that you must view with the Read tool before you answer (the file paths follow at the end of this message), labelled with its media time:",
      ...call.frames.map((f) => `- ${frameLabel(f)}`),
    );
  lines.push(
    "",
    "Reply with ONLY one JSON object, exactly this shape, with no prose and no code fence:",
    '{"boundaries":[{"mediaS":0,"reason":"..."}],"visualSteps":[{"mediaS":0,"reason":"..."}],"duplicateGroups":[{"frames":[{"frameId":"...","mediaS":0},{"frameId":"...","mediaS":0}],"reason":"..."}]}',
  );
  return lines.join("\n");
}

// ───────────────────────────── strict response validation ─────────────────────────────

export type ChunkProposal = {
  readonly boundaries: readonly { readonly mediaS: number; readonly reason: string }[];
  readonly visualSteps: readonly { readonly mediaS: number; readonly reason: string }[];
  readonly duplicateGroups: readonly { readonly frames: readonly { readonly frameId: string; readonly mediaS: number }[]; readonly reason: string }[];
};
export type ParsedResponse = { readonly ok: true; readonly value: ChunkProposal } | { readonly ok: false; readonly error: string };

/**
 * The reply must be exactly one JSON object (one code fence around it is allowed) with exactly the three arrays. Nothing is
 * repaired, clipped or filled in: any problem refuses the whole reply, and every problem is listed.
 */
export function parseResponse(text: string, call: ClipCall): ParsedResponse {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  let raw: unknown;
  try {
    raw = JSON.parse(fenced ? fenced[1]! : text.trim());
  } catch (e) {
    return { ok: false, error: `the reply is not valid JSON (${e instanceof Error ? e.message : "parse error"}); it must be one JSON object and nothing else` };
  }
  if (!isRec(raw)) return { ok: false, error: "the reply must be one JSON object with boundaries, visualSteps and duplicateGroups" };
  const errors: string[] = [];
  const bad = (path: string, why: string) => void errors.push(`${path} ${why}`);
  for (const k of ["boundaries", "visualSteps", "duplicateGroups"]) if (!(k in raw)) bad(k, "is missing");
  for (const k of Object.keys(raw)) if (!["boundaries", "visualSteps", "duplicateGroups"].includes(k)) bad(k, "is not an allowed field");
  const { start, end } = call.clip.spanS;
  const exact = (o: Rec, path: string, allowed: readonly string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${path}.${k}`, "is not an allowed field");
  };
  const timed = (name: "boundaries" | "visualSteps"): { mediaS: number; reason: string }[] => {
    const v = raw[name];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      bad(name, "must be an array");
      return [];
    }
    return v.flatMap((x: unknown, i: number) => {
      const path = `${name}[${i}]`;
      if (!isRec(x)) {
        bad(path, "must be an object");
        return [];
      }
      exact(x, path, ["mediaS", "reason"]);
      let ok = true;
      if (typeof x.mediaS !== "number" || !Number.isFinite(x.mediaS) || x.mediaS < start || x.mediaS >= end) {
        bad(`${path}.mediaS`, `${JSON.stringify(x.mediaS)} must be a number from ${num(start)} up to but not including ${num(end)}, inside the clip's watched span`);
        ok = false;
      }
      if (!isText(x.reason)) {
        bad(`${path}.reason`, "must be a non-empty string");
        ok = false;
      }
      return ok ? [{ mediaS: x.mediaS as number, reason: x.reason as string }] : [];
    });
  };
  const boundaries = timed("boundaries");
  const visualSteps = timed("visualSteps");

  const byId = new Map(call.frames.map((f) => [f.id, f] as const));
  const inGroup = new Map<string, number>();
  const duplicateGroups: ChunkProposal["duplicateGroups"][number][] = [];
  const dups = raw.duplicateGroups;
  if (dups !== undefined && !Array.isArray(dups)) bad("duplicateGroups", "must be an array");
  else
    (dups ?? []).forEach((g: unknown, i: number) => {
      const path = `duplicateGroups[${i}]`;
      if (!isRec(g)) return bad(path, "must be an object");
      exact(g, path, ["frames", "reason"]);
      let ok = true;
      if (!isText(g.reason)) {
        bad(`${path}.reason`, "must be a non-empty string");
        ok = false;
      }
      if (!Array.isArray(g.frames) || g.frames.length < 2) {
        bad(`${path}.frames`, "needs at least 2 frames");
        return;
      }
      const frames: { frameId: string; mediaS: number }[] = [];
      g.frames.forEach((f: unknown, j: number) => {
        const fp = `${path}.frames[${j}]`;
        if (!isRec(f)) return void bad(fp, "must be an object");
        exact(f, fp, ["frameId", "mediaS"]);
        let frame: FrameRef | undefined;
        if (f.frameId !== undefined) {
          frame = typeof f.frameId === "string" ? byId.get(f.frameId) : undefined;
          if (frame === undefined) return void bad(`${fp}.frameId`, `${JSON.stringify(f.frameId)} is not a frame shown in this call`);
          if (f.mediaS !== undefined && !(typeof f.mediaS === "number" && Math.abs(f.mediaS - frame.mediaS) <= FRAME_TIME_EPS_S)) return void bad(`${fp}.mediaS`, `${JSON.stringify(f.mediaS)} disagrees with frame ${frame.id}, which is at ${num(frame.mediaS)} s`);
        } else if (typeof f.mediaS === "number") {
          frame = call.frames.find((c) => Math.abs(c.mediaS - (f.mediaS as number)) <= FRAME_TIME_EPS_S);
          if (frame === undefined) return void bad(`${fp}.mediaS`, `${JSON.stringify(f.mediaS)} matches no frame shown in this call`);
        } else return void bad(fp, "needs a frameId or a mediaS");
        if (frames.some((x) => x.frameId === frame!.id)) return void bad(fp, `names frame ${frame.id} twice in one group; frames in a group must be distinct`);
        const other = inGroup.get(frame.id);
        if (other !== undefined && other !== i) return void bad(fp, `names frame ${frame.id}, which is already in duplicateGroups[${other}]; a frame is in one group`);
        inGroup.set(frame.id, i);
        frames.push({ frameId: frame.id, mediaS: frame.mediaS });
      });
      if (ok && frames.length === g.frames.length) duplicateGroups.push({ frames, reason: g.reason as string });
    });

  return errors.length > 0 ? { ok: false, error: errors.join("; ") } : { ok: true, value: { boundaries, visualSteps, duplicateGroups } };
}

// ───────────────────────────── deterministic merge ─────────────────────────────

/**
 * One clip's call proposals, merged without a model. A boundary or step within MERGE_TOLERANCE_S of an item kept from an
 * EARLIER call is that item seen again at a seam: it is dropped, the earlier call's wording stays. Items of one call are
 * never merged with each other. Duplicate groups of different calls that share a frame become one group (frames by time,
 * the earliest call's reason). The output is sorted by time.
 */
export function mergeChunks(chunks: readonly ChunkProposal[]): ChunkProposal {
  const timed = (pick: (c: ChunkProposal) => readonly { readonly mediaS: number; readonly reason: string }[]) => {
    const kept: { chunk: number; item: { mediaS: number; reason: string } }[] = [];
    chunks.forEach((c, ci) => {
      for (const item of pick(c)) if (!kept.some((k) => k.chunk < ci && Math.abs(k.item.mediaS - item.mediaS) <= MERGE_TOLERANCE_S)) kept.push({ chunk: ci, item: { mediaS: item.mediaS, reason: item.reason } });
    });
    return kept.map((k) => k.item).sort((a, b) => a.mediaS - b.mediaS);
  };

  type G = { chunk: number; frames: Map<string, { frameId: string; mediaS: number }>; reason: string };
  let groups: G[] = [];
  chunks.forEach((c, ci) => {
    for (const g of c.duplicateGroups) {
      const sharing = groups.filter((k) => k.chunk < ci && g.frames.some((f) => k.frames.has(f.frameId)));
      const target = sharing[0] ?? { chunk: ci, frames: new Map<string, { frameId: string; mediaS: number }>(), reason: g.reason };
      if (sharing.length === 0) groups.push(target);
      for (const other of sharing.slice(1)) {
        for (const [id, f] of other.frames) target.frames.set(id, f);
        groups = groups.filter((x) => x !== other);
      }
      for (const f of g.frames) target.frames.set(f.frameId, { frameId: f.frameId, mediaS: f.mediaS });
    }
  });
  const duplicateGroups = groups
    .map((g) => ({ frames: [...g.frames.values()].sort((a, b) => a.mediaS - b.mediaS || a.frameId.localeCompare(b.frameId)), reason: g.reason }))
    .sort((a, b) => a.frames[0]!.mediaS - b.frames[0]!.mediaS);
  return { boundaries: timed((c) => c.boundaries), visualSteps: timed((c) => c.visualSteps), duplicateGroups };
}

/** The product's rule: a video ending does not close and the next clip's first window decides. So code adds a candidate at each later clip's start. */
export function joinBoundaries(clips: readonly ClipEvidence[]): readonly ProposedBoundary[] {
  return clips.slice(1).map((c, i) => ({
    videoId: c.videoId,
    mediaS: c.spanS.start,
    reason: `Added by code, not proposed by the model: start of clip ${i + 2}. The product does not close a chunk when a video ends; the next clip's first window decides (flow B).`,
    source: "join" as const,
  }));
}

// ───────────────────────────── the plan ─────────────────────────────

export type ProposePlan = { readonly clips: readonly { readonly videoId: string; readonly frames: number; readonly calls: number }[]; readonly calls: number; readonly lines: readonly string[] };

/** Counts the calls `propose` would make for one model, from the real evidence. Opens no client and makes no call. */
export function planPropose(opts: { readonly dataDir: string; readonly captureId: string }): ProposePlan {
  const { clips, provenance } = readClips(opts.dataDir, opts.captureId);
  const calls = callsOfClips(clips);
  const per = clips.map((c) => ({ videoId: c.videoId, frames: c.frames.length, calls: calls.filter((x) => x.clip.videoId === c.videoId).length }));
  const total = calls.length;
  const lines = [
    "Claude proposal plan: counts only, no call is made.",
    ...(provenance === null ? [] : [`Data origin: ${provenance}`]),
    ...per.map((c, i) => `clip ${i + 1} ${c.videoId}: ${c.frames} frames in ${c.calls} call(s)${c.calls === 0 ? " (no passages and no frames: nothing to show)" : ""}`),
    `propose, one model: ${total} calls at the minimum (no retry); at most ${2 * total} if every call were refused once`,
    `propose, both models (${PROPOSED_MODELS.join(", ")}): ${2 * total} calls at the minimum`,
    `timing pilot: ${PILOT_CALLS} calls per model`,
    `ceiling for the whole experiment: ${BUDGET_CLAUDE_CALLS} Claude calls, retries included`,
  ];
  return { clips: per, calls: total, lines };
}

// ───────────────────────────── the rails: counter, ceiling, out dir ─────────────────────────────

export type CallOptions = {
  readonly model: string;
  readonly effort?: Effort;
  readonly outDir: string;
  /** `--live-claude`: use the real client. Needs maxClaudeCalls. Without it only an injected `client` runs. */
  readonly live: boolean;
  readonly maxClaudeCalls?: number;
  /** Scripted client for tests; ignored when live. */
  readonly client?: ClaudeCli;
  /** Seams for the real client in tests. */
  readonly spawn?: SpawnFn;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly imageRoot?: string;
  readonly now?: () => number;
  /** For tests only: a lower ceiling. The command line has no such flag. */
  readonly ceiling?: number;
  /** The directory that holds `claude-state.<origin>.json` and the sibling output dirs the call floor reads. Default: the parent of `outDir`. */
  readonly ledgerDir?: string;
  readonly out?: (line: string) => void;
};

export function parseMaxClaudeCalls(s: string): number {
  const n = Number(s);
  if (s.trim() === "" || !Number.isInteger(n) || n < 1) refuse(`--max-claude-calls must be a positive integer, got "${s}"`);
  return n;
}

export function checkCommon(opts: CallOptions): { effort: Effort; origin: Origin } {
  if (!(PROPOSED_MODELS as readonly string[]).includes(opts.model)) refuse(`--model must be one of ${PROPOSED_MODELS.join(", ")}, got "${opts.model}"`);
  const effort = opts.effort ?? PROPOSE_EFFORT;
  if (!EFFORTS.includes(effort)) refuse(`--effort must be one of ${EFFORTS.join(", ")}, got "${String(effort)}"`);
  if (opts.live) {
    if (opts.maxClaudeCalls === undefined) refuse("a live run needs --max-claude-calls <n>");
  } else if (opts.client === undefined) {
    refuse("no Claude call is made without --live-claude and --max-claude-calls <n>; without them only an injected scripted client (tests) runs");
  }
  if (opts.maxClaudeCalls !== undefined && (!Number.isInteger(opts.maxClaudeCalls) || opts.maxClaudeCalls < 1)) refuse(`--max-claude-calls must be a positive integer, got ${String(opts.maxClaudeCalls)}`);
  return { effort, origin: opts.live ? "live" : "fixture" };
}

function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

function checkOutDir(outDir: string, dataDir: string | undefined): void {
  if (dataDir !== undefined && inside(realish(outDir), realish(dataDir))) refuse(`--out ${outDir} is inside the data dir ${dataDir} (also through a symlink); the data dir is never written`);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) refuse(`--out ${outDir} is not empty; proposals are never mixed into or overwritten over an earlier run`);
}

type ClaudeState = { readonly version: 1; readonly callsUsed: number };
const stateFile = (labDir: string, origin: Origin) => join(labDir, `claude-state.${origin}.json`);

function readClaudeState(path: string): ClaudeState {
  if (!existsSync(path)) return { version: 1, callsUsed: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    refuse(`${path} is not valid JSON; refusing to guess the Claude-call counter (state). Restore it or ask Derek.`);
  }
  if (!isRec(parsed) || parsed.version !== 1 || typeof parsed.callsUsed !== "number" || !Number.isInteger(parsed.callsUsed) || parsed.callsUsed < 0) {
    refuse(`${path} is malformed (not a version 1 Claude-call state); refusing to guess the counter. Restore it or ask Derek.`);
  }
  return parsed as ClaudeState;
}

/** A deleted state file cannot reset the counter: every attempt writes a meta file in some output dir next to this one, and those count. */
function floorFromFiles(labDir: string, origin: Origin): number {
  if (!existsSync(labDir)) return 0;
  let n = 0;
  for (const entry of readdirSync(labDir)) {
    const calls = join(labDir, entry, "calls");
    if (!existsSync(calls)) continue;
    for (const f of readdirSync(calls)) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const m = JSON.parse(readFileSync(join(calls, f), "utf8")) as Rec;
        if (m.origin === "fixture" || m.origin === "live") {
          if (m.origin === origin) n++;
          continue;
        }
      } catch {
        // a file that cannot be read still stands for a call
      }
      n++;
    }
  }
  return n;
}

type Ledger = {
  readonly used: () => number;
  /** Checked BEFORE each call, retries included; counts the call and persists the counter. */
  charge(): void;
  assertPlan(planned: number): void;
};

function openLedger(labDir: string, origin: Origin, opts: { readonly maxClaudeCalls?: number; readonly ceiling?: number }): Ledger {
  const path = stateFile(labDir, origin);
  const ceiling = opts.ceiling ?? BUDGET_CLAUDE_CALLS;
  let used = Math.max(readClaudeState(path).callsUsed, floorFromFiles(labDir, origin));
  let runCalls = 0;
  return {
    used: () => used,
    assertPlan(planned) {
      if (opts.maxClaudeCalls !== undefined && planned > opts.maxClaudeCalls) refuse(`this run plans ${planned} Claude calls but --max-claude-calls is ${opts.maxClaudeCalls}; nothing was called`);
      if (used + planned > ceiling) refuse(`${used} Claude calls are already used in ${labDir}; this run plans ${planned}, which would pass the ${ceiling}-call ceiling for the whole experiment; nothing was called`);
    },
    charge() {
      if (used >= ceiling) refuse(`the ${ceiling}-call ceiling is reached (${used} used); no further call is made`);
      if (opts.maxClaudeCalls !== undefined && runCalls >= opts.maxClaudeCalls) refuse(`--max-claude-calls ${opts.maxClaudeCalls} reached; aborting before the next call`);
      used++;
      runCalls++;
      mkdirSync(labDir, { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, callsUsed: used }, null, 2) + "\n");
    },
  };
}

function makeRedactor(env: Readonly<Record<string, string | undefined>>): (s: string) => string {
  const secrets = SECRET_ENV.map((k) => env[k]).filter((v): v is string => typeof v === "string" && v.length >= 8);
  return (s) => secrets.reduce((acc, v) => acc.split(v).join("[redacted]"), s);
}

// ───────────────────────────── one stored Claude call ─────────────────────────────

export type CallKind = "propose" | "pilot-text" | "pilot-image" | "pilot-json" | "optimize";
export type Attempt = { readonly n: number; readonly ok: true; readonly text: string } | { readonly n: number; readonly ok: false; readonly error: string };

export type Session = {
  readonly client: ClaudeCli;
  readonly ledger: Ledger;
  readonly outDir: string;
  readonly model: string;
  readonly effort: Effort;
  readonly origin: Origin;
  readonly now: () => number;
  readonly redact: (s: string) => string;
  readonly say: (line: string) => void;
  n: number;
};

export type CallSpec = {
  readonly kind: CallKind;
  readonly system: string;
  readonly prompt: string;
  readonly images: readonly ClaudeImage[];
  readonly videoId?: string;
  readonly chunk?: { readonly index: number; readonly of: number };
  readonly attempt: number;
};

const callPath = (s: Session, n: number, ext: string) => join(s.outDir, "calls", `${n}.${ext}`);

export function writeMeta(s: Session, n: number, meta: Rec): void {
  writeFileSync(callPath(s, n, "meta.json"), s.redact(JSON.stringify(meta, null, 2)) + "\n");
}

/** One attempt: charge the ledger, store the prompt and a "started" meta BEFORE the call, then the response and the outcome. */
export async function attemptCall(s: Session, spec: CallSpec): Promise<Attempt & { readonly meta: Rec }> {
  s.ledger.charge();
  const n = ++s.n;
  const meta: Rec = {
    n, origin: s.origin, model: s.model, effort: s.effort, kind: spec.kind, videoId: spec.videoId ?? null, chunk: spec.chunk ?? null, attempt: spec.attempt,
    images: spec.images.map((i) => i.label), startedAt: new Date().toISOString(), status: "started", ok: null, latencyMs: null, refusedReason: null, usage: null, error: null,
  };
  writeFileSync(callPath(s, n, "prompt.txt"), s.redact(spec.prompt));
  writeMeta(s, n, meta);
  const req: ClaudeRequest = { model: s.model, effort: s.effort, system: spec.system, prompt: spec.prompt, images: spec.images, webTools: false, timeoutMs: CALL_TIMEOUT_MS };
  const t0 = s.now();
  try {
    const res = await s.client.streamText(req, () => {}, new AbortController().signal);
    const latencyMs = Math.max(0, s.now() - t0);
    writeFileSync(callPath(s, n, "response.txt"), s.redact(res.text));
    Object.assign(meta, { status: "done", ok: true, latencyMs, usage: usageOf(res.usage) });
    writeMeta(s, n, meta);
    return { n, ok: true, text: res.text, meta };
  } catch (e) {
    const latencyMs = Math.max(0, s.now() - t0);
    const error = e instanceof Error ? e.message : String(e);
    Object.assign(meta, { status: "done", ok: false, latencyMs, error: s.redact(error), refusedReason: s.redact(error) });
    writeMeta(s, n, meta);
    return { n, ok: false, error, meta };
  }
}

const usageOf = (u: UsageReport) => ({ model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cost: u.cost });

/** Ask, validate strictly, and retry at most once. A refused reply is stored with its reason; nothing is repaired. */
async function askValidated<T>(s: Session, spec: Omit<CallSpec, "attempt">, validate: (text: string) => { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }): Promise<T> {
  let prompt = spec.prompt;
  let reason = "";
  for (const attempt of [1, 2]) {
    const r = await attemptCall(s, { ...spec, prompt, attempt });
    if (r.ok) {
      const v = validate(r.text);
      if (v.ok) return v.value;
      reason = v.error;
      r.meta.refusedReason = s.redact(reason);
      writeMeta(s, r.n, r.meta);
      prompt = `${spec.prompt}\n\nYour previous reply was refused: ${reason}\nReply again with ONLY the corrected JSON object, in the same shape.`;
    } else {
      reason = r.error;
    }
    s.say(`call ${r.n} (attempt ${attempt}) refused: ${s.redact(reason).slice(0, 200)}`);
  }
  return refuse(`${spec.videoId === undefined ? "a call" : `clip ${spec.videoId}${spec.chunk ? ` call ${spec.chunk.index + 1} of ${spec.chunk.of}` : ""}`} failed twice and is not retried again; last reason: ${s.redact(reason).slice(0, 400)}`);
}

export function openSession(opts: CallOptions, effort: Effort, origin: Origin, planned: number, dataDir: string | undefined): { session: Session; cleanup: () => void } {
  const outDir = resolve(opts.outDir);
  checkOutDir(outDir, dataDir);
  const labDir = opts.ledgerDir === undefined ? dirname(outDir) : resolve(opts.ledgerDir);
  const ledger = openLedger(labDir, origin, { ...(opts.maxClaudeCalls === undefined ? {} : { maxClaudeCalls: opts.maxClaudeCalls }), ...(opts.ceiling === undefined ? {} : { ceiling: opts.ceiling }) });
  ledger.assertPlan(planned);
  const env = opts.env ?? process.env;
  let cleanup = () => {};
  let client: ClaudeCli;
  if (opts.live) {
    // The product's client strips the three billing variables; the Jev key is not for Claude either.
    const { TYPESAFE_API_KEY: _jev, ...childEnv } = env;
    const cwd = mkdtempSync(join(tmpdir(), "afterclass-propose-cwd-"));
    cleanup = () => rmSync(cwd, { recursive: true, force: true });
    client = createClaudeCli({ bin: "claude", cwd, maxConcurrent: 1, env: childEnv, ...(opts.spawn ? { spawn: opts.spawn } : {}), ...(opts.imageRoot ? { imageRoot: opts.imageRoot } : {}) });
  } else client = opts.client!;
  mkdirSync(join(outDir, "calls"), { recursive: true });
  const redact = makeRedactor(env);
  const tag = `[${origin}] `;
  const say = (line: string) => (opts.out ?? ((l: string) => console.log(l)))(redact(line === "" ? line : tag + line));
  return { session: { client, ledger, outDir, model: opts.model, effort, origin, now: opts.now ?? Date.now, redact, say, n: 0 }, cleanup };
}

// ───────────────────────────── propose ─────────────────────────────

export type ProposeOptions = CallOptions & { readonly dataDir: string; readonly captureId: string };
export type ProposeOutcome = { readonly proposalsPath: string; readonly readmePath: string; readonly calls: number; readonly proposals: LabelProposals };

function imageOf(file: string, label: string): ClaudeImage {
  const bytes = new Uint8Array(readFileSync(file));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!jpeg && !png) refuse(`frame file ${file} is neither JPEG nor PNG`);
  return { label, mediaType: jpeg ? "image/jpeg" : "image/png", bytes };
}

function readmeText(info: { readonly title: string; readonly model: string; readonly effort: string; readonly origin: Origin; readonly provenance: string | null; readonly captureId?: string; readonly calls: number; readonly status: string; readonly files: readonly string[] }): string {
  return [
    `# ${info.title}`,
    "",
    `Proposals by ${info.model} (effort ${info.effort}), not Derek's labels, not truth. A model proposed them for Derek to verify; nothing here is signed off or scored.`,
    "",
    ...(info.origin === "fixture" ? ["**Origin: fixture.** A scripted client answered, not a model. These are test files, not proposals by the model named above.", ""] : []),
    `- Status: ${info.status}`,
    `- Data origin: ${info.provenance ?? "no ASSEMBLED.json in the data dir (not an assembled capture)"}`,
    ...(info.captureId === undefined ? [] : [`- Capture: ${info.captureId}`]),
    `- Claude calls made (retries included): ${info.calls}`,
    "- The model saw the transcript passages with media times and the captured frames (read as image files) of one clip per call. It saw no Jev output and no other model's labels. Clip joins are added by code, not asked of the model.",
    "- Every prompt and response is stored verbatim in calls/ (secrets from the environment are replaced by [redacted]). The image file paths the client appends to a prompt are temporary and are not stored; the labels of the images are in each meta file.",
    "",
    "Files:",
    ...info.files.map((f) => `- ${f}`),
    "",
  ].join("\n");
}

export async function proposeLecture(opts: ProposeOptions): Promise<ProposeOutcome> {
  const { effort, origin } = checkCommon(opts);
  const dataDir = resolve(opts.dataDir);
  const { clips, provenance } = readClips(dataDir, opts.captureId);
  const calls = callsOfClips(clips);
  const { session: s, cleanup } = openSession(opts, effort, origin, calls.length, dataDir);
  const readmePath = join(s.outDir, "README.md");
  const proposalsPath = join(s.outDir, "proposals.json");
  const info = { title: `Label proposals by ${opts.model}`, model: opts.model, effort, origin, provenance, captureId: opts.captureId };
  const files = ["proposals.json (schemaVersion 1, kind label-proposals)", "calls/<n>.prompt.txt, calls/<n>.response.txt, calls/<n>.meta.json"];
  s.say(`proposing with ${opts.model} (effort ${effort}) for capture ${opts.captureId}: ${calls.length} planned calls over ${clips.length} clips`);
  if (provenance !== null) s.say(`data origin: ${provenance}`);
  try {
    const perClip = new Map<string, ChunkProposal[]>();
    for (const call of calls) {
      const spec = {
        kind: "propose" as const,
        system: PROPOSE_SYSTEM,
        prompt: buildPrompt(call),
        images: call.frames.map((f) => imageOf(f.file, `${frameLabel(f)} (${call.clip.videoId})`)),
        videoId: call.clip.videoId,
        chunk: { index: call.chunkIndex, of: call.chunkCount },
      };
      const value = await askValidated(s, spec, (text) => parseResponse(text, call));
      perClip.set(call.clip.videoId, [...(perClip.get(call.clip.videoId) ?? []), value]);
      s.say(`clip ${call.clipNumber}/${call.clipCount} call ${call.chunkIndex + 1}/${call.chunkCount}: ${value.boundaries.length} boundaries, ${value.visualSteps.length} visual steps, ${value.duplicateGroups.length} duplicate groups`);
    }
    const boundaries: ProposedBoundary[] = [];
    const visualSteps: ProposedStep[] = [];
    const duplicateGroups: ProposedGroup[] = [];
    const joins = joinBoundaries(clips);
    clips.forEach((clip, i) => {
      const merged = mergeChunks(perClip.get(clip.videoId) ?? []);
      if (i > 0) boundaries.push(joins[i - 1]!);
      boundaries.push(...merged.boundaries.map((b) => ({ videoId: clip.videoId, mediaS: b.mediaS, reason: b.reason, source: "model" as const })));
      visualSteps.push(...merged.visualSteps.map((b) => ({ videoId: clip.videoId, mediaS: b.mediaS, reason: b.reason })));
      duplicateGroups.push(...merged.duplicateGroups.map((g) => ({ reason: g.reason, frames: g.frames.map((f) => ({ videoId: clip.videoId, mediaS: f.mediaS, frameId: f.frameId })) })));
    });
    const proposals = JSON.parse(s.redact(JSON.stringify({
      schemaVersion: 1, kind: "label-proposals", proposedBy: { model: opts.model, effort }, captureId: opts.captureId, provenance, createdAt: new Date().toISOString(), origin,
      items: { boundaries, visualSteps, duplicateGroups },
    }))) as LabelProposals;
    const checked = validateProposals(proposals);
    if (!checked.ok) throw new Error(`propose produced an invalid proposals file: ${checked.errors.join("; ")}`);
    writeFileSync(proposalsPath, JSON.stringify(proposals, null, 2) + "\n");
    writeFileSync(readmePath, readmeText({ ...info, calls: s.n, status: "COMPLETE", files }));
    s.say(`wrote ${proposalsPath}: ${boundaries.length} boundaries (${joins.length} joins added by code), ${visualSteps.length} visual steps, ${duplicateGroups.length} duplicate groups, after ${s.n} Claude calls. Proposals by ${opts.model}: not Derek's labels, not truth.`);
    return { proposalsPath, readmePath, calls: s.n, proposals };
  } catch (e) {
    writeFileSync(readmePath, readmeText({ ...info, calls: s.n, status: `INCOMPLETE: ${s.redact(e instanceof Error ? e.message : String(e))}. No proposals.json was written; the calls made are stored in calls/.`, files: files.slice(1) }));
    throw e;
  } finally {
    cleanup();
  }
}

// ───────────────────────────── the timing pilot ─────────────────────────────

export type PilotOptions = CallOptions & { readonly dataDir?: string; readonly captureId?: string };
export type PilotOutcome = { readonly latenciesMs: readonly number[]; readonly p50Ms: number | null; readonly readmePath: string };

const PILOT_SYSTEM = "You answer a tiny connectivity check exactly as asked, in as few words as possible.";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A solid-colour RGB PNG, made here so the pilot needs no lecture data. */
function solidPng(size: number, rgb: readonly [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = new Uint8Array(1 + size * 3);
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3);
  const raw = new Uint8Array(row.length * size);
  for (let y = 0; y < size; y++) raw.set(row, y * row.length);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

/** 3 tiny calls to time latency and confirm the model id works through `claude -p`: text only, one image read with the Read tool, one small JSON object. */
export async function runPilot(opts: PilotOptions): Promise<PilotOutcome> {
  const { effort, origin } = checkCommon(opts);
  const dataDir = opts.dataDir === undefined ? undefined : resolve(opts.dataDir);
  let image: ClaudeImage;
  let imageNote: string;
  const real = dataDir !== undefined && opts.captureId !== undefined ? readClips(dataDir, opts.captureId).clips.find((c) => c.frames.length > 0) : undefined;
  if (real !== undefined) {
    const f = real.frames[0]!;
    image = imageOf(f.file, `${frameLabel(f)} (${real.videoId})`);
    imageNote = "the first captured frame of the capture";
  } else {
    image = { label: "pilot image (a solid red square made by the tool)", mediaType: "image/png", bytes: solidPng(64, [220, 30, 30]) };
    imageNote = "a solid red square made by the tool";
  }
  const { session: s, cleanup } = openSession(opts, effort, origin, PILOT_CALLS, dataDir);
  const readmePath = join(s.outDir, "README.md");
  const specs: Omit<CallSpec, "attempt">[] = [
    { kind: "pilot-text", system: PILOT_SYSTEM, prompt: "Reply with the single word OK and nothing else.", images: [] },
    { kind: "pilot-image", system: PILOT_SYSTEM, prompt: "View the image file listed at the end of this message with the Read tool, then reply with one word: its main colour.", images: [image] },
    { kind: "pilot-json", system: PILOT_SYSTEM, prompt: 'Reply with ONLY this JSON object and nothing else: {"ok": true, "colors": ["red", "green", "blue"]}', images: [] },
  ];
  s.say(`timing pilot of ${opts.model} (effort ${effort}): ${PILOT_CALLS} calls`);
  const latencies: number[] = [];
  const notes: string[] = [];
  try {
    for (const [i, spec] of specs.entries()) {
      const r = await attemptCall(s, { ...spec, attempt: 1 });
      const latency = r.meta.latencyMs as number;
      if (r.ok) {
        latencies.push(latency);
        let verdict = "";
        if (spec.kind === "pilot-json") {
          let okJson = false;
          try {
            const v: unknown = JSON.parse(r.text.trim());
            okJson = isRec(v) && v.ok === true;
          } catch {
            okJson = false;
          }
          verdict = okJson ? ", JSON object parsed" : ", NOT a JSON object as asked";
        }
        s.say(`call ${i + 1} (${spec.kind}): ${latency} ms${verdict}`);
        notes.push(`call ${i + 1} ${spec.kind}: ${latency} ms${verdict}`);
      } else {
        s.say(`call ${i + 1} (${spec.kind}) FAILED after ${latency} ms: ${s.redact(r.error).slice(0, 200)}`);
        notes.push(`call ${i + 1} ${spec.kind}: FAILED after ${latency} ms`);
      }
    }
    const p50 = percentile(latencies, 50);
    s.say(`p50 latency: ${p50 === null ? "none (no call succeeded)" : `${p50} ms`} over ${latencies.length} successful call(s)`);
    writeFileSync(readmePath, readmeText({ title: `Timing pilot of ${opts.model}`, model: opts.model, effort, origin, provenance: null, calls: s.n, status: `COMPLETE. ${notes.join("; ")}. p50 ${p50 ?? "n/a"} ms. The image was ${imageNote}.`, files: ["calls/<n>.prompt.txt, calls/<n>.response.txt, calls/<n>.meta.json"] }));
    return { latenciesMs: latencies, p50Ms: p50, readmePath };
  } catch (e) {
    writeFileSync(readmePath, readmeText({ title: `Timing pilot of ${opts.model}`, model: opts.model, effort, origin, provenance: null, calls: s.n, status: `INCOMPLETE: ${s.redact(e instanceof Error ? e.message : String(e))}`, files: [] }));
    throw e;
  } finally {
    cleanup();
  }
}

// ───────────────────────────── compare ─────────────────────────────

type Section<T> = { readonly both: readonly { readonly a: T; readonly b: T }[]; readonly onlyA: readonly T[]; readonly onlyB: readonly T[] };
export type Comparison = {
  readonly schemaVersion: 1;
  readonly kind: "proposal-comparison";
  readonly captureId: string;
  readonly a: { readonly model: string; readonly effort: string; readonly file?: string };
  readonly b: { readonly model: string; readonly effort: string; readonly file?: string };
  readonly tolerances: { readonly boundaryS: number; readonly stepS: number; readonly frameMatchS: number; readonly proposed: true };
  /** Join candidates are added by code in both files, so they are counted, not compared. */
  readonly joins: { readonly a: number; readonly b: number };
  readonly boundaries: Section<ProposedBoundary>;
  readonly visualSteps: Section<ProposedStep>;
  readonly duplicateGroups: Section<ProposedGroup>;
};

/** One-to-one pairing by a score, best score first, then input order; the result keeps input order. */
function pair<T>(as: readonly T[], bs: readonly T[], score: (a: T, b: T) => number | null): Section<T> {
  const cands: { i: number; j: number; s: number }[] = [];
  as.forEach((a, i) => bs.forEach((b, j) => {
    const s = score(a, b);
    if (s !== null) cands.push({ i, j, s });
  }));
  cands.sort((x, y) => x.s - y.s || x.i - y.i || x.j - y.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const both: { i: number; j: number }[] = [];
  for (const c of cands) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    both.push(c);
  }
  both.sort((x, y) => x.i - y.i);
  return { both: both.map((c) => ({ a: as[c.i]!, b: bs[c.j]! })), onlyA: as.filter((_, i) => !usedA.has(i)), onlyB: bs.filter((_, j) => !usedB.has(j)) };
}

const near = (tol: number) => (a: { videoId: string; mediaS: number }, b: { videoId: string; mediaS: number }): number | null => (a.videoId === b.videoId && Math.abs(a.mediaS - b.mediaS) <= tol ? Math.abs(a.mediaS - b.mediaS) : null);

const sameFrame = (x: ProposedFrame, y: ProposedFrame): boolean => x.videoId === y.videoId && (x.frameId !== undefined && y.frameId !== undefined ? x.frameId === y.frameId : Math.abs(x.mediaS - y.mediaS) <= COMPARE_FRAME_MATCH_S);

/** Items both models proposed (same video, times within the tolerance), only A, only B. Deterministic; no model call. */
export function compareProposals(a: LabelProposals, b: LabelProposals): Comparison {
  if (a.captureId !== b.captureId) refuse(`the two proposals are for different captures (${a.captureId} and ${b.captureId}); they cannot be compared`);
  const modelOnly = (p: LabelProposals) => p.items.boundaries.filter((x) => x.source === "model");
  return {
    schemaVersion: 1,
    kind: "proposal-comparison",
    captureId: a.captureId,
    a: { model: a.proposedBy.model, effort: a.proposedBy.effort },
    b: { model: b.proposedBy.model, effort: b.proposedBy.effort },
    tolerances: { boundaryS: COMPARE_TOLERANCE_BOUNDARY_S, stepS: COMPARE_TOLERANCE_STEP_S, frameMatchS: COMPARE_FRAME_MATCH_S, proposed: true },
    joins: { a: a.items.boundaries.length - modelOnly(a).length, b: b.items.boundaries.length - modelOnly(b).length },
    boundaries: pair(modelOnly(a), modelOnly(b), near(COMPARE_TOLERANCE_BOUNDARY_S)),
    visualSteps: pair(a.items.visualSteps, b.items.visualSteps, near(COMPARE_TOLERANCE_STEP_S)),
    duplicateGroups: pair(a.items.duplicateGroups, b.items.duplicateGroups, (x, y) => {
      const shared = x.frames.filter((f) => y.frames.some((g) => sameFrame(f, g))).length;
      return shared === 0 ? null : -shared;
    }),
  };
}

function readProposals(path: string): LabelProposals {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return refuse(`${path} cannot be read as JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const checked = validateProposals(raw);
  if (!checked.ok) refuse(`${path} is not a valid proposals file: ${checked.errors.join("; ")}`);
  return (checked as { proposals: LabelProposals }).proposals;
}

export function compareFiles(opts: { readonly aPath: string; readonly bPath: string; readonly outPath: string }): Comparison {
  if (existsSync(opts.outPath)) refuse(`${opts.outPath} already exists; a comparison is never overwritten`);
  const c = compareProposals(readProposals(opts.aPath), readProposals(opts.bPath));
  const withFiles: Comparison = { ...c, a: { ...c.a, file: opts.aPath }, b: { ...c.b, file: opts.bPath } };
  mkdirSync(dirname(resolve(opts.outPath)), { recursive: true });
  writeFileSync(opts.outPath, JSON.stringify(withFiles, null, 2) + "\n");
  return withFiles;
}

// ───────────────────────────── command line ─────────────────────────────

const tagged = (origin: Origin, lines: readonly string[]) => lines.map((l) => (l === "" ? l : `[${origin}] ${l}`)).join("\n");

async function cli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      data: { type: "string" }, capture: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, out: { type: "string" },
      "live-claude": { type: "boolean" }, "max-claude-calls": { type: "string" }, a: { type: "string" }, b: { type: "string" }, origin: { type: "string", default: "fixture" },
    },
  });
  if (values.origin !== "fixture" && values.origin !== "live") return usage("--origin must be fixture or live");
  const origin: Origin = values.origin;
  const max = values["max-claude-calls"] === undefined ? undefined : parseMaxClaudeCalls(values["max-claude-calls"]);
  const common = () => ({
    model: values.model!, outDir: resolve(values.out!), live: values["live-claude"] === true,
    ...(values.effort ? { effort: values.effort as Effort } : {}), ...(max === undefined ? {} : { maxClaudeCalls: max }),
  });
  switch (command) {
    case "plan": {
      if (!values.data || !values.capture) return usage("plan needs --data and --capture");
      const plan = planPropose({ dataDir: resolve(values.data), captureId: values.capture });
      console.log(tagged(origin, plan.lines));
      return 0;
    }
    case "pilot": {
      if (!values.model || !values.out) return usage("pilot needs --model and --out");
      await runPilot({ ...common(), ...(values.data ? { dataDir: resolve(values.data) } : {}), ...(values.capture ? { captureId: values.capture } : {}) });
      return 0;
    }
    case "propose": {
      if (!values.data || !values.capture || !values.model || !values.out) return usage("propose needs --data, --capture, --model and --out");
      await proposeLecture({ ...common(), dataDir: resolve(values.data), captureId: values.capture });
      return 0;
    }
    case "compare": {
      if (!values.a || !values.b || !values.out) return usage("compare needs --a, --b and --out");
      const c = compareFiles({ aPath: resolve(values.a), bPath: resolve(values.b), outPath: resolve(values.out) });
      const row = (name: string, s: Section<unknown>) => `${name}: ${s.both.length} proposed by both, ${s.onlyA.length} only by A (${c.a.model}), ${s.onlyB.length} only by B (${c.b.model})`;
      console.log(tagged(origin, [
        `Comparison of two models' proposals for capture ${c.captureId} (no call was made; proposals are not Derek's labels). Tolerances PROPOSED: boundaries ${c.tolerances.boundaryS} s, steps ${c.tolerances.stepS} s.`,
        row("boundaries", c.boundaries), row("visual steps", c.visualSteps), row("duplicate groups", c.duplicateGroups),
        `clip joins added by code, not compared: A ${c.joins.a}, B ${c.joins.b}`,
        `wrote ${resolve(values.out)}`,
      ]));
      return 0;
    }
    default:
      return usage("commands: plan, pilot, propose, compare");
  }
}

function usage(message: string): number {
  console.error(`jev-lab-propose: ${message}`);
  return 2;
}

if (import.meta.main) {
  void cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`jev-lab-propose: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
