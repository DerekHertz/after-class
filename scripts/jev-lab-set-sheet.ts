/**
 * The labeling sheet for a SET of clips (experiment 2, Amendment 1; experiment 6, stage 4): ONE offline page for the
 * whole set, written from a schema 2 label file (a `draft-labels-set` draft) and, optionally, the proposals of up to
 * two models. Reached through `bun run scripts/jev-lab-sheet.ts --labels <set draft> [--proposals <file> ...] --out <dir>`.
 *
 * Output: `<out>/index.html` and `<out>/frames/cNN-fNNNN.jpg`. Why files and not data: URIs: the assembled set has 393
 * frames, 44 MB, which would be a 58 MB page that the browser must parse before it shows anything. As files, the page
 * is the transcript only (about a megabyte), a clip's frames are fetched when its section is opened, and the folder is
 * still fully offline: the Content-Security-Policy allows no network and images only from the page's own folder. The
 * page script builds a frame's address only from the fixed pattern `frames/cNN-fNNNN.jpg` the generator wrote.
 *
 * Same guarantees as the per-clip sheet: the capture is read through a scratch copy (the data dir is never written and
 * `--out` may not lie inside it), no Jev or Claude call, no key, no network; label and proposal errors stop generation
 * before any output; embedded JSON escapes `<` and U+2028/2029; the only links are YouTube watch links.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { CaptureId, EvidenceId } from "../src/shared/ids";
import { clipRecords, openCapture } from "./jev-lab";
import { makeSplitter, watchedIn } from "./jev-lab-score";
import type { LabelFileV2, LabelInfo } from "./jev-lab-score";
import { BOUNDARY_TOLERANCE_S, FRAME_FILE, STEP_TOLERANCE_S } from "./jev-lab-set-client";
import type { SetClip, SetData } from "./jev-lab-set-client";
import { proposalsAgainstLabels, validateProposals } from "./jev-lab-proposals";
import type { Proposals } from "./jev-lab-proposals";
import { isVideoId } from "./jev-lab-sheet-client";
import { CSS, canonical, csp, jsonForScript, pageScript, refuse, sha256Base64, shell } from "./jev-lab-sheet";
import type { SheetResult } from "./jev-lab-sheet";

/** Page-only styles for the set sheet, appended to the shared sheet CSS. */
export const SET_CSS = `
.rule { border-left: 6px solid var(--accent); background: var(--card); padding: 0.5rem 0.9rem; margin: 0.8rem 0; }
.rule p { margin: 0.2rem 0; }
.clips-table { border-collapse: collapse; width: 100%; font-size: 0.9rem; } .clips-table th, .clips-table td { border-bottom: 1px solid var(--line); padding: 0.2rem 0.5rem; text-align: left; vertical-align: top; }
.half-first { --half: #2f6fbf; } .half-second { --half: #9a5a00; }
.pill.half { border-color: var(--half); color: var(--half); font-weight: 600; }
.tl-clip { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--line); }
.tl-tune { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, #2f6fbf 12%, transparent); }
.tl-held { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, #9a5a00 14%, transparent); }
.tl-no { position: absolute; top: 2px; font-size: 0.7rem; color: var(--muted); transform: translateX(2px); }
.tl-mid { border-left: 3px solid var(--accent); }
.join { border: 2px dashed var(--muted); border-radius: 6px; padding: 0.4rem 0.75rem; margin: 1rem 0 0.2rem; background: var(--card); }
.join.is-split { border: 3px solid var(--accent); }
.join p { margin: 0.2rem 0; }
.clip-head { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: baseline; margin: 0.6rem 0 0.2rem; }
.clip-head h2 { margin: 0; font-size: 1.15rem; }
.clip-toggle { font-weight: 600; }
.clip-body[hidden] { display: none; }
.clip-body { border-left: 3px solid var(--half, var(--line)); padding-left: 0.6rem; }
.clipwrap[hidden] { display: none; }
.proposers { list-style: none; padding: 0; margin: 0.2rem 0; }
.proposers li { margin: 0.15rem 0; font-size: 0.9rem; }
.who { border: 1px solid var(--accent); border-radius: 999px; padding: 0 0.5rem; font-size: 0.8rem; color: var(--accent); }
.who.both { background: var(--accent); color: var(--bg); }
.dis-list { list-style: none; padding: 0; } .dis-list li { margin: 0.2rem 0; }
.link-button { border: none; background: none; padding: 0; color: var(--accent); text-decoration: underline; cursor: pointer; text-align: left; }
.dis-panel { border: 1px solid var(--line); border-radius: 6px; padding: 0.4rem 0.9rem; background: var(--card); }
.card.is-disagreement { border-left-width: 10px; }
.members .clipno { font-size: 0.8rem; color: var(--muted); }
`;

/** Reads and validates proposal files. Any problem refuses, naming the file and every field. */
export function loadProposals(files: readonly string[]): readonly { readonly file: string; readonly sha256: string; readonly proposals: Proposals }[] {
  return files.map((file) => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return refuse(`cannot read proposals file ${file}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return refuse(`${file} is not valid JSON`);
    }
    const checked = validateProposals(json);
    if (!checked.ok) return refuse(`${file} is not a valid proposals file:\n${checked.errors.map((e) => `  ${e}`).join("\n")}`);
    return { file: basename(file), sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"), proposals: checked.proposals };
  });
}

type SetOptions = { readonly dataDir: string; readonly outDir: string; readonly info: LabelInfo; readonly proposalFiles: readonly string[]; readonly allowFixtureProposals?: boolean };

export async function generateSetSheet(opts: SetOptions): Promise<SheetResult> {
  const dataDir = canonical(opts.dataDir);
  const outDir = canonical(opts.outDir);
  if (outDir === dataDir || outDir.startsWith(dataDir + sep)) refuse(`--out ${opts.outDir} is inside the data dir ${opts.dataDir}; the data dir is never written, so choose another place`);

  const draft = opts.info.labels as LabelFileV2;
  if (draft.schemaVersion !== 2) refuse(`${opts.info.file} is not a schema 2 set`);
  const ids = draft.lecture.videos.map((v) => v.videoId);
  for (const id of ids) if (!isVideoId(id)) refuse(`"${id}" is not a YouTube video id (11 characters of A-Z a-z 0-9 _ -); it is used in a link, so no sheet is written`);
  if (ids.length > 99) refuse(`a set of ${ids.length} clips is more than the sheet's file names allow (99)`);

  const proposalFiles = loadProposals(opts.proposalFiles);
  if (proposalFiles.length > 2) refuse(`${proposalFiles.length} proposal files given; the sheet compares at most two models`);
  for (const p of proposalFiles) {
    if (p.proposals.origin === "fixture" && opts.allowFixtureProposals !== true) {
      refuse(`${p.file} has origin "fixture": it was produced by a scripted test client, not a model. Pass --allow-fixture-proposals to show it anyway, labelled FIXTURE, not a model.`);
    }
  }
  const seen = new Set<string>();
  for (const p of proposalFiles) {
    const who = `${p.proposals.proposedBy.model} (${p.proposals.proposedBy.effort})`;
    if (seen.has(who)) refuse(`two proposal files are from the same model and effort, ${who}; pass one file per model`);
    seen.add(who);
  }

  const script = await pageScript("jev-lab-set-page.ts");
  const notes: string[] = [];
  const cap = openCapture(opts.dataDir);
  const clips: SetClip[] = [];
  const frameBytes: { readonly path: string; readonly bytes: Uint8Array }[] = [];
  try {
    const records = clipRecords(cap, opts.info);
    const captureId = draft.lecture.captureId as CaptureId;
    const bundle = cap.evidence.captureBundle(captureId);
    const view = cap.evidence.captureView(captureId);
    const splitter = makeSplitter(records.map((c) => ({ videoId: c.videoId, spanS: c.spanS, watchedS: watchedIn(c.watched, c.spanS) })));
    const frameIdsByVideo = new Map<string, Set<string>>();
    records.forEach((rec, n) => {
      const source = view.sources.find((s) => s.id === rec.sourceId);
      if (source === undefined) return refuse(`capture ${captureId} has no source for video ${rec.videoId}`);
      const passages = bundle.passages.filter((p) => p.sourceId === source.id && p.text.trim() !== "").sort((a, b) => a.start - b.start);
      const frameRows = bundle.frames.filter((f) => f.sourceId === source.id).sort((a, b) => a.mediaS - b.mediaS);
      if (passages.length === 0 && frameRows.length === 0) refuse(`capture ${captureId} has no passages or frames for video ${rec.videoId}; is the label file for this data dir?`);
      frameIdsByVideo.set(rec.videoId, new Set(frameRows.map((f) => f.id as string)));
      const frames: SetClip["frames"][number][] = [];
      frameRows.forEach((f, k) => {
        const bytes = cap.evidence.frameBytes(f.id as EvidenceId);
        if (bytes === null) return void notes.push(`${rec.videoId}: frame ${f.id} has no bytes on disk, so it is not on the sheet`);
        const file = `frames/c${String(n + 1).padStart(2, "0")}-f${String(k).padStart(4, "0")}.jpg`;
        if (!FRAME_FILE.test(file)) throw new Error(`frame file name ${file} does not fit the pattern the page accepts (is a clip over 9999 frames?)`);
        frameBytes.push({ path: file, bytes });
        frames.push({ id: f.id, mediaS: f.mediaS, width: f.width, height: f.height, file });
      });
      clips.push({
        videoId: rec.videoId,
        title: draft.lecture.videos[n]!.title ?? source.title,
        durationS: source.durationS,
        spanS: rec.spanS,
        watched: rec.watched,
        watchedS: watchedIn(rec.watched, rec.spanS),
        half: splitter.halfOf(rec.videoId, rec.spanS.start) ?? "first",
        passages: passages.map((p) => ({ id: p.id, start: p.start, end: p.end, text: p.text })),
        frames,
      });
    });

    const problems = proposalFiles.flatMap((p) => proposalsAgainstLabels(p.proposals, draft, (v) => frameIdsByVideo.get(v) ?? null));
    if (problems.length > 0) {
      refuse(`${problems.length} proposal(s) do not fit this label file's set, so no sheet is written (nothing is dropped silently):\n${problems.slice(0, 40).map((e) => `  ${e}`).join("\n")}${problems.length > 40 ? `\n  ... and ${problems.length - 40} more` : ""}`);
    }

    const data: SetData = {
      draft,
      inputHash: new Bun.CryptoHasher("sha256").update([opts.info.sha256, ...proposalFiles.map((p) => p.sha256)].join("|")).digest("hex").slice(0, 16),
      clips,
      split: { kind: splitter.kind, joinIndex: splitter.joinIndex, totalS: splitter.totalS, midpointS: splitter.midpointS, beforeS: splitter.beforeS, afterS: splitter.afterS },
      proposals: proposalFiles.map((p) => p.proposals),
    };
    const css = CSS + SET_CSS;
    const html = shell(
      `Labeling sheet: set of ${clips.length} clip${clips.length === 1 ? "" : "s"}`,
      csp(sha256Base64(script), sha256Base64(css), "'self'"), css,
      `<noscript><p>This labeling sheet needs JavaScript. It makes no network request.</p></noscript>\n<main id="app"></main>\n<script type="application/json" id="sheet-data">${jsonForScript(data)}</script>\n<script>${script}</script>`,
    );

    mkdirSync(join(resolve(opts.outDir), "frames"), { recursive: true });
    const files: { path: string; bytes: number }[] = [];
    const indexPath = join(resolve(opts.outDir), "index.html");
    writeFileSync(indexPath, html);
    files.push({ path: indexPath, bytes: Buffer.byteLength(html) });
    let frameTotal = 0;
    for (const f of frameBytes) {
      writeFileSync(join(resolve(opts.outDir), f.path), f.bytes);
      frameTotal += f.bytes.byteLength;
    }
    notes.push(`${frameBytes.length} frame files in ${join(resolve(opts.outDir), "frames")}, ${(frameTotal / 1e6).toFixed(1)} MB; keep the folder together (the page shows its frames from it)`);
    if (proposalFiles.length > 0) notes.push(`proposals from ${proposalFiles.map((p) => `${p.proposals.proposedBy.model} (${p.proposals.proposedBy.effort})`).join(" and ")}; tolerances ${STEP_TOLERANCE_S} s for steps and ${BOUNDARY_TOLERANCE_S} s for boundaries (PROPOSED); none is confirmed`);
    return { files, notes };
  } finally {
    cap.close();
  }
}
