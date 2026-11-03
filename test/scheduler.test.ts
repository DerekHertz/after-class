import { describe, expect, test } from "bun:test";
import type { MemoKey } from "../src/shared/ids";
import type { Provider, Purpose } from "../src/shared/domain";
import { createScheduler } from "../src/backend/scheduler";
import type { SchedulerLimits, SchedulerOptions, Timers, WorkItem } from "../src/backend/scheduler";
import { createInterleave, raceAt } from "./interleave";

const k = (s: string) => s as MemoKey;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Manual clock: nothing fires until `advance`, so debounce and sweep timing are exact. */
function fakeClock() {
  let nowMs = 1_000;
  type Timer = { at: number; fn: () => void; every: number | null; live: boolean };
  const timers: Timer[] = [];
  const add = (ms: number, fn: () => void, every: number | null) => {
    const t: Timer = { at: nowMs + ms, fn, every, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  };
  const api: Timers = { after: (ms, fn) => add(ms, fn, null), every: (ms, fn) => add(ms, fn, ms) };
  return {
    now: () => nowMs,
    timers: api,
    set: (ms: number) => {
      nowMs = ms;
    },
    liveTimers: () => timers.filter((t) => t.live).length,
    async advance(ms: number) {
      const end = nowMs + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        nowMs = Math.max(nowMs, due.at);
        if (due.every === null) due.live = false;
        else due.at += due.every;
        due.fn();
        await flush();
      }
      nowMs = end;
    },
  };
}

type Spec = { key: string; purpose: Purpose; provider: Provider };

/**
 * A fake world: `wanted` is the demand (a pure function of state, as in production).
 * An item stays demanded until its run finishes; run holds on a gate the test opens.
 */
function world() {
  const wanted = new Map<string, Spec>();
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  const finished: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const live = { jev: 0, claude: 0 };
  const max = { jev: 0, claude: 0 };

  const item = (s: Spec): WorkItem => ({
    key: k(s.key),
    purpose: s.purpose,
    provider: s.provider,
    async run(signal) {
      started.push(s.key);
      signals.set(s.key, signal);
      live[s.provider]++;
      max[s.provider] = Math.max(max[s.provider], live[s.provider]);
      try {
        await new Promise<void>((resolve, reject) => {
          gates.set(s.key, resolve);
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
        wanted.delete(s.key);
        finished.push(s.key);
      } finally {
        live[s.provider]--;
        gates.delete(s.key);
      }
    },
  });

  return {
    wanted,
    started,
    finished,
    live,
    max,
    signals,
    want: (key: string, purpose: Purpose = "interpretation", provider: Provider = "jev") => wanted.set(key, { key, purpose, provider }),
    source: (): readonly WorkItem[] => [...wanted.values()].map(item),
    release: (key: string) => gates.get(key)?.(),
    releaseAll: () => [...gates.values()].forEach((g) => g()),
  };
}

const LIMITS: SchedulerLimits = { jev: 4, claude: 2 };

function setup(w: ReturnType<typeof world>, limits: SchedulerLimits = LIMITS, opts: SchedulerOptions = {}, extra: (() => readonly WorkItem[])[] = []) {
  const clock = fakeClock();
  const errors: unknown[] = [];
  const scheduler = createScheduler([w.source, ...extra], limits, { now: clock.now, timers: clock.timers, onError: (_, e) => errors.push(e), ...opts });
  return { clock, scheduler, errors };
}

describe("scheduler: bounded concurrency", () => {
  test("runs more items than the limit and never exceeds it per provider", async () => {
    const w = world();
    for (let i = 0; i < 13; i++) w.want(`j${i}`, "claim_check", "jev");
    for (let i = 0; i < 7; i++) w.want(`c${i}`, "interpretation", "claude");
    const { scheduler, clock } = setup(w);

    scheduler.pump();
    expect(w.live).toEqual({ jev: 4, claude: 2 });
    expect(scheduler.inflight()).toHaveLength(6);

    for (let guard = 0; w.wanted.size > 0 && guard < 100; guard++) {
      w.releaseAll();
      await flush();
      await clock.advance(50);
    }
    expect(w.wanted.size).toBe(0);
    expect(w.max).toEqual({ jev: 4, claude: 2 });
    expect(w.finished).toHaveLength(20);
    expect(new Set(w.started).size).toBe(20);
  });

  test("a capture's demand drains to empty with nothing left in flight", async () => {
    const w = world();
    for (let i = 0; i < 9; i++) w.want(`k${i}`, i % 2 ? "frame_change" : "claim_check", "jev");
    const { scheduler, clock } = setup(w);
    scheduler.pump();
    for (let guard = 0; w.wanted.size > 0 && guard < 50; guard++) {
      w.releaseAll();
      await flush();
      await clock.advance(50);
    }
    expect(w.source()).toEqual([]);
    expect(scheduler.inflight()).toEqual([]);
  });

  test("an inflight key is never dispatched twice, even when two sources demand it", async () => {
    const w = world();
    w.want("same", "boundary");
    const { scheduler } = setup(w, LIMITS, {}, [w.source]);
    scheduler.pump();
    scheduler.pump();
    expect(w.started).toEqual(["same"]);
  });

  test("a completion frees its slot for the next item after the debounce", async () => {
    const w = world();
    for (let i = 0; i < 3; i++) w.want(`k${i}`, "claim_check");
    const { scheduler, clock } = setup(w, { jev: 2, claude: 1 });
    scheduler.pump();
    expect(w.started).toEqual(["k0", "k1"]);
    w.release("k0");
    await flush();
    expect(w.started).toEqual(["k0", "k1"]);
    await clock.advance(49);
    expect(w.started).toHaveLength(2);
    await clock.advance(1);
    expect(w.started).toEqual(["k0", "k1", "k2"]);
  });

  test("completions inside one debounce window share a single pump", async () => {
    const w = world();
    for (let i = 0; i < 4; i++) w.want(`k${i}`, "claim_check");
    let reads = 0;
    const { scheduler, clock } = setup(w, LIMITS, {}, [() => (reads++, [])]);
    scheduler.pump();
    const before = reads;
    w.releaseAll();
    await flush();
    await clock.advance(50);
    expect(reads - before).toBe(1);
  });
});

describe("scheduler: priority", () => {
  test("boundary, then frame judgments, then claim checks and revisions, then interpretation, then resource search", async () => {
    const w = world();
    w.want("res", "resource_search", "jev");
    w.want("int", "interpretation", "jev");
    w.want("rev", "claim_revision", "jev");
    w.want("chk", "claim_check", "jev");
    w.want("frm", "frame_change", "jev");
    w.want("bnd", "boundary", "jev");
    const { scheduler, clock } = setup(w, { jev: 1, claude: 1 });

    scheduler.pump();
    for (let guard = 0; w.finished.length < 6 && guard < 20; guard++) {
      w.releaseAll();
      await flush();
      await clock.advance(50);
    }
    expect(w.started.slice(0, 2)).toEqual(["bnd", "frm"]);
    expect(new Set(w.started.slice(2, 4))).toEqual(new Set(["chk", "rev"]));
    expect(w.started.slice(4)).toEqual(["int", "res"]);
  });

  test("a later higher-priority item takes the next free slot ahead of waiting lower ones", async () => {
    const w = world();
    w.want("int1", "interpretation");
    w.want("int2", "interpretation");
    const { scheduler, clock } = setup(w, { jev: 1, claude: 1 });
    scheduler.pump();
    w.want("bnd", "boundary");
    w.release("int1");
    await flush();
    await clock.advance(50);
    expect(w.started).toEqual(["int1", "bnd"]);
  });

  test('R6: "A pending resource search never blocks a review that is otherwise ready." A held search leaves other work running and never takes its provider\'s last slot', async () => {
    const w = world();
    w.want("search1", "resource_search", "claude");
    w.want("search2", "resource_search", "claude");
    const { scheduler, clock } = setup(w, { jev: 2, claude: 2 });

    scheduler.pump();
    expect(w.started).toEqual(["search1"]);

    w.want("check", "claim_check", "jev");
    w.want("interp", "interpretation", "claude");
    scheduler.pump();
    expect(w.started).toEqual(["search1", "check", "interp"]);

    w.release("check");
    w.release("interp");
    await flush();
    await clock.advance(50);
    expect(w.finished).toEqual(["check", "interp"]);
    expect(scheduler.inflight().map((i) => i.key)).toContain(k("search1"));
    expect(w.wanted.has("search1")).toBe(true);
  });

  test("with a single slot a lone resource search still runs", () => {
    const w = world();
    w.want("search", "resource_search", "claude");
    const { scheduler } = setup(w, { jev: 1, claude: 1 });
    scheduler.pump();
    expect(w.started).toEqual(["search"]);
  });
});

describe("scheduler: abort what is no longer demanded", () => {
  test('R5/R8: stop-early removes demand, the inflight call is aborted, and its late result is not applied or restarted', async () => {
    const w = world();
    w.want("a", "interpretation");
    w.want("b", "interpretation");
    const { scheduler, clock } = setup(w);
    scheduler.pump();
    expect(w.live.jev).toBe(2);

    w.wanted.delete("a");
    scheduler.pump();
    expect(w.signals.get("a")?.aborted).toBe(true);
    expect(w.signals.get("b")?.aborted).toBe(false);
    await flush();
    expect(scheduler.inflight().map((i) => i.key)).toEqual([k("b")]);
    expect(w.finished).toEqual([]);

    await clock.advance(50);
    expect(w.started).toEqual(["a", "b"]);
    expect(scheduler.estimateSeconds(["interpretation"])).toBeNull();
  });

  test("an aborted call still holds its provider slot until it settles", async () => {
    const w = world();
    const stubborn: WorkItem = {
      key: k("stuck"),
      purpose: "boundary",
      provider: "claude",
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    };
    let demanded = true;
    const { scheduler } = setup(w, { jev: 1, claude: 1 }, {}, [() => (demanded ? [stubborn] : [])]);
    w.want("next", "interpretation", "claude");
    scheduler.pump();
    expect(scheduler.inflight().map((i) => i.key)).toEqual([k("stuck")]);
    demanded = false;
    scheduler.pump();
    expect(scheduler.inflight().map((i) => i.key)).toEqual([k("stuck")]);
    expect(w.started).toEqual([]);
    await new Promise((r) => setTimeout(r, 40));
    scheduler.pump();
    expect(w.started).toEqual(["next"]);
  });
});

describe("scheduler: crash and repump", () => {
  test("a restarted scheduler runs only what the durable state still demands", async () => {
    const w = world();
    for (const key of ["a", "b", "c", "d"]) w.want(key, "claim_check");
    const first = setup(w, { jev: 2, claude: 1 });
    first.scheduler.pump();
    w.release("a");
    await flush();
    expect(w.finished).toEqual(["a"]);

    await first.scheduler.stop();
    expect(first.scheduler.inflight()).toEqual([]);
    expect(w.signals.get("b")?.aborted).toBe(true);

    const second = setup(w, { jev: 2, claude: 1 });
    second.scheduler.pump();
    expect(w.started).toEqual(["a", "b", "b", "c"]);
    w.releaseAll();
    await flush();
    for (let guard = 0; w.wanted.size > 0 && guard < 10; guard++) {
      await second.clock.advance(50);
      w.releaseAll();
      await flush();
    }
    expect(w.finished.sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("stop() cancels the debounce so no pump runs afterward", async () => {
    const w = world();
    w.want("a", "claim_check");
    const { scheduler, clock } = setup(w);
    scheduler.pump();
    w.release("a");
    await flush();
    await scheduler.stop();
    w.want("late", "claim_check");
    await clock.advance(1000);
    scheduler.pump();
    expect(w.started).toEqual(["a"]);
  });
});

describe("scheduler: a delta racing a stale demand snapshot", () => {
  /** Two chunk revisions each demand a delta over the same uncovered material; running one covers it. */
  function deltas() {
    let covered = false;
    const ran: string[] = [];
    const doubleRuns: string[] = [];
    const delta = (rev: string): WorkItem => ({
      key: k(`delta-${rev}`),
      purpose: "interpretation",
      provider: "jev",
      async run() {
        if (covered) doubleRuns.push(rev);
        covered = true;
        ran.push(rev);
        await new Promise<void>(() => {});
      },
    });
    const source = (il?: ReturnType<typeof createInterleave>) => (): readonly WorkItem[] => {
      const snapshot = covered ? [] : [delta("r1"), delta("r2")];
      il?.at("after-snapshot");
      return snapshot;
    };
    return { delta, source, ran, doubleRuns };
  }

  test("two deltas from one snapshot over the same material: only the first runs", () => {
    const d = deltas();
    const s = createScheduler([d.source()], LIMITS);
    s.pump();
    expect(d.ran).toEqual(["r1"]);
    expect(d.doubleRuns).toEqual([]);
  });

  test("another actor covers the material between the snapshot and the start: the stale delta does not run", async () => {
    const d = deltas();
    const result = await raceAt(
      "after-snapshot",
      (il) => {
        const s = createScheduler([d.source(il)], LIMITS);
        s.pump();
        return s.inflight().map((i) => i.key);
      },
      () => {
        void d.delta("r2").run(new AbortController().signal);
      },
    );
    expect(d.ran).toEqual(["r2"]);
    expect(d.doubleRuns).toEqual([]);
    expect(result.first).toEqual([]);
  });
});

describe("scheduler: reentrancy", () => {
  test("a source that triggers pump() mid-collect does not nest or exceed the limit", () => {
    const w = world();
    for (let i = 0; i < 8; i++) w.want(`k${i}`, "claim_check");
    const il = createInterleave();
    const clock = fakeClock();
    const scheduler = createScheduler(
      [
        () => {
          il.at("collect");
          return w.source();
        },
      ],
      { jev: 3, claude: 1 },
      { now: clock.now, timers: clock.timers },
    );
    il.on("collect", () => scheduler.pump());
    scheduler.pump();
    expect(il.fired("collect")).toBe(1);
    expect(w.max.jev).toBe(3);
    expect(w.started).toHaveLength(3);
  });
});

describe("scheduler: failures", () => {
  test("a run that throws is reported and left alone for the cooldown, not retried in a hot loop", async () => {
    let calls = 0;
    const bad: WorkItem = {
      key: k("bad"),
      purpose: "claim_check",
      provider: "jev",
      run: async () => {
        calls++;
        throw new Error("db write failed");
      },
    };
    const clock = fakeClock();
    const errors: string[] = [];
    const scheduler = createScheduler([() => [bad]], LIMITS, { now: clock.now, timers: clock.timers, cooldownMs: 1000, onError: (where) => errors.push(where) });
    scheduler.pump();
    await flush();
    await clock.advance(50);
    await clock.advance(500);
    expect(calls).toBe(1);
    expect(errors).toEqual(["bad"]);
    await clock.advance(600);
    scheduler.pump();
    expect(calls).toBe(2);
  });
});

describe("scheduler: estimateSeconds", () => {
  async function complete(w: ReturnType<typeof world>, scheduler: ReturnType<typeof setup>["scheduler"], clock: ReturnType<typeof fakeClock>, n: number, purpose: Purpose, provider: Provider, takesMs: number, prefix: string) {
    for (let i = 0; i < n; i++) {
      w.want(`${prefix}${i}`, purpose, provider);
      scheduler.pump();
      clock.set(clock.now() + takesMs);
      w.release(`${prefix}${i}`);
      await flush();
      await clock.advance(50);
    }
  }

  test("null until every pending purpose has five completed samples", async () => {
    const w = world();
    const { scheduler, clock } = setup(w, { jev: 2, claude: 1 });
    expect(scheduler.estimateSeconds(["claim_check"])).toBeNull();
    await complete(w, scheduler, clock, 4, "claim_check", "jev", 2000, "a");
    expect(scheduler.estimateSeconds(["claim_check"])).toBeNull();
    await complete(w, scheduler, clock, 1, "claim_check", "jev", 2000, "b");
    expect(scheduler.estimateSeconds(["claim_check"])).toBe(2);
    expect(scheduler.estimateSeconds(["claim_check", "interpretation"])).toBeNull();
  });

  test("averages per purpose and spreads each provider's total across its limit", async () => {
    const w = world();
    const { scheduler, clock } = setup(w, { jev: 2, claude: 1 });
    await complete(w, scheduler, clock, 5, "claim_check", "jev", 4000, "a");
    await complete(w, scheduler, clock, 5, "interpretation", "claude", 10_000, "b");
    expect(scheduler.estimateSeconds(["claim_check", "claim_check", "claim_check", "claim_check"])).toBe(8);
    expect(scheduler.estimateSeconds(["claim_check", "interpretation"])).toBe(10);
    expect(scheduler.estimateSeconds([])).toBe(0);
  });
});

describe("scheduler: sweepExpired timer", () => {
  test("runs at start and then daily, and stops with the scheduler", async () => {
    const w = world();
    let sweeps = 0;
    const { scheduler, clock } = setup(w, LIMITS, { sweep: { run: () => void sweeps++ } });
    expect(sweeps).toBe(1);
    await clock.advance(24 * 60 * 60 * 1000 - 1);
    expect(sweeps).toBe(1);
    await clock.advance(1);
    expect(sweeps).toBe(2);
    await clock.advance(24 * 60 * 60 * 1000);
    expect(sweeps).toBe(3);
    await scheduler.stop();
    expect(clock.liveTimers()).toBe(0);
    await clock.advance(3 * 24 * 60 * 60 * 1000);
    expect(sweeps).toBe(3);
  });

  test("a sweep that throws is reported and does not stop the schedule", async () => {
    const w = world();
    let sweeps = 0;
    const errors: string[] = [];
    const { clock } = setup(w, LIMITS, {
      sweep: {
        run: () => {
          sweeps++;
          throw new Error("disk");
        },
        everyMs: 1000,
      },
      onError: (where) => errors.push(where),
    });
    await clock.advance(2000);
    expect(sweeps).toBe(3);
    expect(errors).toEqual(["sweepExpired", "sweepExpired", "sweepExpired"]);
  });
});
