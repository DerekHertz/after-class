import { describe, expect, test } from "bun:test";
import type { BoundaryJudgment, BoundaryWindow, CaptureStatus, ChunkProvenance, Frame, Passage, Route, Seq, Verdict } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, SourceId, WindowId } from "../src/shared/ids";
import { Material, interval, media } from "../src/shared/time";
import { asSeq } from "../src/backend/db";
import type { WatchOrder } from "../src/backend/evidence";
import { createMemo } from "../src/backend/providers/memo";
import type { Lookup } from "../src/backend/providers/memo";
import { buildWindows, planChunks, reconcile, route } from "../src/backend/segmentation/core";
import { SEGMENTATION_DEFAULTS, createSegmentation } from "../src/backend/segmentation";
import type { RoutingOptions } from "../src/backend/segmentation/core";
import { PRODUCT_JEV_SETUP } from "../src/backend/jev-setup";
import type { SegmentationConfig } from "../src/backend/segmentation";
import { fakeTask, ok, testDb } from "./fakes";

/** 30 s windows are three 10 s passages; the cap is five windows so cap tests stay short. */
const CFG: SegmentationConfig = { windowNewS: 30, contextS: 60, timeCapS: 150, maxFramesPerWindow: 2, reviseOnNextNoNo: true };
const SRC_A = stableId("src", "youtube", "lectureA");
const SRC_B = stableId("src", "youtube", "lectureB");
const CAP = randomId("cap");

function passage(source: SourceId, start: number, end: number): Passage {
  return {
    kind: "passage", id: stableId("ev", source, start, end), sourceId: source, transcriptRevId: stableId("trv", source),
    interval: interval(start, end), text: `caption ${start}`, origin: "panel",
  } as unknown as Passage;
}

function frame(source: SourceId, mediaS: number): Frame {
  return { kind: "frame", id: stableId("ev", "frame", source, mediaS), sourceId: source, mediaS: media(mediaS), width: 1280, height: 720, teaching: "unjudged" } as unknown as Frame;
}

/** Back-to-back 10 s caption passages covering [from, to) of one source. */
function lecture(source: SourceId, from: number, to: number): Passage[] {
  return Array.from({ length: (to - from) / 10 }, (_, k) => passage(source, from + k * 10, from + k * 10 + 10));
}

function watchOrder(passages: readonly Passage[], opts: { stopped?: boolean; frames?: readonly Frame[] } = {}): WatchOrder {
  const status: CaptureStatus = opts.stopped ? { state: "stopped" } : { state: "capturing" };
  return {
    passages: passages.map((p, k) => ({ passage: p, firstWatchedAtSeq: asSeq(k + 1), sourceIndex: p.sourceId === SRC_A ? 0 : 1 })),
    frameCandidates: opts.frames ?? [],
    status,
    stoppedAtSeq: opts.stopped ? asSeq(passages.length + 1) : null,
    watchedSeconds: passages.length * 10,
  };
}

type Script = "pending" | "failed" | `${Verdict}/${Verdict}`;

function judgmentOf(w: BoundaryWindow, s: Script): BoundaryJudgment | "pending" | "failed" {
  if (s === "pending" || s === "failed") return s;
  const [newConcept, stoppingPoint] = s.split("/") as [Verdict, Verdict];
  return { windowId: w.id, newConcept, stoppingPoint, pNewConcept: null, pStoppingPoint: null, questionVersion: "v1" };
}

/** Plans `script[k]` as the judgment of window k of one lecture of `script.length` windows. */
function plan(script: readonly Script[], opts: { stopped?: boolean; cfg?: SegmentationConfig; passages?: readonly Passage[] } = {}) {
  const cfg = opts.cfg ?? CFG;
  const order = watchOrder(opts.passages ?? lecture(SRC_A, 0, script.length * 30), { stopped: true });
  const windows = buildWindows(CAP, order, cfg);
  const result = planChunks(windows, (w) => judgmentOf(w, script[w.ordinal] ?? "pending"), opts.stopped ?? false, cfg);
  const ordinalOf = new Map(windows.map((w) => [w.id, w.ordinal]));
  const ords = (ids: readonly WindowId[]) => ids.map((id) => ordinalOf.get(id)!);
  return {
    windows,
    result,
    closed: result.closed.map((c): [number[], ChunkProvenance] => [ords(c.windows), c.provenance]),
    open: result.open ? ords(result.open.windows) : null,
    blockedOn: result.blockedOn === null ? null : ordinalOf.get(result.blockedOn)!,
  };
}

describe("flow B routing table", () => {
  const rows: [Verdict, Verdict, Route][] = [
    ["yes", "yes", "close"],
    ["no", "yes", "soft_pause"],
    ["yes", "no", "flag_recheck"],
    ["no", "no", "continue"],
    ["uncertain", "uncertain", "continue"],
    ["yes", "uncertain", "continue"],
    ["uncertain", "yes", "continue"],
    ["no", "uncertain", "continue"],
    ["uncertain", "no", "continue"],
  ];
  test.each(rows)("new concept %s, stopping point %s routes to %s", (newConcept, stoppingPoint, expected) => {
    expect(route(newConcept, stoppingPoint)).toBe(expected);
  });

  test("the starting values are the flow B numbers", () => {
    expect(SEGMENTATION_DEFAULTS).toEqual({ windowNewS: 30, contextS: 120, timeCapS: 480, maxFramesPerWindow: 2, reviseOnNextNoNo: false });
  });
});

describe("windows", () => {
  test("every ~30 s of newly watched captions is a window; a trailing partial waits for the stop", () => {
    const passages = lecture(SRC_A, 0, 100);
    const running = buildWindows(CAP, watchOrder(passages), CFG);
    expect(running.map((w) => w.newPassages.length)).toEqual([3, 3, 3]);
    expect(running.map((w) => w.watchedSecondsAtEnd)).toEqual([30, 60, 90]);
    const stopped = buildWindows(CAP, watchOrder(passages, { stopped: true }), CFG);
    expect(stopped.map((w) => w.newPassages.length)).toEqual([3, 3, 3, 1]);
    expect(stopped.map((w) => w.ordinal)).toEqual([0, 1, 2, 3]);
  });

  test("context is the preceding watched passages up to the context length, oldest first", () => {
    const passages = lecture(SRC_A, 0, 150);
    const windows = buildWindows(CAP, watchOrder(passages), CFG);
    expect(windows[0]!.contextPassages).toEqual([]);
    expect(windows[1]!.contextPassages).toEqual(passages.slice(0, 3).map((p) => p.id));
    expect(windows[4]!.contextPassages).toEqual(passages.slice(6, 12).map((p) => p.id));
  });

  test("context and windows follow watch order across videos", () => {
    const passages = [...lecture(SRC_A, 0, 60), ...lecture(SRC_B, 0, 60)];
    const windows = buildWindows(CAP, watchOrder(passages), CFG);
    expect(windows).toHaveLength(4);
    expect(windows[2]!.contextPassages).toEqual(passages.slice(0, 6).map((p) => p.id));
    expect(Material.sources(windows[2]!.newMaterial)).toEqual([SRC_B]);
  });

  test("frames are up to two candidates inside the new material, latest first, each in one window only", () => {
    const frames = [frame(SRC_A, 5), frame(SRC_A, 12), frame(SRC_A, 25), frame(SRC_A, 40), frame(SRC_B, 45)];
    const windows = buildWindows(CAP, watchOrder(lecture(SRC_A, 0, 60), { frames }), CFG);
    expect(windows[0]!.frames).toEqual([frames[2]!.id, frames[1]!.id]);
    expect(windows[1]!.frames).toEqual([frames[3]!.id]);
  });

  test("identical material in another session is the same window, and a rewatch adds no window", () => {
    const passages = lecture(SRC_A, 0, 90);
    const first = buildWindows(CAP, watchOrder(passages), CFG);
    const otherSession = buildWindows(randomId("cap"), watchOrder(passages), CFG);
    expect(otherSession.map((w) => w.id)).toEqual(first.map((w) => w.id));
    const afterRewatch = buildWindows(CAP, watchOrder(passages), CFG);
    expect(afterRewatch.map((w) => w.id)).toEqual(first.map((w) => w.id));
    const grown = buildWindows(CAP, watchOrder([...passages, ...lecture(SRC_A, 90, 120)]), CFG);
    expect(grown.map((w) => w.id).slice(0, 3)).toEqual(first.map((w) => w.id));
    expect(grown).toHaveLength(4);
  });
});

describe("chunk plan", () => {
  test("no/no continues collecting", () => {
    const p = plan(["no/no", "no/no", "no/no"]);
    expect(p.closed).toEqual([]);
    expect(p.open).toEqual([0, 1, 2]);
  });

  test("yes/yes closes the chunk before the window that begins the new concept", () => {
    const p = plan(["no/no", "no/no", "yes/yes", "no/yes"]);
    expect(p.closed).toEqual([[[0, 1], "boundary"]]);
    expect(p.open).toEqual([2, 3]);
  });

  test("a first window judged yes/yes has nothing to close", () => {
    const p = plan(["yes/yes", "no/yes"]);
    expect(p.closed).toEqual([]);
    expect(p.open).toEqual([0, 1]);
  });

  test("no/yes is a soft pause: the chunk stays open", () => {
    const p = plan(["no/no", "no/yes", "no/no"]);
    expect(p.closed).toEqual([]);
    expect(p.open).toEqual([0, 1, 2]);
  });

  test("yes/no does not close; the next window's yes/yes cuts back to the flagged window", () => {
    const p = plan(["no/no", "no/no", "yes/no", "yes/yes"]);
    expect(p.closed).toEqual([[[0, 1], "boundary"]]);
    expect(p.open).toEqual([2, 3]);
  });

  test("a later window that sees no new concept drops the flag, so the close takes everything before the closing window", () => {
    expect(plan(["no/no", "yes/no", "no/no", "yes/yes"]).closed).toEqual([[[0, 1, 2], "boundary"]]);
    expect(plan(["no/no", "yes/no", "no/yes", "yes/yes"]).closed).toEqual([[[0, 1, 2], "boundary"]]);
  });

  test("a flag at the very start of the chunk cuts nothing back", () => {
    const p = plan(["yes/no", "yes/yes"]);
    expect(p.closed).toEqual([[[0], "boundary"]]);
    expect(p.open).toEqual([1]);
  });

  test("an uncertain or failed judgment is treated as continue, never as a close or a flag", () => {
    for (const s of ["failed", "uncertain/uncertain", "yes/uncertain", "uncertain/yes"] as const) {
      const p = plan(["no/no", s, "no/no"]);
      expect(p.closed).toEqual([]);
      expect(p.open).toEqual([0, 1, 2]);
    }
  });

  test("a pending judgment stops the fold; later windows wait", () => {
    const p = plan(["no/no", "yes/yes", "pending", "yes/yes"]);
    expect(p.blockedOn).toBe(2);
    expect(p.closed).toEqual([[[0], "boundary"]]);
    expect(p.open).toEqual([1]);
  });
});

describe("watch order with repeats", () => {
  test("a passage listed twice yields no extra window", () => {
    const ps = lecture(SRC_A, 0, 90);
    const once = buildWindows(CAP, watchOrder(ps), CFG).map((w) => w.id);
    const twice = buildWindows(CAP, watchOrder([...ps, ...ps]), CFG).map((w) => w.id);
    expect(twice).toEqual(once);
  });
});

describe("boundary revision", () => {
  test("is off by default: a no/no after a close stays in the new chunk", () => {
    const p = plan(["no/no", "yes/yes", "no/no"], { cfg: { ...CFG, reviseOnNextNoNo: false } });
    expect(p.closed).toEqual([[[0], "boundary"]]);
    expect(p.open).toEqual([1, 2]);
  });

  test("a no/no first window after a boundary close moves that boundary forward through that window, once per boundary", () => {
    const p = plan(["no/no", "no/no", "yes/yes", "no/no", "no/no", "yes/yes", "no/no"], { stopped: true });
    expect(p.closed[0]).toEqual([[0, 1, 2, 3], "boundary_revised"]);
    expect(p.closed[1]).toEqual([[4, 5, 6], "boundary_revised"]);
    expect(p.open).toBeNull();
  });

  test("only the first window after the close can revise it", () => {
    const p = plan(["no/no", "yes/yes", "no/yes", "no/no"]);
    expect(p.closed).toEqual([[[0], "boundary"]]);
    expect(p.open).toEqual([1, 2, 3]);
  });

  test("a first window after the close that is not no/no leaves the boundary alone", () => {
    for (const s of ["no/yes", "yes/no", "uncertain/uncertain", "failed"] as const) {
      expect(plan(["no/no", "yes/yes", s]).closed).toEqual([[[0], "boundary"]]);
    }
  });

  test("a close that cut back to a flag is not reconsidered", () => {
    const p = plan(["no/no", "yes/no", "yes/yes", "no/no"]);
    expect(p.closed).toEqual([[[0], "boundary"]]);
    expect(p.open).toEqual([1, 2, 3]);
  });
});

describe("time cap", () => {
  test("a chunk at the cap closes with provenance time, at this window when there is no soft pause", () => {
    const p = plan(["no/no", "no/no", "no/no", "no/no", "no/no", "no/no"]);
    expect(p.closed).toEqual([[[0, 1, 2, 3, 4], "time"]]);
    expect(p.open).toEqual([5]);
  });

  test("the cut is at the latest soft pause and the windows after it start the next chunk", () => {
    const p = plan(["no/no", "no/yes", "no/no", "no/yes", "no/no", "no/no"]);
    expect(p.closed).toEqual([[[0, 1, 2, 3], "time"]]);
    expect(p.open).toEqual([4, 5]);
    expect(p.result.notes.get(p.windows[4]!.id)).toContain("latest soft pause");
  });

  test("with the starting values the cap is eight minutes of watched captions", () => {
    const script: Script[] = Array.from({ length: 17 }, () => "no/no");
    const p = plan(script, { cfg: SEGMENTATION_DEFAULTS });
    expect(p.closed).toEqual([[Array.from({ length: 16 }, (_, k) => k), "time"]]);
    expect(p.open).toEqual([16]);
  });

  test("below the cap nothing closes", () => {
    expect(plan(["no/no", "no/yes", "no/no", "no/yes"]).closed).toEqual([]);
  });

  test("a time close is not reconsidered", () => {
    const p = plan(["no/no", "no/no", "no/no", "no/no", "no/no", "no/no"]);
    expect(p.closed.map(([, provenance]) => provenance)).toEqual(["time"]);
  });
});

describe("video end and session end", () => {
  const twoVideos = [...lecture(SRC_A, 0, 60), ...lecture(SRC_B, 0, 60)];

  test("the end of a video never closes a chunk: a topic runs on into the next clip", () => {
    const p = plan(["no/no", "no/no", "no/no", "no/no"], { passages: twoVideos });
    expect(p.closed).toEqual([]);
    expect(p.open).toEqual([0, 1, 2, 3]);
    expect(Material.sources(p.result.open!.material)).toEqual([SRC_A, SRC_B].sort());
  });

  test("the next clip's first window decides: yes/yes closes the chunk holding only the first video", () => {
    const p = plan(["no/no", "no/no", "yes/yes", "no/yes"], { passages: twoVideos });
    expect(p.closed).toEqual([[[0, 1], "boundary"]]);
    expect(Material.sources(p.result.closed[0]!.material)).toEqual([SRC_A]);
  });

  test("a topic that spans two videos closes as one chunk with material from both", () => {
    const p = plan(["no/no", "no/no", "no/no", "no/no"], { passages: twoVideos, stopped: true });
    expect(p.closed).toEqual([[[0, 1, 2, 3], "session_end"]]);
    expect(Material.sources(p.result.closed[0]!.material)).toEqual([SRC_A, SRC_B].sort());
  });

  test("session end closes the open chunk with provenance session_end", () => {
    const p = plan(["no/no", "yes/yes", "no/yes"], { stopped: true });
    expect(p.closed).toEqual([[[0], "boundary"], [[1, 2], "session_end"]]);
    expect(p.open).toBeNull();
  });

  test("session end waits for a pending judgment", () => {
    const p = plan(["no/no", "pending"], { stopped: true });
    expect(p.closed).toEqual([]);
    expect(p.open).toEqual([0]);
  });

  test("without a stop the open chunk stays open", () => {
    expect(plan(["no/no", "no/no"]).open).toEqual([0, 1]);
  });
});

describe("chunk revisions", () => {
  const rev = (seq: { n: number }) => () => asSeq(++seq.n);

  test("reconcile appends a first revision, skips an unchanged chunk, and appends a superseding revision when material changes", () => {
    const seq = { n: 0 };
    const before = plan(["no/no", "yes/yes", "pending"], { passages: lecture(SRC_A, 0, 90) });
    const first = reconcile(CAP, before.result, [], rev(seq));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ordinal: 0, revisionNo: 1, supersedes: null, provenance: "boundary" });

    expect(reconcile(CAP, before.result, first, rev(seq))).toEqual([]);
    expect(seq.n).toBe(1);

    const after = plan(["no/no", "yes/yes", "no/no"], { passages: lecture(SRC_A, 0, 90) });
    const second = reconcile(CAP, after.result, first, rev(seq));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ chunkId: first[0]!.chunkId, revisionNo: 2, supersedes: first[0]!.id, provenance: "boundary_revised" });
    expect(second[0]!.id).not.toBe(first[0]!.id);
    expect(Material.contains(second[0]!.material, first[0]!.material)).toBe(true);
  });

  test("material that returns to an older revision still gets a fresh ID, never a duplicate key", () => {
    const seq = { n: 0 };
    const short = plan(["no/no", "yes/yes", "pending"], { passages: lecture(SRC_A, 0, 90) });
    const long = plan(["no/no", "yes/yes", "no/no"], { passages: lecture(SRC_A, 0, 90) });
    const r1 = reconcile(CAP, short.result, [], rev(seq));
    const r2 = reconcile(CAP, long.result, r1, rev(seq));
    const r3 = reconcile(CAP, short.result, [...r1, ...r2], rev(seq));
    expect(r3[0]).toMatchObject({ revisionNo: 3, supersedes: r2[0]!.id });
    expect(new Set([...r1, ...r2, ...r3].map((r) => r.id)).size).toBe(3);
  });
});

type Fixture = ReturnType<typeof fixture>;

/** A segmentation over a scripted lecture of `windows` windows. Judgments are set per window ordinal. */
function fixture(windows: number, opts: { cfg?: SegmentationConfig; captureId?: CaptureId; db?: ReturnType<typeof testDb>; routing?: RoutingOptions | undefined } = {}) {
  const cfg = opts.cfg ?? CFG;
  const captureId = opts.captureId ?? CAP;
  const db = opts.db ?? testDb();
  const all = lecture(SRC_A, 0, windows * 30);
  const ids = buildWindows(captureId, watchOrder(all), cfg).map((w) => w.id);
  const lookups = new Map<WindowId, Lookup<BoundaryJudgment>>();
  const state = { shown: all.length, stopped: false, seqCalls: 0 };
  const seg = createSegmentation(db, {
    watchOrder: () => watchOrder(all.slice(0, state.shown), { stopped: state.stopped }),
    lookupBoundary: (input) => lookups.get(input.window.id) ?? { kind: "missing", key: "key_x" as never },
    boundaryInput: (window) => ({ window, newPassages: [], contextPassages: [], frames: [] }),
    nextSeq: () => {
      state.seqCalls++;
      return db.nextSeq();
    },
  }, cfg, opts.routing);
  return {
    db, seg, ids, state,
    show(n: number) { state.shown = n * 3; },
    judge(k: number, s: Exclude<Script, "pending">) {
      const w = { id: ids[k]! } as BoundaryWindow;
      const j = judgmentOf(w, s);
      lookups.set(ids[k]!, j === "failed"
        ? { kind: "failed", key: "key_x" as never, attempts: 3, lastError: "boom", atSeq: 1 as Seq }
        : { kind: "hit", key: "key_x" as never, value: j as BoundaryJudgment, atSeq: 1 as Seq });
    },
    inflight(k: number) { lookups.set(ids[k]!, { kind: "inflight", key: "key_x" as never }); },
    /** Window k answered with an intro/conclusion (lesson framing) verdict as well. */
    judgeFraming(k: number, newConcept: Verdict, stoppingPoint: Verdict, lessonFraming: Verdict) {
      const value: BoundaryJudgment = { windowId: ids[k]!, newConcept, stoppingPoint, lessonFraming, pNewConcept: null, pStoppingPoint: null, questionVersion: "v1" };
      lookups.set(ids[k]!, { kind: "hit", key: "key_x" as never, value, atSeq: 1 as Seq });
    },
  };
}

function summary(f: Fixture) {
  return f.seg.current(CAP).map((r) => ({ ordinal: r.ordinal, revisionNo: r.revisionNo, provenance: r.provenance, windows: r.windows.map((id) => f.ids.indexOf(id)) }));
}

describe("segmentation over the database", () => {
  test("sync appends a revision when a chunk closes and is a no-op when run again", () => {
    const f = fixture(4);
    f.show(3);
    f.judge(0, "no/no");
    f.judge(1, "no/no");
    f.judge(2, "yes/yes");
    const first = f.seg.sync(CAP);
    expect(first.closed.map((r) => r.provenance)).toEqual(["boundary"]);
    expect(summary(f)).toEqual([{ ordinal: 0, revisionNo: 1, provenance: "boundary", windows: [0, 1] }]);

    const seqsBefore = f.state.seqCalls;
    expect(f.seg.sync(CAP).closed).toEqual([]);
    expect(f.state.seqCalls).toBe(seqsBefore);
    expect(f.seg.history(first.closed[0]!.chunkId)).toHaveLength(1);
  });

  test("a later window revises a boundary by appending; the first revision stays readable and unchanged", () => {
    const f = fixture(4);
    f.show(3);
    f.judge(0, "no/no");
    f.judge(1, "no/no");
    f.judge(2, "yes/yes");
    const rev1 = f.seg.sync(CAP).closed[0]!;
    const frozenCopy = structuredClone({ ...rev1, material: Material.canonical(rev1.material) });

    f.show(4);
    f.judge(3, "no/no");
    const rev2 = f.seg.sync(CAP).closed[0]!;
    expect(rev2).toMatchObject({ chunkId: rev1.chunkId, revisionNo: 2, supersedes: rev1.id, provenance: "boundary_revised" });
    expect(f.seg.history(rev1.chunkId).map((r) => r.id)).toEqual([rev1.id, rev2.id]);
    expect(f.seg.current(CAP)).toHaveLength(1);
    expect(f.seg.current(CAP)[0]!.id).toBe(rev2.id);

    const stillThere = f.seg.revision(rev1.id)!;
    expect({ ...stillThere, material: Material.canonical(stillThere.material) }).toEqual(frozenCopy);
    expect(() => f.db.sql.run("UPDATE chunk_revisions SET provenance = 'time' WHERE id = ?", [rev1.id])).toThrow(/append-only/);
  });

  test("demand lists windows with no judgment in watch order, including those in flight, not those already settled", () => {
    const f = fixture(4);
    f.show(4);
    f.judge(0, "no/no");
    f.inflight(1);
    const { demand } = f.seg.sync(CAP);
    expect(demand.map((i) => f.ids.indexOf(i.window.id))).toEqual([1, 2, 3]);
    f.judge(2, "failed");
    expect(f.seg.sync(CAP).demand.map((i) => f.ids.indexOf(i.window.id))).toEqual([1, 3]);
  });

  test("a failed judgment folds as continue and closes nothing", () => {
    const f = fixture(3);
    f.show(3);
    f.judge(0, "no/no");
    f.judge(1, "failed");
    f.judge(2, "no/no");
    expect(f.seg.sync(CAP).closed).toEqual([]);
  });

  test("the time cap closes at the latest soft pause", () => {
    const f = fixture(6);
    f.show(6);
    (["no/no", "no/yes", "no/no", "no/yes", "no/no", "no/no"] as const).forEach((s, k) => f.judge(k, s));
    f.seg.sync(CAP);
    expect(summary(f)).toEqual([{ ordinal: 0, revisionNo: 1, provenance: "time", windows: [0, 1, 2, 3] }]);
  });

  test("session end closes the open chunk, once the trailing partial window is judged", () => {
    const f = fixture(2);
    f.show(2);
    f.judge(0, "no/no");
    f.judge(1, "no/no");
    expect(f.seg.sync(CAP).closed).toEqual([]);
    f.state.stopped = true;
    expect(f.seg.sync(CAP).closed.map((r) => r.provenance)).toEqual(["session_end"]);
    expect(f.seg.sync(CAP).closed).toEqual([]);
  });

  test("trace shows each window's inputs, judgment, route and what the fold did", () => {
    const f = fixture(4);
    f.show(4);
    f.judge(0, "no/no");
    f.judge(1, "no/yes");
    f.judge(2, "yes/yes");
    const trace = f.seg.trace(CAP);
    expect(trace.map((t) => t.window.id)).toEqual(f.ids);
    expect(trace.map((t) => t.route)).toEqual(["continue", "soft_pause", "close", null]);
    expect(trace.map((t) => (typeof t.judgment === "string" ? t.judgment : `${t.judgment.newConcept}/${t.judgment.stoppingPoint}`))).toEqual(["no/no", "no/yes", "yes/yes", "pending"]);
    expect(trace[0]!.note).toContain("new 30s");
    expect(trace[0]!.note).toContain(SRC_A);
    expect(trace[1]!.note).toContain("soft pause");
    expect(trace[2]!.note).toContain("closed chunk 0 at boundary");
    expect(trace[3]!.note).toContain("awaiting Jev judgment");
  });

  test("a window judged after an unjudged one is shown as waiting, not folded", () => {
    const f = fixture(3);
    f.show(3);
    f.judge(0, "no/no");
    f.judge(2, "yes/yes");
    const trace = f.seg.trace(CAP);
    expect(trace[2]!.route).toBe("close");
    expect(trace[2]!.note).toContain("not folded yet");
    expect(f.seg.sync(CAP).closed).toEqual([]);
  });
});

describe("rewatch and a second session reuse cached judgments", () => {
  test("identical material in a new capture is served from the memo with no new call and no demand", async () => {
    const db = testDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const scripted = new Map<WindowId, [Verdict, Verdict]>();
    const task = fakeTask<{ w: string }, BoundaryJudgment>({
      answer: ({ w }) => {
        const [newConcept, stoppingPoint] = scripted.get(w as WindowId)!;
        return ok({ windowId: w as WindowId, newConcept, stoppingPoint, pNewConcept: null, pStoppingPoint: null, questionVersion: "v1" });
      },
    });

    const passages = lecture(SRC_A, 0, 120);
    const first = createSegmentation(db, {
      watchOrder: () => watchOrder(passages),
      lookupBoundary: (input) => memo.lookup(task, { w: input.window.id }),
      boundaryInput: (window) => ({ window, newPassages: [], contextPassages: [], frames: [] }),
      nextSeq: () => db.nextSeq(),
    }, CFG, undefined);
    const windows = buildWindows(CAP, watchOrder(passages), CFG);
    (["no/no", "no/yes", "yes/yes", "no/yes"] as const).forEach((s, k) => scripted.set(windows[k]!.id, s.split("/") as [Verdict, Verdict]));

    const { demand } = first.sync(CAP);
    expect(demand).toHaveLength(4);
    await Promise.all(demand.map((i) => memo.run(task, { w: i.window.id })));
    expect(task.calls).toHaveLength(4);
    expect(first.sync(CAP).demand).toEqual([]);
    expect(first.current(CAP).map((r) => r.provenance)).toEqual(["boundary"]);

    const otherCapture = randomId("cap");
    const again = first.sync(otherCapture);
    expect(again.demand).toEqual([]);
    expect(task.calls).toHaveLength(4);
    expect(again.closed).toHaveLength(1);
    expect(again.closed[0]!.captureId).toBe(otherCapture);
    expect(again.closed[0]!.chunkId).not.toBe(first.current(CAP)[0]!.chunkId);
    expect(Material.equals(again.closed[0]!.material, first.current(CAP)[0]!.material)).toBe(true);
  });
});

describe("the product's intro/conclusion close through createSegmentation (flow B amendment, 2026-11-06)", () => {
  const run = (routing: RoutingOptions | undefined, nc: Verdict, sp: Verdict, lf: Verdict) => {
    const f = fixture(4, { routing });
    f.show(3);
    f.judge(0, "no/no");
    f.judge(1, "no/no");
    f.judgeFraming(2, nc, sp, lf);
    return f.seg.sync(CAP).closed.map((r) => r.provenance);
  };

  test("the product routing closes on new concept yes and intro/conclusion yes even when the stopping point is no", () => {
    expect(PRODUCT_JEV_SETUP.routing).toEqual({ lessonFramingCloses: true });
    expect(run(PRODUCT_JEV_SETUP.routing, "yes", "no", "yes")).toEqual(["boundary"]);
  });

  test("without the routing option the same answers do not close", () => {
    expect(run(undefined, "yes", "no", "yes")).toEqual([]);
  });

  test("intro/conclusion yes alone does not close", () => {
    expect(run(PRODUCT_JEV_SETUP.routing, "no", "no", "yes")).toEqual([]);
  });
});
