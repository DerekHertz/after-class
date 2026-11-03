// providers/jev/client.ts -- Jev transport + adapter => JevPort. Wire types stop here.
import type { Clock } from "../../../shared/core/clock";
import type { JevPort } from "../ports";
import type { Ledger } from "../metered";

export interface JevClientConfig { readonly baseUrl: string; readonly apiKey: string; readonly model: string; readonly timeoutMs: number }

/**
 * POST {baseUrl}/v1/systemone with Authorization: Bearer; adds `TypeSafe-Danger-Zone-Images: true` iff the request has assets.
 *
 * Each JevPort method = build request (questions.ts) -> metered(post) -> map answers:
 *   answers[k].noul -> Answer{ probability, verdict: verdictOf(p) }
 *   HTTP 4xx/5xx, timeout, JSON parse failure, missing answer key -> ProviderCallFailed (ledgered as an event) -> caught here ->
 *       Answer{ verdict:'uncertain', probability:null }  (routing treats it as "continue"; a revision is requested for claim checks)
 *   AbortError is rethrown (cancellation is not "uncertain").
 * Reported usage: tokens from response.usage; cost = { kind:'unknown' } always until TypeSafe publishes pricing.
 * stamp.model = response.model (what ran), not the requested alias, so "jev-latest" drift invalidates the cache.
 * Retries: none here. Retry policy belongs to the job (bounded attempts), so every attempt is a ledger event.
 */
export function createJev(cfg: JevClientConfig, ledger: Ledger, clock: Clock): JevPort {
  throw new Error("not implemented");
}
