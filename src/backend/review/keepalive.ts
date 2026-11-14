/**
 * Keeps a review's cached tutor prompt warm while the learner is idle (Derek, 2026-11-13: "yeah we should use the 5 minute
 * cache, 1 hour only for pauses in the review.").
 *
 * The tutor's system block (instructions, usable claims, lecture evidence) is cached for 5 minutes, and every request that
 * reads it restarts that timer. Turns less than 5 minutes apart keep it warm on their own. When no tutor request has been
 * sent for PING_AFTER_MS, this sends a keep-alive: the review's last tutor request as the adapter's `keepWarm`, which bills
 * a cache read and generates nothing. It repeats every PING_AFTER_MS until one of these, whichever comes first:
 *
 *   IDLE_LIMIT_MS since the review's last tutor request    the next turn pays one 5 minute cache write instead
 *   the review has ended                                   checked before every keep-alive
 *   the learner left the review                            `leave`, from the app's leave request
 *   a keep-alive was not a hit                             held by the stop switch or a cap, or failed; it never retries
 *   the process stops                                      `stop`
 *
 * Every keep-alive is a memo run of its own task, purpose "cache_keepalive", so it is admitted by the budget like any paid
 * call and records a usage event (R17). It is not exempt from the caps. A held keep-alive sends nothing and stops quietly:
 * the learner never sees it. main.ts builds one per user only when the Claude adapter has `keepWarm` (the Messages API),
 * so the `claude -p` backend and replay mode never send one.
 */
import type { ReviewId } from "../../shared/ids";
import type { ClaudeCli, ClaudeRequest } from "../providers/claude";
import type { Memo, Task } from "../providers/memo";
import type { TutorInput, TutorModel } from "./tutor";

/** A minute short of the 5 minute lifetime, which counts from the start of the request that last read or wrote the entry. */
export const PING_AFTER_MS = 4 * 60_000;
export const IDLE_LIMIT_MS = 60 * 60_000;

export type KeepAliveInput = { readonly reviewId: ReviewId; readonly atMs: number; readonly request: ClaudeRequest };

/** One keep-alive. The key is the review and the moment, so each one is its own call; the request is the tutor's last, unchanged. */
function keepAliveTask(keepWarm: NonNullable<ClaudeCli["keepWarm"]>, model: TutorModel): Task<KeepAliveInput, null> {
  return {
    provider: "claude",
    purpose: "cache_keepalive",
    model,
    version: "keepalive-1",
    maxAttempts: 1,
    canonicalInput: ({ reviewId, atMs }) => ({ reviewId, atMs }),
    async attempt(input, ctx) {
      return { output: null, usage: await keepWarm(input.request, ctx) };
    },
    decode: (stored) => {
      if (stored !== null) throw new Error("a keep-alive stores no output");
      return null;
    },
  };
}

export type KeepAliveDeps = {
  readonly memo: Pick<Memo, "run">;
  readonly ended: (reviewId: ReviewId) => boolean;
  readonly now?: () => number;
  /** Runs `fn` after `ms` and returns its cancel. */
  readonly after?: (ms: number, fn: () => void) => () => void;
  readonly onError?: (reviewId: ReviewId, error: unknown) => void;
};

export type KeepAlive = {
  /** A tutor request for this input was just admitted: its review's prefix is warm from now. The tutor task's `onSent`. */
  sent(input: TutorInput, request: ClaudeRequest): void;
  /** The learner left the review. Nothing more is sent for it until its next tutor request. */
  leave(reviewId: ReviewId): void;
  stop(): void;
};

const realAfter = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/** A review whose prefix is warm: the request that keeps it so, when its last tutor request was sent, and the pending timer. */
type Warm = { readonly request: ClaudeRequest; readonly lastTurnMs: number; cancel: () => void };

/** A keep-alive for an adapter that can keep a cache warm, else null: neither `claude -p` nor replay's refusing adapter can. */
export function keepAliveFor(claude: ClaudeCli, model: TutorModel, deps: KeepAliveDeps): KeepAlive | null {
  const { keepWarm } = claude;
  return keepWarm === undefined ? null : createKeepAlive(keepAliveTask((req, send) => keepWarm(req, send), model), deps);
}

function createKeepAlive(task: Task<KeepAliveInput, null>, deps: KeepAliveDeps): KeepAlive {
  const now = deps.now ?? Date.now;
  const after = deps.after ?? realAfter;
  const warm = new Map<ReviewId, Warm>();

  function forget(reviewId: ReviewId): void {
    warm.get(reviewId)?.cancel();
    warm.delete(reviewId);
  }

  function arm(reviewId: ReviewId, w: Warm, refreshedMs: number): void {
    w.cancel = after(Math.max(0, refreshedMs + PING_AFTER_MS - now()), () => void ping(reviewId, w));
  }

  function sent(input: TutorInput, request: ClaudeRequest): void {
    const reviewId = input.state.reviewId;
    warm.get(reviewId)?.cancel();
    const w: Warm = { request, lastTurnMs: now(), cancel: () => {} };
    warm.set(reviewId, w);
    arm(reviewId, w, w.lastTurnMs);
  }

  /** `w` is the entry this timer was armed for; a tutor request or a leave since then replaced it, and this does nothing. */
  async function ping(reviewId: ReviewId, w: Warm): Promise<void> {
    if (warm.get(reviewId) !== w) return;
    const atMs = now();
    let warmed = false;
    try {
      if (atMs - w.lastTurnMs < IDLE_LIMIT_MS && !deps.ended(reviewId)) {
        warmed = (await deps.memo.run(task, { reviewId, atMs, request: w.request })).kind === "hit";
      }
    } catch (e) {
      deps.onError?.(reviewId, e);
    }
    if (warm.get(reviewId) !== w) return;
    if (warmed) arm(reviewId, w, atMs);
    else forget(reviewId);
  }

  return {
    sent,
    leave: forget,
    stop() {
      for (const w of warm.values()) w.cancel();
      warm.clear();
    },
  };
}
