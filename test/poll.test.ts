/** The polling loop behind the capture screen and the diagram panel, driven by a hand-cranked clock and fake reads. */
import { describe, expect, test } from "bun:test";
import { startPolling } from "../src/app/poll";
import type { PollTimers } from "../src/app/poll";

type Timer = { readonly fn: () => void; readonly ms: number; cancelled: boolean };

function clock() {
  const timers: Timer[] = [];
  const api: PollTimers = {
    set: (fn, ms) => { const t: Timer = { fn, ms, cancelled: false }; timers.push(t); return t; },
    clear: (h) => { (h as Timer).cancelled = true; },
  };
  const live = () => timers.filter((t) => !t.cancelled);
  return {
    api,
    scheduled: () => live().map((t) => t.ms),
    count: () => live().length,
    fire: () => { const t = live()[0]; if (t === undefined) throw new Error("no timer"); t.cancelled = true; t.fn(); },
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

type Read = { kind: "ok"; pending: boolean } | { kind: "fail" };

function harness(script: Read[], extra: { maxFailures?: number } = {}) {
  const c = clock();
  const log: string[] = [];
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const stop = startPolling<boolean>({
    read: async () => {
      const step = script[calls++];
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await settle();
      inFlight--;
      if (step === undefined || step.kind === "fail") throw new Error("network down");
      return step.pending;
    },
    pending: (p) => p,
    onResult: (p) => log.push(p ? "pending" : "done"),
    onError: (e) => log.push(`error: ${(e as Error).message}`),
    intervalMs: 1000,
    timers: c.api,
    ...extra,
  });
  return { c, log, stop, calls: () => calls, maxInFlight: () => maxInFlight };
}

describe("startPolling", () => {
  test("keeps polling after a failed read and stops at the terminal state", async () => {
    const h = harness([{ kind: "ok", pending: true }, { kind: "fail" }, { kind: "ok", pending: true }, { kind: "ok", pending: false }]);
    await settle();
    expect(h.log).toEqual(["pending"]);
    expect(h.c.scheduled()).toEqual([1000]);
    h.c.fire(); await settle();
    expect(h.log).toEqual(["pending", "error: network down"]);
    expect(h.c.count()).toBe(1);
    h.c.fire(); await settle();
    expect(h.log.at(-1)).toBe("pending");
    expect(h.c.scheduled()).toEqual([1000]);
    h.c.fire(); await settle();
    expect(h.log.at(-1)).toBe("done");
    expect(h.c.count()).toBe(0);
    expect(h.calls()).toBe(4);
    expect(h.maxInFlight()).toBe(1);
  });

  test("backs off after consecutive failures and resets after a success", async () => {
    const h = harness([{ kind: "fail" }, { kind: "fail" }, { kind: "fail" }, { kind: "ok", pending: true }, { kind: "fail" }]);
    await settle();
    expect(h.c.scheduled()).toEqual([2000]);
    h.c.fire(); await settle();
    expect(h.c.scheduled()).toEqual([4000]);
    h.c.fire(); await settle();
    expect(h.c.scheduled()).toEqual([8000]);
    h.c.fire(); await settle();
    expect(h.c.scheduled()).toEqual([1000]);
    h.c.fire(); await settle();
    expect(h.c.scheduled()).toEqual([2000]);
  });

  test("gives up after the failure bound and leaves the error for a manual retry", async () => {
    const h = harness([{ kind: "fail" }, { kind: "fail" }, { kind: "fail" }], { maxFailures: 3 });
    await settle(); h.c.fire(); await settle(); h.c.fire(); await settle();
    expect(h.log.filter((l) => l.startsWith("error"))).toHaveLength(3);
    expect(h.c.count()).toBe(0);
    expect(h.calls()).toBe(3);
  });

  test("never schedules when the first read is already terminal", async () => {
    const h = harness([{ kind: "ok", pending: false }]);
    await settle();
    expect(h.log).toEqual(["done"]);
    expect(h.c.count()).toBe(0);
  });

  test("stop cancels the timer and drops a read still in flight", async () => {
    const h = harness([{ kind: "ok", pending: true }, { kind: "ok", pending: true }]);
    await settle();
    h.c.fire();
    h.stop();
    await settle();
    expect(h.log).toEqual(["pending"]);
    expect(h.c.count()).toBe(0);
    const h2 = harness([{ kind: "ok", pending: true }]);
    await settle();
    expect(h2.c.count()).toBe(1);
    h2.stop();
    expect(h2.c.count()).toBe(0);
  });
});
