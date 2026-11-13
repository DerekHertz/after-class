/**
 * The only way to call a model. Every provider call is a memoized, ledgered,
 * single-flight function of its exact input:
 *
 *   key = stableId("key", provider, purpose, version, model, task.canonicalInput(input))
 *
 *  - Cache reuse is the call path: a rewatched window or re-closed chunk with the
 *    same evidence has the same key, so no new call is made.
 *  - Outdated results are never selected: a result is stored under the key of
 *    the input it came from, and derivations look up the key of the CURRENT input.
 *  - Cancelled results are never applied: a result's `atSeq` is minted when it
 *    is stored, after the call returns, so a stop-early fact issued while the
 *    call was in flight has a smaller Seq. See `appliesBefore`.
 *  - R17: every attempt writes its usage event in the same transaction as the
 *    result or the failure. No other module calls `Task.attempt`.
 *  - Replay mode: lookups work, a miss throws `ReplayMiss`, so a recorded
 *    database is a labelled replay sample with no provider constructed.
 *  - Budgets: with a `Budget`, every attempt reserves before it starts and settles in its usage event's transaction. A
 *    refused attempt makes no call and resolves `held`; it records no usage event, because nothing was called.
 *  - Per user: a memo is built on a `UserDb` and reads and writes only that user's rows, which are keyed by
 *    (user_id, key). The key itself stays a hash of the call alone, so it does not change when a user is added and
 *    the later shared cache of lecture-only rows can use it as it is. A `MemoKey` is therefore unique only within one
 *    user: never look one up without the user.
 *
 *   const r = memo.lookup(boundaryTask, input);          // sync, for derivations
 *   if (r.kind === "missing") await memo.run(boundaryTask, input, { signal });
 */
import { canonicalJson, stableId } from "../../shared/ids";
import type { CaptureId, IdPart, MemoKey } from "../../shared/ids";
import type { BudgetHold, Cost, Provider, Purpose, Seq, UsageEvent, UsageOutcome } from "../../shared/domain";
import { asSeq } from "../db";
import type { UserDb } from "../db";
import type { Budget, Reservation } from "./budget";

/** What a provider adapter reports for one attempt. Numbers it doesn't know stay null. */
export type UsageReport = {
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cost: Cost;
};

/**
 * A provider failure, with usage when the provider billed before failing. `not_billed` is for a failure the adapter knows
 * cost nothing (a request turned away before any model ran); with no usage it is recorded as a known zero, not as unknown.
 */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  constructor(message: string, readonly usage: UsageReport | null, readonly retryable: boolean, readonly billing: "not_billed" | "maybe_billed" = "maybe_billed") {
    super(message);
  }
}

export class ReplayMiss extends Error {
  override readonly name = "ReplayMiss";
  constructor(readonly purpose: Purpose, readonly key: MemoKey) {
    super(`replay: no recorded ${purpose} result for ${key}`);
  }
}

export type AttemptContext = {
  readonly signal: AbortSignal;
  /** Raw text deltas for streaming tasks (the tutor). The stored value is still the final output. */
  readonly streamTo: ((delta: string) => void) | null;
};

/**
 * Domain knowledge (what to ask, how to read the answer) bound to a provider
 * adapter. Tasks live next to the domain that owns them; every Jev task lives
 * in jev-tasks.ts.
 */
export type Task<I, O> = {
  readonly provider: Provider;
  readonly purpose: Purpose;
  readonly model: string;
  /** Bump when wording, criteria, thresholds or output schema change. */
  readonly version: string;
  /** Attempts per run while errors are retryable. A non-retryable error is terminal at once. */
  readonly maxAttempts: number;
  /** Exactly what the provider sees, canonicalised. Equal canonical forms are the same call. */
  canonicalInput(input: I): IdPart;
  /** One attempt. Throw ProviderError on failure. The output must survive JSON and `decode`. */
  attempt(input: I, ctx: AttemptContext): Promise<{ readonly output: O; readonly usage: UsageReport }>;
  /** Validate stored output on read (zod), so a schema change can't feed old shapes to new code. */
  decode(stored: unknown): O;
};

export type Lookup<O> =
  | { readonly kind: "hit"; readonly key: MemoKey; readonly value: O; readonly atSeq: Seq }
  | { readonly kind: "failed"; readonly key: MemoKey; readonly attempts: number; readonly lastError: string; readonly atSeq: Seq }
  | { readonly kind: "inflight"; readonly key: MemoKey }
  | { readonly kind: "missing"; readonly key: MemoKey };

/** What `run` adds to a lookup: a budget refused the attempt before it began, so no call was made and nothing was stored. */
export type Held = { readonly kind: "held"; readonly key: MemoKey; readonly hold: BudgetHold };
export type RunResult<O> = Lookup<O> | Held;

/** Passed into pure derivations so they stay testable with a Map. */
export type LookupFn = <I, O>(task: Task<I, O>, input: I) => Lookup<O>;

/**
 * R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes."
 * A settled lookup counts only if it was stored before the covering cutoff (a stop-early Seq).
 */
export function appliesBefore<O>(l: RunResult<O>, cutoff: Seq | null): l is Extract<Lookup<O>, { kind: "hit" | "failed" }> {
  if (l.kind !== "hit" && l.kind !== "failed") return false;
  return cutoff === null || l.atSeq < cutoff;
}

export type MemoInspection = {
  readonly key: MemoKey;
  readonly provider: Provider;
  readonly purpose: Purpose;
  readonly version: string;
  readonly model: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly failure: { readonly attempts: number; readonly lastError: string; readonly terminal: boolean } | null;
  readonly usage: readonly UsageEvent[];
};

export type MemoMode = "live" | "replay";

export type MemoRunOptions = {
  readonly signal?: AbortSignal;
  readonly streamTo?: (delta: string) => void;
  readonly onRetry?: () => void;
  /** The capture this call is for, stored on its usage events. Leave it out when the caller has none. */
  readonly captureId?: CaptureId;
};

export type Memo = {
  readonly mode: MemoMode;
  key<I>(task: Task<I, unknown>, input: I): MemoKey;
  lookup: LookupFn;
  /**
   * Hit or terminal failure: returned without a call. In flight: the same
   * promise (single-flight; only the first caller's `streamTo` gets deltas).
   * Otherwise attempts until success, a non-retryable error, or `maxAttempts`.
   * An aborted attempt records an `aborted` usage event and resolves `missing`.
   * An attempt the budget refuses resolves `held`; the key stays missing, so asking again later runs it.
   * `onRetry` runs after a retryable failure and before the next attempt, so a caller that
   * has been given the failed attempt's `streamTo` deltas can drop them.
   */
  run<I, O>(task: Task<I, O>, input: I, opts?: MemoRunOptions): Promise<RunResult<O>>;
  /** User retry: forget terminal failures so demand re-runs them. Never deletes hits. */
  clearFailures(keys: readonly MemoKey[]): void;
  /** Exact input, output and usage for a key (PRD acceptance: inspectable preprocessing). */
  inspect(key: MemoKey): MemoInspection | null;
};

export type MemoOptions = {
  readonly now?: () => number;
  /** Delay before retry attempt n+1 after n failures. */
  readonly retryDelayMs?: (failures: number) => number;
  /** main.ts passes one in live mode. Without one, attempts are not budgeted (replay mode and tests). */
  readonly budget?: Budget;
};

type InputRow = { provider: Provider; purpose: Purpose; version: string; model: string; input_json: string };
type FailureRow = { attempts: number; last_error: string; seq: number; terminal: number };
type UsageRow = {
  id: string; memo_key: string; attempt_no: number; provider: Provider; model: string; purpose: Purpose; outcome: UsageOutcome;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
  cost_kind: Cost["kind"]; cost_usd: number | null; cost_basis: string | null; cost_reason: string | null;
  started_ms: number; duration_ms: number;
};

const NEVER = new AbortController().signal;

/** The cost of a failure the adapter says was turned away before any model ran. */
const NOT_BILLED: Cost = { kind: "estimated", usd: 0, basis: "rejected before any model ran" };

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function costColumns(c: Cost): { kind: Cost["kind"]; usd: number | null; basis: string | null; reason: string | null } {
  switch (c.kind) {
    case "measured":
      return { kind: c.kind, usd: c.usd, basis: null, reason: null };
    case "notional":
    case "estimated":
      return { kind: c.kind, usd: c.usd, basis: c.basis, reason: null };
    case "unknown":
      return { kind: c.kind, usd: null, basis: null, reason: c.reason };
  }
}

function costFromRow(r: UsageRow): Cost {
  switch (r.cost_kind) {
    case "measured":
      return { kind: "measured", usd: r.cost_usd! };
    case "notional":
      return { kind: "notional", usd: r.cost_usd!, basis: "claude_subscription" };
    case "estimated":
      return { kind: "estimated", usd: r.cost_usd!, basis: r.cost_basis! };
    case "unknown":
      return { kind: "unknown", reason: r.cost_reason! };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createMemo(db: UserDb, mode: MemoMode, opts: MemoOptions = {}): Memo {
  const now = opts.now ?? Date.now;
  const retryDelayMs = opts.retryDelayMs ?? ((n: number) => Math.min(30_000, 1000 * 2 ** (n - 1)));
  const inflight = new Map<MemoKey, Promise<RunResult<unknown>>>();
  const userId = db.userId;
  const budget = opts.budget ?? null;

  const q = {
    insertInput: db.sql.query(
      `INSERT INTO memo_inputs (user_id, key, provider, purpose, version, model, input_json, first_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, key) DO NOTHING`,
    ),
    input: db.sql.query<InputRow, [string, string]>(`SELECT provider, purpose, version, model, input_json FROM memo_inputs WHERE user_id = ? AND key = ?`),
    hit: db.sql.query<{ output_json: string; seq: number }, [string, string]>(`SELECT output_json, seq FROM memo WHERE user_id = ? AND key = ?`),
    insertHit: db.sql.query(`INSERT INTO memo (user_id, key, output_json, seq, stored_ms) VALUES (?, ?, ?, ?, ?)`),
    failure: db.sql.query<FailureRow, [string, string]>(`SELECT attempts, last_error, seq, terminal FROM memo_failures WHERE user_id = ? AND key = ?`),
    upsertFailure: db.sql.query<{ attempts: number }, [string, string, string, number, number]>(
      `INSERT INTO memo_failures (user_id, key, attempts, last_error, seq, terminal) VALUES (?1, ?2, 1, ?3, ?4, ?5)
       ON CONFLICT (user_id, key) DO UPDATE SET attempts = memo_failures.attempts + 1, last_error = ?3, seq = ?4, terminal = ?5
       RETURNING attempts`,
    ),
    deleteFailure: db.sql.query(`DELETE FROM memo_failures WHERE user_id = ? AND key = ?`),
    nextAttempt: db.sql.query<{ n: number }, [string, string]>(`SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM usage_events WHERE user_id = ? AND memo_key = ?`),
    insertUsage: db.sql.query(
      `INSERT INTO usage_events (id, user_id, memo_key, capture_id, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens,
         cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    usage: db.sql.query<UsageRow, [string, string]>(
      `SELECT id, memo_key, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens, cache_read_tokens,
              cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms
       FROM usage_events WHERE user_id = ? AND memo_key = ? ORDER BY attempt_no`,
    ),
  };

  function keyOf<I>(task: Task<I, unknown>, input: I): MemoKey {
    return stableId("key", task.provider, task.purpose, task.version, task.model, task.canonicalInput(input));
  }

  function settled<O>(task: Task<unknown, O>, key: MemoKey): Lookup<O> {
    const hit = q.hit.get(userId, key);
    if (hit) return { kind: "hit", key, value: task.decode(JSON.parse(hit.output_json)), atSeq: asSeq(hit.seq) };
    const f = q.failure.get(userId, key);
    if (f && f.terminal === 1) return { kind: "failed", key, attempts: f.attempts, lastError: f.last_error, atSeq: asSeq(f.seq) };
    return { kind: "missing", key };
  }

  function lookup<I, O>(task: Task<I, O>, input: I): Lookup<O> {
    const key = keyOf(task, input);
    if (inflight.has(key)) return { kind: "inflight", key };
    return settled(task as Task<unknown, O>, key);
  }

  /** Must run inside a transaction: the attempt number, the event and the budget settlement commit together. */
  function recordUsage<I, O>(task: Task<I, O>, key: MemoKey, captureId: CaptureId | null, outcome: UsageOutcome, usage: UsageReport | null, startedMs: number, why: string, reservation: Reservation | null, notBilled = false): void {
    const attemptNo = q.nextAttempt.get(userId, key)!.n;
    const recorded = usage?.cost ?? (notBilled ? NOT_BILLED : { kind: "unknown", reason: `no usage reported (${why})` });
    if (reservation !== null) budget!.settle(reservation, recorded);
    const cost = costColumns(recorded);
    q.insertUsage.run(
      stableId("use", userId, key, attemptNo), userId, key, captureId, attemptNo, task.provider, usage?.model ?? task.model, task.purpose, outcome,
      usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.cacheReadTokens ?? null,
      cost.kind, cost.usd, cost.basis, cost.reason, Math.round(startedMs), Math.max(0, Math.round(now() - startedMs)),
    );
  }

  async function attemptLoop<I, O>(task: Task<I, O>, input: I, key: MemoKey, signal: AbortSignal, streamTo: ((d: string) => void) | null, onRetry: (() => void) | null, captureId: CaptureId | null): Promise<RunResult<O>> {
    q.insertInput.run(userId, key, task.provider, task.purpose, task.version, task.model, canonicalJson(task.canonicalInput(input)), Math.round(now()));
    let failures = q.failure.get(userId, key)?.attempts ?? 0;
    while (true) {
      if (signal.aborted) return { kind: "missing", key };
      const admission = budget?.reserve(userId, task.purpose, key) ?? null;
      if (admission?.kind === "held") return { kind: "held", key, hold: admission.hold };
      const reservation = admission?.reservation ?? null;
      const startedMs = now();
      let outcome:
        | { ok: true; usage: UsageReport; encoded: string; value: O }
        | { ok: false; usage: UsageReport | null; message: string; retryable: boolean; notBilled: boolean };
      try {
        const result = await task.attempt(input, { signal, streamTo });
        try {
          const encoded = JSON.stringify(result.output);
          outcome = { ok: true, usage: result.usage, encoded, value: task.decode(JSON.parse(encoded)) };
        } catch (err) {
          outcome = { ok: false, usage: result.usage, message: `invalid output: ${errorMessage(err)}`, retryable: false, notBilled: false };
        }
      } catch (err) {
        outcome = {
          ok: false,
          usage: err instanceof ProviderError ? err.usage : null,
          message: errorMessage(err),
          retryable: err instanceof ProviderError && err.retryable,
          notBilled: err instanceof ProviderError && err.billing === "not_billed",
        };
      }

      if (outcome.ok) {
        const { usage, encoded, value } = outcome;
        return db.tx(() => {
          const atSeq = db.nextSeq();
          q.insertHit.run(userId, key, encoded, atSeq, Math.round(now()));
          q.deleteFailure.run(userId, key);
          recordUsage(task, key, captureId, "ok", usage, startedMs, "ok", reservation);
          return { kind: "hit", key, value, atSeq } as const;
        });
      }
      const { usage, message, retryable, notBilled } = outcome;
      if (signal.aborted) {
        db.tx(() => recordUsage(task, key, captureId, "aborted", usage, startedMs, "aborted", reservation, notBilled));
        return { kind: "missing", key };
      }
      const terminal = !retryable || failures + 1 >= task.maxAttempts;
      db.tx(() => {
        recordUsage(task, key, captureId, "error", usage, startedMs, message, reservation, notBilled);
        failures = q.upsertFailure.get(userId, key, message, db.nextSeq(), terminal ? 1 : 0)!.attempts;
      });
      if (terminal) return settled(task as Task<unknown, O>, key);
      onRetry?.();
      await sleep(retryDelayMs(failures), signal);
    }
  }

  function run<I, O>(task: Task<I, O>, input: I, runOpts: MemoRunOptions = {}): Promise<RunResult<O>> {
    const key = keyOf(task, input);
    const flying = inflight.get(key);
    if (flying) return flying as Promise<RunResult<O>>;
    const done = settled(task as Task<unknown, O>, key);
    if (done.kind !== "missing") return Promise.resolve(done);
    if (mode === "replay") return Promise.reject(new ReplayMiss(task.purpose, key));
    const p = attemptLoop(task, input, key, runOpts.signal ?? NEVER, runOpts.streamTo ?? null, runOpts.onRetry ?? null, runOpts.captureId ?? null).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function clearFailures(keys: readonly MemoKey[]): void {
    db.tx(() => {
      for (const k of keys) q.deleteFailure.run(userId, k);
    });
  }

  function inspect(key: MemoKey): MemoInspection | null {
    const input = q.input.get(userId, key);
    if (!input) return null;
    const hit = q.hit.get(userId, key);
    const f = q.failure.get(userId, key);
    return {
      key,
      provider: input.provider,
      purpose: input.purpose,
      version: input.version,
      model: input.model,
      input: JSON.parse(input.input_json),
      output: hit ? JSON.parse(hit.output_json) : null,
      failure: f ? { attempts: f.attempts, lastError: f.last_error, terminal: f.terminal === 1 } : null,
      usage: q.usage.all(userId, key).map((r) => ({
        id: r.id as UsageEvent["id"],
        provider: r.provider,
        model: r.model,
        purpose: r.purpose,
        memoKey: r.memo_key as MemoKey,
        attemptNo: r.attempt_no,
        outcome: r.outcome,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cost: costFromRow(r),
        startedAtMs: r.started_ms,
        durationMs: r.duration_ms,
      })),
    };
  }

  return { mode, key: keyOf, lookup, run, clearFailures, inspect };
}
