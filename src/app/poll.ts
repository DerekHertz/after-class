import { useCallback, useEffect, useState } from "react";

export type PollTimers = { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };

const REAL_TIMERS: PollTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export const MAX_FAILURES = 5;
export const MAX_BACKOFF_MS = 30_000;

export type PollOptions<T> = {
  readonly read: () => Promise<T>;
  /** Whether another read is needed after this result. */
  readonly pending: (result: T) => boolean;
  readonly onResult: (result: T) => void;
  readonly onError: (error: unknown) => void;
  readonly intervalMs: number;
  readonly maxFailures?: number;
  readonly timers?: PollTimers;
};

/**
 * Reads once now, then again after each completed read while `pending` holds. A failed read waits twice as long as the one before it,
 * up to `MAX_BACKOFF_MS`, and the loop gives up after `maxFailures` in a row so the error stays visible for a manual retry.
 * One read runs at a time and one timer exists at a time. The returned function stops the loop and drops any read still in flight.
 */
export function startPolling<T>(o: PollOptions<T>): () => void {
  const timers = o.timers ?? REAL_TIMERS;
  const maxFailures = o.maxFailures ?? MAX_FAILURES;
  let live = true;
  let failures = 0;
  let timer: unknown = null;

  const schedule = (ms: number) => { timer = timers.set(run, ms); };

  function run() {
    timer = null;
    o.read().then(
      (result) => {
        if (!live) return;
        failures = 0;
        o.onResult(result);
        if (o.pending(result)) schedule(o.intervalMs);
      },
      (e: unknown) => {
        if (!live) return;
        failures += 1;
        o.onError(e);
        if (failures < maxFailures) schedule(Math.min(o.intervalMs * 2 ** failures, MAX_BACKOFF_MS));
      },
    );
  }

  run();
  return () => {
    live = false;
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
}

export type Polled<T> = {
  readonly data: T | null;
  readonly error: string | null;
  /** Reads again now and restarts the loop, which also clears a gave-up state. */
  readonly reload: () => void;
  /** Replaces the data with a result learned elsewhere. */
  readonly setData: (next: (prev: T | null) => T | null) => void;
  readonly setError: (error: string | null) => void;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `load`, kept fresh while `pending` holds, and kept going through failed reads. Keeps the last data when a read fails. */
export function usePolled<T>(load: () => Promise<T>, pending: (data: T) => boolean, intervalMs: number): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(
    () => startPolling<T>({
      read: load,
      pending,
      onResult: (next) => { setData(next); setError(null); },
      onError: (e) => setError(message(e)),
      intervalMs,
    }),
    [load, pending, intervalMs, tick],
  );
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload, setData, setError };
}
