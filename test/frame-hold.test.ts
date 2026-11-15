import { describe, expect, test } from "bun:test";
import { FRAME_HOLD_MS, createEvidence } from "../src/backend/evidence";
import { main } from "../src/backend/main";
import { canonicalInterpretation } from "../src/backend/preparation/tasks";
import type { InterpretationInput, InterpretationOutput } from "../src/backend/preparation/tasks";
import type { FrameChangeInput } from "../src/backend/providers/jev-tasks";
import type { JevClient } from "../src/backend/providers/jev";
import { productFrameChangeTask } from "../src/backend/providers/jev-tasks";
import { createMemo } from "../src/backend/providers/memo";
import { initialPlayback, stepPlayback } from "../src/extension/content/capture";
import type { Verdict } from "../src/shared/domain";
import type { CaptureId } from "../src/shared/ids";
import { stableId } from "../src/shared/ids";
import { OTHER, VIDEO, stream } from "./evidence-fixtures";
import type { FakeTask } from "./fakes";
import { fakeTask, ok, testUserDb } from "./fakes";
import { tmpDir } from "./tmp";

const frameCanonical = productFrameChangeTask({} as JevClient).canonicalInput;
const frameTask = () =>
  Object.assign(fakeTask({ purpose: "frame_change", answer: () => ok("yes") }), { canonicalInput: frameCanonical }) as unknown as FakeTask<FrameChangeInput, Verdict>;

/** Evidence over a real memo and a counting fake Jev that answers "yes". */
function world() {
  const db = testUserDb();
  const clock = { t: 1_000_000 };
  const task = frameTask();
  const memo = createMemo(db, "live");
  const wakes: { captureId: CaptureId; atMs: number }[] = [];
  const evidence = createEvidence(db, tmpDir("frame-hold-"), {
    lookupFrameChange: (input) => memo.lookup(task, input),
    runFrameChange: (input, signal) => memo.run(task, input, { signal }),
    frameChangeKey: (input) => memo.key(task, input),
    onChange: () => {},
    now: () => clock.t,
    wakeAt: (captureId, atMs) => void wakes.push({ captureId, atMs }),
  });
  const s = stream();
  const ingest = () => evidence.ingest({ captureId: s.captureId, facts: s.facts.splice(0) });
  const frame = () => evidence.watchOrder(s.captureId).frameCandidates.find((f) => f.id === stableId("ev", s.captureId, "b"))!;
  const demand = () => evidence.frameDemand(s.captureId);
  const run = async () => {
    for (const w of demand()) await w.run(new AbortController().signal);
  };
  const inBundle = () => evidence.bundle(evidence.watchedMaterial(s.captureId)).frames.some((f) => f.id === frame().id);
  const asked = () => task.calls.map((i) => i.nearbyPassages.map((p) => p.text));
  return { clock, task, memo, wakes, evidence, s, ingest, frame, demand, run, inBundle, asked };
}

/** Frame "b" at 8 s, watched to 10 s: its caption window reaches 23 s, so it is still open. */
function seed(w: ReturnType<typeof world>, o: { duration?: number | null; end?: number; frame?: number } = {}) {
  w.s.control("start");
  w.s.source({ durationS: o.duration === undefined ? 600 : o.duration });
  w.s.transcript([[0, 4, "already watched"]]);
  w.s.span(0, o.end ?? 10);
  w.s.frame("a", 1);
  w.s.frame("b", o.frame ?? 8);
  w.ingest();
}

describe("a frame whose caption window never closes is asked once its wait ends", () => {
  test("a YouTube pause flushes a span and leaves the capture capturing", () => {
    const sample = { videoId: VIDEO, t: 0, wallMs: 0, rate: 1, paused: false, seeking: false, ended: false, ready: true, visible: true, ad: null };
    const playing = stepPlayback(stepPlayback(initialPlayback, { type: "observing", on: true, wallMs: 0 }).state, { type: "tick", s: sample }).state;
    const paused = stepPlayback(playing, { type: "tick", s: { ...sample, t: 10, wallMs: 10_000, paused: true } });
    expect(paused.facts.map((f) => f.kind)).toEqual(["span"]);

    const w = world();
    seed(w);
    expect(w.evidence.captureView(w.s.captureId).status.state).toBe("capturing");
    expect(w.demand()).toHaveLength(0);
    expect(w.wakes.at(-1)).toEqual({ captureId: w.s.captureId, atMs: w.clock.t + FRAME_HOLD_MS });
    w.clock.t += FRAME_HOLD_MS - 1;
    expect(w.demand()).toHaveLength(0);
    w.clock.t += 1;
    expect(w.demand()).toHaveLength(1);
  });

  const stuck: [string, (w: ReturnType<typeof world>) => void][] = [
    ["a rewind that keeps rewatching below the furthest point", (w) => {
      seed(w, { end: 100, frame: 98 });
      for (let i = 0; i < 5; i++) {
        w.s.span(0, 60, { rate: 2, wallMs: 30_000 });
        w.ingest();
      }
    }],
    ["a video that ends with no duration known", (w) => seed(w, { duration: null, end: 12 })],
    ["a video with no transcript whose gap was accepted", (w) => {
      w.s.control("start");
      w.s.source();
      w.s.push({ kind: "transcript_unavailable", videoId: VIDEO, reason: "no_captions" });
      w.s.push({ kind: "transcription_choice", videoId: VIDEO, choice: "continue_with_gap" });
      w.s.span(0, 10);
      w.s.frame("a", 1);
      w.s.frame("b", 8);
      w.ingest();
    }],
  ];
  for (const [name, play] of stuck) {
    test(name, () => {
      const w = world();
      play(w);
      expect(w.demand()).toHaveLength(0);
      w.clock.t += FRAME_HOLD_MS;
      expect(w.demand()).toHaveLength(1);
    });
  }

  test("a rate change alone is governed by media time", () => {
    for (const rate of [0.5, 2]) {
      const w = world();
      seed(w);
      w.s.span(10, 24, { rate, wallMs: 14_000 / rate });
      w.ingest();
      expect(w.demand()).toHaveLength(1);
    }
  });
});

describe("a verdict for the frame's current question is always used", () => {
  test("resuming after a pause keeps the verdict asked during it", async () => {
    const w = world();
    seed(w);
    w.s.control("pause");
    w.ingest();
    await w.run();
    expect(w.frame().teaching).toBe("kept");
    w.s.control("resume");
    w.ingest();
    expect(w.frame().teaching).toBe("kept");
    expect(w.demand()).toHaveLength(0);
    expect(w.inBundle()).toBe(true);
  });

  test("returning to a video in a playlist keeps the verdict asked while away", async () => {
    const w = world();
    seed(w);
    w.s.source({ video: OTHER });
    w.ingest();
    await w.run();
    expect(w.frame().teaching).toBe("kept");
    w.s.source();
    w.ingest();
    expect(w.frame().teaching).toBe("kept");
    expect(w.inBundle()).toBe(true);
  });

  test("a late transcript that reopens the window without adding a caption keeps the verdict", async () => {
    const w = world();
    w.s.control("start");
    w.s.source();
    w.s.span(0, 24);
    w.s.frame("a", 1);
    w.s.frame("b", 5);
    w.ingest();
    await w.run();
    expect(w.frame().teaching).toBe("kept");
    w.s.transcript([[18, 30, "arrived late, only partly watched"]]);
    w.ingest();
    expect(w.evidence.watchOrder(w.s.captureId).passages).toHaveLength(0);
    expect(w.frame().teaching).toBe("kept");
    expect(w.demand()).toHaveLength(0);
    expect(w.task.calls).toHaveLength(1);
  });
});

describe("how often a frame is asked", () => {
  test("a capture growing 5 s at a time asks a frame once, with the captions it ends with", async () => {
    const w = world();
    w.s.control("start");
    w.s.source();
    w.s.transcript([[0, 4, "one"], [10, 14, "two"], [18, 21, "three"], [40, 44, "far"]]);
    w.s.frame("a", 1);
    w.s.frame("b", 5);
    for (let t = 0; t < 60; t += 5) {
      w.s.span(t, t + 5);
      w.ingest();
      await w.run();
    }
    expect(w.asked()).toEqual([["one", "two", "three"]]);
  });

  test("a caption that arrives after the frame was asked asks again with it", async () => {
    const w = world();
    w.s.control("start");
    w.s.source();
    w.s.span(0, 24);
    w.s.frame("a", 1);
    w.s.frame("b", 5);
    w.ingest();
    await w.run();
    w.s.transcript([[10, 14, "late but fully watched"]]);
    w.ingest();
    await w.run();
    expect(w.asked()).toEqual([[], ["late but fully watched"]]);
  });

  test("the end of a video waits for a last caption still being watched", async () => {
    const w = world();
    w.s.control("start");
    w.s.source({ durationS: 12 });
    w.s.transcript([[10, 12, "last caption"]]);
    w.s.span(0, 11.5);
    w.s.frame("a", 1);
    w.s.frame("b", 8);
    w.ingest();
    await w.run();
    w.s.span(11.5, 12);
    w.ingest();
    await w.run();
    expect(w.asked()).toEqual([["last caption"]]);
  });

  test("frameDemandIn asks for the frames of a material whatever their wait", () => {
    const w = world();
    seed(w);
    expect(w.demand()).toHaveLength(0);
    expect(w.evidence.frameDemandIn(w.evidence.watchedMaterial(w.s.captureId))).toHaveLength(1);
  });
});

const until = async (done: () => boolean) => {
  const end = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > end) throw Error("timeout");
    await Bun.sleep(10);
  }
};

function tasks() {
  const boundary = Object.assign(
    fakeTask({
      purpose: "boundary",
      answer: (i: { window: { id: string } }) => ok({ windowId: i.window.id, newConcept: "no", stoppingPoint: "no", pNewConcept: 0.1, pStoppingPoint: 0.1, questionVersion: "fake" }),
    }),
    { canonicalInput: (i: { window: { id: string } }) => i.window.id },
  );
  const frameChange = frameTask();
  const interpret = Object.assign(fakeTask({ purpose: "interpretation", provider: "claude", answer: () => ok({ concepts: [], links: [], supersedes: [] }) }), {
    canonicalInput: canonicalInterpretation,
  }) as unknown as FakeTask<InterpretationInput, InterpretationOutput>;
  const unused = fakeTask({ answer: () => { throw Error("unexpected task"); } });
  return { boundary, frameChange, preparation: { interpret, revise: unused, checkClaim: unused, searchResources: unused }, tutor: unused, wrapUp: unused };
}

async function app(f: ReturnType<typeof tasks>, frameHoldMs?: number) {
  return main({
    port: 0, buildApp: false, appDir: tmpDir("frame-hold-app-"), configDir: tmpDir("frame-hold-config-"),
    env: { AFTERCLASS_DATA: tmpDir("frame-hold-data-"), AFTERCLASS_MODE: "replay" }, ingestPumpMs: 10, tasks: f as never,
    ...(frameHoldMs === undefined ? {} : { frameHoldMs }), log: () => {}, error: console.error,
  });
}

describe("composition", () => {
  for (const action of ["pause", "stop"] as const) {
    test(`${action} wakes a capture that slept with a waiting frame`, async () => {
      const f = tasks();
      const r = await app(f);
      try {
        const s = stream();
        s.control("start");
        s.source();
        s.transcript([[0, 4, "one"]]);
        s.span(0, 10);
        s.frame("a", 1);
        s.frame("b", 8);
        r.modules.evidence.ingest({ captureId: s.captureId, facts: s.facts.splice(0) });
        await Bun.sleep(150);
        expect(f.frameChange.calls).toHaveLength(0);
        r.modules.evidence.ingest({ captureId: s.captureId, facts: [s.control(action)] });
        await until(() => f.frameChange.calls.length === 1);
      } finally {
        await r.stop();
      }
    });
  }

  test("the end of a frame's wait wakes its sleeping capture with no new fact", async () => {
    const f = tasks();
    const r = await app(f, 300);
    try {
      const s = stream();
      s.control("start");
      s.source();
      s.span(0, 10);
      s.frame("a", 1);
      s.frame("b", 8);
      r.modules.evidence.ingest({ captureId: s.captureId, facts: s.facts.splice(0) });
      await Bun.sleep(150);
      expect(f.frameChange.calls).toHaveLength(0);
      const real = r.modules.evidence.frameDemand;
      const derived: CaptureId[] = [];
      r.modules.evidence.frameDemand = (id) => (derived.push(id), real(id));
      r.modules.scheduler.pump();
      await Bun.sleep(20);
      expect(derived).toEqual([]);
      await until(() => f.frameChange.calls.length === 1 && derived.includes(s.captureId));
    } finally {
      await r.stop();
    }
  });

  test("an interpretation waits for the frames of its chunk, judged with the captions it has", async () => {
    const f = tasks();
    const r = await app(f);
    try {
      const s = stream();
      s.control("start");
      s.source();
      s.transcript(Array.from({ length: 120 }, (_, i): [number, number, string] => [i * 5, (i + 1) * 5, `caption ${i}`]));
      s.span(0, 495);
      s.frame("a", 1);
      s.frame("b", 490);
      r.modules.evidence.ingest({ captureId: s.captureId, facts: s.facts.splice(0) });
      await until(() => f.preparation.interpret.calls.length === 1);
      const frameId = stableId("ev", s.captureId, "b");
      expect(f.preparation.interpret.calls[0]!.newMaterial.frames.some((fr) => fr.id === frameId)).toBe(true);
      expect(f.frameChange.calls).toHaveLength(1);
    } finally {
      await r.stop();
    }
  });
});
