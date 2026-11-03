/**
 * `claude -p` adapter (W5). Transport only: spawn, args, parse, usage. Prompts
 * and output schemas live with the domain task that owns them. Importable only
 * inside providers/ (tasks get a ClaudeCli injected by main.ts).
 *
 * Auth: Derek's subscription. `--bare` never reads subscription login, so it is
 * NOT passed (SYNTHESIS correction). One arg builder:
 *   claude -p --model <m> --effort <e>
 *          --restricted --tools Read --strict-mcp-config --disable-slash-commands
 *          --system-prompt <s> --no-session-persistence
 *          --input-format stream-json                         (images as content blocks)
 *          --output-format json --json-schema <z.toJSONSchema>  (structured calls)
 *          --output-format stream-json --verbose --include-partial-messages  (tutor)
 *   resource search only: WebSearch, WebFetch added to --tools.
 * Untested: the first live call confirms login works with these flags.
 * Cost: { kind: "notional", usd: total_cost_usd, basis: "claude_subscription" }; unknown if not reported.
 *
 * Stateless: every call is a fresh process with the full context built from
 * our DB. No --resume, so Claude's session store is never a second copy of a review.
 * No @anthropic-ai/sdk: the CLI is the only path to Claude.
 */
import type { z } from "zod";
import type { UsageReport } from "./memo";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeImage = { readonly label: string; readonly mediaType: "image/jpeg" | "image/png"; readonly bytes: Uint8Array };

export type ClaudeRequest = {
  readonly model: string; // "opus" (default per stack) | "sonnet" (lab comparison arm)
  readonly effort: Effort;
  readonly system: string;
  readonly prompt: string;
  readonly images: readonly ClaudeImage[];
  readonly webTools: boolean; // true only for resource search
  readonly timeoutMs: number;
};

export type ClaudeCli = {
  /** --output-format json + --json-schema. Output re-validated with `schema`; the CLI's validation is not trusted alone. */
  structured<O>(req: ClaudeRequest, schema: z.ZodType<O>, signal: AbortSignal): Promise<{ readonly output: O; readonly usage: UsageReport }>;
  /** --output-format stream-json. Calls onText per assistant text delta; resolves with the full text. Used by the tutor. */
  streamText(req: ClaudeRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<{ readonly text: string; readonly usage: UsageReport }>;
};

/** Pure, unit-tested: the exact argv for a request. The one place auth policy lives. */
export function claudeArgs(req: ClaudeRequest, output: "json" | "stream-json", jsonSchema: string | null): readonly string[] {
  throw new Error("not implemented");
}

export function createClaudeCli(opts: { readonly bin: string; readonly cwd: string; readonly maxConcurrent: number }): ClaudeCli {
  // TODO: Bun.spawn with stdin = one stream-json user message (text + base64 image blocks);
  //       signal → proc.kill(); parse the final {type:"result", is_error, total_cost_usd, usage, structured_output|result}.
  //       is_error or non-zero exit → ProviderError(usage if present, retryable for overload/timeouts).
  throw new Error("not implemented");
}
