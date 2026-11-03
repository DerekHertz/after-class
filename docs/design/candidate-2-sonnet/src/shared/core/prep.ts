// core/prep.ts -- preparation status is DERIVED from jobs + claims, never stored (derive instead of sync).
// R6: nothing in this file takes a resource-search argument, so a pending resource search cannot block readiness.
import type { ChunkId, ClaimId, ContentKey } from "../domain/ids";
import type { Claim, SupportedClaim } from "../domain/claim";
import type { NonEmpty } from "../domain/ids";
import type { PartialReason } from "../domain/review";

export type InterpretState = "none" | "queued" | "running" | "done" | "failed" | "cancelled";

export interface ChunkPrepInput {
  readonly chunkId: ChunkId;
  readonly contentKey: ContentKey;
  readonly interpret: InterpretState;
  readonly claims: readonly Claim[];
  readonly reviewed: boolean;
  readonly hasCaptureGap: boolean;
}

/** The diagram in the spec, as a total function of its inputs. */
export type PrepStatus =
  | "collecting_done_queued" | "interpreting" | "checking" | "revising"
  | "ready"        // every claim finished, >= 1 supported, none unverified
  | "partial"      // finished with some unverified/dropped but >= 1 supported
  | "unavailable"  // finished, zero supported / interpret failed
  | "cancelled";

export function summarizePrep(c: ChunkPrepInput): PrepStatus {
  throw new Error("not implemented");
}

/** A chunk is 'prepared' (TLA: Prepared) iff interpretation is done and every claim is supported|unverified|dropped. */
export function isPrepared(c: ChunkPrepInput): boolean {
  throw new Error("not implemented");
}

export type Readiness =
  | { readonly tag: "ready"; readonly chunks: readonly ChunkId[]; readonly supported: NonEmpty<SupportedClaim>; readonly partial: readonly PartialReason[] }
  | { readonly tag: "processing"; readonly pending: readonly ChunkId[]; readonly estimateMs: number | null }
  | { readonly tag: "nothing_to_review"; readonly gaps: readonly PartialReason[]; readonly unverified: readonly ClaimId[]; readonly canRetry: boolean };

/**
 * pseudocode (mirrors TLA ReadyScope / HasSupported):
 *   prepared = chunks.filter(c => !c.reviewed && isPrepared(c))
 *   supported = prepared.flatMap(c => c.claims.filter(isSupported))
 *   if supported.length > 0: ready(prepared chunk ids, supported as NonEmpty, partial reasons)
 *   elif some chunk unreviewed && !isPrepared:  processing(pending, estimateMs = reliable ? x : null)
 *   else: nothing_to_review(gaps, unverified claims WITH evidence for display, canRetry = any dropped|failed)
 * `estimateMs` is non-null only when >= N completed jobs of the same kind give a stable median (spec: "estimate only when reliable").
 */
export function reviewReadiness(chunks: readonly ChunkPrepInput[]): Readiness {
  throw new Error("not implemented");
}
