/**
 * Experiment 2 support: assemble the recorded facts of several captures into ONE capture in a NEW data dir.
 *
 *   bun run scripts/assemble-capture.ts --in <dataDir>:<captureId> [--in <dataDir>:<captureId> ...] --out <newDataDir>
 *   bun run scripts/assemble-capture.ts --describe <dataDir>
 *
 * The inputs, in the order given, are the WATCH ORDER of the result. Each input is read through a scratch copy of its
 * sqlite (the real file is never opened writable) and its frame files are only read. The facts are re-ingested through the
 * product's own `evidence.ingest`, so every derived table and frame file comes from the product's code. No model is called:
 * frame-change judgments are stubbed as missing, as in probe-export. No network, no key.
 *
 * This is REPLAY of recorded live data, never new lecture content, and it is always labeled: <out>/ASSEMBLED.json and
 * <out>/ASSEMBLED.md say so, and `readProvenance` lets other tools surface it.
 *
 * What changes from the inputs (and nothing else): one fresh capture id; every input's own `control start` and
 * `control stop` is dropped (and so is a final pause with reason left_watch_page: that capture ended when its tab left the watch page) and one `start` is put first and one `stop` last (other pause and resume are kept); clientSeq is
 * renumbered 0..n-1; wallMs of each later input is shifted so it follows the earlier ones, relative timing inside an input
 * unchanged; a frameId is prefixed only if two inputs use the same one in this capture (the evidence id is derived from it).
 * Afterwards each input's per-video evidence is compared with the assembled capture's, and the run is refused (output
 * removed) on any difference.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { EvidenceBundleJson, EvidenceStoreWithProbe } from "../src/backend/evidence";
import { sourceIdOf } from "../src/backend/evidence/core";
import type { CaptureFact, CaptureFactBody } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, MemoKey } from "../src/shared/ids";
import { scratchCopy } from "./probe-export";

export const ASSEMBLED_JSON = "ASSEMBLED.json";
export const ASSEMBLED_MD = "ASSEMBLED.md";
export const ASSEMBLED_ORIGIN = "assembled (replayed live data)";
/** Wall-time gap put between the end of one input and the start of the next. */
export const JOIN_GAP_MS = 1000;

/**
 * A capture whose tab navigated away from the watch page ends PAUSED (reason left_watch_page), not stopped. That pause
 * is the end of that capture, so it is dropped like a stop; carried into the stream it would leave every later input
 * outside capture. Only that exact case: a user pause with no resume is still kept, and the comparison still refuses it.
 */
function endedByLeavingWatchPage(facts: readonly CaptureFact[]): CaptureFact | null {
  let last: CaptureFact | null = null;
  for (const f of [...facts].sort((a, b) => a.clientSeq - b.clientSeq)) if (f.kind === "control" && (f.action === "pause" || f.action === "resume")) last = f;
  return last !== null && last.kind === "control" && last.action === "pause" && last.reason === "left_watch_page" ? last : null;
}

/** Channel failures still open at the end of a capture: the last health fact of a (channel, video) pair is not ok. */
function openChannelFailures(facts: readonly CaptureFact[]): readonly Extract<CaptureFact, { kind: "channel" }>[] {
  const last = new Map<string, Extract<CaptureFact, { kind: "channel" }>>();
  for (const f of [...facts].sort((a, b) => a.clientSeq - b.clientSeq)) if (f.kind === "channel") last.set(`${f.channel}|${f.videoId ?? ""}`, f);
  return [...last.values()].filter((f) => f.health !== "ok");
}

export type InputSpec = { readonly dataDir: string; readonly captureId: string };

export type InputProvenance = {
  readonly order: number;
  readonly dataDir: string;
  readonly captureId: string;
  readonly sqliteSha256: string;
  readonly sqliteBytes: number;
  readonly walSha256: string | null;
  readonly factCount: number;
  readonly videoIds: readonly string[];
  readonly watchedSeconds: number;
  readonly droppedControls: readonly string[];
  /** Facts the assembler added: a recovery for each channel failure still open when this input ended (the product records one when capture resumes). */
  readonly addedFacts: readonly string[];
  readonly wallShiftMs: number;
  readonly renamedFrameIds: number;
  readonly videosDeduped: readonly string[];
};

export type Join = {
  readonly fromVideoId: string;
  readonly toVideoId: string;
  /** Cumulative watched seconds, over the assembled capture, at the end of `fromVideoId`. */
  readonly cumulativeWatchedS: number;
  readonly crossesInputs: boolean;
};

export type Provenance = {
  readonly assembled: true;
  readonly origin: typeof ASSEMBLED_ORIGIN;
  readonly notOneLiveSession: true;
  readonly assembledAt: string;
  readonly tool: "scripts/assemble-capture.ts";
  readonly captureId: string;
  readonly inputs: readonly InputProvenance[];
  readonly videoIds: readonly string[];
  readonly watchedSeconds: number;
  readonly frames: number;
  readonly passages: number;
  readonly joins: readonly Join[];
  readonly handling: readonly string[];
};

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

// ───────────────────────────── paths ─────────────────────────────

/** realpath of the nearest existing ancestor, plus the not-yet-existing tail: sees through symlinks and `..`. */
function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    tail.unshift(basename(head));
    const up = dirname(head);
    if (up === head) break;
    head = up;
  }
  return join(realpathSync(head), ...tail);
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
};

function checkOut(outDir: string, inputs: readonly InputSpec[]): void {
  const out = realish(outDir);
  for (const i of inputs) {
    const dir = realpathSync(resolve(i.dataDir));
    if (inside(out, dir)) throw new Error(`--out ${outDir} is inside the input data dir ${i.dataDir}; refusing to write there`);
    if (inside(dir, out)) throw new Error(`--out ${outDir} contains the input data dir ${i.dataDir}; refusing`);
  }
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory()) throw new Error(`--out ${outDir} exists and is not a directory`);
    if (readdirSync(outDir).length > 0) throw new Error(`--out ${outDir} is not empty; assemble into a new or empty directory`);
  }
}

// ───────────────────────────── reading an input ─────────────────────────────

type ReadInput = {
  readonly spec: InputSpec;
  readonly dataDir: string;
  readonly facts: readonly (CaptureFact & { readonly jpeg: Uint8Array | null })[];
  readonly sqliteSha256: string;
  readonly sqliteBytes: number;
  readonly walSha256: string | null;
};

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** Facts of one capture in recorded order, each frame fact with the JPEG bytes ingest expects (read from the frame file). */
function readInput(spec: InputSpec): ReadInput {
  const dataDir = resolve(spec.dataDir);
  const scratch = scratchCopy(dataDir);
  try {
    // Hashed before opening: opening a database can change it, and these are the bytes the facts were read from.
    const sqliteSha256 = sha256(scratch.path);
    const sqliteBytes = statSync(scratch.path).size;
    const wal = scratch.path + "-wal";
    const walSha256 = existsSync(wal) && statSync(wal).size > 0 ? sha256(wal) : null;
    const db = openDb(scratch.path);
    try {
      const rows = db.sql
        .query<{ client_seq: number; wall_ms: number; body_json: string }, [string]>("SELECT client_seq, wall_ms, body_json FROM capture_facts WHERE capture_id = ? ORDER BY client_seq")
        .all(spec.captureId);
      if (rows.length === 0) throw new Error(`capture ${spec.captureId} has no facts in ${join(dataDir, "afterclass.sqlite")}; is the id right?`);
      rows.forEach((r, i) => {
        if (r.client_seq !== i) throw new Error(`capture ${spec.captureId} in ${dataDir} has a hole in clientSeq (expected ${i}, found ${r.client_seq}); refusing an incomplete capture`);
      });
      const frameRow = db.sql.query<{ path: string }, [string, string]>("SELECT path FROM frames WHERE capture_id = ? AND frame_id = ?");
      const facts = rows.map((r) => {
        const { jpegOk, ...body } = JSON.parse(r.body_json) as CaptureFactBody & { jpegOk?: boolean };
        let jpeg: Uint8Array | null = null;
        if (body.kind === "frame" && jpegOk === true) {
          const row = frameRow.get(spec.captureId, body.frameId);
          if (!row) throw new Error(`frame fact ${r.client_seq} (${body.frameId}) of ${spec.captureId} is marked as a stored JPEG but has no frame row in ${dataDir}; refusing`);
          const file = resolve(dataDir, row.path);
          if (!inside(file, resolve(dataDir, "frames"))) throw new Error(`frame path ${row.path} of ${spec.captureId} leaves ${dataDir}/frames; refusing`);
          if (!existsSync(file)) throw new Error(`frame file ${file} is missing (frame ${body.frameId} of ${spec.captureId}); the input is incomplete, refusing`);
          jpeg = new Uint8Array(readFileSync(file));
          if (jpeg.length <= JPEG_MAGIC.length || !JPEG_MAGIC.every((m, k) => jpeg![k] === m)) throw new Error(`frame file ${file} is not a JPEG; refusing`);
        }
        return { captureId: spec.captureId as CaptureId, clientSeq: r.client_seq, wallMs: r.wall_ms, ...body, jpeg } as CaptureFact & { jpeg: Uint8Array | null };
      });
      return { spec, dataDir, facts, sqliteSha256, sqliteBytes, walSha256 };
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch.dir, { recursive: true, force: true });
  }
}

const videoOf = (f: CaptureFact): string | null => ("videoId" in f && typeof f.videoId === "string" ? f.videoId : null);

/** A video's facts, compared across inputs ignoring capture id, clientSeq and wall time (frame bytes by hash). */
function videoFingerprint(input: ReadInput, videoId: string): string {
  const parts = input.facts
    .filter((f) => videoOf(f) === videoId)
    .map((f) => {
      const { captureId: _c, clientSeq: _s, wallMs: _w, jpeg, ...rest } = f as CaptureFact & { jpeg: Uint8Array | null };
      return JSON.stringify({ ...rest, jpegSha256: jpeg ? createHash("sha256").update(jpeg).digest("hex") : null, ...(f.kind === "frame" ? { jpegBase64: undefined } : {}) });
    });
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// ───────────────────────────── the per-video comparison ─────────────────────────────

type VideoEvidence = {
  readonly watched: readonly (readonly [number, number])[];
  readonly passages: readonly string[];
  readonly frames: readonly string[];
  readonly gaps: readonly string[];
  readonly ads: readonly string[];
};

function videoEvidence(b: EvidenceBundleJson, videoId: string): VideoEvidence {
  const sid = sourceIdOf(videoId);
  return {
    watched: b.watched.filter((w) => w.sourceId === sid).flatMap((w) => w.intervals),
    passages: b.passages.filter((p) => p.sourceId === sid).map((p) => `${p.start}-${p.end} ${p.origin} ${p.text}`),
    frames: b.frames.filter((f) => f.sourceId === sid).map((f) => `${f.mediaS} ${f.width}x${f.height}`),
    gaps: b.gaps.filter((g) => g.sourceId === sid).map((g) => `${g.start}-${g.end} ${g.channel} ${g.reason}`),
    ads: b.ads.filter((a) => a.sourceId === sid).map((a) => `${a.atContentS} ${a.wallDurationMs} ${a.signals.join(",")}`),
  };
}

const watchedOf = (v: VideoEvidence): number => v.watched.reduce((s, [a, b]) => s + (b - a), 0);

function diffEvidence(label: string, a: VideoEvidence, b: VideoEvidence): string | null {
  for (const key of ["watched", "passages", "frames", "gaps", "ads"] as const) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return `${label}: ${key} differ (input has ${a[key].length}, assembled has ${b[key].length})`;
  }
  return null;
}

// ───────────────────────────── assembling ─────────────────────────────

export type AssembleResult = {
  readonly captureId: string;
  readonly outDir: string;
  readonly provenance: Provenance;
  readonly outBytes: number;
};

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return n;
}

export function assembleCaptures(opts: { readonly inputs: readonly InputSpec[]; readonly outDir: string; readonly now?: () => Date }): AssembleResult {
  const { inputs } = opts;
  const outDir = resolve(opts.outDir);
  if (inputs.length === 0) throw new Error("give at least one --in <dataDir>:<captureId>");
  const seenInputs = new Set<string>();
  for (const i of inputs) {
    const key = `${realpathSync(resolve(i.dataDir))}:${i.captureId}`;
    if (seenInputs.has(key)) throw new Error(`input ${i.dataDir}:${i.captureId} is given twice`);
    seenInputs.add(key);
  }
  checkOut(outDir, inputs);

  const read = inputs.map(readInput);

  // A video in two inputs: refuse unless the facts for it are identical (then only the first input's copy is used).
  const firstHolder = new Map<string, number>();
  const dedupe: Set<string>[] = read.map(() => new Set());
  read.forEach((input, k) => {
    for (const videoId of new Set(input.facts.map(videoOf).filter((v): v is string => v !== null))) {
      const first = firstHolder.get(videoId);
      if (first === undefined) firstHolder.set(videoId, k);
      else if (videoFingerprint(read[first]!, videoId) === videoFingerprint(input, videoId)) dedupe[k]!.add(videoId);
      else throw new Error(`video ${videoId} appears in input ${first + 1} (${inputs[first]!.captureId}) and input ${k + 1} (${inputs[k]!.captureId}) with different facts; refusing to assemble a capture that holds two versions of one video`);
    }
  });

  // One fact stream.
  const captureId = randomId("cap");
  const stream: (CaptureFact & { jpeg?: Uint8Array | null })[] = [];
  const usedFrameIds = new Set<string>();
  const perInput: Omit<InputProvenance, "watchedSeconds" | "videoIds">[] = [];
  let wallEnd = Number.NEGATIVE_INFINITY;
  let firstWall = Number.POSITIVE_INFINITY;
  read.forEach((input, k) => {
    const ending = endedByLeavingWatchPage(input.facts);
    const isDropped = (f: CaptureFact): boolean => f.kind === "control" && (f.action === "start" || f.action === "stop" || f === ending);
    const kept = input.facts.filter((f) => {
      const v = videoOf(f);
      return !(v !== null && dedupe[k]!.has(v)) && !isDropped(f);
    });
    const dropped = input.facts.filter(isDropped).map((f) => `${(f as Extract<CaptureFact, { kind: "control" }>).action}@clientSeq ${f.clientSeq}${f === ending ? " (the pause that ended the capture when its tab left the watch page)" : ""}`);
    const min = Math.min(...input.facts.map((f) => f.wallMs));
    const max = Math.max(...input.facts.map((f) => f.wallMs));
    const shift = k === 0 ? 0 : wallEnd + JOIN_GAP_MS - min;
    if (k === 0) firstWall = min;
    wallEnd = max + shift;

    const frameIds = new Set(kept.filter((f) => f.kind === "frame").map((f) => (f as Extract<CaptureFact, { kind: "frame" }>).frameId));
    const clash = [...frameIds].some((id) => usedFrameIds.has(id));
    let renamed = 0;
    for (const f of kept) {
      let fact = f;
      if (f.kind === "frame") {
        let frameId = f.frameId;
        if (clash) {
          frameId = `in${k + 1}-${f.frameId}`;
          renamed++;
        }
        fact = { ...f, frameId };
      }
      stream.push({ ...fact, captureId: captureId as CaptureId, wallMs: f.wallMs + shift });
    }
    // An input that ended by leaving the watch page ends with its failure episodes open (nothing resumed capture). Carried on, they
    // would mark the next input's clips as failed; the product closes them when capture resumes, so close them here, and say so.
    const added: string[] = [];
    if (ending !== null && k < read.length - 1) {
      for (const open of openChannelFailures(input.facts)) {
        stream.push({ captureId: captureId as CaptureId, clientSeq: 0, wallMs: max + shift, kind: "channel", channel: open.channel, health: "ok", videoId: open.videoId, atMediaS: null, detail: "assembled: capture resumed in the next input" });
        added.push(`channel ${open.channel} ok${open.videoId ? ` (${open.videoId})` : ""} closing a ${open.health} episode that was open when this input ended`);
      }
    }
    for (const f of stream) if (f.kind === "frame") usedFrameIds.add(f.frameId);
    perInput.push({
      order: k + 1, dataDir: input.dataDir, captureId: input.spec.captureId, sqliteSha256: input.sqliteSha256, sqliteBytes: input.sqliteBytes, walSha256: input.walSha256,
      factCount: input.facts.length, droppedControls: dropped, addedFacts: added, wallShiftMs: shift, renamedFrameIds: renamed, videosDeduped: [...dedupe[k]!],
    });
  });
  const control = (action: "start" | "stop", wallMs: number): CaptureFact => ({ captureId: captureId as CaptureId, clientSeq: 0, wallMs, kind: "control", action, reason: "user" });
  const full = [control("start", firstWall), ...stream, control("stop", wallEnd)].map((f, i) => ({ ...f, clientSeq: i }));

  // Ingest into the new data dir with the product's own store.
  const created = !existsSync(outDir);
  mkdirSync(outDir, { recursive: true });
  const cleanOut = () => {
    if (created) rmSync(outDir, { recursive: true, force: true });
    else for (const e of readdirSync(outDir)) rmSync(join(outDir, e), { recursive: true, force: true });
  };
  try {
    const db = openDb(join(outDir, "afterclass.sqlite"));
    let bundle: EvidenceBundleJson;
    let evidence: EvidenceStoreWithProbe;
    let sources: readonly { readonly id: string; readonly videoId: string }[];
    try {
      const keyOf = (input: { readonly after: { readonly frame: { readonly id: string } } }): MemoKey => stableId("key", "frame_change", "assembled", input.after.frame.id);
      evidence = createEvidence(db, outDir, {
        lookupFrameChange: (input) => ({ kind: "missing", key: keyOf(input) }),
        runFrameChange: () => Promise.reject(new Error("assembling a capture makes no model call")),
        frameChangeKey: keyOf,
        onChange: () => {},
      });
      evidence.ingest({
        captureId: captureId as CaptureId,
        facts: full.map((f) => {
          const { jpeg, ...fact } = f as CaptureFact & { jpeg?: Uint8Array | null };
          return fact.kind === "frame" ? ({ ...fact, jpegBase64: jpeg ? Buffer.from(jpeg).toString("base64") : "" } as CaptureFact) : (fact as CaptureFact);
        }),
      });
      bundle = evidence.captureBundle(captureId as CaptureId);
      sources = evidence.captureView(captureId as CaptureId).sources.map((s) => ({ id: s.id as string, videoId: s.videoId }));

      verify(read, dedupe, evidence, bundle, captureId, inputs);
    } finally {
      db.close();
    }

    const videoIds = sources.map((s) => s.videoId);
    const watchedBySource = (videoId: string) => videoEvidence(bundle, videoId).watched.reduce((s, [a, b]) => s + (b - a), 0);
    const owner = (videoId: string) => firstHolder.get(videoId)!;
    let cumulative = 0;
    const joins: Join[] = [];
    videoIds.forEach((v, i) => {
      cumulative += watchedBySource(v);
      if (i + 1 < videoIds.length) joins.push({ fromVideoId: v, toVideoId: videoIds[i + 1]!, cumulativeWatchedS: cumulative, crossesInputs: owner(v) !== owner(videoIds[i + 1]!) });
    });
    const provenance: Provenance = {
      assembled: true, origin: ASSEMBLED_ORIGIN, notOneLiveSession: true,
      assembledAt: (opts.now ?? (() => new Date()))().toISOString(), tool: "scripts/assemble-capture.ts", captureId,
      inputs: perInput.map((p, k) => ({
        ...p,
        videoIds: [...firstHolder].filter(([, o]) => o === k).map(([v]) => v),
        watchedSeconds: perVideoTotal(k, bundle, firstHolder),
      })),
      videoIds, watchedSeconds: bundle.watchedSeconds, frames: bundle.frames.length, passages: bundle.passages.length, joins,
      handling: [
        "Each input's own control start and stop were dropped (counts per input above); one start was put first and one stop last, both with reason user. Pause and resume controls are kept.",
        `clientSeq was renumbered 0..n-1. wallMs of each later input was shifted to start ${JOIN_GAP_MS} ms after the previous input's last fact; timing inside an input is unchanged.`,
        "Every source, transcript, span, ad, channel, transcription_choice and frame fact is otherwise untouched. A frameId is prefixed with in<N>- only when two inputs reuse it (see renamedFrameIds).",
        "Frame-change judgments were not run (no model call): frames show teaching unjudged. Nothing here is new lecture content.",
      ],
    };
    writeFileSync(join(outDir, ASSEMBLED_JSON), JSON.stringify(provenance, null, 2) + "\n");
    writeFileSync(join(outDir, ASSEMBLED_MD), renderProvenance(provenance));
    return { captureId, outDir, provenance, outBytes: dirBytes(outDir) };
  } catch (e) {
    cleanOut();
    throw e;
  }
}

/** Watched seconds credited to input k: the videos it holds (first holder), measured in the assembled capture. */
function perVideoTotal(k: number, bundle: EvidenceBundleJson, holder: ReadonlyMap<string, number>): number {
  let s = 0;
  for (const [videoId, o] of holder) if (o === k) s += videoEvidence(bundle, videoId).watched.reduce((t, [a, b]) => t + (b - a), 0);
  return s;
}

function verify(read: readonly ReadInput[], dedupe: readonly Set<string>[], assembled: EvidenceStoreWithProbe, bundle: EvidenceBundleJson, captureId: string, inputs: readonly InputSpec[]): void {
  const counted = new Set<string>();
  let expected = 0;
  read.forEach((input, k) => {
    const scratch = scratchCopy(input.dataDir);
    const db = openDb(scratch.path);
    try {
      const keyOf = (i: { readonly after: { readonly frame: { readonly id: string } } }): MemoKey => stableId("key", "frame_change", "assembled", i.after.frame.id);
      const own = createEvidence(db, input.dataDir, {
        lookupFrameChange: (i) => ({ kind: "missing", key: keyOf(i) }),
        runFrameChange: () => Promise.reject(new Error("no model call")),
        frameChangeKey: keyOf,
        onChange: () => {},
      });
      const ownBundle = own.captureBundle(input.spec.captureId as CaptureId);
      const videoIds = [...new Set(input.facts.map(videoOf).filter((v): v is string => v !== null))];
      for (const videoId of videoIds) {
        const label = `video ${videoId} of input ${k + 1} (${inputs[k]!.captureId})`;
        const a = videoEvidence(ownBundle, videoId);
        const b = videoEvidence(bundle, videoId);
        const bad = diffEvidence(label, a, b);
        if (bad) throw new Error(`verification failed, assembled capture does not reproduce the input: ${bad}`);
        // Frame bytes: the nth frame of this video has the same bytes in both stores.
        const ownFrames = ownBundle.frames.filter((f) => f.sourceId === sourceIdOf(videoId));
        const newFrames = bundle.frames.filter((f) => f.sourceId === sourceIdOf(videoId));
        ownFrames.forEach((f, n) => {
          const g = newFrames[n]!;
          if (f.file === null || g.file === null || !existsSync(f.file) || !existsSync(g.file)) throw new Error(`verification failed: ${label}: frame ${n} has no bytes on disk (input ${f.file}, assembled ${g.file})`);
          if (!readFileSync(f.file).equals(readFileSync(g.file))) throw new Error(`verification failed: ${label}: frame ${n} bytes differ from the input`);
        });
        if (!counted.has(videoId)) {
          counted.add(videoId);
          expected += watchedOf(a);
        }
      }
    } finally {
      db.close();
      rmSync(scratch.dir, { recursive: true, force: true });
    }
  });
  if (Math.abs(bundle.watchedSeconds - expected) > 1e-6) throw new Error(`verification failed: assembled capture ${captureId} has ${bundle.watchedSeconds} s watched, the inputs' videos sum to ${expected} s`);
}

// ───────────────────────────── provenance ─────────────────────────────

export function renderProvenance(p: Provenance): string {
  const lines = [
    "# ASSEMBLED capture",
    "",
    `**Data origin: ${p.origin}.** This capture was ASSEMBLED from replayed recorded facts of the input captures below on ${p.assembledAt}, in this watch order. It is NOT one live session, and it holds no new lecture content.`,
    "",
    `Assembled capture id: \`${p.captureId}\` (${p.videoIds.length} videos, ${p.watchedSeconds.toFixed(1)} s watched, ${p.frames} frames, ${p.passages} passages).`,
    "",
    "## Inputs, in watch order",
    "",
    ...p.inputs.flatMap((i) => [
      `${i.order}. data dir \`${i.dataDir}\`, capture \`${i.captureId}\``,
      `   - sqlite sha256 \`${i.sqliteSha256}\`${i.walSha256 ? ` (WAL sha256 \`${i.walSha256}\`)` : ""}, ${i.factCount} facts, ${i.watchedSeconds.toFixed(1)} s watched`,
      `   - dropped controls: ${i.droppedControls.length === 0 ? "none" : i.droppedControls.join(", ")}; added facts: ${i.addedFacts.length === 0 ? "none" : i.addedFacts.join(", ")}; wall shift ${i.wallShiftMs} ms; frame ids renamed: ${i.renamedFrameIds}${i.videosDeduped.length ? `; videos taken from an earlier input: ${i.videosDeduped.join(", ")}` : ""}`,
    ]),
    "",
    "## What was done",
    "",
    ...p.handling.map((h) => `- ${h}`),
    "",
    "## Clip joins in watch order",
    "",
    ...p.joins.map((j) => `- ${j.fromVideoId} -> ${j.toVideoId} at ${j.cumulativeWatchedS.toFixed(1)} s cumulative watched${j.crossesInputs ? " (crosses two input captures)" : ""}`),
    "",
  ];
  return lines.join("\n");
}

/** Reads <dataDir>/ASSEMBLED.json; null when the dir is not an assembled one. Other tools call this to surface the label. */
export function readProvenance(dataDir: string): Provenance | null {
  const file = join(dataDir, ASSEMBLED_JSON);
  if (!existsSync(file)) return null;
  const p = JSON.parse(readFileSync(file, "utf8")) as Provenance;
  if (p.assembled !== true) throw new Error(`${file} is not an assembled-capture provenance file`);
  return p;
}

export function provenanceLine(p: Provenance): string {
  return `${p.origin}: capture ${p.captureId} assembled ${p.assembledAt} from ${p.inputs.map((i) => `${i.dataDir}:${i.captureId}`).join(" then ")}; not one live session`;
}

// ───────────────────────────── cli ─────────────────────────────

function parseIn(s: string): InputSpec {
  const at = s.lastIndexOf(":");
  if (at <= 0 || at === s.length - 1) throw new Error(`--in wants <dataDir>:<captureId>, got ${s}`);
  return { dataDir: s.slice(0, at), captureId: s.slice(at + 1) };
}

if (import.meta.main) {
  const usage = "usage: bun run scripts/assemble-capture.ts --in <dataDir>:<captureId> [--in ...] --out <newDataDir>\n       bun run scripts/assemble-capture.ts --describe <dataDir>";
  const { values } = parseArgs({ options: { in: { type: "string", multiple: true }, out: { type: "string" }, describe: { type: "string" } } });
  try {
    if (values.describe) {
      const p = readProvenance(resolve(values.describe));
      if (!p) throw new Error(`${values.describe} has no ${ASSEMBLED_JSON}: it is not an assembled capture`);
      console.log(renderProvenance(p));
    } else if (values.in?.length && values.out) {
      const done = assembleCaptures({ inputs: values.in.map(parseIn), outDir: values.out });
      const p = done.provenance;
      console.log(`assembled capture ${done.captureId}: ${p.videoIds.length} videos, ${p.watchedSeconds.toFixed(1)} s watched, ${p.frames} frames, ${p.passages} passages, ${(done.outBytes / 1e6).toFixed(1)} MB -> ${done.outDir}`);
      console.log(provenanceLine(p));
      for (const j of p.joins) console.log(`join ${j.fromVideoId} -> ${j.toVideoId} at ${j.cumulativeWatchedS.toFixed(1)} s${j.crossesInputs ? " (between inputs)" : ""}`);
    } else {
      console.error(usage);
      process.exit(2);
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
