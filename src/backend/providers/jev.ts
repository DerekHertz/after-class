/**
 * Jev HTTP adapter (W5; docs/research/jev-api.md). Transport only: no question
 * wording, no thresholds. Importable only inside providers/.
 *
 * POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer $TYPESAFE_API_KEY
 *   TypeSafe-Danger-Zone-Images: true      (only when assets are present)
 *   { model, state, questions, assets? }
 * → { model, answers: { [q]: { type: "noul", noul } | { type: "choice", … } }, usage: { input_tokens, output_tokens } }
 *
 * Cost is always { kind: "unknown", reason: "typesafe pricing not published" } until pricing is known.
 */
import type { UsageReport } from "./memo";

export type JevQuestion =
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> };

export type JevImage = { readonly ref: string; readonly format: "jpeg" | "png"; readonly bytes: Uint8Array; readonly width: number; readonly height: number };

export type JevRequest<Q extends string> = {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<Q, JevQuestion>>;
  readonly images: readonly JevImage[];
};

export type JevAnswer =
  | { readonly type: "noul"; readonly p: number }
  | { readonly type: "choice"; readonly choice: string; readonly probabilities: Readonly<Record<string, number>> };

export type JevClient = {
  /**
   * One request, independent questions over one state.
   * Checks image bounds (280–1568 px per side, 78,400–2,458,624 px, 16 MiB) and
   * that every asset is referenced BEFORE sending: one bad image fails the
   * whole request on Jev's side, so we fail fast and the task maps it to uncertain.
   * Throws ProviderError (retryable: status >= 500 || 429), with usage when the response carried it.
   */
  ask<Q extends string>(req: JevRequest<Q>, signal: AbortSignal): Promise<{ readonly answers: Readonly<Record<Q, JevAnswer>>; readonly usage: UsageReport }>;
};

export function createJevClient(opts: { readonly apiKey: string; readonly baseUrl?: string; readonly fetch?: typeof fetch }): JevClient {
  throw new Error("not implemented");
}
