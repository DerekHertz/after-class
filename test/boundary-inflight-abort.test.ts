import { expect, test } from "bun:test";
import type { BoundaryJudgment, CaptureStatus, Passage } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import { interval } from "../src/shared/time";
import { asSeq } from "../src/backend/db";
import type { WatchOrder } from "../src/backend/evidence";
import { createMemo } from "../src/backend/providers/memo";
import { DEFAULT_LIMITS, createScheduler } from "../src/backend/scheduler";
import type { WorkItem } from "../src/backend/scheduler";
import { SEGMENTATION_DEFAULTS, createSegmentation } from "../src/backend/segmentation";
import { fakeTask, ok, testUserDb } from "./fakes";

const CAP = randomId("cap");
const SRC = stableId("src", "youtube", "lecture");

function passage(start: number): Passage {
  return {
    kind: "passage", id: stableId("ev", SRC, start), sourceId: SRC, transcriptRevId: stableId("trv", SRC),
    interval: interval(start, start + 10), text: `caption ${start}`, origin: "panel",
  } as unknown as Passage;
}

const order = (): WatchOrder => {
  const passages = Array.from({ length: 12 }, (_, k) => passage(k * 10));
  const status: CaptureStatus = { state: "capturing" };
  return {
    passages: passages.map((p, k) => ({ passage: p, firstWatchedAtSeq: asSeq(k + 1), sourceIndex: 0 })),
    frameCandidates: [],
    status,
    stoppedAtSeq: null,
    watchedSeconds: passages.length * 10,
  };
};

// Live wiring as in main.ts: segmentation demand feeds the scheduler, and a boundary call stays in flight for a while.
test("a boundary call that is still in flight is not aborted by the next pump", async () => {
  const db = testUserDb();
  const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const task = fakeTask<{ w: string }, BoundaryJudgment>({
    answer: async ({ w }) => {
      await gate;
      return ok({ windowId: w, newConcept: "no", stoppingPoint: "no", pNewConcept: null, pStoppingPoint: null, questionVersion: "v1" } as unknown as BoundaryJudgment);
    },
  });
  const seg = createSegmentation(db, {
    watchOrder: order,
    lookupBoundary: (input) => memo.lookup(task, { w: input.window.id }),
    boundaryInput: (window) => ({ window, newPassages: [], contextPassages: [], frames: [] }),
    nextSeq: () => db.nextSeq(),
  }, SEGMENTATION_DEFAULTS, undefined);

  const source = (): WorkItem[] =>
    seg.sync(CAP).demand.map((input) => ({
      key: memo.key(task, { w: input.window.id }),
      purpose: "boundary",
      provider: "jev",
      run: (signal) => memo.run(task, { w: input.window.id }, { signal }),
    }));
  const scheduler = createScheduler([source], DEFAULT_LIMITS);

  scheduler.pump();
  await new Promise((r) => setTimeout(r, 300));
  const aborted = db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events WHERE outcome = 'aborted'").get()!.n;
  release();
  await new Promise((r) => setTimeout(r, 100));
  await scheduler.stop();

  expect(aborted).toBe(0);
});
