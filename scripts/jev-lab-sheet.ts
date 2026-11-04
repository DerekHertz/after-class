/**
 * Experiment 2's labeling sheet: one static, offline HTML page per lecture, for Derek to mark topic boundaries,
 * important visual steps and duplicate frames, and to export a label file the lab validates.
 *
 *   bun run scripts/jev-lab-sheet.ts --data <dir> --labels <file> [--labels <file> ...] --out <dir>
 *
 * Each draft label file (from `jev-lab draft-labels`) names the capture and the video. The capture is read through a
 * scratch copy of the database, as probe-export does, so <dir> is never written; --out may not lie inside it. No
 * model is called and no key is read. A page is self-contained: frames are embedded as data: URIs, the logic is
 * bundled from jev-lab-sheet-page.ts, and a Content-Security-Policy that allows only that one script and style
 * forbids every network request. The only links are YouTube watch links, built from a validated video id.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { CaptureId, EvidenceId } from "../src/shared/ids";
import { LabRefusal, loadLabels, openCapture } from "./jev-lab";
import { fmtTime, isVideoId, midpointOf } from "./jev-lab-sheet-client";
import type { SheetData } from "./jev-lab-sheet-client";

function refuse(message: string): never {
  throw new LabRefusal(message);
}

/** JSON that is safe inside a <script> element: no "<" (so no "</script" or "<!--") and no U+2028/2029 (line terminators in older JS). */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const sha256Base64 = (s: string): string => createHash("sha256").update(s).digest("base64");

/** The path with symlinks resolved as far as it exists, so an alias of the data dir is not mistaken for another place. */
function canonical(path: string): string {
  const abs = resolve(path);
  const rest: string[] = [];
  let at = abs;
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  return join(realpathSync(at), ...rest);
}

const CSS = `
:root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1d1c1a; --muted: #5d5a54; --line: #d6d2c9; --card: #ffffff; --accent: #1f5fbf; --ok: #1d6b3a; --warn: #9a5a00; --bad: #a3261f; --watched: #bfe3c8; }
@media (prefers-color-scheme: dark) { :root { --bg: #17171a; --fg: #ece9e2; --muted: #a9a59c; --line: #3a3a3f; --card: #212125; --accent: #7aa7ff; --ok: #6fcf8e; --warn: #e0a54a; --bad: #ff8b82; --watched: #2f5a3d; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 62rem; padding: 1rem; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
h1 { margin: 0.2rem 0; font-size: 1.5rem; } h2 { margin-top: 2rem; }
a { color: var(--accent); }
.meta { color: var(--muted); font-size: 0.9rem; margin: 0.3rem 0; }
.split { border: 2px solid var(--accent); border-radius: 6px; padding: 0.5rem 0.75rem; }
.note { border-left: 4px solid var(--warn); padding-left: 0.5rem; }
.skip { position: absolute; left: -999px; } .skip:focus { left: 0.5rem; top: 0.5rem; background: var(--card); padding: 0.3rem; }
button, input, textarea, select { font: inherit; color: inherit; }
button { background: var(--card); border: 1px solid var(--muted); border-radius: 5px; padding: 0.25rem 0.6rem; cursor: pointer; }
button[aria-pressed="true"] { background: var(--accent); color: var(--bg); border-color: var(--accent); }
button:disabled { opacity: 0.45; cursor: default; }
input[type="text"], input[type="search"], textarea { background: var(--card); border: 1px solid var(--muted); border-radius: 5px; padding: 0.25rem 0.4rem; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; background: var(--bg); padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
.toolbar .sep { flex: 1 1 1rem; }
.timeline { position: relative; height: 76px; border: 1px solid var(--line); border-radius: 6px; margin: 0.5rem 0 1.2rem; background: var(--card); cursor: crosshair; }
.tl-watched { position: absolute; top: 0; bottom: 0; background: var(--watched); }
.tl-frame { position: absolute; bottom: 14px; width: 1px; height: 8px; background: var(--muted); }
.tl-mid { position: absolute; top: 0; bottom: 0; border-left: 2px dashed var(--accent); }
.tl-label { position: absolute; bottom: -1.3rem; font-size: 0.75rem; color: var(--muted); transform: translateX(-50%); white-space: nowrap; }
.tl-marks { position: absolute; inset: 0; pointer-events: none; }
.tl-mark { position: absolute; width: 18px; height: 18px; padding: 0; font-size: 0.7rem; line-height: 1; pointer-events: auto; border-radius: 50%; }
.tl-mark.confirmed { background: var(--ok); color: var(--bg); border-color: var(--ok); }
.tl-mark.unconfirmed { background: transparent; border: 2px solid var(--warn); }
.tl-mark.rejected { opacity: 0.35; text-decoration: line-through; }
.item { scroll-margin-top: 4rem; }
.row { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.4rem 0.2rem; border-bottom: 1px solid var(--line); scroll-margin-top: 4rem; }
.row[hidden] { display: none; }
.row .time { font-variant-numeric: tabular-nums; color: var(--muted); min-width: 3.5rem; }
.row .text { flex: 1; margin: 0; }
.row.frame { background: color-mix(in srgb, var(--card) 70%, transparent); }
.thumb { padding: 0; border: 1px solid var(--muted); line-height: 0; }
.thumb img, .members img { max-width: 100%; height: auto; }
.frame-meta { display: flex; flex-direction: column; gap: 0.3rem; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.check { display: inline-flex; gap: 0.3rem; align-items: center; }
.slot { margin-left: 1rem; }
.card { border: 1px solid var(--line); border-left: 6px solid var(--warn); border-radius: 6px; background: var(--card); padding: 0.4rem 0.75rem; margin: 0.4rem 0; }
.card.confirmed { border-left-color: var(--ok); } .card.rejected { border-left-color: var(--bad); opacity: 0.65; }
.card-head { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: baseline; margin: 0.2rem 0; }
.pill { border: 1px solid var(--muted); border-radius: 999px; padding: 0 0.5rem; font-size: 0.8rem; }
.cue { margin: 0.2rem 0; color: var(--muted); font-size: 0.9rem; }
.note-label { display: flex; gap: 0.5rem; align-items: center; margin: 0.3rem 0; } .note-label input { flex: 1; }
.members { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.75rem; }
.members li { display: flex; flex-direction: column; gap: 0.2rem; align-items: flex-start; }
.signoff { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 0.75rem; max-width: 28rem; margin: 0.5rem 0; }
.export-status { font-weight: 600; } .export-status.signed_off { color: var(--ok); } .export-status.draft { color: var(--warn); }
.blockers li { color: var(--bad); } .warnings li { color: var(--warn); }
#export-json { width: 100%; font: 0.85rem/1.4 ui-monospace, monospace; }
.lightbox { max-width: 96vw; max-height: 96vh; background: var(--card); color: var(--fg); border: 1px solid var(--muted); border-radius: 8px; } .lightbox img { max-width: 100%; max-height: 80vh; }
.lectures { list-style: none; padding: 0; } .lectures li { border: 1px solid var(--line); border-radius: 6px; background: var(--card); padding: 0.5rem 0.9rem; margin: 0.6rem 0; }
`;

const csp = (scriptHash: string | null, styleHash: string): string =>
  `default-src 'none'; img-src data:; style-src 'sha256-${styleHash}'; ${scriptHash === null ? "" : `script-src 'sha256-${scriptHash}'; `}base-uri 'none'; form-action 'none'`;

const shell = (title: string, policy: string, css: string, body: string): string =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="${policy}">\n<title>${escapeHtml(title)}</title>\n<style>${css}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

let bundle: Promise<string> | undefined;
/** The page script, bundled once per process. It must hold no "</script" or "<!--", which would end or confuse the script element. */
function pageScript(): Promise<string> {
  bundle ??= (async () => {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, "jev-lab-sheet-page.ts")], target: "browser", format: "iife", minify: false, throw: false });
    if (!result.success || result.outputs.length !== 1) throw new Error(`building the sheet script failed:\n${result.logs.map(String).join("\n")}`);
    const text = await result.outputs[0]!.text();
    if (/<\/script|<!--/i.test(text)) throw new Error("the bundled sheet script contains </script or <!--; it cannot be inlined safely");
    return text;
  })();
  return bundle;
}

type Summary = { readonly videoId: string; readonly title: string; readonly durationS: number | null; readonly spanS: { readonly start: number; readonly end: number }; readonly frames: number; readonly passages: number; readonly candidates: readonly [number, number, number]; readonly bytes: number };

export type SheetResult = { readonly files: readonly { readonly path: string; readonly bytes: number }[]; readonly notes: readonly string[] };

export async function generateSheet(opts: { readonly dataDir: string; readonly labelFiles: readonly string[]; readonly outDir: string }): Promise<SheetResult> {
  const dataDir = canonical(opts.dataDir);
  const outDir = canonical(opts.outDir);
  if (outDir === dataDir || outDir.startsWith(dataDir + sep)) refuse(`--out ${opts.outDir} is inside the data dir ${opts.dataDir}; the data dir is never written, so choose another place`);

  const infos = loadLabels(opts.labelFiles).map((i) => {
    if (i.labels.schemaVersion !== 1) return refuse(`${i.file} is a schema 2 set of clips; the sheet makes one page per video and reads schema 1 files only (a set has no sheet yet)`);
    return { ...i, labels: i.labels };
  });
  const ids = infos.map((i) => i.labels.lecture.videoId);
  for (const id of ids) if (!isVideoId(id)) refuse(`"${id}" is not a YouTube video id (11 characters of A-Z a-z 0-9 _ -); it is used in a file name and a link, so no sheet is written`);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) refuse(`two label files name the video ${twice}; their pages would share a file name`);

  const script = await pageScript();
  const notes: string[] = [];
  const pages: { readonly summary: Omit<Summary, "bytes">; readonly html: string }[] = [];
  const cap = openCapture(opts.dataDir);
  try {
    for (const info of infos) {
      const { captureId, videoId, spanS } = info.labels.lecture;
      const bundleJson = cap.evidence.captureBundle(captureId as CaptureId);
      const source = cap.evidence.captureView(captureId as CaptureId).sources.find((s) => s.videoId === videoId);
      const passages = bundleJson.passages.filter((p) => p.sourceId === source?.id && p.text.trim() !== "").sort((a, b) => a.start - b.start);
      const frameRows = bundleJson.frames.filter((f) => f.sourceId === source?.id).sort((a, b) => a.mediaS - b.mediaS);
      if (source === undefined || (passages.length === 0 && frameRows.length === 0)) refuse(`capture ${captureId} has no passages or frames for video ${videoId}; is the label file for this data dir?`);

      const frames: SheetData["frames"][number][] = [];
      for (const f of frameRows) {
        const bytes = cap.evidence.frameBytes(f.id as EvidenceId);
        if (bytes === null) notes.push(`${videoId}: frame ${f.id} has no bytes on disk, so it is not on the sheet`);
        else frames.push({ id: f.id, mediaS: f.mediaS, width: f.width, height: f.height, src: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` });
      }
      const data: SheetData = {
        draft: info.labels,
        draftHash: info.sha256.slice(0, 16),
        videoId,
        durationS: source.durationS,
        watched: bundleJson.watched.find((w) => w.sourceId === source.id)?.intervals ?? [],
        passages: passages.map((p) => ({ id: p.id, start: p.start, end: p.end, text: p.text })),
        frames,
      };
      const policy = csp(sha256Base64(script), sha256Base64(CSS));
      const html = shell(
        `Labeling sheet: ${source.title === "" ? videoId : source.title}`, policy, CSS,
        `<noscript><p>This labeling sheet needs JavaScript. It makes no network request.</p></noscript>\n<main id="app"></main>\n<script type="application/json" id="sheet-data">${jsonForScript(data)}</script>\n<script>${script}</script>`,
      );
      pages.push({
        html,
        summary: {
          videoId, title: info.labels.lecture.title ?? source.title, durationS: source.durationS, spanS, frames: frames.length, passages: passages.length,
          candidates: [info.labels.boundaries.length, info.labels.visualSteps.length, info.labels.duplicateGroups.length],
        },
      });
    }
  } finally {
    cap.close();
  }

  mkdirSync(opts.outDir, { recursive: true });
  const files: { path: string; bytes: number }[] = [];
  const write = (name: string, text: string) => {
    const path = join(resolve(opts.outDir), name);
    writeFileSync(path, text);
    files.push({ path, bytes: Buffer.byteLength(text) });
  };
  const summaries: Summary[] = pages.map((p) => ({ ...p.summary, bytes: Buffer.byteLength(p.html) }));
  for (const p of pages) write(`${p.summary.videoId}.html`, p.html);
  write("index.html", indexPage(summaries));
  return { files, notes };
}

function indexPage(lectures: readonly Summary[]): string {
  const items = lectures.map((l) => {
    const mid = midpointOf(l.spanS);
    return `<li><h2><a href="${l.videoId}.html">${escapeHtml(l.title)}</a></h2>
<p class="meta">Video ${l.videoId}. Duration ${l.durationS === null ? "unknown" : fmtTime(l.durationS)}. Labeled span ${fmtTime(l.spanS.start)} to ${fmtTime(l.spanS.end)}. ${l.frames} frames, ${l.passages} caption passages. Page ${(l.bytes / 1e6).toFixed(1)} MB.</p>
<p>Split midpoint ${fmtTime(mid)} (${mid} s): before it is the tuning half, after it is the held-out half, scored once. The draft suggests ${l.candidates[0]} boundaries, ${l.candidates[1]} visual steps and ${l.candidates[2]} duplicate groups; every one needs your confirmation.</p></li>`;
  });
  const body = `<h1>Labeling sheets, experiment 2</h1>\n<p class="meta">Each page works offline, makes no network request and saves your work in this browser only. Export a label file from each page.</p>\n<ul class="lectures">\n${items.join("\n")}\n</ul>`;
  return shell("Labeling sheets", `default-src 'none'; style-src 'sha256-${sha256Base64(CSS)}'; base-uri 'none'; form-action 'none'`, CSS, body);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { data: { type: "string" }, labels: { type: "string", multiple: true }, out: { type: "string" } } });
  if (!values.data || !values.out || (values.labels ?? []).length === 0) {
    console.error("usage: bun run scripts/jev-lab-sheet.ts --data <dir> --labels <file> [--labels <file> ...] --out <dir>");
    process.exit(2);
  }
  try {
    const done = await generateSheet({ dataDir: resolve(values.data), labelFiles: values.labels!.map((f) => resolve(f)), outDir: resolve(values.out) });
    for (const f of done.files) console.log(`${f.path}  ${(f.bytes / 1e6).toFixed(2)} MB (${f.bytes} bytes)`);
    for (const n of done.notes) console.log(`note: ${n}`);
  } catch (e) {
    console.error(`jev-lab-sheet: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
