// providers/metered.ts -- R17 in one function. Every paid call goes through `metered`; adapters cannot reach the ledger
// or skip it, because the transports are private to providers/ and only createProviders (index.ts) composes them.
import type { Clock } from "../../shared/core/clock";
import type { UsageEvent, Cost, TokenUsage } from "../../shared/domain/usage";
import type { CallCtx } from "./ports";

export interface Ledger { append(e: UsageEvent): void }

/** What a transport reports back, in provider-neutral form. Anything the provider did not say is null/unknown, never 0. */
export interface Reported {
  readonly provider: "jev" | "claude_cli";
  readonly model: string | null;
  readonly tokens: TokenUsage;
  readonly cost: Cost;
}

export class ProviderCallFailed extends Error {
  constructor(readonly outcome: "provider_error" | "timeout" | "parse_error", readonly reported: Reported | null, message: string) { super(message); }
}

/**
 * pseudocode:
 *   t0 = clock.mono()
 *   try { { value, reported } = await call(); outcome='ok'; return value }
 *   catch (e) { outcome = e is AbortError ? 'cancelled' : e.outcome ?? 'provider_error'; reported = e.reported ?? UNKNOWN_REPORT; throw e }
 *   finally { ledger.append({ id: random, atWall: clock.wall(), stage: ctx.stage, ..., latencyMs: clock.mono() - t0,
 *                             tokens: reported.tokens, cost: reported.cost, outcome }) }    // runs on EVERY path
 * The ledger write is synchronous (bun:sqlite) and happens before the caller sees the result or the error.
 */
export async function metered<T>(
  ledger: Ledger,
  clock: Clock,
  ctx: CallCtx,
  provider: "jev" | "claude_cli",
  call: () => Promise<{ readonly value: T; readonly reported: Reported }>,
): Promise<T> {
  throw new Error("not implemented");
}

export const UNKNOWN_TOKENS: TokenUsage = { input: null, output: null, cacheRead: null, cacheWrite: null };
