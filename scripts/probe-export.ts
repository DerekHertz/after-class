/**
 * Experiment 1, the capture probe: turn one capture in a backend data dir into the files Derek spot-checks.
 *
 *   bun run scripts/probe-export.ts --data <dir> [--capture <captureId>] --out <dir>
 *
 * Writes <out>/bundle.json (the evidence store's own bundle), <out>/samples.json and <out>/frames/<n>.jpg.
 *
 * It reads a scratch copy of <dir>/afterclass.sqlite and only reads frame files from <dir>/frames, so the real data
 * dir is never written and the backend need not be stopped for it to be safe (stop it anyway for a complete copy).
 * It builds the evidence store directly: no backend, no scheduler, no provider, so it cannot make a model call. Frame
 * judgments are stubbed as missing, so frames show teaching "unjudged" (the probe is free; Jev is not run).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { EvidenceBundleJson } from "../src/backend/evidence";
import { stableId } from "../src/shared/ids";
import type { CaptureId, EvidenceId, MemoKey } from "../src/shared/ids";
import { adCandidates } from "./probe-report";

const SAMPLE_COUNT = 10;

export type CaptionSample = {
  readonly index: number;
  readonly videoId: string | null;
  readonly sourceId: string;
  readonly mediaS: number;
  readonly text: string;
  readonly passage: readonly [number, number];
  readonly watched: readonly [number, number];
};
export type FrameSample = { readonly index: number; readonly evidenceId: string; readonly videoId: string | null; readonly sourceId: string; readonly mediaS: number; readonly teaching: string };
export type IntervalSample = { readonly index: number; readonly videoId: string | null; readonly sourceId: string; readonly start: number; readonly end: number; readonly text: string | null };
export type Sampling = {
  readonly captions: { readonly requested: number; readonly samples: readonly CaptionSample[] };
  readonly frames: { readonly requested: number; readonly samples: readonly FrameSample[] };
  /** Everything inside an ad's window (see adCandidates), each for Derek to check. Passages carry text; watched intervals do not. */
  readonly adCandidates: { readonly frames: readonly FrameSample[]; readonly passages: readonly IntervalSample[]; readonly spans: readonly IntervalSample[] };
  readonly notes: readonly string[];
};

type Placed = { readonly passage: EvidenceBundleJson["passages"][number]; readonly watched: readonly [number, number]; readonly coord: number };

/** Passages wholly inside a watched interval, each placed by its midpoint on the watched timeline laid end to end. */
function placePassages(bundle: EvidenceBundleJson): { readonly placed: readonly Placed[]; readonly totalS: number } {
  const placed: Placed[] = [];
  let offset = 0;
  for (const sourceId of new Set(bundle.watched.map((w) => w.sourceId))) {
    const intervals = bundle.watched.filter((w) => w.sourceId === sourceId).flatMap((w) => w.intervals);
    for (const [start, end] of intervals) {
      for (const passage of bundle.passages) {
        if (passage.sourceId !== sourceId || passage.text.trim() === "" || passage.start < start || passage.end > end) continue;
        placed.push({ passage, watched: [start, end], coord: offset + (passage.start + passage.end) / 2 - start });
      }
      offset += end - start;
    }
  }
  return { placed: placed.sort((a, b) => a.coord - b.coord), totalS: offset };
}

/** Evenly spaced picks with no randomness: the same bundle always gives the same samples. */
export function sampleExport(bundle: EvidenceBundleJson, videoIdOf: (sourceId: string) => string | null, want = SAMPLE_COUNT): Sampling {
  const notes: string[] = [];
  const { placed, totalS } = placePassages(bundle);

  let chosen: Placed[];
  if (placed.length <= want) chosen = [...placed];
  else {
    const free = new Set(placed);
    chosen = [];
    for (let k = 0; k < want; k++) {
      const target = (totalS * (k + 0.5)) / want;
      let best: Placed | null = null;
      for (const p of free) if (best === null || Math.abs(p.coord - target) < Math.abs(best.coord - target)) best = p;
      free.delete(best!);
      chosen.push(best!);
    }
    chosen.sort((a, b) => a.coord - b.coord);
  }
  if (chosen.length < want) notes.push(`only ${chosen.length} caption samples exist (wanted ${want}); exported all of them, so bar 2 cannot be scored on ${want}`);

  const captions = chosen.map((c, index): CaptionSample => ({
    index, videoId: videoIdOf(c.passage.sourceId), sourceId: c.passage.sourceId, mediaS: c.passage.start, text: c.passage.text,
    passage: [c.passage.start, c.passage.end], watched: c.watched,
  }));

  const usable = bundle.frames.filter((f) => f.teaching !== "dropped" && f.file !== null);
  const picks = usable.length <= want ? usable : Array.from({ length: want }, (_, k) => usable[Math.floor(((k + 0.5) * usable.length) / want)]!);
  if (picks.length < want) notes.push(`only ${picks.length} frame samples exist (wanted ${want}); exported all of them, so bar 3 cannot be scored on ${want}`);
  const frameOf = (f: EvidenceBundleJson["frames"][number], index: number): FrameSample => ({
    index, evidenceId: f.id, videoId: videoIdOf(f.sourceId), sourceId: f.sourceId, mediaS: f.mediaS, teaching: f.teaching,
  });

  const ad = adCandidates(bundle);
  return {
    captions: { requested: want, samples: captions },
    frames: { requested: want, samples: picks.map(frameOf) },
    adCandidates: {
      frames: ad.frames.map(frameOf),
      passages: ad.passages.map((p, index) => ({ index, videoId: videoIdOf(p.sourceId), sourceId: p.sourceId, start: p.start, end: p.end, text: p.text })),
      spans: ad.spans.map((s, index) => ({ index, videoId: videoIdOf(s.sourceId), sourceId: s.sourceId, start: s.start, end: s.end, text: null })),
    },
    notes,
  };
}

const SQLITE = "afterclass.sqlite";

/** Copies the database (and its WAL, if the backend left one) so opening it cannot touch the real files. */
export function scratchCopy(dataDir: string): { readonly dir: string; readonly path: string } {
  const source = join(dataDir, SQLITE);
  if (!existsSync(source)) throw new Error(`${source} does not exist; pass the backend's data dir with --data`);
  const dir = mkdtempSync(join(tmpdir(), "afterclass-probe-"));
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(source + suffix)) copyFileSync(source + suffix, join(dir, SQLITE + suffix));
  return { dir, path: join(dir, SQLITE) };
}

const hasEvidence = (b: EvidenceBundleJson): boolean => b.watched.length > 0 || b.passages.length > 0 || b.frames.length > 0;

/**
 * Default capture when --capture is not given: the one with the most watched time among those with evidence.
 * Starting capture again after a stop makes a new, usually tiny, capture; "newest" would export that one and
 * leave the real run unseen. `candidates` come newest first, so a tie goes to the newest.
 */
export function pickCapture(candidates: readonly { readonly captureId: string; readonly watchedSeconds: number; readonly hasEvidence: boolean }[]): string | undefined {
  let best: (typeof candidates)[number] | undefined;
  for (const c of candidates) if (c.hasEvidence && (best === undefined || c.watchedSeconds > best.watchedSeconds)) best = c;
  return best?.captureId;
}

export function exportCapture(opts: { readonly dataDir: string; readonly outDir: string; readonly captureId?: string | undefined }): Sampling & { readonly captureId: string } {
  const scratch = scratchCopy(opts.dataDir);
  const db = openDb(scratch.path);
  try {
    const keyOf = (input: { readonly after: { readonly frame: { readonly id: string } } }): MemoKey => stableId("key", "frame_change", "probe", input.after.frame.id);
    const evidence = createEvidence(db, opts.dataDir, {
      lookupFrameChange: (input) => ({ kind: "missing", key: keyOf(input) }),
      runFrameChange: () => Promise.reject(new Error("the capture probe makes no model call")),
      frameChangeKey: keyOf,
      onChange: () => {},
    });

    const all = db.sql.query<{ capture_id: string }, []>("SELECT capture_id FROM capture_facts GROUP BY capture_id ORDER BY MAX(seq) DESC").all().map((r) => r.capture_id);
    const candidates = all.map((id) => {
      const b = evidence.captureBundle(id as CaptureId);
      return { captureId: id, watchedSeconds: b.watchedSeconds, hasEvidence: hasEvidence(b) };
    });
    const captureId = opts.captureId ?? pickCapture(candidates);
    if (!captureId) throw new Error(candidates.length === 0 ? `${join(opts.dataDir, SQLITE)} holds no capture` : `none of the ${candidates.length} capture(s) in ${join(opts.dataDir, SQLITE)} has evidence`);
    const bundle = evidence.captureBundle(captureId as CaptureId);
    if (!hasEvidence(bundle)) throw new Error(`capture ${captureId} has no evidence; is the id right?`);
    const skipped = opts.captureId === undefined ? candidates.filter((c) => c.captureId !== captureId) : [];

    const videoIds = new Map(evidence.captureView(captureId as CaptureId).sources.map((s) => [s.id as string, s.videoId] as const));
    const sampling = sampleExport(bundle, (sourceId) => videoIds.get(sourceId) ?? null);

    mkdirSync(join(opts.outDir, "frames"), { recursive: true });
    const notes = [...sampling.notes];
    if (skipped.length > 0) {
      notes.push(`exported ${captureId} (${bundle.watchedSeconds.toFixed(0)}s watched), the capture with the most watched time; not exported: ${skipped.map((c) => `${c.captureId} (${c.watchedSeconds.toFixed(0)}s watched${c.hasEvidence ? "" : ", no evidence"})`).join(", ")}. Pass --capture <id> to choose another.`);
    }
    const copy = (f: FrameSample, name: string) => {
      const bytes = evidence.frameBytes(f.evidenceId as EvidenceId);
      if (bytes === null) notes.push(`frame ${f.evidenceId} has no bytes on disk, so ${name} was not written`);
      else writeFileSync(join(opts.outDir, "frames", name), bytes);
    };
    for (const f of sampling.frames.samples) copy(f, `${f.index}.jpg`);
    for (const f of sampling.adCandidates.frames) copy(f, `ad-${f.index}.jpg`);

    const result = { ...sampling, notes };
    writeFileSync(join(opts.outDir, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n");
    writeFileSync(join(opts.outDir, "samples.json"), JSON.stringify({ captureId, ...result }, null, 2) + "\n");
    return { captureId, ...result };
  } finally {
    db.close();
    rmSync(scratch.dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { data: { type: "string" }, capture: { type: "string" }, out: { type: "string" } } });
  if (!values.data || !values.out) {
    console.error("usage: bun run scripts/probe-export.ts --data <dir> [--capture <captureId>] --out <dir>");
    process.exit(2);
  }
  const done = exportCapture({ dataDir: resolve(values.data), outDir: resolve(values.out), captureId: values.capture });
  console.log(`capture ${done.captureId}: ${done.captions.samples.length} caption sample(s), ${done.frames.samples.length} frame sample(s), ${done.adCandidates.frames.length}+${done.adCandidates.passages.length}+${done.adCandidates.spans.length} ad candidate frame+passage+interval(s) -> ${resolve(values.out)}`);
  for (const note of done.notes) console.log(`note: ${note}`);
}
