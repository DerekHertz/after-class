/** The test-only autostart (AFTERCLASS_TEST_AUTOSTART=1): only a watch page opened with ac_autostart=1 starts capture, and only when the flag is on. */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { boot, connectPort, newEnv, restoreGlobals, sendPopup, wait } from "./worker-harness";

afterAll(restoreGlobals);
const flag = globalThis as unknown as { __AFTERCLASS_TEST_AUTOSTART__?: boolean };
afterEach(() => {
  delete flag.__AFTERCLASS_TEST_AUTOSTART__;
});

const VIDEO = "dQw4w9WgXcQ";

async function openTab(url: string, on: boolean) {
  if (on) flag.__AFTERCLASS_TEST_AUTOSTART__ = true;
  const env = newEnv();
  env.urls[1] = url;
  const { c } = await boot(env);
  connectPort(c, 1);
  c.tabs.onUpdated.fire(1, { status: "complete" }, { url });
  await wait(80);
  const state = (await sendPopup(c, { type: "status", tabId: 1 })).state?.state ?? null;
  // Let this worker's uploads finish before the next test swaps the fake chrome out from under it.
  await sendPopup(c, { type: "stop", tabId: 1 });
  await wait(200);
  return state;
}

describe("test autostart", () => {
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
