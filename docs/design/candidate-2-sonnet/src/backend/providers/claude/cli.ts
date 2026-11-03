// providers/claude/cli.ts -- `claude -p` transport. PRIVATE to providers/claude. One way to call Claude: runStructured / streamStructured.
//
// argv (pure, unit-tested without spawning):
//   claude -p --bare --model <m> --effort <e> --system-prompt <s> --json-schema <JSON> --output-format json
// streaming variant: --output-format stream-json (the CLI may require --verbose and --include-partial-messages with -p; verify in the spike).
// The prompt goes on STDIN, never argv (size, and it keeps lecture text out of `ps`).
// The schema is derived from the zod schema with z.toJSONSchema, so the zod type is the single source of truth: what we ask for == what we parse.
import type { z } from "zod";
import type { Reported } from "../metered";

export interface ClaudeCall<S extends z.ZodType> {
  readonly bin: string;
  readonly model: string;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly system: string;
  readonly prompt: string;
  readonly schema: S;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export function buildArgv(c: Pick<ClaudeCall<z.ZodType>, "model" | "effort" | "system"> & { readonly jsonSchema: string; readonly stream: boolean }): readonly string[] {
  throw new Error("not implemented");
}

/**
 * pseudocode:
 *   proc = Bun.spawn([bin, ...argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: minimalEnv() })   // no TYPESAFE key in the child's env
 *   write prompt; close stdin
 *   signal.abort / timeout -> proc.kill('SIGTERM'), then 'SIGKILL' after 2s; throw AbortError | ProviderCallFailed('timeout')
 *   envelope = EnvelopeSchema.parse(JSON.parse(stdout))        // zod with passthrough: unknown fields tolerated, KNOWN ones validated
 *   envelope.is_error -> ProviderCallFailed('provider_error', reported-if-any)
 *   value = c.schema.parse(envelope.structured_output ?? JSON.parse(envelope.result))   // exact field name verified in the spike
 *   reported = { provider:'claude_cli', model: from envelope, tokens: envelope.usage mapped (missing => null),
 *                cost: envelope.total_cost_usd != null ? {kind:'notional', usd, basis:'claude -p total_cost_usd (subscription)'} : {kind:'unknown'} }
 *   parse failure of the value => ProviderCallFailed('parse_error', reported)   // still ledgered: the tokens were spent
 */
export function runStructured<S extends z.ZodType>(c: ClaudeCall<S>): Promise<{ readonly value: z.infer<S>; readonly reported: Reported }> {
  throw new Error("not implemented");
}

export type StreamPiece<T> =
  | { readonly tag: "text_delta"; readonly text: string }
  | { readonly tag: "final"; readonly value: T; readonly reported: Reported };

/**
 * Line-delimited stream-json. Tutor schema puts the header fields first and `say` LAST; a tiny incremental JSON extractor (pure, tested on chunked fixtures)
 * yields the header once its keys are complete, then the growing `say` string as text_delta, so the app can speak sentence by
 * sentence while the JSON completes, after the gate has accepted the header.
 * Interrupt (learner starts talking) = abort the signal: child killed, ledger records the partial usage as 'cancelled'.
 * FALLBACK if the spike shows deltas of structured output are not available: no deltas, one 'final'; voice waits for the whole turn.
 */
export function streamStructured<S extends z.ZodType>(c: ClaudeCall<S>): AsyncIterable<StreamPiece<z.infer<S>>> {
  throw new Error("not implemented");
}
