/** Pause and stop must not lose the span the content script closes in response (pass bar 1). */
import { afterAll, describe, expect, test } from "bun:test";
import { boot, connectPort, feed, kindsOf, newEnv, restoreGlobals, sendPopup, span, wait } from "./worker-harness";
import type { FakePort } from "./worker-harness";

afterAll(restoreGlobals);

/** A content script that, asked to flush, sends its open span and then says so. */
const answeringFlush = (p: FakePort, closing = span(5, 8)) => {
  p.onPost = (m) => {
    if (m.type === "flush") {
      feed(p, closing);
      feed(p, { type: "flushed" });
    }
  };
};

async function capturing() {
  const env = newEnv();
  const { c } = await boot(env);
  const p = connectPort(c, 1);
  await sendPopup(c, { type: "start", tabId: 1 });
  feed(p, span(0, 5));
  await wait();
  return { env, c, p };
}
const stored = (env: ReturnType<typeof newEnv>) => kindsOf([...env.backend.stored.values()][0]);

describe("the closing span", () => {
  test("a user pause keeps the span the content script closes in response", async () => {
    const { env, c, p } = await capturing();
    answeringFlush(p);
    const r = await sendPopup(c, { type: "pause", tabId: 1 });
    expect(r.state.state).toBe("paused");
    await wait(80);
    expect(stored(env)).toEqual(["control:start", "span", "span", "control:pause"]);
  });

  test("a user stop keeps it too", async () => {
    const { env, c, p } = await capturing();
    answeringFlush(p);
    await sendPopup(c, { type: "stop", tabId: 1 });
    await wait(80);
    expect(stored(env)).toEqual(["control:start", "span", "span", "control:stop"]);
  });

  test("leaving the watch page auto-pauses after the closing span", async () => {
    const { env, c, p } = await capturing();
    answeringFlush(p);
    c.tabs.onUpdated.fire(1, { url: "https://www.youtube.com/" });
    await wait(120);
    expect(stored(env)).toEqual(["control:start", "span", "span", "control:pause"]);
  });

  test("a content script that never answers delays the pause by about a second, and the lost seconds are logged as a gap", async () => {
    const { env, c } = await capturing();
    const started = Date.now();
    const r = await sendPopup(c, { type: "pause", tabId: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.state.state).toBe("paused");
    await wait(80);
    expect(stored(env)).toEqual(["control:start", "span", "channel", "control:pause"]);
    const gap = [...[...env.backend.stored.values()][0]!.values()][2] as unknown as { detail: string; health: string };
    expect(gap.health).toBe("failed");
    expect(gap.detail).toContain("did not answer");
  });

  test("a page that is already gone cannot flush: the pause is immediate and the gap is logged", async () => {
    const { env, c, p } = await capturing();
    p.onDisconnect.fire();
    c.tabs.onUpdated.fire(1, { url: "https://www.youtube.com/" });
    await wait(100);
    expect(stored(env)).toEqual(["control:start", "span", "channel", "control:pause"]);
  });

  test("pausing something already paused asks for no flush and adds no gap", async () => {
    const { env, c, p } = await capturing();
    answeringFlush(p);
    await sendPopup(c, { type: "pause", tabId: 1 });
    const flushes = () => p.posted.filter((m) => m.type === "flush").length;
    expect(flushes()).toBe(1);
    await sendPopup(c, { type: "pause", tabId: 1 });
    await wait(60);
    expect(flushes()).toBe(1);
    expect(stored(env)).toEqual(["control:start", "span", "span", "control:pause"]);
  });
});

describe("worker to content messages", () => {
  test("observe messages carry the capture id, and a new start gets a new one", async () => {
    const { c, p } = await capturing();
    answeringFlush(p);
    const lastObserve = () => p.posted.filter((m) => m.type === "observe").at(-1);
    const first = lastObserve();
    expect(first).toMatchObject({ on: true, captureId: expect.stringMatching(/^cap_/) });
    await sendPopup(c, { type: "stop", tabId: 1 });
    expect(lastObserve()).toMatchObject({ on: false, captureId: first.captureId });
    await sendPopup(c, { type: "start", tabId: 1 });
    expect(lastObserve().on).toBe(true);
    expect(lastObserve().captureId).not.toBe(first.captureId);
  });

  test("retry_observe re-sends the observe state to the page", async () => {
    const { c, p } = await capturing();
    const before = p.posted.length;
    const r = await sendPopup(c, { type: "retry_observe", tabId: 1 });
    expect(r.error).toBeUndefined();
    expect(p.posted.slice(before)).toEqual([{ type: "observe", on: true, captureId: r.state.captureId }]);
  });
});
