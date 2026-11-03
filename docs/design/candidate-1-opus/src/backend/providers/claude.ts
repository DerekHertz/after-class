/**
 * `claude -p` adapter. Transport only (spawn, args, parse, usage). Prompts and
 * output schemas live with the domain task that owns them.
 *
 * One arg builder, one place to change auth policy:
 *   claude -p --bare --model <m> --effort <e> --system-prompt <s>
 *          --tools "" (or --allowedTools WebSearch,WebFetch for resource search)
 *          --no-session-persistence
 *          --input-format stream-json          (so images go in as content blocks)
 *          --output-format json | stream-json --verbose --include-partial-messages
 *          --json-schema <z.toJSONSchema(schema)>   (structured calls)
 *
 * AUTH CONFLICT (open question): `--bare` reads only ANTHROPIC_API_KEY/apiKeyHelper,
 * never OAuth, so "--bare" and "on Derek's subscription" cannot both hold. The
 * config makes the choice explicit and the cost kind follows from it:
 *   auth "api_key"      → pass --bare, cost { kind: "measured", usd: total_cost_usd }
 *   auth "subscription" → omit --bare, pass --setting-sources "" --strict-mcp-config
 *                         --disable-slash-commands; cost { kind: "notional", basis: "claude_subscription" }
 *
 * Stateless by design: every call is a fresh process with the full context
 * built from our DB. No --resume: Claude's session store would be a second copy
 * of the conversation.
 */
import type { z } from "zod";
import type { UsageReport } from "./memo";

export type ClaudeAuth = "api_key" | "subscription";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeImage = { readonly label: string; readonly mediaType: "image/jpeg" | "image/png"; readonly bytes: Uint8Array };

export type ClaudeRequest = {
  readonly model: string; // "opus" (default per stack) | "sonnet" (lab comparison arm)
  readonly effort: Effort;
  readonly system: string;
  readonly prompt: string;
  readonly images: readonly ClaudeImage[];
  readonly tools: readonly ("WebSearch" | "WebFetch")[]; // [] for everything except resource search
  readonly timeoutMs: number;
};

export type ClaudeCli = {
  /** --output-format json + --json-schema. Output validated with `schema` (never trust the CLI's validation alone). */
  structured<O>(req: ClaudeRequest, schema: z.ZodType<O>, signal: AbortSignal): Promise<{ output: O; usage: UsageReport }>;
  /**
   * --output-format stream-json. Calls onText for each assistant text delta and
   * resolves with the full text. Used by the tutor (speech starts on sentence one).
   */
  streamText(req: ClaudeRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<{ text: string; usage: UsageReport }>;
};

export function createClaudeCli(opts: { bin: string; auth: ClaudeAuth; cwd: string; maxConcurrent: number }): ClaudeCli {
  // TODO: Bun.spawn with stdin = one stream-json user message (text + base64 image blocks);
  //       signal → proc.kill(); parse final {type:"result", is_error, total_cost_usd, usage, structured_output|result}.
  //       is_error or non-zero exit → ProviderError(usage if present, retryable for overload/timeouts).
  throw new Error("not implemented");
}
