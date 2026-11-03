// providers/jev/wire.ts -- Jev's HTTP shapes. PRIVATE to providers/jev: not re-exported, not importable from outside
// providers/ (test/architecture.test.ts). Parsed into domain Answers by client.ts.
import { z } from "zod";

export interface JevRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, { readonly type: "noul"; readonly instructions: string }>>;
  /** keyed by reference string that MUST appear verbatim in state/instructions; every asset must be referenced */
  readonly assets?: Readonly<Record<string, { readonly type: "image"; readonly format: "png" | "jpg" | "jpeg"; readonly data_base64: string }>>;
}

export const JevResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.object({ type: z.string(), noul: z.number().min(0).max(1).optional() }).passthrough()),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).partial().optional(),
});
export type JevResponse = z.infer<typeof JevResponse>;

/** errors are JSON with some of these; we keep all that exist for the usage log */
export const JevError = z.object({ message: z.string(), detail: z.string(), error: z.string(), error_type: z.string() }).partial();
