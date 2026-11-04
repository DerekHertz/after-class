import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { EvidenceBundleJson } from "../src/backend/evidence";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureFact, CaptureFactBody } from "../src/shared/domain";
import { media } from "../src/shared/time";
import { AD_WINDOW_SLACK_S, adCandidates, buildReport, parseBundle } from "../scripts/probe-report";
import type { PerfInput, ProbeInputs, SpotInput } from "../scripts/probe-report";
import { exportCapture, sampleExport } from "../scripts/probe-export";

const SRC = "src_a";

type Bundle = { -readonly [K in keyof EvidenceBundleJson]: EvidenceBundleJson[K] };

function bundle(over: Partial<Bundle> = {}): EvidenceBundleJson {
  return {
    captureId: "cap_x",
    status: { state: "stopped" },
    watchedSeconds: 20,
    watched: [{ sourceId: SRC, intervals: [[0, 10], [20, 30]] }],
    passages: [
      { id: "ev_p1", sourceId: SRC, start: 0, end: 10, text: "first", origin: "panel", transcriptRevId: "trv_1" },
      { id: "ev_p2", sourceId: SRC, start: 20, end: 30, text: "second", origin: "panel", transcriptRevId: "trv_1" },
    ],
    frames: [],
    gaps: [],
    ads: [],
    ...over,
  };
}

const ten = (yes: number) => Array.from({ length: 10 }, (_, index) => index < yes);

const captionResults = (yes: number) => ten(yes).map((match, index) => ({ index, match }));
const frameResults = (yes: number) => ten(yes).map((readable, index) => ({ index, readable }));
const spot = (captionYes = 10, frameYes = 10): SpotInput => ({ captionChecks: captionResults(captionYes), frameChecks: frameResults(frameYes) });

function run(inputs: Partial<ProbeInputs> = {}) {
  return buildReport({ bundle: bundle(), origin: "fixture", ...inputs });
}

const bar = (r: ReturnType<typeof run>, n: 1 | 2 | 3 | 4 | 5) => r.bars[n - 1]!;

describe("bar 1: every watched interval has evidence or a logged gap", () => {
  test("passes when passages cover every watched second", () => {
    expect(bar(run(), 1).verdict).toBe("PASS");
  });

  test("fails and prints the uncovered interval", () => {
    const r = run({ bundle: bundle({ passages: [bundle().passages[0]!] }) });
    expect(bar(r, 1).verdict).toBe("FAIL");
    expect(r.text).toContain(`${SRC} [20, 30)`);
  });

  test("a gap that exactly closes the uncovered interval makes it pass", () => {
    const r = run({ bundle: bundle({ passages: [bundle().passages[0]!], gaps: [{ sourceId: SRC, start: 20, end: 30, channel: "transcript", reason: "no_captions" }] }) });
    expect(bar(r, 1).verdict).toBe("PASS");
  });

  test("half-open: a gap starting where a passage ends leaves nothing, a gap starting later leaves a sliver", () => {
    const first = bundle().passages[0]!;
    const watched = [{ sourceId: SRC, intervals: [[0, 10]] as [number, number][] }];
    const abut = run({ bundle: bundle({ watched, passages: [{ ...first, end: 5 }], gaps: [{ sourceId: SRC, start: 5, end: 10, channel: "transcript", reason: "x" }] }) });
    expect(bar(abut, 1).verdict).toBe("PASS");
    const late = run({ bundle: bundle({ watched, passages: [{ ...first, end: 5 }], gaps: [{ sourceId: SRC, start: 5.5, end: 10, channel: "transcript", reason: "x" }] }) });
    expect(bar(late, 1).verdict).toBe("FAIL");
    expect(late.text).toContain(`${SRC} [5, 5.5)`);
  });

  test("evidence of another source does not cover this source", () => {
    const other = { ...bundle().passages[1]!, sourceId: "src_b" };
    const r = run({ bundle: bundle({ passages: [bundle().passages[0]!, other] }) });
    expect(bar(r, 1).verdict).toBe("FAIL");
  });

  test("nothing watched is not measured, not a pass", () => {
    expect(bar(run({ bundle: bundle({ watched: [], passages: [] }) }), 1).verdict).toBe("NOT MEASURED");
  });
});

describe("bar 2 and bar 3: spot checks", () => {
  test("9 of 10 passes and 8 of 10 fails, for captions and for frames", () => {
    const nine = run({ spot: spot(9, 9) });
    expect([bar(nine, 2).verdict, bar(nine, 3).verdict]).toEqual(["PASS", "PASS"]);
    const eight = run({ spot: spot(8, 8) });
    expect([bar(eight, 2).verdict, bar(eight, 3).verdict]).toEqual(["FAIL", "FAIL"]);
  });

  test("each bar is scored on its own", () => {
    const r = run({ spot: spot(10, 8) });
    expect([bar(r, 2).verdict, bar(r, 3).verdict]).toEqual(["PASS", "FAIL"]);
  });

  test("missing spot results are not measured", () => {
    const r = run();
    expect([bar(r, 2).verdict, bar(r, 3).verdict]).toEqual(["NOT MEASURED", "NOT MEASURED"]);
  });

  test("anything other than exactly ten distinct results is not measured", () => {
    const nine = { captionChecks: captionResults(10).slice(0, 9), frameChecks: frameResults(10).slice(0, 9) };
    expect([bar(run({ spot: nine }), 2).verdict, bar(run({ spot: nine }), 3).verdict]).toEqual(["NOT MEASURED", "NOT MEASURED"]);
    const dup = captionResults(10).map((c) => ({ ...c, index: 0 }));
    expect(bar(run({ spot: { captionChecks: dup, frameChecks: frameResults(10) } }), 2).verdict).toBe("NOT MEASURED");
  });
});

describe("bar 4: zero ad evidence", () => {
  const ad = { sourceId: SRC, atContentS: 0, wallDurationMs: 15_000, signals: ["dom_class"] };
  const frame = (id: string, mediaS: number, sourceId = SRC) => ({ id, sourceId, mediaS, width: 640, height: 360, teaching: "kept", file: null });

  test("no ad record means not measured, never a pass", () => {
    const r = run();
    expect(bar(r, 4).verdict).toBe("NOT MEASURED");
    expect(r.text).toContain("no ad occurred in this capture, so the bar was not exercised");
  });

  const windowEnd = 15 + AD_WINDOW_SLACK_S;
  const passage = (id: string, start: number, end: number) => ({ id, sourceId: SRC, start, end, text: id, origin: "panel", transcriptRevId: "trv_1" });
  const clear = (kind: "frame" | "passage" | "span", index: number, isAd = false) => ({ kind, index, isAd });
  const withChecks = (adChecks: { kind: "frame" | "passage" | "span"; index: number; isAd: boolean }[]) => ({ ...spot(), adChecks });
  const none = { watched: [{ sourceId: SRC, intervals: [[100, 110]] as [number, number][] }], passages: [passage("ev_far", 100, 110)] };

  test("an ad with nothing in its window passes and says zero candidates were checked", () => {
    const r = run({ bundle: bundle({ ...none, ads: [ad], frames: [frame("ev_f1", windowEnd)] }) });
    expect(bar(r, 4).verdict).toBe("PASS");
    expect(r.text).toContain("0 candidates were checked");
  });

  test("a frame inside the window is a candidate and needs Derek's check; the window is half-open", () => {
    const b = bundle({ ...none, ads: [ad], frames: [frame("ev_f1", windowEnd - 0.1), frame("ev_f2", windowEnd), frame("ev_f3", 3, "src_b")] });
    expect(adCandidates(b).frames.map((f) => f.id)).toEqual(["ev_f1"]);
    expect(bar(run({ bundle: b }), 4).verdict).toBe("NOT MEASURED");
  });

  test("a leaked passage and watched interval with no frame are NOT MEASURED, then PASS once Derek says they are the lecture", () => {
    const b = bundle({ ads: [{ ...ad, atContentS: 20 }], watched: [{ sourceId: SRC, intervals: [[0, 15]] }], passages: [passage("ev_p", 0, 15)], frames: [] });
    expect(bar(run({ bundle: b, spot: spot() }), 4).verdict).toBe("NOT MEASURED");
    expect(bar(run({ bundle: b, spot: withChecks([clear("passage", 0)]) }), 4).verdict).toBe("NOT MEASURED");
    const cleared = run({ bundle: b, spot: withChecks([clear("passage", 0), clear("span", 0)]) });
    expect(bar(cleared, 4).verdict).toBe("PASS");
    expect(cleared.text).toContain("Checked by Derek: 2/2; 0 judged to be an ad.");
  });

  test("any candidate judged to be an ad fails, even when others are unchecked", () => {
    const b = bundle({ ads: [ad], watched: [{ sourceId: SRC, intervals: [[0, 15]] }], passages: [passage("ev_p", 0, 15)], frames: [frame("ev_f1", 2)] });
    expect(bar(run({ bundle: b, spot: withChecks([clear("frame", 0), clear("passage", 0), clear("span", 0)]) }), 4).verdict).toBe("PASS");
    expect(bar(run({ bundle: b, spot: withChecks([clear("frame", 0), clear("passage", 0), clear("span", 0, true)]) }), 4).verdict).toBe("FAIL");
    expect(bar(run({ bundle: b, spot: withChecks([clear("passage", 0, true)]) }), 4).verdict).toBe("FAIL");
  });

  test("slack boundary: a passage starting exactly at wall + slack is outside, one second inside is a candidate", () => {
    const edge = bundle({ ...none, ads: [ad], passages: [passage("ev_edge", windowEnd, windowEnd + 5)] });
    expect(adCandidates(edge).passages).toEqual([]);
    const inside = bundle({ ...none, ads: [ad], passages: [passage("ev_in", windowEnd - 1, windowEnd + 5)] });
    expect(adCandidates(inside).passages.map((p) => p.id)).toEqual(["ev_in"]);
    expect(bar(run({ bundle: inside }), 4).verdict).toBe("NOT MEASURED");
  });

  test("candidates of another source are not the ad's", () => {
    const b = bundle({ ...none, ads: [ad], passages: [{ ...passage("ev_o", 0, 10), sourceId: "src_b" }], watched: [{ sourceId: "src_b", intervals: [[0, 10]] }] });
    expect(adCandidates(b)).toEqual({ frames: [], passages: [], spans: [] });
  });
});

describe("perf probe: more than 1 percentage point more dropped frames fails", () => {
  const perf = (off: [number, number], on: [number, number]): PerfInput => ({ off: { dropped: off[0], total: off[1] }, on: { dropped: on[0], total: on[1] } });

  test("exactly 1 point more passes", () => {
    expect(bar(run({ perf: perf([0, 1000], [10, 1000]) }), 5).verdict).toBe("PASS");
  });

  test("just over 1 point fails", () => {
    expect(bar(run({ perf: perf([0, 1000], [11, 1000]) }), 5).verdict).toBe("FAIL");
  });

  test("the difference is on minus off, so a faster run with capture on passes", () => {
    expect(bar(run({ perf: perf([50, 1000], [10, 1000]) }), 5).verdict).toBe("PASS");
  });

  test("a baseline that already drops frames is subtracted out", () => {
    expect(bar(run({ perf: perf([20, 1000], [30, 1000]) }), 5).verdict).toBe("PASS");
    expect(bar(run({ perf: perf([20, 1000], [31, 1000]) }), 5).verdict).toBe("FAIL");
  });

  test("absent, zero total or impossible counts are not measured", () => {
    expect(bar(run(), 5).verdict).toBe("NOT MEASURED");
    expect(bar(run({ perf: perf([0, 0], [1, 100]) }), 5).verdict).toBe("NOT MEASURED");
    expect(bar(run({ perf: perf([0, 100], [0, 0]) }), 5).verdict).toBe("NOT MEASURED");
    expect(bar(run({ perf: perf([0, 100], [101, 100]) }), 5).verdict).toBe("NOT MEASURED");
  });
});

describe("overall", () => {
  const passing = (): Partial<ProbeInputs> => ({
    bundle: bundle({ ads: [{ sourceId: SRC, atContentS: 0, wallDurationMs: 5000, signals: ["dom_class"] }] }),
    spot: { ...spot(), adChecks: [{ kind: "passage", index: 0, isAd: false }, { kind: "span", index: 0, isAd: false }] },
    perf: { off: { dropped: 0, total: 1000 }, on: { dropped: 0, total: 1000 } },
  });

  test("passes only when all four bars pass", () => {
    const r = run(passing());
    expect(r.overall).toBe("PASS");
    expect(r.exitCode).toBe(0);
  });

  test("any not measured bar blocks the pass and is named", () => {
    const r = run({ ...passing(), bundle: bundle() });
    expect(r.overall).toBe("NOT PASSED");
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("not measured: bar 4");
  });

  test("a failed bar fails the run and is named, perf included", () => {
    const r = run({ ...passing(), perf: { off: { dropped: 0, total: 1000 }, on: { dropped: 50, total: 1000 } } });
    expect(r.overall).toBe("FAIL");
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("failed: perf");
  });

  test("a perf probe that was not measured does not block the four bars", () => {
    const r = run({ ...passing(), perf: undefined });
    expect(r.overall).toBe("PASS");
    expect(r.text).toContain("perf probe was not measured");
  });
});

describe("report text", () => {
  test("quotes every bar verbatim and labels each line with the data origin", () => {
    const r = run();
    for (const quoted of [
      "every watched interval has evidence or a logged gap",
      "≥9/10 spot checks caption-to-screen within ±2s",
      "board text readable in ≥9/10 frames",
      "zero ad evidence",
    ]) expect(r.text).toContain(`"${quoted}"`);
    const lines = r.text.split("\n").filter((l) => l !== "");
    expect(lines.every((l) => l.startsWith("[fixture] "))).toBe(true);
    expect(run({ origin: "live" }).text.split("\n").filter((l) => l !== "").every((l) => l.startsWith("[live] "))).toBe(true);
  });

  test("is deterministic", () => {
    expect(run({ spot: spot(9, 9) }).text).toBe(run({ spot: spot(9, 9) }).text);
  });

  test("lists observations without scoring them", () => {
    const r = run({ spot: { ...spot(), observations: [{ question: "Does the popup show the title?", answer: true }, { question: "Note", answer: "slow to load" }] } });
    expect(r.text).toContain("Observations outside the bars");
    expect(r.text).toContain("Does the popup show the title? yes");
    expect(r.text).toContain("Note slow to load");
  });
});

describe("probe-export sampling", () => {
  const passages = Array.from({ length: 30 }, (_, i) => ({ id: `ev_p${i}`, sourceId: SRC, start: i * 10, end: i * 10 + 10, text: `line ${i}`, origin: "panel", transcriptRevId: "trv_1" }));
  const full = bundle({ watched: [{ sourceId: SRC, intervals: [[0, 300]] }], watchedSeconds: 300, passages });
  const videoIdOf = (s: string) => (s === SRC ? "vid12345678" : null);

  test("takes ten evenly spread passages, each inside a watched interval", () => {
    const { captions } = sampleExport(full, videoIdOf);
    expect(captions.samples).toHaveLength(10);
    expect(captions.samples.map((s) => s.mediaS)).toEqual([10, 40, 70, 100, 130, 160, 190, 220, 250, 280]);
    const starts = captions.samples.map((s) => s.mediaS);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(10);
    for (const s of captions.samples) {
      expect(s.videoId).toBe("vid12345678");
      expect(s.watched[0]).toBeLessThanOrEqual(s.mediaS);
    }
  });

  test("is deterministic", () => {
    expect(sampleExport(full, videoIdOf)).toEqual(sampleExport(full, videoIdOf));
  });

  test("a passage that is not wholly inside a watched interval is never sampled", () => {
    const partial = bundle({ watched: [{ sourceId: SRC, intervals: [[0, 105]] }], passages });
    const { captions } = sampleExport(partial, videoIdOf);
    expect(captions.samples.every((s) => s.passage[1] <= 105)).toBe(true);
    expect(captions.samples.length).toBe(10);
  });

  test("fewer than ten passages exports what exists and says so", () => {
    const { captions, notes } = sampleExport(bundle(), videoIdOf);
    expect(captions.samples).toHaveLength(2);
    expect(notes.join(" ")).toContain("only 2 caption samples");
  });

  test("frame samples skip dropped frames and frames without a file, spread evenly", () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({
      id: `ev_f${i}`, sourceId: SRC, mediaS: i * 5, width: 640, height: 360, teaching: i % 4 === 3 ? "dropped" : "kept", file: i === 0 ? null : `/x/${i}.jpg`,
    }));
    const { frames: out } = sampleExport(bundle({ frames }), videoIdOf);
    expect(out.samples).toHaveLength(10);
    expect(out.samples.every((s) => s.teaching !== "dropped")).toBe(true);
    expect(out.samples.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const t = out.samples.map((s) => s.mediaS);
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(t.includes(0)).toBe(false);
  });
});

describe("probe-export on a data dir", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
  const VIDEO = "aaaaaaaaaaa";
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fabricate(): string {
    const dataDir = mkdtempSync(join(tmpdir(), "afterclass-probe-test-"));
    dirs.push(dataDir);
    const db = openDb(join(dataDir, "afterclass.sqlite"));
    const evidence = createEvidence(db, dataDir, {
      lookupFrameChange: () => ({ kind: "missing", key: stableId("key", "x") }),
      runFrameChange: async () => undefined,
      frameChangeKey: () => stableId("key", "x"),
      onChange: () => {},
    });
    const captureId = randomId("cap");
    let next = 0;
    const fact = (body: CaptureFactBody): CaptureFact => ({ captureId, clientSeq: next++, wallMs: 1000 + next, ...body }) as CaptureFact;
    const segments = Array.from({ length: 12 }, (_, i) => ({ start: media(i * 5), end: media(i * 5 + 5), text: `line ${i}` }));
    evidence.ingest({
      captureId,
      facts: [
        fact({ kind: "control", action: "start", reason: "user" }),
        fact({ kind: "source", videoId: VIDEO, title: "Lecture", channelName: "Prof", url: "https://www.youtube.com/watch?v=x", durationS: 600 }),
        fact({ kind: "transcript", videoId: VIDEO, origin: "panel", language: "en", autoGenerated: false, segments }),
        fact({ kind: "span", videoId: VIDEO, start: media(0), end: media(60), rate: 1, tabVisible: true, wallDurationMs: 60_000 }),
        fact({ kind: "frame", videoId: VIDEO, frameId: "f1", mediaS: media(10), width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: JPEG }),
        fact({ kind: "ad", videoId: VIDEO, atContentS: media(30), wallDurationMs: 15_000, signals: ["dom_class"] }),
        fact({ kind: "control", action: "stop", reason: "user" }),
      ],
    });
    db.close();
    return dataDir;
  }

  test("writes the bundle, samples and frame files, and leaves the real database untouched", () => {
    const dataDir = fabricate();
    const before = readFileSync(join(dataDir, "afterclass.sqlite"));
    const out = join(dataDir, "out");

    const done = exportCapture({ dataDir, outDir: out });

    expect(done.captions.samples).toHaveLength(10);
    expect(done.captions.samples[0]!.videoId).toBe(VIDEO);
    expect(done.frames.samples).toHaveLength(1);
    expect(existsSync(join(out, "frames", "0.jpg"))).toBe(true);
    expect(done.adCandidates.frames.map((f) => f.mediaS)).toEqual([10]);
    expect(done.adCandidates.passages).toHaveLength(4);
    expect(done.adCandidates.spans.map((s) => [s.start, s.end])).toEqual([[0, 60]]);
    expect(existsSync(join(out, "frames", "ad-0.jpg"))).toBe(true);
    const bundle = parseBundle(JSON.parse(readFileSync(join(out, "bundle.json"), "utf8")));
    expect(buildReport({ bundle, origin: "fixture" }).bars[0]!.verdict).toBe("PASS");
    expect(JSON.parse(readFileSync(join(out, "samples.json"), "utf8")).captureId).toBe(done.captureId);
    expect(readFileSync(join(dataDir, "afterclass.sqlite")).equals(before)).toBe(true);
  });

  test("an unknown capture id or an empty data dir is an error, not an empty export", () => {
    const dataDir = fabricate();
    expect(() => exportCapture({ dataDir, outDir: join(dataDir, "o"), captureId: "cap_nope" })).toThrow("no evidence");
    const empty = mkdtempSync(join(tmpdir(), "afterclass-probe-test-"));
    dirs.push(empty);
    expect(() => exportCapture({ dataDir: empty, outDir: join(empty, "o") })).toThrow("does not exist");
  });
});
