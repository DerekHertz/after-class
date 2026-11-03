/**
 * Offline test harness. No test in this repo calls Jev or Claude: every Task
 * under test is a FakeTask whose answers are scripted per input.
 *
 *   const t = fakeTask<{ w: string }, string>({ purpose: "boundary", answer: (i) => ok(`judged ${i.w}`) });
 *   const memo = createMemo(testDb(), "live", { retryDelayMs: () => 0 });
 *   await memo.run(t, { w: "a" });             // t.calls has one entry
 */
import type { Cost, Provider, Purpose, Seq } from "../src/shared/domain";
import type { IdPart } from "../src/shared/ids";
import { asSeq, openDb } from "../src/backend/db";
import type { Db } from "../src/backend/db";
import { ProviderError } from "../src/backend/providers/memo";
import type { AttemptContext, Task, UsageReport } from "../src/backend/providers/memo";

export function testDb(): Db {
  return openDb(":memory:");
}

export function testSeq(n: number): Seq {
  return asSeq(n);
}

export type FakeStep<O> =
  | { readonly kind: "ok"; readonly output: O; readonly usage: UsageReport; readonly deltas: readonly string[] }
  | { readonly kind: "error"; readonly message: string; readonly retryable: boolean; readonly usage: UsageReport | null };

export const UNKNOWN_COST: Cost = { kind: "unknown", reason: "fake provider" };

export function usage(cost: Cost = UNKNOWN_COST, model = "fake-model"): UsageReport {
  return { model, inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cost };
}

export function ok<O>(output: O, opts: { usage?: UsageReport; deltas?: readonly string[] } = {}): FakeStep<O> {
  return { kind: "ok", output, usage: opts.usage ?? usage(), deltas: opts.deltas ?? [] };
}

export function fail(message: string, opts: { retryable?: boolean; usage?: UsageReport | null } = {}): FakeStep<never> {
  return { kind: "error", message, retryable: opts.retryable ?? false, usage: opts.usage ?? null };
}

export type FakeTask<I, O> = Task<I, O> & {
  /** Every attempt's input, in call order. */
  readonly calls: I[];
};

/**
 * A Task whose attempt returns the scripted step for (input, attemptNo).
 * `answer` may return a promise the test controls, to hold a call in flight.
 * The attempt honours abort: it rejects as soon as the signal fires.
 */
export function fakeTask<I extends IdPart, O>(opts: {
  readonly purpose?: Purpose;
  readonly provider?: Provider;
  readonly model?: string;
  readonly version?: string;
  readonly maxAttempts?: number;
  readonly answer: (input: I, attemptNo: number) => FakeStep<O> | Promise<FakeStep<O>>;
  readonly decode?: (stored: unknown) => O;
}): FakeTask<I, O> {
  const calls: I[] = [];
  return {
    provider: opts.provider ?? "jev",
    purpose: opts.purpose ?? "boundary",
    model: opts.model ?? "fake-model",
    version: opts.version ?? "v1",
    maxAttempts: opts.maxAttempts ?? 3,
    calls,
    canonicalInput: (input) => input,
    decode: opts.decode ?? ((stored) => stored as O),
    async attempt(input: I, ctx: AttemptContext) {
      calls.push(input);
      const aborted = new Promise<never>((_, reject) => {
        if (ctx.signal.aborted) reject(new DOMException("aborted", "AbortError"));
        ctx.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      aborted.catch(() => {});
      const step = await Promise.race([Promise.resolve(opts.answer(input, calls.length)), aborted]);
      if (step.kind === "error") throw new ProviderError(step.message, step.usage, step.retryable);
      for (const d of step.deltas) ctx.streamTo?.(d);
      return { output: step.output, usage: step.usage };
    },
  };
}

/** A promise plus its resolver, for holding a fake call in flight. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
