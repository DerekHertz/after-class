/**
 * Experiment 7, build prerequisite 1: the scoped Jev tasks, the opt-in lesson-framing routing and the pure keep helpers.
 * Offline: Jev is a scripted fake; nothing here touches the network or a key file.
 */
import { describe, expect, test } from "bun:test";
import type { BoundaryJudgment, BoundaryWindow, CaptureStatus, EvidenceBundle, Frame, Passage, Verdict } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import type { SourceId, WindowId } from "../src/shared/ids";
import { interval } from "../src/shared/time";
import { asSeq } from "../src/backend/db";
import type { WatchOrder } from "../src/backend/evidence";
import type { JevClient, JevRequest } from "../src/backend/providers/jev";
import {
  QUESTIONS, boundaryTask, claimRelevanceTask, claimRelevanceWordingVersion, claimsKept, frameChangeTask, frameRelevanceTask, frameRelevanceWordingVersion,
  framesKept, lessonFramingTask, lessonFramingWordingVersion, passagesNear,
} from "../src/backend/providers/jev-tasks";
import type { BoundaryInput } from "../src/backend/providers/jev-tasks";
import { createMemo } from "../src/backend/providers/memo";
import type { UsageReport } from "../src/backend/providers/memo";
import { buildWindows, planChunks, routeWithFraming } from "../src/backend/segmentation/core";
import type { SegmentationConfig } from "../src/backend/segmentation";
import { testDb } from "./fakes";

// ───────────────────────────── fixtures ─────────────────────────────────────

function jpeg(w: number, h: number): Uint8Array {
  const b = new Uint8Array(2 + 2 + 16 + 2 + 17 + 2);
  const v = new DataView(b.buffer);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  v.setUint16(4, 16);
  b.set([0xff, 0xc0], 20);
  v.setUint16(22, 17);
  b[24] = 8;
  v.setUint16(25, h);
  v.setUint16(27, w);
  b[29] = 3;
  b.set([0xff, 0xd9], b.length - 2);
  return b;
}

const SRC_A = stableId("src", "youtube", "lectureA");
const SRC_B = stableId("src", "youtube", "lectureB");
const CAP = randomId("cap");
const ctx = { signal: new AbortController().signal, streamTo: null };

const passageAt = (id: string, start: number, end: number, text = `caption ${start}`, sourceId: string = SRC_A) =>
  ({ kind: "passage", id, sourceId, interval: { start, end }, text }) as unknown as Passage;
const frameAt = (id: string, mediaS: number, sourceId: string = SRC_A) =>
  ({ kind: "frame", id, sourceId, mediaS, width: 1280, height: 720, teaching: "kept" }) as unknown as Frame;
const withBytes = (f: Frame) => ({ frame: f, bytes: () => jpeg(f.width, f.height) });
const p = (x: number) => ({ type: "noul" as const, p: x });

function fakeJev(answers: Record<string, unknown>): { jev: JevClient; requests: JevRequest<string>[] } {
  const requests: JevRequest<string>[] = [];
  const usage: UsageReport = { model: "jev-1.13.0", inputTokens: 10, outputTokens: 1, cacheReadTokens: null, cost: { kind: "unknown", reason: "fake" } };
  const jev: JevClient = {
    async ask(req) {
      requests.push(req as JevRequest<string>);
      return { answers: answers as never, usage };
    },
  };
  return { jev, requests };
}
const NO_JEV = fakeJev({}).jev;

const boundaryInput = (): BoundaryInput => ({
  window: { id: "win_1", ordinal: 0 } as unknown as BoundaryWindow,
  newPassages: [passageAt("ev_n", 120, 125, "Welcome to lecture three.")],
  contextPassages: [passageAt("ev_c", 90, 95, "That wraps up lecture two.")],
  frames: [withBytes(frameAt("ev_f", 121))],
});

// ───────────────────────────── wording and keys ─────────────────────────────

describe("experiment 7 default wording and keys", () => {
  test("every new task starts at wording version 1 and carries it, with the thresholds, in the task version", () => {
    expect(QUESTIONS.frameRelevance.version).toBe("1");
    expect(QUESTIONS.claimRelevance.version).toBe("1");
    expect(QUESTIONS.lessonFraming.version).toBe("1");
    expect(frameRelevanceTask(NO_JEV).version).toBe("frame_relevance.1@0.7/0.3");
    expect(claimRelevanceTask(NO_JEV).version).toBe("claim_relevance.1@0.7/0.3");
    expect(lessonFramingTask(NO_JEV).version).toBe("boundary.1+lesson_framing.1@0.7/0.3");
  });

  test("the default wording as an override is the same version; any other wording is its own arm-<hash> version", () => {
    expect(frameRelevanceWordingVersion({ refersToFrame: QUESTIONS.frameRelevance.refersToFrame })).toBe("1");
    expect(claimRelevanceWordingVersion({ related: QUESTIONS.claimRelevance.related })).toBe("1");
    expect(lessonFramingWordingVersion({ framing: QUESTIONS.lessonFraming.framing })).toBe("1");
    expect(frameRelevanceTask(NO_JEV, { refersToFrame: "x" }).version).toMatch(/^frame_relevance\.arm-[0-9a-f]{16}@/);
    expect(claimRelevanceTask(NO_JEV, { related: "x" }).version).toMatch(/^claim_relevance\.arm-[0-9a-f]{16}@/);
    expect(lessonFramingTask(NO_JEV, { framing: "x" }).version).toMatch(/^boundary\.1\+lesson_framing\.arm-[0-9a-f]{16}@/);
    expect(frameRelevanceWordingVersion({ refersToFrame: "x" })).not.toBe(frameRelevanceWordingVersion({ refersToFrame: "y" }));
  });

  test("changed wording changes the memo key; the same input and wording keeps it; image bytes are not in it", () => {
    const memo = createMemo(testDb(), "live");
    const fin = { frame: withBytes(frameAt("ev_f", 100)), nearbyPassages: [passageAt("ev_a", 95, 100)] };
    const base = memo.key(frameRelevanceTask(NO_JEV), fin);
    expect(memo.key(frameRelevanceTask(NO_JEV), fin)).toBe(base);
    expect(memo.key(frameRelevanceTask(NO_JEV, { refersToFrame: "other wording" }), fin)).not.toBe(base);
    expect(memo.key(frameRelevanceTask(NO_JEV), { ...fin, frame: { frame: fin.frame.frame, bytes: () => jpeg(64, 64) } })).toBe(base);
    expect(memo.key(frameRelevanceTask(NO_JEV), { ...fin, nearbyPassages: [passageAt("ev_b", 95, 100)] })).not.toBe(base);

    const cin = { claim: { id: "clm_1", text: "A line is a set of points." }, newPassages: [passageAt("ev_a", 0, 5)] };
    const cbase = memo.key(claimRelevanceTask(NO_JEV), cin);
    expect(memo.key(claimRelevanceTask(NO_JEV, { related: "other wording" }), cin)).not.toBe(cbase);
    expect(memo.key(claimRelevanceTask(NO_JEV), { ...cin, claim: { id: "clm_1", text: "revised" } })).not.toBe(cbase);

    const bin = boundaryInput();
    const bkey = memo.key(boundaryTask(NO_JEV), bin);
    const lkey = memo.key(lessonFramingTask(NO_JEV), bin);
    expect(lkey).not.toBe(bkey);
    expect(memo.key(lessonFramingTask(NO_JEV, { framing: "other wording" }), bin)).not.toBe(lkey);
    expect(memo.key(lessonFramingTask(NO_JEV, undefined, { newConcept: "a", stoppingPoint: "b" }), bin)).not.toBe(lkey);
  });

  test("the draft wordings are neutral questions about the right state fields", () => {
    expect(QUESTIONS.frameRelevance.refersToFrame).toContain("state.captions");
    expect(QUESTIONS.frameRelevance.refersToFrame).toContain("state.frame");
    expect(QUESTIONS.claimRelevance.related).toContain("state.claim");
    expect(QUESTIONS.claimRelevance.related).toContain("state.passages");
    expect(QUESTIONS.lessonFraming.framing).toContain("state.passage");
    expect(QUESTIONS.lessonFraming.framing).toContain("state.context");
  });

  test("the product's tasks keep their versions and wording", () => {
    expect(boundaryTask(NO_JEV).version).toBe("boundary.1@0.7/0.3");
    expect(frameChangeTask(NO_JEV).version).toBe("frame_change.1@0.7/0.3");
  });
});

// ───────────────────────────── the tasks ────────────────────────────────────

describe("frameRelevanceTask", () => {
  test("one image and the captions go in one request; each probability maps to a verdict", async () => {
    for (const [prob, verdict] of [[0.9, "yes"], [0.1, "no"], [0.5, "uncertain"]] as const) {
      const { jev, requests } = fakeJev({ refers_to_frame: p(prob) });
      const { output } = await frameRelevanceTask(jev).attempt({ frame: withBytes(frameAt("ev_f", 100)), nearbyPassages: [passageAt("ev_a", 95.04, 100, "Look at this graph.")] }, ctx);
      expect(output).toBe(verdict);
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0]!.questions)).toEqual(["refers_to_frame"]);
      expect(requests[0]!.questions.refers_to_frame!.instructions).toBe(QUESTIONS.frameRelevance.refersToFrame);
      expect(requests[0]!.images.map((i) => i.ref)).toEqual(["frame"]);
      expect(requests[0]!.state).toEqual({ frame: "frame", captions: [{ t: 95, text: "Look at this graph." }] });
    }
  });

  test("an answer that is not a probability is uncertain, never no", async () => {
    const { jev } = fakeJev({ refers_to_frame: { type: "choice", choice: "a", probabilities: {} } });
    const { output } = await frameRelevanceTask(jev).attempt({ frame: withBytes(frameAt("ev_f", 100)), nearbyPassages: [] }, ctx);
    expect(output).toBe("uncertain");
  });

  test("an override wording is what is asked", async () => {
    const { jev, requests } = fakeJev({ refers_to_frame: p(0.9) });
    await frameRelevanceTask(jev, { refersToFrame: "custom" }).attempt({ frame: withBytes(frameAt("ev_f", 100)), nearbyPassages: [] }, ctx);
    expect(requests[0]!.questions.refers_to_frame!.instructions).toBe("custom");
  });
});

describe("claimRelevanceTask", () => {
  test("sends the claim text and the new passages, no images", async () => {
    const { jev, requests } = fakeJev({ related: p(0.1) });
    const { output } = await claimRelevanceTask(jev).attempt({ claim: { id: "clm_1", text: "Rank is column rank." }, newPassages: [passageAt("ev_a", 10, 15, "Now eigenvalues.")] }, ctx);
    expect(output).toBe("no");
    expect(requests[0]!.images).toEqual([]);
    expect(requests[0]!.state).toEqual({ claim: "Rank is column rank.", passages: [{ t: 10, text: "Now eigenvalues." }] });
    expect(Object.keys(requests[0]!.questions)).toEqual(["related"]);
  });
});

describe("lessonFramingTask", () => {
  test("is boundaryTask plus a third question in the same request; one call, the same state and images", async () => {
    const plain = fakeJev({ new_concept: p(0.9), stopping_point: p(0.9) });
    const bound = await boundaryTask(plain.jev).attempt(boundaryInput(), ctx);
    const framed = fakeJev({ new_concept: p(0.9), stopping_point: p(0.1), lesson_framing: p(0.8) });
    const { output } = await lessonFramingTask(framed.jev).attempt(boundaryInput(), ctx);

    expect(framed.requests).toHaveLength(1);
    expect(Object.keys(framed.requests[0]!.questions)).toEqual(["new_concept", "stopping_point", "lesson_framing"]);
    expect(framed.requests[0]!.questions.lesson_framing!.instructions).toBe(QUESTIONS.lessonFraming.framing);
    expect(framed.requests[0]!.state).toEqual(plain.requests[0]!.state);
    expect(framed.requests[0]!.images).toEqual(plain.requests[0]!.images);
    expect(output).toMatchObject({ newConcept: "yes", stoppingPoint: "no", lessonFraming: "yes", pLessonFraming: 0.8, questionVersion: "boundary.1+lesson_framing.1" });
    // the product's task does not ask it and its judgment has no such field
    expect(Object.keys(plain.requests[0]!.questions)).toEqual(["new_concept", "stopping_point"]);
    expect("lessonFraming" in bound.output).toBe(false);
    expect("pLessonFraming" in bound.output).toBe(false);
  });

  test("an unanswered framing question is uncertain; a stored judgment round-trips with and without the field", async () => {
    const { jev } = fakeJev({ new_concept: p(0.9), stopping_point: p(0.9) });
    const task = lessonFramingTask(jev);
    const { output } = await task.attempt(boundaryInput(), ctx);
    expect(output).toMatchObject({ lessonFraming: "uncertain", pLessonFraming: null });
    expect(task.decode(JSON.parse(JSON.stringify(output)))).toEqual(output);
    const old = { windowId: "win_x" as unknown as BoundaryJudgment["windowId"], newConcept: "no" as const, stoppingPoint: "no" as const, pNewConcept: 0.1, pStoppingPoint: 0.1, questionVersion: "boundary.1" };
    expect(boundaryTask(jev).decode(old)).toEqual(old);
  });

  test("boundary wording overrides apply to the bundled task", async () => {
    const { jev, requests } = fakeJev({ new_concept: p(0.5), stopping_point: p(0.5), lesson_framing: p(0.5) });
    await lessonFramingTask(jev, { framing: "F" }, { newConcept: "N", stoppingPoint: "S" }).attempt(boundaryInput(), ctx);
    expect(Object.values(requests[0]!.questions).map((q) => q.instructions)).toEqual(["N", "S", "F"]);
  });
});

// ───────────────────────────── routing ──────────────────────────────────────

const CFG: SegmentationConfig = { windowNewS: 30, contextS: 60, timeCapS: 150, maxFramesPerWindow: 2, reviseOnNextNoNo: false };

function passage(source: SourceId, start: number, end: number): Passage {
  return { kind: "passage", id: stableId("ev", source, start, end), sourceId: source, transcriptRevId: stableId("trv", source), interval: interval(start, end), text: `caption ${start}`, origin: "panel" } as unknown as Passage;
}
const lecture = (source: SourceId, from: number, to: number): Passage[] =>
  Array.from({ length: (to - from) / 10 }, (_, k) => passage(source, from + k * 10, from + k * 10 + 10));
function watchOrder(passages: readonly Passage[]): WatchOrder {
  const status: CaptureStatus = { state: "stopped" };
  return {
    passages: passages.map((q, k) => ({ passage: q, firstWatchedAtSeq: asSeq(k + 1), sourceIndex: q.sourceId === SRC_A ? 0 : 1 })),
    frameCandidates: [],
    status,
    stoppedAtSeq: asSeq(passages.length + 1),
    watchedSeconds: passages.length * 10,
  };
}

type Step = `${Verdict}/${Verdict}` | `${Verdict}/${Verdict}/${Verdict}`;
function judge(w: BoundaryWindow, s: Step): BoundaryJudgment {
  const [newConcept, stoppingPoint, framing] = s.split("/") as [Verdict, Verdict, Verdict | undefined];
  return { windowId: w.id, newConcept, stoppingPoint, pNewConcept: null, pStoppingPoint: null, questionVersion: "v", ...(framing === undefined ? {} : { lessonFraming: framing }) };
}
function plan(script: readonly Step[], routing?: Parameters<typeof planChunks>[4], passages?: readonly Passage[]) {
  const windows = buildWindows(CAP, watchOrder(passages ?? lecture(SRC_A, 0, script.length * 30)), CFG);
  const result = planChunks(windows, (w) => judge(w, script[w.ordinal]!), false, CFG, routing);
  const ord = new Map<WindowId, number>(windows.map((w) => [w.id, w.ordinal]));
  return { windows, result, closed: result.closed.map((c) => [c.windows.map((id) => ord.get(id)!), c.provenance] as const) };
}

describe("lesson-framing routing (design item 6)", () => {
  const verdicts: Verdict[] = ["yes", "no", "uncertain"];
  test("flag off: every combination routes as today, whatever the framing says", () => {
    for (const nc of verdicts) for (const sp of verdicts) for (const lf of [...verdicts, undefined]) {
      expect(routeWithFraming(nc, sp, lf)).toBe(routeWithFraming(nc, sp, undefined));
      expect(routeWithFraming(nc, sp, lf, {})).toBe(routeWithFraming(nc, sp, undefined));
      expect(routeWithFraming(nc, sp, lf, { lessonFramingCloses: false })).toBe(routeWithFraming(nc, sp, undefined));
    }
  });

  test("flag on: closes on new concept yes with framing yes whatever the stopping point; otherwise the table", () => {
    const on = { lessonFramingCloses: true };
    for (const sp of verdicts) expect(routeWithFraming("yes", sp, "yes", on)).toBe("close");
    expect(routeWithFraming("yes", "no", "no", on)).toBe("flag_recheck");
    expect(routeWithFraming("yes", "no", "uncertain", on)).toBe("flag_recheck");
    expect(routeWithFraming("yes", "no", undefined, on)).toBe("flag_recheck");
    expect(routeWithFraming("no", "yes", "yes", on)).toBe("soft_pause");
    expect(routeWithFraming("no", "no", "yes", on)).toBe("continue");
    expect(routeWithFraming("uncertain", "yes", "yes", on)).toBe("continue");
    expect(routeWithFraming("yes", "yes", "no", on)).toBe("close");
  });

  test("flag off or omitted: windows and chunk plans are identical to today, framing verdicts ignored", () => {
    const base: Step[] = ["no/no", "yes/yes", "yes/no", "no/yes", "yes/yes", "no/no"];
    const withFraming: Step[] = base.map((s, k) => `${s}/${k % 2 === 0 ? "yes" : "no"}` as Step);
    const today = plan(base);
    for (const routing of [undefined, {}, { lessonFramingCloses: false }]) {
      const again = plan(withFraming, routing);
      expect(again.windows.map((w) => w.id)).toEqual(today.windows.map((w) => w.id));
      expect(again.closed).toEqual(today.closed);
      expect(again.result.open?.windows).toEqual(today.result.open?.windows);
      expect([...again.result.notes.values()]).toEqual([...today.result.notes.values()]);
    }
  });

  test("flag on: a lesson introduction closes the chunk before it even though the stopping point is no", () => {
    const script: Step[] = ["no/no/no", "no/no/no", "yes/no/yes", "no/no/no"];
    expect(plan(script).closed).toEqual([]);
    const on = plan(script, { lessonFramingCloses: true });
    expect(on.closed).toEqual([[[0, 1], "boundary"]]);
    expect(on.result.open?.windows).toEqual([on.windows[2]!.id, on.windows[3]!.id]);
  });

  test("flag on: a clip join adds nothing by itself (no/no across sources continues)", () => {
    const passages = [...lecture(SRC_A, 0, 60), ...lecture(SRC_B, 0, 60)];
    const script: Step[] = ["no/no/no", "no/no/no", "no/no/no", "no/no/no"];
    const on = plan(script, { lessonFramingCloses: true }, passages);
    expect(on.closed).toEqual([]);
    expect(on.result.open?.windows).toHaveLength(4);
  });
});

// ───────────────────────────── helpers ──────────────────────────────────────

describe("keep helpers", () => {
  const f1 = frameAt("f1", 10), f2 = frameAt("f2", 20), f3 = frameAt("f3", 30), f4 = frameAt("f4", 40), f5 = frameAt("f5", 50);
  const bundle = { frames: [f1, f2, f3, f4, f5] } as unknown as EvidenceBundle;

  test("framesKept drops only a no; yes, uncertain, failed and unjudged are kept, in order", () => {
    const kept = framesKept(bundle, new Map([["f1", "yes"], ["f2", "no"], ["f3", "uncertain"], ["f4", "failed"]] as const));
    expect(kept.map((f) => f.id as string)).toEqual(["f1", "f3", "f4", "f5"]);
    expect(framesKept(bundle, new Map()).map((f) => f.id as string)).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect(framesKept({ frames: [] } as unknown as EvidenceBundle, new Map())).toEqual([]);
  });

  test("claimsKept drops only a no, keeps order and extra fields", () => {
    const claims = [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }, { id: "d", text: "D" }];
    expect(claimsKept(claims, new Map([["a", "no"], ["b", "yes"], ["c", "failed"]] as const))).toEqual(claims.slice(1));
    expect(claimsKept(claims, new Map())).toEqual(claims);
  });

  test("passagesNear takes the same source's passages touching the frame time ±15 s", () => {
    const f = frameAt("f", 100);
    const ps = [passageAt("a", 70, 84), passageAt("b", 80, 86), passageAt("c", 114, 120), passageAt("d", 116, 120), passageAt("e", 100, 105, "x", SRC_B)];
    expect(passagesNear(f, ps).map((x) => x.id as string)).toEqual(["b", "c"]);
    expect(passagesNear(f, ps, 5).map((x) => x.id as string)).toEqual([]);
  });
});
