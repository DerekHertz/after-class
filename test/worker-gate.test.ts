/**
 * The real service worker against a backend that refuses uploads for a while (507, or 503 with Retry-After). Every trigger that
 * flushes the outbox must respect the wait: a new fact, the popup's status heartbeat and the 30 s recovery alarm.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { boot, connectPort, feed, newEnv, restoreGlobals, sendPopup, span, wait } from "./worker-harness";
import type { Env } from "./worker-harness";

const QUOTA_MESSAGE = "Backend: storage limit reached on the server, so this capture is not being saved";
const T0 = new Date("2026-11-14T12:00:00Z").getTime();

afterAll(restoreGlobals);
beforeEach(() => setSystemTime(new Date(T0)));
afterEach(() => setSystemTime());

async function refusedWorker(refuse: NonNullable<Env["backend"]["refuseWith"]>) {
  const env = newEnv();
  const { c } = await boot(env);
  const p = connectPort(c, 1);
  env.backend.refuseWith = refuse;
  await sendPopup(c, { type: "start", tabId: 1 });
  await wait(60);
  return { env, c, p, calls: () => env.backend.calls };
}

/** Fires the three triggers once each and returns how many requests they made. */
async function pullEveryTrigger(w: Awaited<ReturnType<typeof refusedWorker>>): Promise<number> {
  const before = w.calls();
  feed(w.p, span(0, 5));
  await wait(40);
  await sendPopup(w.c, { type: "status", tabId: 1 });
  await wait(40);
  w.c.alarms.onAlarm.fire({ name: "afterclass-flush" });
  await wait(40);
  return w.calls() - before;
}

describe("after a 507 the outbox stays shut", () => {
  test("a new fact, the popup heartbeat and the recovery alarm send nothing, and the popup keeps its message and every fact", async () => {
    const w = await refusedWorker({ status: 507 });
    expect(w.calls()).toBe(1);
    expect(await pullEveryTrigger(w)).toBe(0);
    const s = (await sendPopup(w.c, { type: "status", tabId: 1 })).state;
    expect(s.uploadBacklog).toBeGreaterThanOrEqual(2);
    expect(`Backend: ${s.lastError}`).toBe(QUOTA_MESSAGE);
  });

  test("the block survives a worker restart", async () => {
    const w = await refusedWorker({ status: 507 });
    const before = w.calls();
    const { c } = await boot(w.env);
    c.alarms.onAlarm.fire({ name: "afterclass-flush" });
    await wait(40);
    expect(w.calls()).toBe(before);
  });

  test("one try per window: the alarm after the window sends one batch, and a second 507 shuts it again", async () => {
    const w = await refusedWorker({ status: 507 });
    setSystemTime(new Date(T0 + 16 * 60_000));
    const before = w.calls();
    w.c.alarms.onAlarm.fire({ name: "afterclass-flush" });
    await wait(40);
    expect(w.calls() - before).toBe(1);
    expect(await pullEveryTrigger(w)).toBe(0);
  });

  test("the learner resuming lifts the block, and uploads carry on once the backend has room", async () => {
    const w = await refusedWorker({ status: 507 });
    expect(await pullEveryTrigger(w)).toBe(0);
    w.env.backend.refuseWith = null;
    await sendPopup(w.c, { type: "pause", tabId: 1 });
    await sendPopup(w.c, { type: "resume", tabId: 1 });
    await wait(60);
    expect((await sendPopup(w.c, { type: "status", tabId: 1 })).state.uploadBacklog).toBe(0);
  });
});

describe("after a 503 every trigger waits its Retry-After", () => {
  test("nothing is sent inside the wait, and the next trigger after it is", async () => {
    const w = await refusedWorker({ status: 503, retryAfter: "120" });
    expect(w.calls()).toBe(1);
    expect(await pullEveryTrigger(w)).toBe(0);
    setSystemTime(new Date(T0 + 121_000));
    w.env.backend.refuseWith = null;
    w.c.alarms.onAlarm.fire({ name: "afterclass-flush" });
    await wait(60);
    expect(w.calls()).toBeGreaterThan(1);
    expect((await sendPopup(w.c, { type: "status", tabId: 1 })).state.uploadBacklog).toBe(0);
  });
});
