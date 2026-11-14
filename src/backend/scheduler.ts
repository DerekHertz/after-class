/**
 * Demand-driven scheduler (W10, composition phase). There is NO job table.
 *
 *   pump():
 *     collect demand from every source (composition wires one per capture and module:
 *       segmentation.sync → boundary windows, evidence.frameDemand, preparation.demand)
 *     dispatch items whose key is not inflight, ≤ limits per provider, best priority first
 *     abort inflight items no longer demanded
 *     on each completion → pump() again (debounced)
 *
 * Why this is safe:
 *  - Demand is a pure function of facts + memo; memo.run is single-flight per key.
 *  - Crash: restart and pump. Finished keys hit the memo; the rest re-run.
 *  - Cancellation: stopEarly writes a fact; the next demand excludes those items,
 *    and the scheduler aborts inflight items no longer demanded. The scheduler never
 *    reads a result: derivations apply it through `appliesBefore`.
 *  - R5: "Choosing Later never cancels preparation." This file never imports review/.
 *  - Budgets: a run that resolves `held` (memo.ts) made no call. Its key is left alone for `heldRetryMs` and a pump is
 *    set for then, so held work is asked again when the stop switch is off or a new month starts, without a busy loop.
 *
 * Priority: boundary windows > frame judgments > claim checks/revisions >
 * interpretation > resource search.
 * R6: "A pending resource search never blocks a review that is otherwise ready."
 * It sits last and has no effect on any other item: nothing waits for it.
 */
import type { MemoKey } from "../shared/ids";
import type { Provider, Purpose } from "../shared/domain";

export type WorkItem = {
  readonly key: MemoKey;
  readonly purpose: Purpose;
  readonly provider: Provider;
  run(signal: AbortSignal): Promise<unknown>; // = memo.run(task, input, { signal })
};

/** memo.run's answer when a budget refused the attempt. The only part of a result the scheduler reads. */
const isHeld = (result: unknown): boolean => typeof result === "object" && result !== null && (result as { readonly kind?: unknown }).kind === "held";

export type SchedulerLimits = { readonly jev: number; readonly claude: number }; // starting values: 4, 2

export type Scheduler = {
  pump(): void;
  inflight(): readonly { readonly key: MemoKey; readonly purpose: Purpose; readonly startedAtMs: number }[];
  /** Processing estimate only when ≥ 5 completed samples for every pending purpose (flow C "estimate only when reliable"). */
  estimateSeconds(pending: readonly Purpose[]): number | null;
  stop(): Promise<void>;
};

export type Timers = {
  after(ms: number, fn: () => void): () => void;
  every(ms: number, fn: () => void): () => void;
};

export type SchedulerOptions = {
  /** Delay after a completion before the next pump; completions inside it share one pump. Default 50. */
  readonly debounceMs?: number;
  /** Runs once now and then every `everyMs` (default 24 h): composition passes `() => evidence.sweepExpired(Date.now(), days)`. */
  readonly sweep?: { readonly run: () => void; readonly everyMs?: number };
  /** How long a key whose run threw is left alone. memo.run records provider failures itself and resolves; a throw is something else. Default 5000. */
  readonly cooldownMs?: number;
  /** How long a key whose run a budget held back is left alone before it is asked again. Default 60000. */
  readonly heldRetryMs?: number;
  readonly now?: () => number;
  readonly timers?: Timers;
  /** `where` is the failing item's key, or "sweepExpired". */
  readonly onError?: (where: string, error: unknown) => void;
};

export const DEFAULT_LIMITS: SchedulerLimits = { jev: 4, claude: 2 };
export const MIN_ESTIMATE_SAMPLES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const PRIORITY: Readonly<Record<Purpose, number>> = {
  boundary: 0,
  frame_change: 1,
  claim_check: 2,
  claim_revision: 2,
  interpretation: 3,
  resource_search: 4,
  tutor_turn: 5,
  wrap_up: 5,
  diagram_summary: 5,
  cache_keepalive: 5,
};

const realTimers: Timers = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
  every(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref?.();
    return () => clearInterval(t);
  },
};

type Running = {
  readonly key: MemoKey;
  readonly purpose: Purpose;
  readonly provider: Provider;
  readonly startedAtMs: number;
  readonly controller: AbortController;
  readonly done: Promise<void>;
};

export function createScheduler(
  sources: readonly (() => readonly WorkItem[])[],
  limits: SchedulerLimits,
  options: SchedulerOptions = {},
): Scheduler {
  const debounceMs = options.debounceMs ?? 50;
  const cooldownMs = options.cooldownMs ?? 5000;
  const heldRetryMs = options.heldRetryMs ?? 60_000;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;

  const running = new Map<MemoKey, Running>();
  const coolingUntil = new Map<MemoKey, number>();
  const samples = new Map<Purpose, { readonly provider: Provider; readonly ms: number[] }>();
  let stopped = false;
  let pumping = false;
  let again = false;
  let cancelDebounce: (() => void) | null = null;
  let cancelWake: (() => void) | null = null;
  const heldKeys = new Set<MemoKey>();

  /** Every source, deduplicated by key, ordered by priority then source order. */
  function collect(): Map<MemoKey, WorkItem> {
    const out = new Map<MemoKey, WorkItem>();
    for (const source of sources) for (const item of source()) if (!out.has(item.key)) out.set(item.key, item);
    return out;
  }

  const inUse = (provider: Provider) => [...running.values()].filter((r) => r.provider === provider).length;

  /** Resource search is the slowest, least urgent work: it never takes a provider's last slot, so a search cannot hold up interpretation or checks (R6). */
  const hasRoom = (item: WorkItem): boolean => {
    const limit = limits[item.provider];
    if (inUse(item.provider) >= limit) return false;
    if (item.purpose !== "resource_search") return true;
    const searching = [...running.values()].filter((r) => r.provider === item.provider && r.purpose === "resource_search").length;
    return searching < Math.max(1, limit - 1);
  };

  function next(demand: ReadonlyMap<MemoKey, WorkItem>): WorkItem | null {
    const at = now();
    let best: WorkItem | null = null;
    for (const item of demand.values()) {
      if (running.has(item.key) || (coolingUntil.get(item.key) ?? 0) > at || !hasRoom(item)) continue;
      if (best === null || PRIORITY[item.purpose] < PRIORITY[best.purpose]) best = item;
    }
    return best;
  }

  function start(item: WorkItem): void {
    const controller = new AbortController();
    const startedAtMs = now();
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // registered before run so a run that throws synchronously still gets its slot freed by the finally below
    running.set(item.key, { key: item.key, purpose: item.purpose, provider: item.provider, startedAtMs, controller, done });
    void (async () => {
      try {
        const result = await item.run(controller.signal);
        if (isHeld(result)) {
          coolingUntil.set(item.key, now() + heldRetryMs);
          heldKeys.add(item.key);
          wakeAfterHold();
        } else if (!controller.signal.aborted) {
          const s = samples.get(item.purpose) ?? { provider: item.provider, ms: [] };
          s.ms.push(now() - startedAtMs);
          samples.set(item.purpose, s);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          coolingUntil.set(item.key, now() + cooldownMs);
          options.onError?.(item.key, error);
        }
      } finally {
        running.delete(item.key);
        finish();
        if (!stopped) schedulePump();
      }
    })();
  }

  /** One timer for every held key: when the first one's wait is over, all of them are asked again in one pump. */
  function wakeAfterHold(): void {
    if (cancelWake || stopped) return;
    cancelWake = timers.after(heldRetryMs, () => {
      cancelWake = null;
      for (const key of heldKeys) coolingUntil.delete(key);
      heldKeys.clear();
      pump();
    });
  }

  function schedulePump(): void {
    if (cancelDebounce) return;
    cancelDebounce = timers.after(debounceMs, () => {
      cancelDebounce = null;
      pump();
    });
  }

  function abortUndemanded(demand: ReadonlyMap<MemoKey, WorkItem>): void {
    for (const r of running.values()) if (!demand.has(r.key) && !r.controller.signal.aborted) r.controller.abort();
  }

  function pump(): void {
    if (stopped) return;
    // A source may write a fact whose hook pumps again; fold that into one more pass.
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        for (;;) {
          const demand = collect();
          abortUndemanded(demand);
          const pick = next(demand);
          if (pick === null) break;
          // Starting one item can cover another's material (a delta over the same span),
          // so confirm against a fresh read that the pick is still demanded.
          const fresh = collect().get(pick.key);
          if (fresh) start(fresh);
        }
      } while (again && !stopped);
    } finally {
      pumping = false;
    }
  }

  const stopSweep = options.sweep
    ? (() => {
        const run = () => {
          try {
            options.sweep!.run();
          } catch (error) {
            options.onError?.("sweepExpired", error);
          }
        };
        run();
        return timers.every(options.sweep.everyMs ?? DAY_MS, run);
      })()
    : null;

  return {
    pump,
    inflight: () => [...running.values()].map(({ key, purpose, startedAtMs }) => ({ key, purpose, startedAtMs })),
    estimateSeconds(pending) {
      const perProvider = new Map<Provider, { total: number; longest: number }>();
      for (const purpose of pending) {
        const s = samples.get(purpose);
        if (!s || s.ms.length < MIN_ESTIMATE_SAMPLES) return null;
        const mean = s.ms.reduce((a, b) => a + b, 0) / s.ms.length;
        const p = perProvider.get(s.provider) ?? { total: 0, longest: 0 };
        perProvider.set(s.provider, { total: p.total + mean, longest: Math.max(p.longest, mean) });
      }
      // Providers drain in parallel; within one, items share its slots but no item finishes faster than itself.
      let ms = 0;
      for (const [provider, p] of perProvider) ms = Math.max(ms, p.longest, p.total / Math.max(1, limits[provider]));
      return Math.ceil(ms / 1000);
    },
    async stop() {
      stopped = true;
      cancelDebounce?.();
      cancelDebounce = null;
      cancelWake?.();
      cancelWake = null;
      stopSweep?.();
      const pending = [...running.values()];
      for (const r of pending) r.controller.abort();
      await Promise.all(pending.map((r) => r.done));
    },
  };
}
