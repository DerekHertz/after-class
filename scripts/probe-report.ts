/**
 * Experiment 1, the capture probe (docs/flows/after-class.md, "Experiments and pass bars"). Scores one capture bundle
 * against bars that are fixed here, before any result exists. Nothing in this file is tuned after the fact.
 *
 *   bun run scripts/probe-report.ts --bundle bundle.json [--spot spot-results.json] [--perf perf.json]
 *                                   [--origin fixture|live] [--out probe-report.md]
 *
 * Exit code 0 only when the four bars all PASS and the perf probe, if measured, did not FAIL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { EvidenceBundleJson } from "../src/backend/evidence";
import { contains, IntervalSet, media, overlaps } from "../src/shared/time";
import type { Interval } from "../src/shared/time";

export type Origin = "fixture" | "live";
export type Verdict = "PASS" | "FAIL" | "NOT MEASURED";

const n = z.number().finite().nonnegative();
const bundleSchema = z.object({
  captureId: z.string().nullable(),
  status: z.unknown(),
  watchedSeconds: n,
  watched: z.array(z.object({ sourceId: z.string(), intervals: z.array(z.tuple([n, n])) })),
  passages: z.array(z.object({ id: z.string(), sourceId: z.string(), start: n, end: n, text: z.string(), origin: z.string(), transcriptRevId: z.string() })),
  frames: z.array(z.object({ id: z.string(), sourceId: z.string(), mediaS: n, width: n, height: n, teaching: z.string(), file: z.string().nullable() })),
  gaps: z.array(z.object({ sourceId: z.string(), start: n, end: n, channel: z.string(), reason: z.string() })),
  ads: z.array(z.object({ sourceId: z.string(), atContentS: n, wallDurationMs: n, signals: z.array(z.string()) })),
});

const spotSchema = z.object({
  captionChecks: z.array(z.object({ index: z.number().int(), match: z.boolean() })).optional(),
  frameChecks: z.array(z.object({ index: z.number().int(), readable: z.boolean() })).optional(),
  adChecks: z.array(z.object({ kind: z.enum(["frame", "passage", "span"]), index: z.number().int(), isAd: z.boolean() })).optional(),
  observations: z.array(z.object({ question: z.string(), answer: z.union([z.boolean(), z.string()]) })).optional(),
});

const perfSchema = z.object({
  off: z.object({ dropped: z.number(), total: z.number() }),
  on: z.object({ dropped: z.number(), total: z.number() }),
});

export type SpotInput = z.input<typeof spotSchema>;
export type PerfInput = z.input<typeof perfSchema>;
export type ProbeInputs = { readonly bundle: EvidenceBundleJson; readonly spot?: SpotInput | undefined; readonly perf?: PerfInput | undefined; readonly origin: Origin };
export type Bar = { readonly name: string; readonly verdict: Verdict };
export type ProbeReport = { readonly bars: readonly Bar[]; readonly overall: "PASS" | "FAIL" | "NOT PASSED"; readonly exitCode: 0 | 1; readonly text: string };

export const parseBundle = (json: unknown) => bundleSchema.parse(json) as EvidenceBundleJson;
export const parseSpot = (json: unknown) => spotSchema.parse(json);
export const parsePerf = (json: unknown) => perfSchema.parse(json);

// Fixed bars, quoted from docs/flows/after-class.md. The perf rule is the plan's (docs/plans/mvp-completion.md, M11).
const BAR_COVERAGE = "every watched interval has evidence or a logged gap";
const BAR_CAPTIONS = "≥9/10 spot checks caption-to-screen within ±2s";
const BAR_FRAMES = "board text readable in ≥9/10 frames";
const BAR_ADS = "zero ad evidence";
const RULE_PERF = "Capture overhead on playback (dropped video frames). Chrome media stats with capture on and off, same clip. Baseline: capture off first. Rule: fail above 1 percent more dropped frames.";
const SPOT_COUNT = 10;
const SPOT_MIN_PASS = 9;
const PERF_LIMIT_POINTS = 1;

const fmt = (x: number) => String(Number(x.toFixed(3)));
const span = (start: number, end: number): Interval[] => (end > start ? [{ start: media(start), end: media(end) }] : []);
const setOf = (pairs: Iterable<readonly [number, number]>) => IntervalSet.of([...pairs].flatMap(([a, b]) => span(a, b)));
const show = (sourceId: string, i: Interval) => `${sourceId} [${fmt(i.start)}, ${fmt(i.end)})`;

type Block = { readonly name: string; readonly title: string; readonly bar: string; readonly verdict: Verdict; readonly lines: readonly string[] };

function coverage(bundle: EvidenceBundleJson): Block {
  const head = { name: "bar 1", title: "Bar 1 (coverage)", bar: BAR_COVERAGE };
  const sources = [...new Set(bundle.watched.map((w) => w.sourceId))];
  let watchedS = 0;
  let uncoveredS = 0;
  const uncovered: string[] = [];
  for (const sourceId of sources) {
    const watched = setOf(bundle.watched.filter((w) => w.sourceId === sourceId).flatMap((w) => w.intervals));
    const evidence = setOf([
      ...bundle.passages.filter((p) => p.sourceId === sourceId).map((p) => [p.start, p.end] as const),
      ...bundle.gaps.filter((g) => g.sourceId === sourceId).map((g) => [g.start, g.end] as const),
    ]);
    const missing = watched.subtract(evidence);
    watchedS += watched.duration();
    uncoveredS += missing.duration();
    for (const i of missing.intervals()) uncovered.push(show(sourceId, i));
  }
  if (watchedS === 0) return { ...head, verdict: "NOT MEASURED", lines: ["Measured: nothing was watched in this capture, so there is no interval to check."] };
  return {
    ...head,
    verdict: uncovered.length === 0 ? "PASS" : "FAIL",
    lines: [
      `Measured: ${fmt(uncoveredS)} s uncovered of ${fmt(watchedS)} s watched, across ${sources.length} source(s).`,
      "Covered means inside a passage interval or a gap interval, half-open [start, end). A frame is an instant and covers no seconds.",
      ...(uncovered.length === 0 ? [] : ["Uncovered intervals:", ...uncovered.map((u) => `  ${u}`)]),
    ],
  };
}

function scored<T extends { readonly index: number }>(
  head: { readonly name: string; readonly title: string; readonly bar: string },
  results: readonly T[] | undefined,
  yes: (r: T) => boolean,
  noun: string,
  matched: string,
): Block {
  if (results === undefined) return { ...head, verdict: "NOT MEASURED", lines: [`Measured: no ${noun} results were supplied.`] };
  const distinct = new Set(results.map((r) => r.index));
  const complete = results.length === SPOT_COUNT && distinct.size === SPOT_COUNT && [...distinct].every((i) => i >= 0 && i < SPOT_COUNT);
  if (!complete) return { ...head, verdict: "NOT MEASURED", lines: [`Measured: ${results.length} ${noun} result(s) with ${distinct.size} distinct index(es); the bar needs exactly ${SPOT_COUNT}, indexed 0 to ${SPOT_COUNT - 1}.`] };
  const hits = results.filter(yes).length;
  return { ...head, verdict: hits >= SPOT_MIN_PASS ? "PASS" : "FAIL", lines: [`Measured: ${hits}/${SPOT_COUNT} ${matched}.`] };
}

/**
 * An ad has no span of content time: the tracker closes its span before the ad starts and records only the point where
 * content stopped (atContentS) and how long the ad ran (wallDurationMs). Content time keeps flowing afterwards, so a
 * window of content time after atContentS holds legitimate evidence. Evidence leaked from an ad would carry the ad
 * video's own clock, which starts at 0, so the window to inspect is [0, wallDurationMs/1000 + AD_WINDOW_SLACK_S).
 * Everything the bundle holds in that window (frames, passages, watched intervals) is a candidate for Derek's eye.
 */
export const AD_WINDOW_SLACK_S = 5;

export type AdCandidates = {
  readonly frames: readonly EvidenceBundleJson["frames"][number][];
  readonly passages: readonly EvidenceBundleJson["passages"][number][];
  readonly spans: readonly { readonly sourceId: string; readonly start: number; readonly end: number }[];
};

export function adCandidates(bundle: EvidenceBundleJson): AdCandidates {
  const windows = bundle.ads.map((a) => ({ sourceId: a.sourceId, window: { start: 0, end: a.wallDurationMs / 1000 + AD_WINDOW_SLACK_S } }));
  const near = (sourceId: string, test: (w: { start: number; end: number }) => boolean) => windows.some((w) => w.sourceId === sourceId && test(w.window));
  return {
    frames: bundle.frames.filter((f) => near(f.sourceId, (w) => contains(w, f.mediaS))),
    passages: bundle.passages.filter((p) => near(p.sourceId, (w) => overlaps(p, w))),
    spans: bundle.watched.flatMap((w) => w.intervals.map(([start, end]) => ({ sourceId: w.sourceId, start, end }))).filter((s) => near(s.sourceId, (w) => overlaps(s, w))),
  };
}

function ads(bundle: EvidenceBundleJson, checks: SpotInput["adChecks"]): Block {
  const head = { name: "bar 4", title: "Bar 4 (ads)", bar: BAR_ADS };
  if (bundle.ads.length === 0) return { ...head, verdict: "NOT MEASURED", lines: ["Measured: no ad occurred in this capture, so the bar was not exercised."] };
  const c = adCandidates(bundle);
  const keys = [
    ...c.frames.map((_, i) => `frame:${i}`),
    ...c.passages.map((_, i) => `passage:${i}`),
    ...c.spans.map((_, i) => `span:${i}`),
  ];
  const base = [
    `Measured: ${bundle.ads.length} ad record(s). Window [0, wallDurationMs/1000 + ${AD_WINDOW_SLACK_S} s); the ${AD_WINDOW_SLACK_S} s slack covers detection lag and was fixed before any data.`,
    `Scored: every frame, passage and watched interval in that window is a candidate Derek checks. Not scored: ad time outside the window.`,
    `Candidates: ${c.frames.length} frame(s), ${c.passages.length} passage(s), ${c.spans.length} watched interval(s).`,
  ];
  if (keys.length === 0) return { ...head, verdict: "PASS", lines: [...base, "Nothing lies in the window, so 0 candidates were checked."] };
  const given = new Map<string, boolean>((checks ?? []).map((k) => [`${k.kind}:${k.index}`, k.isAd]));
  const checked = keys.filter((k) => given.has(k));
  const asAd = checked.filter((k) => given.get(k) === true);
  const lines = [...base, `Checked by Derek: ${checked.length}/${keys.length}; ${asAd.length} judged to be an ad.`];
  if (asAd.length > 0) return { ...head, verdict: "FAIL", lines: [...lines, `Ad evidence: ${asAd.join(", ")}.`] };
  if (checked.length < keys.length) return { ...head, verdict: "NOT MEASURED", lines: [...lines, `Unchecked: ${keys.filter((k) => !given.has(k)).join(", ")}.`] };
  return { ...head, verdict: "PASS", lines };
}

function perf(input: PerfInput | undefined): Block {
  const head = { name: "perf", title: "Perf probe (capture overhead)", bar: RULE_PERF };
  const parsed = input === undefined ? null : perfSchema.safeParse(input);
  if (parsed === null || !parsed.success) return { ...head, verdict: "NOT MEASURED", lines: ["Measured: no perf numbers were supplied."] };
  const { off, on } = parsed.data;
  const valid = [off, on].every((s) => Number.isInteger(s.dropped) && Number.isInteger(s.total) && s.dropped >= 0 && s.total > 0 && s.dropped <= s.total);
  if (!valid) return { ...head, verdict: "NOT MEASURED", lines: [`Measured: unusable counts (off ${off.dropped}/${off.total}, on ${on.dropped}/${on.total}); a total of 0 or dropped above total cannot be scored.`] };
  const rate = (s: { dropped: number; total: number }) => (s.dropped / s.total) * 100;
  // Integer cross-multiplication, so a difference of exactly the limit never rounds to either side.
  const over = (on.dropped * off.total - off.dropped * on.total) * 100 > PERF_LIMIT_POINTS * off.total * on.total;
  return {
    ...head,
    verdict: over ? "FAIL" : "PASS",
    lines: [
      `Interpretation: (dropped/total with capture on) minus (dropped/total with capture off) above ${PERF_LIMIT_POINTS} percentage point fails.`,
      `Measured: off ${off.dropped}/${off.total} = ${fmt(rate(off))}%, on ${on.dropped}/${on.total} = ${fmt(rate(on))}%, difference ${fmt(rate(on) - rate(off))} percentage points.`,
    ],
  };
}

const answerText = (a: boolean | string) => (typeof a === "boolean" ? (a ? "yes" : "no") : a);

export function buildReport({ bundle, spot, perf: perfInput, origin }: ProbeInputs): ProbeReport {
  const blocks = [
    coverage(bundle),
    scored({ name: "bar 2", title: "Bar 2 (caption to screen)", bar: BAR_CAPTIONS }, spot?.captionChecks, (c) => c.match, "caption spot check", "caption spot checks matched"),
    scored({ name: "bar 3", title: "Bar 3 (board text)", bar: BAR_FRAMES }, spot?.frameChecks, (c) => c.readable, "frame check", "frames with readable board text"),
    ads(bundle, spot?.adChecks),
    perf(perfInput),
  ];

  const failed = blocks.filter((b) => b.verdict === "FAIL").map((b) => b.name);
  const notMeasured = blocks.filter((b) => b.name !== "perf" && b.verdict === "NOT MEASURED").map((b) => b.name);
  const overall = failed.length > 0 ? "FAIL" : notMeasured.length > 0 ? "NOT PASSED" : "PASS";
  const perfBlock = blocks[4]!;

  const out: string[] = [`Capture probe report for ${bundle.captureId ?? "(no capture id)"}`, `Data origin: ${origin}`, ""];
  for (const b of blocks) out.push(`${b.title}: ${b.verdict}`, `Bar: "${b.bar}"`, ...b.lines, "");
  if (spot?.observations?.length) {
    out.push("Observations outside the bars (unscored, from real Chrome)");
    for (const o of spot.observations) out.push(`  ${o.question} ${answerText(o.answer)}`);
    out.push("");
  }
  const reasons = [failed.length > 0 ? `failed: ${failed.join(", ")}` : "", notMeasured.length > 0 ? `not measured: ${notMeasured.join(", ")}` : ""].filter(Boolean);
  out.push(`OVERALL: ${overall}${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""}`);
  if (perfBlock.verdict === "NOT MEASURED") out.push("The perf probe was not measured, so capture overhead on playback is unknown.");

  const text = out.map((l) => (l === "" ? l : `[${origin}] ${l}`)).join("\n") + "\n";
  return { bars: blocks.map((b) => ({ name: b.name, verdict: b.verdict })), overall, exitCode: overall === "PASS" ? 0 : 1, text };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { bundle: { type: "string" }, spot: { type: "string" }, perf: { type: "string" }, origin: { type: "string", default: "fixture" }, out: { type: "string" } },
  });
  if (!values.bundle) {
    console.error("usage: bun run scripts/probe-report.ts --bundle bundle.json [--spot spot-results.json] [--perf perf.json] [--origin fixture|live] [--out probe-report.md]");
    process.exit(2);
  }
  if (values.origin !== "fixture" && values.origin !== "live") {
    console.error('--origin must be "fixture" or "live"');
    process.exit(2);
  }
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
  const report = buildReport({
    bundle: parseBundle(read(values.bundle)),
    spot: values.spot ? parseSpot(read(values.spot)) : undefined,
    perf: values.perf ? parsePerf(read(values.perf)) : undefined,
    origin: values.origin,
  });
  process.stdout.write(report.text);
  if (values.out) writeFileSync(values.out, report.text);
  process.exit(report.exitCode);
}
