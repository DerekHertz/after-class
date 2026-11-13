/** The test-only autostart (AFTERCLASS_TEST_AUTOSTART=1): only a watch page opened with ac_autostart=1 starts capture, and only when the flag is on. */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { answeringFlush, boot, connectPort, newEnv, restoreGlobals, sendPopup, wait } from "./worker-harness";

afterAll(restoreGlobals);
const flag = globalThis as unknown as { __AFTERCLASS_TEST_AUTOSTART__?: boolean };
afterEach(() => {
  delete flag.__AFTERCLASS_TEST_AUTOSTART__;
});

const VIDEO = "dQw4w9WgXcQ";

async function openTab(url: string, on: boolean) {
  return (await openTabFull(url, on)).state;
}

async function openTabFull(url: string, on: boolean, before?: (c: Awaited<ReturnType<typeof boot>>["c"]) => Promise<void>) {
  if (on) flag.__AFTERCLASS_TEST_AUTOSTART__ = true;
  const env = newEnv();
  env.urls[1] = url;
  const { c } = await boot(env);
  answeringFlush(connectPort(c, 1), null);
  await before?.(c);
  c.tabs.onUpdated.fire(1, { status: "complete" }, { url, windowId: 7 });
  await wait(80);
  const status = (await sendPopup(c, { type: "status", tabId: 1 })).state;
  const state: string | null = status?.state ?? null;
  const captureId: string | undefined = status?.captureId;
  // Let this worker's uploads finish before the next test swaps the fake chrome out from under it.
  await sendPopup(c, { type: "stop", tabId: 1 });
  await wait(200);
  return { state, captureId, updated: c.updated as unknown[] };
}

describe("test autostart", () => {
  test("it brings the tab and its window to the front", async () => {
    const { state, updated } = await openTabFull(`https://www.youtube.com/watch?v=${VIDEO}&ac_autostart=1`, true);
    expect(state).toBe("capturing");
    expect(updated).toContainEqual({ tab: 1, active: true });
    expect(updated).toContainEqual({ window: 7, focused: true });
  });

  test("a tab left paused by the last run is stopped and restarted as a new capture", async () => {
    const url = `https://www.youtube.com/watch?v=${VIDEO}&ac_autostart=1`;
    let first: string | undefined;
    const { state, captureId } = await openTabFull(url, true, async (c) => {
      first = (await sendPopup(c, { type: "start", tabId: 1 })).state?.captureId;
      await sendPopup(c, { type: "pause", tabId: 1 });
    });
    expect(state).toBe("capturing");
    expect(first).toBeDefined();
    expect(captureId).toBeDefined();
    expect(captureId).not.toBe(first);
  });

  test("flag on and the marker present: capture starts without a popup click", async () => {
    expect(await openTab(`https://www.youtube.com/watch?v=${VIDEO}&ac_autostart=1`, true)).toBe("capturing");
  });

  test("flag on but no marker: an ordinary watch tab is not captured", async () => {
    expect(await openTab(`https://www.youtube.com/watch?v=${VIDEO}`, true)).toBeNull();
  });

  test("flag off (the product build): the marker does nothing", async () => {
    expect(await openTab(`https://www.youtube.com/watch?v=${VIDEO}&ac_autostart=1`, false)).toBeNull();
  });
});
