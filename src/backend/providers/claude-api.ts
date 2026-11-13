/**
 * The Claude Messages API adapter, the second `ClaudeCli` implementation (the first is claude.ts, which spawns
 * `claude -p` on Derek's subscription). It exists for a paid trial of the tutor turn and the wrap-up, and
 * main.ts routes only those two tasks here, and only when AFTERCLASS_CLAUDE_BACKEND=api. Importable only
 * inside providers/ and by main.ts (and the experiment runner under scripts/).
 *
 * Sources for every SDK call (the claude-api skill's reference files, read 2026-11-12):
 *   client.messages.stream(...), stream.on("text"), stream.finalMessage()   typescript/claude-api/streaming.md
 *   client.messages.create(...) with output_config.format = zodOutputFormat  typescript/claude-api/tool-use.md
 *   system block with cache_control { type: "ephemeral", ttl: "1h" }          typescript/claude-api/README.md
 *   typed error classes (Anthropic.RateLimitError and the rest)               typescript/claude-api/README.md, shared/error-codes.md
 *   Opus 5.5 request rules                                                     shared/model-migration.md, Migrating to Claude Opus 5.5
 *
 * Request rules for claude-opus-5-5 and claude-sonnet-5-5: thinking is always on and is never sent, and
 * budget_tokens, temperature, top_p, top_k and forced tool_choice are 400s, so none is ever sent. Depth is
 * output_config.effort only. The stop_reason is always checked: a refusal or a max_tokens stop is a failure.
 *
 * The SDK client is built with maxRetries 0 because memo.ts owns retries, with an explicit baseURL and
 * no auth token so the environment cannot move the key to another endpoint, and with logging off.
 * The key lives only in the client and is scrubbed from every error message. It is never passed to a child process.
 *
 * Structured calls use `create` plus `zodOutputFormat`, not `messages.parse`: parse throws on text that is not
 * valid JSON before the caller can look at stop_reason, so a truncated or refused answer would hide its cause.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ParseableMessageCreateParams as MessageStreamParams } from "@anthropic-ai/sdk";
import type { JSONOutputFormat, Message, MessageCreateParamsNonStreaming, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { z } from "zod";
import { abortError, createLimiter } from "./claude";
import type { ClaudeCli, ClaudeRequest } from "./claude";
import { ProviderError } from "./memo";
import type { UsageReport } from "./memo";

/** The only two models this backend serves. Ids carry no date suffix. */
export const API_MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" } as const;

/** Streaming gets a generous limit because thinking counts toward it. The non-streaming call stays at 16000, which needs no stream. */
export const STREAM_MAX_TOKENS = 32_000;
export const STRUCTURED_MAX_TOKENS = 16_000;

/**
 * List prices in USD per million tokens, checked 2026-11-12 against the figures Derek gave for this trial.
 * Cache reads are 0.05 times the input price on both models. Cache writes cost 1.25 times the input price for
 * the 5 minute lifetime and 2 times for the 1 hour lifetime, per `shared/prompt-caching.md` (Economics) in the
 * claude-api skill, read 2026-11-12. This is a price table, not a bill: the cost it produces is an estimate.
 */
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
} as const;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

export const COST_BASIS = "anthropic_api_list_price";

export type UsageParts = {
  /** Input tokens that were neither written to nor read from the cache. */
  readonly fresh: number;
  readonly creation5m: number;
  readonly creation1h: number;
  readonly read: number;
  readonly output: number;
};

function priceOf(model: string): (typeof PRICES)[keyof typeof PRICES] | null {
  for (const [name, price] of Object.entries(PRICES)) if (model === name || model.startsWith(`${name}-`)) return price;
  return null;
}

/** USD for one response from the price table, or null when the model has no price. */
export function priceUsage(model: string, u: UsageParts): number | null {
  const price = priceOf(model);
  if (price === null) return null;
  return (u.fresh * price.input + u.creation5m * price.input * CACHE_WRITE_5M + u.creation1h * price.input * CACHE_WRITE_1H + u.read * price.cacheRead + u.output * price.output) / 1_000_000;
}

/** The most one call can cost: every input byte priced as a token written to the 1 hour cache, and the whole output limit spent. */
export function worstCaseUsd(model: string, inputBytes: number, maxTokens: number): number | null {
  return priceUsage(model, { fresh: 0, creation5m: 0, creation1h: inputBytes, read: 0, output: maxTokens });
}

/** The parts of the SDK client this adapter uses, so a test can fake the network away. */
export type ApiStream = {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<Message>;
  abort(): void;
};
export type ApiClient = {
  readonly messages: {
    stream(params: MessageStreamParams, options: { readonly signal: AbortSignal }): ApiStream;
    create(params: MessageCreateParamsNonStreaming, options: { readonly signal: AbortSignal }): Promise<Message>;
  };
};

/** What the SDK client is built from. Exported so a test can check the retry, endpoint and auth settings. */
export function clientOptions(apiKey: string) {
  return { apiKey, authToken: null, baseURL: "https://api.anthropic.com", maxRetries: 0, logLevel: "off" } as const;
}

function sdkClient(apiKey: string): ApiClient {
  const sdk = new Anthropic(clientOptions(apiKey));
  return {
    messages: {
      stream: (params, options) => sdk.messages.stream(params, options),
      create: (params, options) => sdk.messages.create(params, options),
    },
  };
}

/** One completed response, as the experiment runner records it. Reported before a failing stop reason throws. */
export type ApiCallDetail = UsageParts & {
  readonly model: string;
  readonly stopReason: string | null;
  readonly costUsd: number | null;
};

export type ClaudeApiOptions = {
  readonly apiKey: string;
  readonly maxConcurrent: number;
  /** A fake in tests. Default: the official SDK client with maxRetries 0. */
  readonly client?: ApiClient;
  readonly onResponse?: (detail: ApiCallDetail) => void;
};

function partsOf(message: Message): UsageParts {
  const u = message.usage;
  const total = u.cache_creation_input_tokens ?? 0;
  // Writes bill by lifetime. Without the breakdown every write is the 1 hour write this adapter asks for.
  const m5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const h1 = u.cache_creation === null || u.cache_creation === undefined ? total : Math.max(u.cache_creation.ephemeral_1h_input_tokens, total - m5);
  return { fresh: u.input_tokens, creation5m: m5, creation1h: h1, read: u.cache_read_input_tokens ?? 0, output: u.output_tokens };
}

function usageOf(message: Message, parts: UsageParts): UsageReport {
  const usd = priceUsage(message.model, parts);
  return {
    model: message.model,
    // The CLI adapter's convention: input is fresh plus cache-creation tokens, cache reads are reported on their own.
    inputTokens: parts.fresh + parts.creation5m + parts.creation1h,
    outputTokens: parts.output,
    cacheReadTokens: parts.read,
    cost: usd === null ? { kind: "unknown", reason: `no price for model ${message.model}` } : { kind: "estimated", usd, basis: COST_BASIS },
  };
}

function textOf(message: Message): string {
  return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

const clip = (text: string) => text.slice(0, 500);

export function createClaudeApi(opts: ClaudeApiOptions): ClaudeCli {
  if (opts.apiKey === "") throw new Error("createClaudeApi needs a non-empty apiKey");
  const client = opts.client ?? sdkClient(opts.apiKey);
  const limiter = createLimiter(opts.maxConcurrent);
  const scrub = (text: string) => text.split(opts.apiKey).join("[redacted]");

  /** Typed errors only, never message text: a retryable failure is overload, a rate limit, a 5xx or the connection. */
  function failureOf(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const text = clip(scrub(err instanceof Error ? err.message : String(err)));
    if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`claude api connection error: ${text}`, null, true);
    if (err instanceof Anthropic.APIError) {
      const retryable = err instanceof Anthropic.RateLimitError || err instanceof Anthropic.RequestTimeoutError || err instanceof Anthropic.InternalServerError || (err.status !== undefined && err.status >= 500);
      return new ProviderError(`claude api error (${err.status ?? "no status"}): ${text}`, null, retryable);
    }
    // A stream that ended without a message is the SDK's own error for an interrupted connection.
    if (err instanceof Anthropic.AnthropicError) return new ProviderError(`claude api error: ${text}`, null, true);
    return new ProviderError(`claude api call failed: ${text}`, null, false);
  }

  /** The slot, the timeout and the abort wrapped around one request. An abort rejects the way the CLI adapter's does. */
  async function call<T>(req: ClaudeRequest, signal: AbortSignal, work: (callSignal: AbortSignal) => Promise<T>): Promise<T> {
    const release = await limiter.acquire(signal);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, req.timeoutMs);
    const onAbort = () => ctl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      return await work(ctl.signal);
    } catch (err) {
      if (signal.aborted) throw abortError();
      if (timedOut) throw new ProviderError(`claude api timed out after ${req.timeoutMs}ms`, null, true);
      throw failureOf(err);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      release();
    }
  }

  /** The request pieces both paths share. Throws before any call for a model or feature this trial does not cover. */
  function prepare(req: ClaudeRequest) {
    const model = (API_MODELS as Readonly<Record<string, string>>)[req.model];
    if (model === undefined) throw new ProviderError(`claude api backend serves only "opus" and "sonnet", got "${req.model}"`, null, false);
    if (req.webTools) throw new ProviderError("claude api backend does not support web tools; this trial covers the tutor turn and the wrap-up only", null, false);
    if (req.images.length > 0) throw new ProviderError("claude api backend does not support images; this trial covers the tutor turn and the wrap-up only", null, false);
    // One stable block, cached for an hour, so a review's lecture context is read from cache on its later turns.
    const system: TextBlockParam[] = [{ type: "text", text: req.system, cache_control: { type: "ephemeral", ttl: "1h" } }];
    return { model, system, messages: [{ role: "user", content: req.prompt }] as const };
  }

  /** Usage, then the stop reason: only a finished answer is an answer. */
  function settle(message: Message): UsageReport {
    const parts = partsOf(message);
    const usage = usageOf(message, parts);
    opts.onResponse?.({ ...parts, model: message.model, stopReason: message.stop_reason, costUsd: usage.cost.kind === "estimated" ? usage.cost.usd : null });
    const stop = message.stop_reason;
    if (stop === "end_turn" || stop === "stop_sequence") return usage;
    if (stop === "refusal") {
      const details = message.stop_details;
      const why = [details?.category, details?.explanation].filter((x): x is string => typeof x === "string" && x !== "").join(": ");
      throw new ProviderError(`claude refused the request${why ? ` (${scrub(clip(why))})` : ""}`, usage, false);
    }
    throw new ProviderError(`claude stopped with ${stop === null ? "no stop reason" : stop}, not a finished answer`, usage, false);
  }

  return {
    async structured<O>(req: ClaudeRequest, schema: z.ZodType<O>, signal: AbortSignal) {
      const { model, system, messages } = prepare(req);
      let format: JSONOutputFormat;
      try {
        const { parse: _parse, ...rest } = zodOutputFormat(schema);
        format = rest;
      } catch (err) {
        throw new ProviderError(`output schema cannot be expressed as JSON Schema: ${err instanceof Error ? err.message : String(err)}`, null, false);
      }
      return call(req, signal, async (callSignal) => {
        const message = await client.messages.create(
          { model, max_tokens: STRUCTURED_MAX_TOKENS, system, messages: [...messages], output_config: { effort: req.effort, format } },
          { signal: callSignal },
        );
        const usage = settle(message);
        let payload: unknown;
        try {
          payload = JSON.parse(textOf(message));
        } catch {
          throw new ProviderError("claude returned text that is not JSON", usage, false);
        }
        const parsed = schema.safeParse(payload);
        if (!parsed.success) throw new ProviderError(`claude output failed validation: ${parsed.error.message.slice(0, 500)}`, usage, false);
        return { output: parsed.data, usage };
      });
    },

    async streamText(req, onText, signal) {
      const { model, system, messages } = prepare(req);
      return call(req, signal, async (callSignal) => {
        const stream = client.messages.stream(
          { model, max_tokens: STREAM_MAX_TOKENS, system, messages: [...messages], output_config: { effort: req.effort } },
          { signal: callSignal },
        );
        stream.on("text", (delta) => onText(delta));
        const message = await stream.finalMessage();
        const usage = settle(message);
        return { text: textOf(message), usage };
      });
    },
  };
}
