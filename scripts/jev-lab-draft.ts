import { openCapture, refuse } from "./jev-lab";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CaptureId } from "../src/shared/ids";
import type { LabelFile, LabelFileV2 } from "./jev-lab-score";
import { validateLabels } from "./jev-lab-score";


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
