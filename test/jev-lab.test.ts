/**
 * Experiment 2's lab, offline. No test makes a Jev or Claude call: the fake client is scripted, and the one test that
 * drives the live path hands the real adapter a `fetch` stub, so no socket is ever opened.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { JevAnswer, JevClient, JevRequest } from "../src/backend/providers/jev";
import { toVerdict } from "../src/backend/providers/jev-tasks";
import { SEGMENTATION_DEFAULTS } from "../src/backend/segmentation";
import type { CaptureFact, CaptureFactBody } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, MemoKey } from "../src/shared/ids";
import { media } from "../src/shared/time";
import { LabRefusal, assertPhaseHalf, describeSplit, draftLabels, loadLabels, planLab, readState, reportFromFile, resolveTuning, runLab } from "../scripts/jev-lab";
import type { RunOptions } from "../scripts/jev-lab";
import {
  BUDGET_CALLS, DEFAULT_THRESHOLDS, buildReport, duplicateOutcomes, falseClosesPerWindow, halfOf, matchBoundaries, parseResults, percentile, splitPoint, stepOutcomes, validateLabels, verdictAt,
} from "../scripts/jev-lab-score";
import type { DuplicateGroup, FrameView, LabelFile, ParsedResults } from "../scripts/jev-lab-score";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `afterclass-lab-${name}-`));
  cleanup.push(dir);
  return dir;
};

// ───────────────────────────── scoring, hand-made data ─────────────────────────────

describe("matching boundaries (clause 1 and 2)", () => {
  test("exactly 60 s apart matches, on either side; a hair further does not", () => {
    expect(matchBoundaries([100], [160]).pairs).toEqual([[100, 160]]);
    expect(matchBoundaries([100], [40]).pairs).toEqual([[100, 40]]);
    expect(matchBoundaries([100], [160.001]).pairs).toEqual([]);
    expect(matchBoundaries([100], [39.999]).pairs).toEqual([]);
    expect(matchBoundaries([120.3], [180.3]).pairs).toHaveLength(1);
  });

  test("a close beside a matched label is a false close: one detection serves one label", () => {
    const m = matchBoundaries([100], [90, 110]);
    expect(m.pairs).toHaveLength(1);
    expect(m.falseCloses).toHaveLength(1);
  });

  test("a close far from every label is a false close, and its label is missed", () => {
    const m = matchBoundaries([100], [200]);
    expect(m.pairs).toEqual([]);
    expect(m.missedLabels).toEqual([100]);
    expect(m.falseCloses).toEqual([200]);
  });

  test("two labels and two nearby detections pair up in order", () => {
    const m = matchBoundaries([100, 150], [95, 155]);
    expect(m.pairs).toEqual([[100, 95], [150, 155]]);
    expect(m.falseCloses).toEqual([]);
  });

  test("no detections: every label is missed and nothing is false", () => {
    const m = matchBoundaries([10, 500], []);
    expect(m.missedLabels).toEqual([10, 500]);
    expect(m.falseCloses).toEqual([]);
  });
});

describe("false closes per 15 min", () => {
  test("arithmetic: 1 in exactly 900 s is exactly 1 per 15 min, which passes; 1 in 899 s fails", () => {
    expect(falseClosesPerWindow(1, 900)).toEqual({ rate: 1, pass: true });
    expect(falseClosesPerWindow(1, 899).pass).toBe(false);
    expect(falseClosesPerWindow(2, 1800)).toEqual({ rate: 1, pass: true });
    expect(falseClosesPerWindow(0, 60)).toEqual({ rate: 0, pass: true });
    expect(falseClosesPerWindow(1, 180).rate).toBe(5);
  });

  test("no watched time cannot be scored", () => {
    expect(falseClosesPerWindow(0, 0)).toEqual({ rate: null, pass: null });
  });
});

describe("percentile, verdicts, split", () => {
  test("nearest rank", () => {
    expect(percentile([50, 10, 30, 20, 40], 50)).toBe(30);
    expect(percentile([50, 10, 30, 20, 40], 95)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  test("verdictAt at the default thresholds is the product's toVerdict", () => {
    for (const p of [null, Number.NaN, 0, 0.1, 0.3, 0.30001, 0.5, 0.69999, 0.7, 0.9, 1]) expect(verdictAt(p, DEFAULT_THRESHOLDS)).toBe(toVerdict(p));
  });

  test("the split is the midpoint of the lecture span; a label at the midpoint is held out; outside the span is nowhere", () => {
    const span = { start: 0, end: 600 };
    expect(splitPoint(span)).toBe(300);
    expect(halfOf(0, span)).toBe("first");
    expect(halfOf(299.999, span)).toBe("first");
    expect(halfOf(300, span)).toBe("second");
    expect(halfOf(599.9, span)).toBe("second");
    expect(halfOf(600, span)).toBeNull();
    expect(halfOf(-1, span)).toBeNull();
    expect(splitPoint({ start: 100, end: 400 })).toBe(250);
  });
});

const frame = (id: string, mediaS: number, dropped: boolean): FrameView => ({ id, mediaS, dropped });

describe("important visual steps (clause 3)", () => {
  const range = { start: 0, end: 600 };
  test("lost when every candidate frame after it is dropped, or there is none; kept when one survives", () => {
    const frames = [frame("a", 10, true), frame("b", 20, true), frame("c", 100, false), frame("d", 105, true)];
    const out = stepOutcomes([10, 100, 400], frames, range);
    expect(out.map((o) => [o.mediaS, o.lost, o.reason])).toEqual([
      [10, true, "every candidate frame dropped"],
      [100, false, "kept"],
      [400, true, "no candidate frame"],
    ]);
  });

  test("the catch window is [s, s + 30): a frame exactly 30 s later does not carry the step", () => {
    expect(stepOutcomes([10], [frame("a", 40, false)], range)[0]!.lost).toBe(true);
    expect(stepOutcomes([10], [frame("a", 39.9, false)], range)[0]!.lost).toBe(false);
    expect(stepOutcomes([10], [frame("a", 10, false)], range)[0]!.lost).toBe(false);
  });

  test("a frame past the end of the scored half does not carry a step", () => {
    expect(stepOutcomes([290], [frame("a", 300, false)], { start: 0, end: 300 })[0]!.lost).toBe(true);
  });
});

describe("duplicates (clause 4)", () => {
  const range = { start: 0, end: 600 };
  const group = (...frames: { mediaS: number; frameId?: string }[]): DuplicateGroup => ({ note: "", confirmed: true, frames });

  test("the earliest member is the original; later members are duplicates, dropped or not", () => {
    const frames = [frame("a", 10, false), frame("b", 20, true), frame("c", 30, false)];
    const out = duplicateOutcomes([group({ mediaS: 20 }, { mediaS: 10 }, { mediaS: 30 })], frames, range);
    expect(out.map((o) => [o.mediaS, o.dropped])).toEqual([[20, true], [30, false]]);
  });

  test("a frame id resolves exactly; a media time resolves to the nearest frame within 2 s; further is unresolved and counts as not dropped", () => {
    const frames = [frame("a", 10, false), frame("b", 21.9, true), frame("c", 50, true)];
    expect(duplicateOutcomes([group({ mediaS: 10 }, { mediaS: 20 })], frames, range)[0]).toEqual({ mediaS: 20, dropped: true, resolved: true });
    expect(duplicateOutcomes([group({ mediaS: 10 }, { mediaS: 24 })], frames, range)[0]).toEqual({ mediaS: 24, dropped: false, resolved: false });
    expect(duplicateOutcomes([group({ mediaS: 10 }, { mediaS: 49, frameId: "c" })], frames, range)[0]).toEqual({ mediaS: 49, dropped: true, resolved: true });
  });

  test("only duplicates inside the scored half are scored", () => {
    const frames = [frame("a", 10, false), frame("b", 400, true)];
    expect(duplicateOutcomes([group({ mediaS: 10 }, { mediaS: 400 })], frames, { start: 0, end: 300 })).toEqual([]);
  });
});

// ───────────────────────────── label files ─────────────────────────────

const validLabels = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1, status: "draft", signedOffBy: null, signedOffAt: null,
  lecture: { captureId: "cap_x", videoId: "vid", spanS: { start: 0, end: 600 } },
  boundaries: [{ mediaS: 100, note: "topic", confirmed: false }],
  visualSteps: [{ mediaS: 200, note: "equation", confirmed: false }],
  duplicateGroups: [{ note: "same board", confirmed: false, frames: [{ mediaS: 300 }, { mediaS: 310, frameId: "ev_x" }] }],
  ...over,
});
const errorsOf = (x: unknown) => {
  const r = validateLabels(x);
  return r.ok ? [] : r.errors;
};

describe("label validation", () => {
  test("a well-formed draft and the shipped fixture example are valid", () => {
    expect(validateLabels(validLabels()).ok).toBe(true);
    const example = JSON.parse(readFileSync(join(import.meta.dir, "..", "docs", "experiments", "labels", "example-fixture.json"), "utf8")) as unknown;
    expect(errorsOf(example)).toEqual([]);
  });

  test("empty label lists are valid (and later NOT MEASURED)", () => {
    expect(validateLabels(validLabels({ boundaries: [], visualSteps: [], duplicateGroups: [] })).ok).toBe(true);
  });

  test("each error names its field", () => {
    expect(errorsOf(validLabels({ status: "done" }))[0]).toContain('status: expected "draft" or "signed_off"');
    expect(errorsOf(validLabels({ boundaries: [{ mediaS: -1, note: "", confirmed: false }] }))[0]).toContain("boundaries[0].mediaS");
    expect(errorsOf(validLabels({ boundaries: [{ mediaS: 600, note: "", confirmed: false }] }))[0]).toContain("outside the lecture span [0, 600)");
    expect(errorsOf(validLabels({ boundaries: [{ mediaS: 5, note: "", confirmed: "yes" }] }))[0]).toContain("boundaries[0].confirmed");
    expect(errorsOf(validLabels({ lecture: { captureId: "", videoId: "v", spanS: { start: 5, end: 5 } } })).join("\n")).toContain("lecture.captureId");
    expect(errorsOf(validLabels({ duplicateGroups: [{ note: "", confirmed: false, frames: [{ mediaS: 1 }] }] }))[0]).toContain("at least 2 frames");
    expect(errorsOf(validLabels({ schemaVersion: 3 }))[0]).toContain("schemaVersion: expected 1 or 2");
  });

  test("a misspelled field is an error, never silently dropped", () => {
    expect(errorsOf(validLabels({ boundries: [] })).join("\n")).toContain("labels.boundries: unknown field");
    expect(errorsOf(validLabels({ boundaries: [{ mediaS: 5, note: "", confirmed: true, time: 1 }] })).join("\n")).toContain("boundaries[0].time: unknown field");
  });

  test("signed_off needs a signer and date and refuses any unconfirmed item; a draft may not carry a signature", () => {
    const signed = { status: "signed_off", signedOffBy: "Derek", signedOffAt: "2026-11-05" };
    const confirmed = { boundaries: [{ mediaS: 100, note: "", confirmed: true }], visualSteps: [], duplicateGroups: [] };
    expect(errorsOf(validLabels({ ...signed, ...confirmed }))).toEqual([]);
    expect(errorsOf(validLabels({ ...signed, signedOffBy: "", ...confirmed })).join("\n")).toContain("signedOffBy");
    expect(errorsOf(validLabels({ ...signed, signedOffAt: "someday", ...confirmed })).join("\n")).toContain("signedOffAt");
    expect(errorsOf(validLabels({ ...signed }))).toHaveLength(3);
    expect(errorsOf(validLabels({ ...signed }))[0]).toContain("unconfirmed in a signed_off file");
    expect(errorsOf(validLabels({ signedOffBy: "Derek" })).join("\n")).toContain("a draft must have null");
  });
});

// ───────────────────────────── a fixture capture ─────────────────────────────

const VIDEO = "aaaaaaaaaaa";
/** A JPEG header the Jev adapter accepts (640x360). The last byte tells the scripted client which frame it is. */
const jpeg = (tag: number, pad = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x68, 0x02, 0x80, ...new Array<number>(8 + pad).fill(0), tag]);

type Seg = { start: number; end: number; text: string };
type Frm = { id: string; at: number; tag: number; pad?: number };

function makeCapture(opts: { segments: readonly Seg[]; frames: readonly Frm[]; spanEnd: number }): { dir: string; captureId: CaptureId } {
  const dir = tmp("capture");
  const db = openDb(join(dir, "afterclass.sqlite"));
  const keyOf = (input: { readonly after: { readonly frame: { readonly id: string } } }): MemoKey => stableId("key", "frame_change", "test", input.after.frame.id);
  const evidence = createEvidence(db, dir, { lookupFrameChange: (i) => ({ kind: "missing", key: keyOf(i) }), runFrameChange: async () => undefined, frameChangeKey: keyOf, onChange: () => {} });
  const captureId = randomId("cap");
  const bodies: CaptureFactBody[] = [
    { kind: "control", action: "start", reason: "user" },
    { kind: "source", videoId: VIDEO, title: "Fixture lecture", channelName: "Prof", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", durationS: opts.spanEnd },
    { kind: "transcript", videoId: VIDEO, origin: "panel", language: "en", autoGenerated: false, segments: opts.segments.map((s) => ({ start: media(s.start), end: media(s.end), text: s.text })) },
    { kind: "span", videoId: VIDEO, start: media(0), end: media(opts.spanEnd), rate: 1, tabVisible: true, wallDurationMs: opts.spanEnd * 1000 },
    ...opts.frames.map((f): CaptureFactBody => ({ kind: "frame", videoId: VIDEO, frameId: f.id, mediaS: media(f.at), width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: jpeg(f.tag, f.pad).toString("base64") })),
    { kind: "control", action: "stop", reason: "user" },
  ];
  evidence.ingest({ captureId, facts: bodies.map((b, i) => ({ captureId, clientSeq: i, wallMs: 1000 + i, ...b }) as CaptureFact) });
  db.close();
  return { dir, captureId };
}

/** 360 s of 10 s captions; a new topic starts at 120, 240 and 300. */
const lectureSegments = (): Seg[] =>
  Array.from({ length: 36 }, (_, k) => ({ start: k * 10, end: k * 10 + 10, text: [120, 240, 300].includes(k * 10) ? `NEWTOPIC at ${k * 10}` : `caption ${k * 10}` }));
const FRAMES: Frm[] = [
  { id: "f40", at: 40, tag: 5 }, { id: "f100", at: 100, tag: 6 }, { id: "f205", at: 205, tag: 1 }, { id: "f215", at: 215, tag: 2 }, { id: "f262", at: 262, tag: 3 }, { id: "f300", at: 300, tag: 4 },
];
/** p that the change adds teaching content, by the frame's tag. */
const FRAME_P: Record<number, number> = { 1: 0.05, 2: 0.05, 3: 0.9, 4: 0.5, 5: 0.9, 6: 0.9 };

type Scripted = JevClient & { readonly requests: JevRequest<string>[] };
function scripted(): Scripted {
  const requests: JevRequest<string>[] = [];
  return {
    requests,
    async ask<Q extends string>(req: JevRequest<Q>) {
      requests.push(req);
      const answers: Record<string, JevAnswer> = {};
      if ("new_concept" in req.questions) {
        const text = (req.state as { passage: { text: string }[] }).passage.map((p) => p.text).join(" ");
        const p = text.includes("NEWTOPIC") ? 0.95 : 0.1;
        answers.new_concept = { type: "noul", p };
        answers.stopping_point = { type: "noul", p };
      } else answers.teaching_change = { type: "noul", p: FRAME_P[req.images[1]!.bytes.at(-1)!] ?? 0.9 };
      return { answers: answers as Record<Q, JevAnswer>, usage: { model: req.model, inputTokens: 100, outputTokens: 5, cacheReadTokens: null, cost: { kind: "unknown", reason: "fake" } } };
    },
  };
}

function labelFile(dir: string, captureId: string, over: Partial<LabelFile> = {}, name = "labels.json"): string {
  const labels: LabelFile = {
    schemaVersion: 1, status: "signed_off", signedOffBy: "Derek (test fixture)", signedOffAt: "2026-11-05",
    lecture: { captureId, videoId: VIDEO, spanS: { start: 0, end: 360 } },
    boundaries: [{ mediaS: 120, note: "", confirmed: true }, { mediaS: 240, note: "", confirmed: true }],
    visualSteps: [95, 200, 260, 320].map((mediaS) => ({ mediaS, note: "", confirmed: true })),
    duplicateGroups: [
      { note: "", confirmed: true, frames: [{ mediaS: 205 }, { mediaS: 215 }] },
      { note: "", confirmed: true, frames: [{ mediaS: 262 }, { mediaS: 300 }] },
    ],
    ...over,
  };
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(labels, null, 2));
  return path;
}

function lab(over: { labels?: Partial<LabelFile> } = {}) {
  const { dir: dataDir, captureId } = makeCapture({ segments: lectureSegments(), frames: FRAMES, spanEnd: 360 });
  const labDir = tmp("lab");
  const labels = labelFile(tmp("labels"), captureId, over.labels);
  let t = 0;
  const base = (client: JevClient = scripted()): Omit<RunOptions, "phase"> => ({
    dataDir, labDir, labelFiles: [labels], live: false, client, now: () => (t += 5), retryDelayMs: () => 0, out: () => {},
  });
  return { dataDir, labDir, labels, captureId, base };
}

// ───────────────────────────── plan, split, draft ─────────────────────────────

describe("split and plan", () => {
  test("split prints the tune and held-out counts per half", () => {
    const { labels } = lab();
    const text = describeSplit(loadLabels([labels])).join("\n");
    expect(text).toContain("split at 180");
    expect(text).toContain("tune (first half, [0, 180)): 1 boundaries, 1 visual steps, 0 duplicates");
    expect(text).toContain("held-out (second half, [180, 360)): 1 boundaries, 3 visual steps, 2 duplicates");
  });

  test("plan counts the real windows and frame calls per half, and makes no call", () => {
    const { dataDir, labels } = lab();
    const plan = planLab({ dataDir, labelFiles: [labels] });
    expect(plan.tuneRoundCalls).toBe(6 + 1);
    expect(plan.scoreCalls).toBe(6 + 4);
    expect(plan.overBudget).toBe(false);
    expect(plan.lines.join("\n")).toContain("17 of 2400 budgeted: within budget");
  });
});

describe("draft-labels", () => {
  function pauseCapture() {
    const segments: Seg[] = [{ start: 0, end: 10, text: "a" }, { start: 10, end: 20, text: "b" }, { start: 24, end: 34, text: "after a 4 s pause" }, { start: 34, end: 44, text: "c" }, { start: 100, end: 110, text: "after 56 s" }, { start: 110, end: 120, text: "d" }];
    return makeCapture({ segments, frames: [{ id: "g1", at: 5, tag: 1 }, { id: "g2", at: 30, tag: 1 }, { id: "g3", at: 60, tag: 2, pad: 40 }], spanEnd: 120 });
  }

  test("writes a deterministic, unconfirmed, valid draft that says it is not truth", () => {
    const { dir, captureId } = pauseCapture();
    const out = join(tmp("draft"), "draft.json");
    const done = draftLabels({ dataDir: dir, captureId, outPath: out });
    const draft = JSON.parse(readFileSync(out, "utf8")) as LabelFile;
    expect(validateLabels(draft).ok).toBe(true);
    expect(draft.status).toBe("draft");
    expect(draft.signedOffBy).toBeNull();
    expect(draft.draftNote).toContain("not truth");
    expect(draft.lecture).toMatchObject({ captureId, videoId: VIDEO, spanS: { start: 0, end: 120 } });
    expect(draft.boundaries.map((b) => b.mediaS)).toEqual([24, 100]);
    expect(draft.boundaries.every((b) => !b.confirmed && b.cue !== undefined)).toBe(true);
    expect(draft.visualSteps.map((s) => s.mediaS)).toEqual([60]);
    expect(draft.duplicateGroups).toHaveLength(1);
    expect(draft.duplicateGroups[0]!.frames.map((f) => f.mediaS)).toEqual([5, 30]);
    expect(done.notes.join(" ")).toContain("all unconfirmed");

    const again = join(tmp("draft2"), "draft.json");
    draftLabels({ dataDir: dir, captureId, outPath: again });
    expect(readFileSync(again, "utf8")).toBe(readFileSync(out, "utf8"));
  });

  test("never overwrites an existing label file without --force", () => {
    const { dir, captureId } = pauseCapture();
    const out = join(tmp("draft"), "draft.json");
    writeFileSync(out, "Derek's work");
    expect(() => draftLabels({ dataDir: dir, captureId, outPath: out })).toThrow("not overwritten");
    expect(readFileSync(out, "utf8")).toBe("Derek's work");
    draftLabels({ dataDir: dir, captureId, outPath: out, force: true });
    expect(readFileSync(out, "utf8")).not.toBe("Derek's work");
  });

  test("a drafted file cannot be run as signed off: it is a draft until Derek says otherwise", () => {
    const { dir, captureId } = pauseCapture();
    const out = join(tmp("draft"), "draft.json");
    draftLabels({ dataDir: dir, captureId, outPath: out });
    const signed = { ...(JSON.parse(readFileSync(out, "utf8")) as LabelFile), status: "signed_off", signedOffBy: "x", signedOffAt: "2026-11-05" };
    expect(errorsOf(signed).join("\n")).toContain("unconfirmed in a signed_off file");
  });
});

// ───────────────────────────── a whole run, with known answers ─────────────────────────────

describe("run (fake client) and the report", () => {
  test("a tune round judges first halves only and reports them as not a result", async () => {
    const { base } = lab();
    const client = scripted();
    const run = await runLab({ ...base(client), phase: "tune" });
    expect(run.newCalls).toBe(7);
    const times = client.requests.filter((r) => "new_concept" in r.questions).map((r) => (r.state as { passage: { t: number }[] }).passage[0]!.t);
    expect(Math.max(...times)).toBeLessThan(180);
    expect(client.requests).toHaveLength(7);
    expect(run.report.text).toContain("[fixture] Scope: first halves (tuning round 1 of 3; not a result)");
    expect(run.report.text).toContain("Measured: 1/1 labeled boundaries detected within ±60s = 100%.");
    expect(run.report.text).toContain("OVERALL (tuning round, not a result): NOT PASSED (not measured: duplicates)");
    expect(readState(join(base().labDir, "fixture"))).toMatchObject({ tuneRounds: 1, callsUsed: 7 });
  });

  test("the scored run judges second halves only and reports each clause against its bar, every line tagged", async () => {
    const { base } = lab();
    await runLab({ ...base(), phase: "tune" });
    const client = scripted();
    const run = await runLab({ ...base(client), phase: "score" });
    expect(run.newCalls).toBe(10);
    const times = client.requests.filter((r) => "new_concept" in r.questions).map((r) => (r.state as { passage: { t: number }[] }).passage[0]!.t);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(180);

    const text = run.report.text;
    expect(text).toContain("Boundary recall: PASS");
    expect(text).toContain('Bar: "≥70% of labeled boundaries detected within ±60s"');
    expect(text).toContain("Measured: 1/1 labeled boundaries detected within ±60s = 100%.");
    expect(text).toContain("False closes: FAIL");
    expect(text).toContain('Bar: "≤1 false close per 15 min"');
    expect(text).toContain("Measured: 1 false close(s) in 180 s watched = 5 per 15 min.");
    expect(text).toContain("false at 300s");
    expect(text).toContain("Visual steps: FAIL");
    expect(text).toContain("200s every candidate frame dropped; 320s no candidate frame");
    expect(text).toContain("Duplicates: PASS");
    expect(text).toContain("Measured: 1/2 labeled duplicates dropped = 50%.");
    expect(text).toContain("calls 10 (boundary 6, frame change 4, failed 0); judgments reused from earlier calls 0");
    expect(text).toContain("input tokens 1000 (0 call(s) without a count), output tokens 50");
    expect(text).toContain("cost unknown");
    expect(text).toContain("all calls p50 5 ms, p95 5 ms (n=10)");
    expect(text).toContain("OVERALL: FAIL (failed: false closes, visual steps)");
    expect(run.report.exitCode).toBe(1);
    for (const line of text.split("\n")) if (line !== "") expect(line.startsWith("[fixture] ")).toBe(true);
  });

  test("a clause with nothing labeled is NOT MEASURED, and the overall line is never PASS on silence", async () => {
    const { base } = lab({ labels: { boundaries: [], visualSteps: [], duplicateGroups: [] } });
    await runLab({ ...base(), phase: "tune" });
    const run = await runLab({ ...base(), phase: "score" });
    expect(run.report.bars.map((b) => b.verdict)).toEqual(["NOT MEASURED", "NOT MEASURED", "NOT MEASURED", "NOT MEASURED"]);
    expect(run.report.text).toContain("OVERALL: NOT PASSED (not measured: recall, false closes, visual steps, duplicates)");
  });

  test("rescore from the stored file alone reproduces the report byte for byte, with no client", async () => {
    const { base, labels } = lab();
    await runLab({ ...base(), phase: "tune" });
    const run = await runLab({ ...base(), phase: "score" });
    const again = reportFromFile(run.resultsPath, [labels]);
    expect(again.text).toBe(readFileSync(run.reportPath, "utf8"));
    expect(again.text).toBe(run.report.text);
    expect(parseResults(readFileSync(run.resultsPath, "utf8")).judgments).toHaveLength(10);
  });

  test("rescore refuses labels that changed since the run, and a file with no end record", async () => {
    const { base, labels } = lab();
    const run = await runLab({ ...base(), phase: "tune" });
    writeFileSync(labels, readFileSync(labels, "utf8").replace("equation", "x").replace('"mediaS": 120', '"mediaS": 121'));
    expect(() => reportFromFile(run.resultsPath, [labels])).toThrow("has changed since the run");
    const lines = readFileSync(run.resultsPath, "utf8").trimEnd().split("\n");
    writeFileSync(run.resultsPath, lines.slice(0, -1).join("\n") + "\n");
    expect(() => parseResults(readFileSync(run.resultsPath, "utf8"))).toThrow("did not complete");
  });

  test("every judgment is stored with its input hash, model, timing, raw p and tokens", async () => {
    const { base } = lab();
    const run = await runLab({ ...base(), phase: "tune" });
    const j = parseResults(readFileSync(run.resultsPath, "utf8")).judgments;
    expect(j).toHaveLength(7);
    expect(j[0]).toMatchObject({ purpose: "boundary", model: "jev-1.13.0", reused: false, error: null });
    expect(j[0]!.key).toMatch(/^key_/);
    expect(j[0]!.p).toHaveProperty("new_concept");
    expect(j[0]!.calls[0]).toMatchObject({ durationMs: 5, inputTokens: 100, outputTokens: 5, ok: true });
    expect(j.at(-1)).toMatchObject({ purpose: "frame_change" });
  });

  test("a second tune round reuses stored judgments for identical inputs: counted as a round, not as calls", async () => {
    const { base, labDir } = lab();
    await runLab({ ...base(), phase: "tune" });
    const client = scripted();
    const run = await runLab({ ...base(client), phase: "tune", overrides: { yesAtOrAbove: 0.9 } });
    expect(client.requests).toHaveLength(0);
    expect(run.report.text).toContain("tuning round 2 of 3");
    expect(run.report.text).toContain("judgments reused from earlier calls 7");
    expect(readState(join(labDir, "fixture"))).toMatchObject({ tuneRounds: 2, callsUsed: 7 });
  });

  test("it never writes the data dir", async () => {
    const { base, dataDir } = lab();
    const before = new Bun.CryptoHasher("sha256").update(readFileSync(join(dataDir, "afterclass.sqlite"))).digest("hex");
    const listing = readdirSync(dataDir).sort();
    await runLab({ ...base(), phase: "tune" });
    expect(new Bun.CryptoHasher("sha256").update(readFileSync(join(dataDir, "afterclass.sqlite"))).digest("hex")).toBe(before);
    expect(readdirSync(dataDir).sort()).toEqual(listing);
  });
});

describe("tuning knobs", () => {
  test("only the named knobs may change", () => {
    expect(resolveTuning({ windowNewS: 45 }).config).toEqual({ ...SEGMENTATION_DEFAULTS, windowNewS: 45 });
    expect(resolveTuning({ yesAtOrAbove: 0.8 }).thresholds).toEqual({ yesAtOrAbove: 0.8, noAtOrBelow: 0.3 });
    expect(() => resolveTuning({ model: "jev-latest" } as never)).toThrow("not a tuning knob");
    expect(() => resolveTuning({ noAtOrBelow: 0.9 })).toThrow("thresholds out of range");
    expect(() => resolveTuning({ timeCapS: 10 })).toThrow("out of range");
  });
});

// ───────────────────────────── safety rails ─────────────────────────────

const SECRET = "tsk-FAKE-SECRET-4f1c9e7a";

function keysFile(mode = 0o600, body = `TYPESAFE_API_KEY=${SECRET}\n`): string {
  const path = join(tmp("keys"), "keys.env");
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

/** A stand-in for the network: answers like Jev, counts calls, and can be told to fail. */
function stubFetch(opts: { fail?: "503" | "leak" } = {}) {
  const seen: { auth: string | null; questions: string[] }[] = [];
  const fn = (async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    seen.push({ auth: headers.Authorization ?? null, questions: Object.keys(body.questions) });
    if (opts.fail === "leak") throw new Error(`connection reset while sending ${headers.Authorization}`);
    if (opts.fail === "503") return new Response(JSON.stringify({ message: `overloaded for ${headers.Authorization}` }), { status: 503 });
    const answers = Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: "noul", noul: q === "teaching_change" ? 0.9 : 0.1 }]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe("safety rails", () => {
  const live = (o: ReturnType<typeof lab>, over: Partial<RunOptions> = {}): RunOptions => ({ ...o.base(), live: true, maxCalls: 50, keysPath: keysFile(), fetch: stubFetch().fn, ...over, phase: "tune" });
  const noCalls = (f: ReturnType<typeof stubFetch>) => expect(f.seen).toHaveLength(0);

  test("without --live the real adapter is never built: a fetch stub is never reached", async () => {
    const o = lab();
    const f = stubFetch();
    const run = await runLab({ ...o.base(), phase: "tune", fetch: f.fn, keysPath: keysFile(), maxCalls: 50 });
    noCalls(f);
    expect(run.report.text.startsWith("[fixture]")).toBe(true);
    expect(existsSync(join(o.labDir, "live"))).toBe(false);
  });

  test("--live without --max-calls refuses before any call", async () => {
    const o = lab();
    const f = stubFetch();
    await expect(runLab({ ...live(o, { fetch: f.fn }), maxCalls: undefined as never })).rejects.toThrow("needs --max-calls");
    noCalls(f);
  });

  test("--max-calls above the budget, or below one, refuses", async () => {
    const o = lab();
    const f = stubFetch();
    await expect(runLab(live(o, { fetch: f.fn, maxCalls: BUDGET_CALLS + 1 }))).rejects.toThrow("--max-calls must be an integer from 1 to 2400");
    await expect(runLab(live(o, { fetch: f.fn, maxCalls: 0 }))).rejects.toThrow("--max-calls must be");
    noCalls(f);
  });

  test("--live with a missing, group-readable or keyless keys file refuses, and the message holds no key", async () => {
    const o = lab();
    const f = stubFetch();
    const messages: string[] = [];
    for (const keysPath of [join(tmp("nokeys"), "keys.env"), keysFile(0o644), keysFile(0o600, "OTHER=1\n")]) {
      const err = await runLab(live(o, { fetch: f.fn, keysPath })).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(LabRefusal);
      messages.push((err as Error).message);
    }
    expect(messages[0]).toContain("no keys file");
    expect(messages[1]).toContain("not 0600");
    expect(messages[2]).toContain("has no TYPESAFE_API_KEY");
    expect(messages.join("\n")).not.toContain(SECRET);
    noCalls(f);
  });

  test("--live with labels that are not signed_off refuses; so does any scored run", async () => {
    const o = lab({ labels: { status: "draft", signedOffBy: null, signedOffAt: null, boundaries: [{ mediaS: 120, note: "", confirmed: false }] } });
    const f = stubFetch();
    await expect(runLab(live(o, { fetch: f.fn }))).rejects.toThrow("needs signed_off labels");
    await runLab({ ...o.base(), phase: "tune" });
    await expect(runLab({ ...o.base(), phase: "score" })).rejects.toThrow("needs signed_off labels");
    noCalls(f);
  });

  test("a live run that needs more calls than --max-calls refuses before the first call", async () => {
    const o = lab();
    const f = stubFetch();
    await expect(runLab(live(o, { fetch: f.fn, maxCalls: 6 }))).rejects.toThrow("needs 7 new calls and --max-calls is 6; no call was made");
    noCalls(f);
  });

  test("the persisted counter refuses a run that would cross 2400, before any call", async () => {
    const o = lab();
    mkdirSync(join(o.labDir, "live"), { recursive: true });
    writeFileSync(join(o.labDir, "live", "state.json"), JSON.stringify({ version: 1, callsUsed: 2395, tuneRounds: 0, lastTune: null, scoreStatus: "none" }));
    const f = stubFetch();
    await expect(runLab(live(o, { fetch: f.fn }))).rejects.toThrow("2395 of 2400 are used; no call was made");
    noCalls(f);
  });

  test("the call that would cross the cap is never made, even through retries", async () => {
    const o = lab();
    mkdirSync(join(o.labDir, "live"), { recursive: true });
    writeFileSync(join(o.labDir, "live", "state.json"), JSON.stringify({ version: 1, callsUsed: 2393, tuneRounds: 0, lastTune: null, scoreStatus: "none" }));
    const f = stubFetch({ fail: "503" });
    await expect(runLab(live(o, { fetch: f.fn, maxCalls: 100 }))).rejects.toThrow("budget is spent");
    expect(f.seen).toHaveLength(7);
    expect(readState(join(o.labDir, "live")).callsUsed).toBe(BUDGET_CALLS);
  });

  test("--max-calls is a hard stop inside the run too", async () => {
    const o = lab();
    const f = stubFetch({ fail: "503" });
    await expect(runLab(live(o, { fetch: f.fn, maxCalls: 7 }))).rejects.toThrow("--max-calls 7 reached");
    expect(f.seen).toHaveLength(7);
  });

  test("a fourth tune round refuses", async () => {
    const o = lab();
    for (let i = 0; i < 3; i++) await runLab({ ...o.base(), phase: "tune" });
    await expect(runLab({ ...o.base(), phase: "tune" })).rejects.toThrow("3 tuning rounds are already used");
    expect(readState(join(o.labDir, "fixture")).tuneRounds).toBe(3);
  });

  test("the held-out half is scored once: a second score run refuses and points at rescore", async () => {
    const o = lab();
    await runLab({ ...o.base(), phase: "tune" });
    await runLab({ ...o.base(), phase: "score" });
    const client = scripted();
    await expect(runLab({ ...o.base(client), phase: "score" })).rejects.toThrow("already scored once");
    await expect(runLab({ ...o.base(client), phase: "score" })).rejects.toThrow("rescore");
    expect(client.requests).toHaveLength(0);
  });

  test("a score run needs a tune round first, and takes no tuning flags", async () => {
    const o = lab();
    await expect(runLab({ ...o.base(), phase: "score" })).rejects.toThrow("no tune round has run yet");
    await runLab({ ...o.base(), phase: "tune" });
    await expect(runLab({ ...o.base(), phase: "score", overrides: { windowNewS: 20 } })).rejects.toThrow("takes no tuning flags");
  });

  test("a run that dies before it finishes may be re-run, and is not a result until it has an end", async () => {
    const o = lab();
    await runLab({ ...o.base(), phase: "tune" });
    const failing: JevClient = { ask: () => Promise.reject(new LabRefusal("simulated stop")) };
    await expect(runLab({ ...o.base(failing), phase: "score" })).rejects.toThrow("simulated stop");
    expect(readState(join(o.labDir, "fixture")).scoreStatus).toBe("in_progress");
    const run = await runLab({ ...o.base(), phase: "score" });
    expect(readState(join(o.labDir, "fixture")).scoreStatus).toBe("complete");
    expect(run.report.text).toContain("held-out second halves");
  });

  test("tune work may hold only first-half items and score work only second-half items", () => {
    expect(() => assertPhaseHalf("tune", [{ half: "first" }, { half: "second" }])).toThrow("a tune run may only use first halves");
    expect(() => assertPhaseHalf("score", [{ half: "second" }, { half: "first" }])).toThrow("a score run may only use second halves");
    expect(() => assertPhaseHalf("tune", [{ half: "first" }])).not.toThrow();
    expect(() => assertPhaseHalf("score", [])).not.toThrow();
  });

  test("a complete live run (fetch stub) works, is tagged [live], sends the key only as the bearer header, and prints it nowhere", async () => {
    const o = lab();
    const f = stubFetch();
    const lines: string[] = [];
    const run = await runLab(live(o, { fetch: f.fn, out: (l) => lines.push(l) }));
    expect(f.seen).toHaveLength(7);
    expect(f.seen.every((s) => s.auth === `Bearer ${SECRET}`)).toBe(true);
    expect(run.report.text.startsWith("[live]")).toBe(true);
    expect(run.report.text).toContain("[live] Data origin: live");
    const everything = [...lines, ...walk(o.labDir).map((p) => readFileSync(p, "utf8"))].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(readState(join(o.labDir, "live"))).toMatchObject({ callsUsed: 7, tuneRounds: 1 });
  });

  test("a transport error that echoes the key is redacted from the thrown text and from everything stored", async () => {
    const o = lab();
    const f = stubFetch({ fail: "leak" });
    const lines: string[] = [];
    const err = await runLab(live(o, { fetch: f.fn, out: (l) => lines.push(l), maxCalls: 100 })).catch((e: unknown) => e as Error);
    expect(f.seen.length).toBeGreaterThan(0);
    expect(String((err as Error).message)).toContain("[redacted]");
    const stored = walk(o.labDir).map((p) => readFileSync(p, "utf8")).join("\n");
    expect([stored, ...lines, String((err as Error).message)].join("\n")).not.toContain(SECRET);

    const o2 = lab();
    const f2 = stubFetch({ fail: "503" });
    const err2 = await runLab(live(o2, { fetch: f2.fn, maxCalls: 7 })).catch((e: unknown) => e as Error);
    expect(String((err2 as Error).message)).not.toContain(SECRET);
    expect(walk(o2.labDir).map((p) => readFileSync(p, "utf8")).join("\n")).not.toContain(SECRET);
  });
});

describe("failed calls and a deleted or damaged state file (an irreversible run must not be burned)", () => {
  const down: JevClient = { ask: () => Promise.reject(new Error("network down")) };
  const firstCallFails = (): JevClient => {
    const inner = scripted();
    let n = 0;
    return { ask: (req, signal) => (n++ === 0 ? Promise.reject(new Error("one blip")) : inner.ask(req, signal)) };
  };

  test("a tune run whose Jev calls fail writes no result and uses up no tuning round", async () => {
    const o = lab();
    const dir = join(o.labDir, "fixture");
    await expect(runLab({ ...o.base(down), phase: "tune" })).rejects.toThrow("judgments failed");
    expect(readState(dir).tuneRounds).toBe(0);
    expect(existsSync(join(dir, "runs"))).toBe(false);
    const run = await runLab({ ...o.base(), phase: "tune" });
    expect(readState(dir).tuneRounds).toBe(1);
    expect(run.resultsPath).toContain("tune-1");
  });

  test("a scored run whose Jev calls fail does not burn the held-out half; the retry redoes only the failures", async () => {
    const o = lab();
    const dir = join(o.labDir, "fixture");
    await runLab({ ...o.base(), phase: "tune" });
    await expect(runLab({ ...o.base(down), phase: "score" })).rejects.toThrow("nothing was scored");
    expect(readState(dir).scoreStatus).toBe("in_progress");
    expect(existsSync(join(dir, "runs", "score-1.jsonl"))).toBe(false);

    await expect(runLab({ ...o.base(firstCallFails()), phase: "score" })).rejects.toThrow("1 of");
    const retry = await runLab({ ...o.base(), phase: "score" });
    expect(retry.newCalls).toBe(1);
    expect(readState(dir).scoreStatus).toBe("complete");
    expect(retry.report.text).toContain("held-out second halves");
  });

  test("deleting state.json does not reopen a scored half or a used-up tuning budget", async () => {
    const o = lab();
    const dir = join(o.labDir, "fixture");
    await runLab({ ...o.base(), phase: "tune" });
    await runLab({ ...o.base(), phase: "score" });
    rmSync(join(dir, "state.json"));
    await expect(runLab({ ...o.base(), phase: "score" })).rejects.toThrow("already scored once");
    await expect(runLab({ ...o.base(), phase: "tune" })).rejects.toThrow("tuning after seeing it");

    const p = lab();
    const pdir = join(p.labDir, "fixture");
    for (let i = 0; i < 3; i++) await runLab({ ...p.base(), phase: "tune" });
    rmSync(join(pdir, "state.json"));
    await expect(runLab({ ...p.base(), phase: "tune" })).rejects.toThrow("no fourth");
  });

  test("a malformed or unreadable state.json is refused, never read as zero", async () => {
    const o = lab();
    const dir = join(o.labDir, "fixture");
    mkdirSync(dir, { recursive: true });
    for (const body of ["{}", '{"version":1,"callsUsed":"7"}', "not json", '{"version":1,"callsUsed":-1,"tuneRounds":0,"lastTune":null,"scoreStatus":"none"}']) {
      writeFileSync(join(dir, "state.json"), body);
      await expect(runLab({ ...o.base(), phase: "tune" })).rejects.toThrow(/malformed|not valid JSON/);
    }
  });

  test("tuning after the held-out half was scored is refused", async () => {
    const o = lab();
    await runLab({ ...o.base(), phase: "tune" });
    await runLab({ ...o.base(), phase: "score" });
    await expect(runLab({ ...o.base(), phase: "tune" })).rejects.toThrow("tuning after seeing it");
  });
});

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => join(dir, p)).filter((p) => existsSync(p) && !readdirSafe(p));
}
function readdirSafe(p: string): boolean {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}

describe("buildReport on hand-made stored judgments", () => {
  test("a results file with no lectures is NOT MEASURED across the board", () => {
    const results: ParsedResults = {
      header: { t: "header", version: 1, runId: "score-1", phase: "score", round: 1, origin: "fixture", model: "m", config: SEGMENTATION_DEFAULTS, thresholds: DEFAULT_THRESHOLDS },
      lectures: [], judgments: [], end: { t: "end", newCalls: 0, judgments: 0 },
    };
    const report = buildReport({ results, labels: [] });
    expect(report.overall).toBe("NOT PASSED");
    expect(report.exitCode).toBe(1);
    expect(report.text).toContain("Latency");
  });
});
