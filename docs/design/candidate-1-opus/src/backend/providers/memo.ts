/**
 * THE way to call a model. Every provider call in the system is a memoized,
 * ledgered, single-flight function of its exact input.
 *
 *   key = stableId("key", task.purpose, task.version, task.model, task.canonicalInput(input))
 *
 * Consequences the rest of the design leans on:
 *  - Cache reuse (flow B "already-judged windows", flow C "valid cache hit") is
 *    not a feature, it's the call path. Rewatch = same key = no call.
 *  - Staleness is structurally impossible (R8, "outdated"): a result is stored
 *    under the key of the input it was computed from. Derivations look up the key
 *    of the CURRENT input, so an outdated job's result is never selected.
 *  - Cancellation (R8, "cancelled") is a fact with a Seq; derivations ignore
 *    results whose `atSeq` is after the cancellation that covers them. The late
 *    result is still stored ("logged, never applied").
 *  - Crash halfway: nothing to recover. On boot the scheduler re-derives demand;
 *    finished keys hit, unfinished keys re-run.
 *  - R17: `run` writes the usage event in the same transaction as the result
 *    (or the failure). There is no other exported way to reach a provider.
 *  - Replay sample: open a DB with `mode: "replay"`; misses throw instead of calling.
 *
 * Usage:
 *   const r = memo.lookup(boundaryTask, window);          // sync, for derivations
 *   if (r.kind === "missing") await memo.run(boundaryTask, window, signal);
 */
import type { MemoKey } from "../../shared/ids";
import type { IdPart } from "../../shared/ids";
import type { Cost, Purpose, Seq, UsageEvent } from "../../shared/domain";
import type { Db } from "../db";

/** What a provider adapter reports for one attempt. Missing numbers stay null. */
export type UsageReport = {
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cost: Cost;
};

/** A provider failure that still produced a usage report (e.g. HTTP 500 after tokens were billed). */
export class ProviderError extends Error {
  constructor(message: string, readonly usage: UsageReport | null, readonly retryable: boolean) {
    super(message);
  }
}

/**
 * A task is domain knowledge (what to ask, how to read the answer) bound to a
 * provider adapter. Tasks are defined next to the domain that owns them; Jev
 * tasks are all in jev-tasks.ts (one versioned module, per spec).
 */
export type Task<I, O> = {
  readonly purpose: Purpose;
  readonly provider: "jev" | "claude";
  readonly model: string;
  /** Bump when wording, criteria, thresholds or output schema change. */
  readonly version: string;
  /** Exactly what the provider will see, canonicalised. Two inputs with equal canonical form MUST be the same call. */
  canonicalInput(input: I): IdPart;
  /** Max attempts before the key is marked failed (terminal until a user retry clears it). */
  readonly maxAttempts: number;
  /** Perform one attempt. Throw ProviderError on failure. */
  attempt(input: I, signal: AbortSignal): Promise<{ output: O; usage: UsageReport }>;
  /** Re-validate stored output on read (zod), so a schema change can't feed old shapes to new code. */
  decode(stored: unknown): O;
};

export type Lookup<O> =
  | { kind: "hit"; key: MemoKey; value: O; atSeq: Seq }
  | { kind: "failed"; key: MemoKey; attempts: number; lastError: string; atSeq: Seq }
  | { kind: "inflight"; key: MemoKey }
  | { kind: "missing"; key: MemoKey };

/** Lookup function type passed into pure derivations, so they stay pure and testable with a Map. */
export type LookupFn = <I, O>(task: Task<I, O>, input: I) => Lookup<O>;

export type Memo = {
  key<I>(task: Task<I, unknown>, input: I): MemoKey;
  lookup: LookupFn;
  /**
   * Single-flight: concurrent runs of one key share a promise.
   * Transaction per attempt: INSERT memo row (or failure row) + INSERT usage event.
   * `streamTo` receives raw text deltas for streaming tasks (tutor speech); the
   * stored value is still the final parsed output.
   */
  run<I, O>(task: Task<I, O>, input: I, opts?: { signal?: AbortSignal; streamTo?: (delta: string) => void }): Promise<Lookup<O>>;
  /** User "retry": forget a terminal failure for these keys so demand re-runs them. Never deletes hits. */
  clearFailures(keys: readonly MemoKey[]): void;
  /** Inspectability (PRD acceptance 2): exact input and output for a key. */
  inspect(key: MemoKey): { purpose: Purpose; version: string; input: unknown; output: unknown; usage: readonly UsageEvent[] } | null;
};

export type MemoMode = "live" | "replay";

export function createMemo(db: Db, mode: MemoMode): Memo {
  // TODO tables (owned here): memo(key PK, purpose, version, model, input_json, output_json, seq)
  //                            memo_failures(key PK, attempts, last_error, seq)
  //       usage_events are written through ledger.recordInTx (same transaction).
  throw new Error("not implemented");
}
