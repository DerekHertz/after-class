/**
 * The product's Jev setup (src/backend/jev-setup.ts): experiment 7 round 1, approved by Derek 2026-11-06.
 * Offline: Jev is a scripted fake.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BoundaryJudgment, BoundaryWindow, CaptureStatus, Frame, Passage, Verdict } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import type { SourceId, WindowId } from "../src/shared/ids";
import { asSeq } from "../src/backend/db";
import type { WatchOrder } from "../src/backend/evidence";
import { PRODUCT_JEV_SETUP } from "../src/backend/jev-setup";
import type { JevClient, JevRequest } from "../src/backend/providers/jev";
import { QUESTIONS, THRESHOLDS, boundaryTask, frameChangeTask, productBoundaryTask, productFrameChangeTask } from "../src/backend/providers/jev-tasks";
import type { BoundaryInput, FrameChangeInput } from "../src/backend/providers/jev-tasks";
import { createMemo } from "../src/backend/providers/memo";
import type { UsageReport } from "../src/backend/providers/memo";
import { SEGMENTATION_DEFAULTS } from "../src/backend/segmentation";
import { buildWindows, planChunks } from "../src/backend/segmentation/core";
import { testDb } from "./fakes";

const SRC = stableId("src", "youtube", "lectureA") as SourceId;
const CAP = randomId("cap");
const ctx = { signal: new AbortController().signal, streamTo: null };
const p = (x: number) => ({ type: "noul" as const, p: x });
const passageAt = (id: string, start: number, end: number) => ({ kind: "passage", id, sourceId: SRC, interval: { start, end }, text: `caption ${start}` }) as unknown as Passage;
const frameAt = (id: string, mediaS: number) => ({ kind: "frame", id, sourceId: SRC, mediaS, width: 8, height: 8, teaching: "kept" }) as unknown as Frame;
const bytes = () => { const b = new Uint8Array(30); b.set([0xff, 0xd8, 0xff, 0xe0], 0); b.set([0xff, 0xc0], 20); new DataView(b.buffer).setUint16(22, 17); b[24] = 8; new DataView(b.buffer).setUint16(25, 8); new DataView(b.buffer).setUint16(27, 8); b[29] = 3; return b; };

function fakeJev(answers: Record<string, unknown>) {
  const requests: JevRequest<string>[] = [];
  const usage: UsageReport = { model: "jev-1.13.0", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cost: { kind: "unknown", reason: "fake" } };
  const jev: JevClient = { async ask(req) { requests.push(req as JevRequest<string>); return { answers: answers as never, usage }; } };
  return { jev, requests };
}
const NO_JEV = fakeJev({}).jev;

const boundaryInput = (): BoundaryInput => ({
  window: { id: "win_1", ordinal: 0 } as unknown as BoundaryWindow,
  newPassages: [passageAt("ev_n", 120, 125)],
  contextPassages: [passageAt("ev_c", 90, 95)],
  frames: [{ frame: frameAt("ev_f", 121), bytes }],
});

describe("product Jev setup, round 1", () => {
  test("the four wordings are byte for byte the round-1 arm config; thresholds and segmentation as approved", () => {
    const arm = JSON.parse(readFileSync(new URL("./fixtures/exp7-fable-1-r1-arm-config.json", import.meta.url), "utf8"));
    for (const k of ["newConcept", "stoppingPoint", "teachingChange", "lessonFraming"] as const) expect(PRODUCT_JEV_SETUP.questions[k]).toBe(arm.questions[k]);
    expect(PRODUCT_JEV_SETUP.thresholds).toEqual({ yesAtOrAbove: 0.5, noAtOrBelow: 0.3 });
    expect(PRODUCT_JEV_SETUP.segmentation).toEqual({ windowNewS: 45, contextS: 120, timeCapS: 480, maxFramesPerWindow: 2, reviseOnNextNoNo: false });
    expect(PRODUCT_JEV_SETUP.routing).toEqual({ lessonFramingCloses: true });
  });

  test("the lab baseline is unchanged", () => {
    expect(THRESHOLDS).toEqual({ yesAtOrAbove: 0.7, noAtOrBelow: 0.3 });
    expect(SEGMENTATION_DEFAULTS.windowNewS).toBe(30);
    expect(QUESTIONS.boundary.version).toBe("1");
    expect(boundaryTask(NO_JEV).version).toBe("boundary.1@0.7/0.3");
    expect(frameChangeTask(NO_JEV).version).toBe("frame_change.1@0.7/0.3");
  });

  test("product task versions are stable and distinct from the lab's", () => {
    expect(productBoundaryTask(NO_JEV).version).toBe("boundary.exp7-fable-1-r1+lesson_framing.exp7-fable-1-r1@0.5/0.3");
    expect(productFrameChangeTask(NO_JEV).version).toBe("frame_change.exp7-fable-1-r1@0.5/0.3");
    expect(productBoundaryTask(NO_JEV).version).not.toBe(boundaryTask(NO_JEV).version);
    const memo = createMemo(testDb(), "live");
    expect(memo.key(productBoundaryTask(NO_JEV), boundaryInput())).not.toBe(memo.key(boundaryTask(NO_JEV), boundaryInput()));
  });

  test("the boundary request carries new concept, stopping point and lesson framing, with round 1's wording", async () => {
    const { jev, requests } = fakeJev({ new_concept: p(0.6), stopping_point: p(0.4), lesson_framing: p(0.5) });
    const { output } = await productBoundaryTask(jev).attempt(boundaryInput(), ctx);
    expect(Object.keys(requests[0]!.questions)).toEqual(["new_concept", "stopping_point", "lesson_framing"]);
    expect(requests[0]!.questions.new_concept!.instructions).toBe(PRODUCT_JEV_SETUP.questions.newConcept);
    expect(requests[0]!.questions.stopping_point!.instructions).toBe(PRODUCT_JEV_SETUP.questions.stoppingPoint);
    expect(requests[0]!.questions.lesson_framing!.instructions).toBe(PRODUCT_JEV_SETUP.questions.lessonFraming);
    // 0.5 is a yes at the product thresholds (>= 0.5); 0.4 is uncertain
    expect(output).toMatchObject({ newConcept: "yes", stoppingPoint: "uncertain", lessonFraming: "yes", pLessonFraming: 0.5 });
  });

  test("frame dedupe uses round 1's teachingChange and thresholds", async () => {
    const { jev, requests } = fakeJev({ teaching_change: p(0.5) });
    const input: FrameChangeInput = { before: { frame: frameAt("ev_a", 10), bytes }, after: { frame: frameAt("ev_b", 20), bytes }, nearbyPassages: [] };
    const { output } = await productFrameChangeTask(jev).attempt(input, ctx);
    expect(requests[0]!.questions.teaching_change!.instructions).toBe(PRODUCT_JEV_SETUP.questions.teachingChange);
    expect(output).toBe("yes");
    const lab = fakeJev({ teaching_change: p(0.5) });
    expect((await frameChangeTask(lab.jev).attempt(input, ctx)).output).toBe("uncertain");
  });
});

// ───────────────────────────── routing in the product's planChunks call ─────────────────────────────

function watchOrder(passages: readonly Passage[]): WatchOrder {
  const status: CaptureStatus = { state: "stopped" };
  return {
    passages: passages.map((q, k) => ({ passage: q, firstWatchedAtSeq: asSeq(k + 1), sourceIndex: 0 })),
    frameCandidates: [],
    status,
    stoppedAtSeq: asSeq(passages.length + 1),
    watchedSeconds: passages.length * 10,
  };
}
type Step = `${Verdict}/${Verdict}/${Verdict}`;
function planWith(script: readonly Step[]) {
  const cfg = PRODUCT_JEV_SETUP.segmentation;
  const passages = Array.from({ length: script.length * 5 }, (_, i) => passageAt(`ev_${i}`, i * 10, i * 10 + 10));
  const windows = buildWindows(CAP, watchOrder(passages), cfg);
  const judge = (w: BoundaryWindow): BoundaryJudgment => {
    const [newConcept, stoppingPoint, lessonFraming] = script[w.ordinal % script.length]!.split("/") as [Verdict, Verdict, Verdict];
    return { windowId: w.id, newConcept, stoppingPoint, pNewConcept: null, pStoppingPoint: null, questionVersion: "v", lessonFraming };
  };
  const result = planChunks(windows, judge, false, cfg, PRODUCT_JEV_SETUP.routing);
  const ord = new Map<WindowId, number>(windows.map((w) => [w.id, w.ordinal]));
  return result.closed.map((c) => [c.windows.map((id) => ord.get(id)!), c.provenance] as const);
}

describe("product routing passes lessonFramingCloses", () => {
  test("new concept yes + framing yes + stopping point no closes; new concept no + framing yes does not", () => {
    expect(planWith(["no/no/no", "yes/no/yes", "no/no/no"]).length).toBe(1);
    expect(planWith(["no/no/no", "yes/no/no", "no/no/no"]).length).toBe(0);
    expect(planWith(["no/no/no", "no/no/yes", "no/no/no"]).length).toBe(0);
    expect(planWith(["no/no/no", "yes/yes/no", "no/no/no"]).length).toBe(1);
  });
});
