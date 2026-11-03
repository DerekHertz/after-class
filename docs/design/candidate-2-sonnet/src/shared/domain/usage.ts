// domain/usage.ts -- R17: every paid call records a usage event; unknown cost is unknown, not 0.
import { z } from "zod";
import { CaptureId, JobId, ReviewId, UsageId } from "./ids";

/**
 * `unknown` is a distinct variant with no number. There is no `usd?: number` anywhere, so
 * "forgot to set it" cannot silently mean zero. DB: CHECK ((cost_kind = 'unknown') = (cost_usd IS NULL)).
 */
export type Cost =
  | { readonly kind: "measured"; readonly usd: number }                     // provider said so
  | { readonly kind: "notional"; readonly usd: number; readonly basis: string } // claude -p on subscription
  | { readonly kind: "estimated"; readonly usd: number; readonly basis: string } // we priced reported tokens
  | { readonly kind: "unknown" };                                          // Jev today: tokens only

export interface TokenUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
}

/** Why this call happened; per-stage cost display and the five live-call experiments key off this. */
export const UsageStage = z.enum([
  "boundary_judgment", "frame_judgment", "claim_check",
  "interpret", "claim_revise", "tutor_turn", "observation_proposal", "resource_search",
]);
export type UsageStage = z.infer<typeof UsageStage>;

export interface UsageEvent {
  readonly id: UsageId;
  readonly atWall: number;
  readonly provider: "jev" | "claude_cli";
  readonly model: string | null;
  readonly stage: UsageStage;
  readonly captureId: CaptureId | null;
  readonly reviewId: ReviewId | null;
  readonly jobId: JobId | null;
  readonly attempt: number;
  /** failed / cancelled / timed-out calls are events too: a request was made */
  readonly outcome: "ok" | "provider_error" | "cancelled" | "timeout" | "parse_error";
  readonly tokens: TokenUsage;
  readonly latencyMs: number;
  readonly cost: Cost;
  readonly liveScope: string | null; // which of the five approved live experiments (or null for normal use)
}

/**
 * A sum that cannot hide unknowns: the UI must render "$X known + N calls of unknown cost".
 */
export interface CostTotal {
  readonly knownUsd: number;
  readonly unknownCalls: number;
  readonly notionalUsd: number; // subscription-backed; shown separately from measured money
  readonly calls: number;
}
