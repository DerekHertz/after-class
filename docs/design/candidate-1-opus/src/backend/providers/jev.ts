/**
 * Jev HTTP adapter (docs/research/jev-api.md). Transport only: no question
 * wording here, no thresholds here. Private to providers/; jev-tasks.ts is the
 * only importer.
 *
 * POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer $TYPESAFE_API_KEY
 *   TypeSafe-Danger-Zone-Images: true      (only when assets present)
 *   { model, state, questions, assets? }
 * → { model, answers: { [q]: { type: "noul", noul } | { type: "choice", … } }, usage: { input_tokens, output_tokens } }
 *
 * Cost is always { kind: "unknown", reason: "typesafe pricing not published" } until pricing is known.
 */
import type { UsageReport } from "./memo";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> };

export type JevImage = { readonly ref: string; readonly format: "jpeg" | "png"; readonly bytes: Uint8Array; readonly width: number; readonly height: number };

export type JevRequest<Q extends string> = {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<Q, JevQuestion>>;
  readonly images: readonly JevImage[];
};

export type JevAnswer = { type: "noul"; p: number } | { type: "choice"; choice: string; probabilities: Readonly<Record<string, number>> };

export type JevClient = {
  /**
   * One request, independent questions over one state (spec: questions in one
   * call must not depend on each other's answers).
   * Validates image bounds BEFORE sending (one bad image fails the whole request
   * on Jev's side; we fail fast instead and the task maps it to "uncertain").
   * Throws ProviderError (with usage when the response carried it).
   */
  ask<Q extends string>(req: JevRequest<Q>, signal: AbortSignal): Promise<{ answers: Readonly<Record<Q, JevAnswer>>; usage: UsageReport }>;
};

export function createJevClient(opts: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): JevClient {
  // TODO: every asset referenced in state/instructions (Jev rejects unreferenced assets) — assert.
  //       Error body: some of message/detail/error/error_type → ProviderError(retryable: status >= 500 || 429).
  throw new Error("not implemented");
}
