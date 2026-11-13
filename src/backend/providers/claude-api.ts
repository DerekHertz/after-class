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
 * Nothing the network sends is trusted. A response and an SDK error are parsed once, in `parseMessage` and `failureOf`
 * below, into values this file made: a stop reason from a fixed set, usage as non-negative integers or nothing, strings
 * redacted and clipped. Nothing past those two functions (an error, `onResponse`, the usage report, a result) holds a raw field.
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

/** USD for one response from the price table, or null when the model has no price or the figure is not a finite non-negative number. */
export function priceUsage(model: string, u: UsageParts): number | null {
  const price = priceOf(model);
  if (price === null) return null;
  const usd = (u.fresh * price.input + u.creation5m * price.input * CACHE_WRITE_5M + u.creation1h * price.input * CACHE_WRITE_1H + u.read * price.cacheRead + u.output * price.output) / 1_000_000;
  // A figure that is not a finite non-negative number is not a cost. Callers read null as unknown.
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}

/** The fixed allowance, in input tokens, for what a request adds around its text. See `worstCaseUsd`. */
export const REQUEST_OVERHEAD_TOKENS = 4_096;

/**
 * An upper bound on what this adapter can be billed for one call, in USD. The assumptions, all of them:
 *   1. A token covers at least one byte of UTF-8 text, so the bytes of the system text, the prompt and the serialized
 *      output schema (zero for a streamed tutor turn) bound the tokens those texts become above.
 *   2. Everything the request adds around that text is covered by REQUEST_OVERHEAD_TOKENS: role and message framing, the
 *      cache_control marker, and the instruction text the API adds to the prompt for structured output. This is an
 *      allowance chosen to be generous, not a measured figure, which is why the runner also checks each finished call.
 *   3. Every one of those tokens costs the most any input token can: a write to the 1 hour cache.
 *   4. The call spends its whole `max_tokens` on output. Thinking tokens are output tokens and are inside that limit.
 *   5. Nothing else is billed: the request has no tools or web search, and the client makes no retry of its own (maxRetries 0).
 * Prices are the table's. This is a bound on the estimate the table produces, not on Derek's invoice.
 */
export function worstCaseUsd(model: string, inputBytes: number, maxTokens: number, schemaBytes: number): number | null {
  return priceUsage(model, { fresh: 0, creation5m: 0, creation1h: inputBytes + schemaBytes + REQUEST_OVERHEAD_TOKENS, read: 0, output: maxTokens });
}

/** The `output_config.format` a structured call sends, shared so the runner reserves for exactly the schema that goes on the wire. */
export function outputFormatOf(schema: z.ZodType): JSONOutputFormat {
  const { parse: _parse, ...rest } = zodOutputFormat(schema);
  return rest;
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

/**
 * The stop reasons the API documents. Anything else a response carries is reported as "unknown", never copied, because
 * the field is a string the network chose and it would go into logs and result files as it came.
 */
const KNOWN_STOPS = ["end_turn", "stop_sequence", "max_tokens", "refusal", "tool_use", "pause_turn", "model_context_window_exceeded"] as const;
export type StopLabel = (typeof KNOWN_STOPS)[number] | "unknown";

/** One completed response, as the experiment runner records it. Reported before a failing stop reason throws. Every field is parsed. */
export type ApiCallDetail = {
  /** Redacted and clipped, or "unknown" when the response named no model. */
  readonly model: string;
  /** Null when the response carried no stop reason. */
  readonly stopReason: StopLabel | null;
  /** Null when the response's usage failed `parseUsage`. Its cost is then unknown, and `costUsd` is null. */
  readonly usage: UsageParts | null;
  readonly costUsd: number | null;
};

export type ClaudeApiOptions = {
  readonly apiKey: string;
  readonly maxConcurrent: number;
  /** A fake in tests. Default: the official SDK client with maxRetries 0. */
  readonly client?: ApiClient;
  readonly onResponse?: (detail: ApiCallDetail) => void;
};

/** The longest message text this adapter lets into a thrown error, and so into the memo's failure table. */
export const MESSAGE_CLIP = 500;

/**
 * The one way text from an SDK error, a response body, a refusal, a stop reason, a model name or the request becomes
 * part of a message. The secret is replaced in the whole text first and only then is the text cut, because a cut made
 * first can end inside the secret, and a prefix of a key is no longer a string the replace can find.
 */
export function redactThenClip(text: string, secret: string, max: number = MESSAGE_CLIP): string {
  const redacted = secret === "" ? text : text.split(secret).join("[redacted]");
  return redacted.slice(0, max);
}

/** Whether a failed call may have been billed. */
export type Billing = "not_billed" | "maybe_billed";

/**
 * The one table of HTTP statuses that prove a request was turned away before any model ran, so the call cost nothing:
 *   400 invalid request, 401 bad key, 403 no permission, 404 no such model, 413 request too large, 422 unprocessable,
 *   all checked while the request is validated and authenticated, and 429 rate limited, which is admission control.
 * Every other outcome keeps its reservation, because the request may have reached a model and its answer may have been
 * billed even though the caller never saw it: every 5xx (500, 502, 503, 504, 529 and any other), 408 and 409 (a timeout or
 * a conflict that does not say whether the work started), a status the SDK did not give or that is not an HTTP status,
 * a connection error or timeout after the request was sent, an abort, and a stream that broke. A status not listed here
 * is maybe billed, so adding a row is the only way to call a failure free, and the default is the safe side of the cap.
 */
const REJECTED_BEFORE_ANY_MODEL_RAN: ReadonlySet<number> = new Set([400, 401, 403, 404, 413, 422, 429]);

export function billingOfStatus(status: number | null): Billing {
  return status !== null && REJECTED_BEFORE_ANY_MODEL_RAN.has(status) ? "not_billed" : "maybe_billed";
}

/** A call that failed in transport or at the API, with what the runner needs to price it. A refusal or a bad stop is a plain ProviderError that carries usage. */
export class ApiCallError extends ProviderError {
  constructor(message: string, usage: UsageReport | null, retryable: boolean, readonly billing: Billing, readonly status: number | null) {
    super(message, usage, retryable);
  }
}

/**
 * The largest token count one usage field may report. The largest context window is 1,000,000 tokens and the largest
 * output limit this adapter sets is 32,000, so a count of ten million in one field is not a measurement. At the dearest
 * price it is already $80, more than any cap the runner takes in practice. A count above this is invalid, and its call
 * is held at its worst case, which is the safe side of the cap.
 */
export const MAX_TOKEN_COUNT = 10_000_000;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null;

/** A token count: a non-negative safe integer no larger than MAX_TOKEN_COUNT, else null. Missing, non-numeric, NaN, infinite, negative and fractional all fail. */
const countOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKEN_COUNT ? v : null);
/** A count the API may leave out or null: that is zero. Present and invalid is still invalid. */
const optionalCountOf = (v: unknown): number | null => (v === undefined || v === null ? 0 : countOf(v));

/** The response's usage as non-negative integers, or null when any part of it is missing or invalid. A null means the cost of the call is unknown. */
export function parseUsage(raw: unknown): UsageParts | null {
  if (!isRecord(raw)) return null;
  const fresh = countOf(raw.input_tokens);
  const output = countOf(raw.output_tokens);
  const total = optionalCountOf(raw.cache_creation_input_tokens);
  const read = optionalCountOf(raw.cache_read_input_tokens);
  if (fresh === null || output === null || total === null || read === null) return null;
  let creation5m = 0;
  let creation1h = total;
  const breakdown = raw.cache_creation;
  if (breakdown !== undefined && breakdown !== null) {
    if (!isRecord(breakdown)) return null;
    const m5 = countOf(breakdown.ephemeral_5m_input_tokens);
    const h1 = countOf(breakdown.ephemeral_1h_input_tokens);
    if (m5 === null || h1 === null) return null;
    // Writes bill by lifetime. A total above the breakdown's two parts is billed as the 1 hour write this adapter asks for.
    creation5m = m5;
    creation1h = Math.max(h1, total - m5);
  }
  const parts = { fresh, creation5m, creation1h, read, output };
  return Object.values(parts).every((n) => countOf(n) !== null) ? parts : null;
}

/** Everything the adapter takes from a response, each field already parsed. The reply text has the key removed. */
type Parsed = {
  readonly model: string;
  readonly stop: StopLabel | null;
  readonly usage: UsageParts | null;
  readonly text: string;
  /** The refusal's category and explanation, redacted and clipped. Empty when there is none. */
  readonly refusal: string;
};

/** The one place a response becomes values this adapter trusts. Reads each field it uses, and no other. */
function parseMessage(raw: unknown, secret: string): Parsed {
  const msg = isRecord(raw) ? raw : {};
  const model = typeof msg.model === "string" && msg.model !== "" ? redactThenClip(msg.model, secret, 80) : "unknown";
  const stop = msg.stop_reason === null || msg.stop_reason === undefined ? null : ((KNOWN_STOPS as readonly unknown[]).includes(msg.stop_reason) ? (msg.stop_reason as StopLabel) : "unknown");
  const content = Array.isArray(msg.content) ? (msg.content as readonly unknown[]) : [];
  const text = content.map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("").split(secret).join("[redacted]");
  const details = isRecord(msg.stop_details) ? msg.stop_details : {};
  const refusal = [details.category, details.explanation].filter((x): x is string => typeof x === "string" && x !== "").join(": ");
  return { model, stop, usage: parseUsage(msg.usage), text, refusal: redactThenClip(refusal, secret) };
}

function usageOf(parsed: Parsed): UsageReport {
  const { model, usage: u } = parsed;
  if (u === null) return { model, inputTokens: null, outputTokens: null, cacheReadTokens: null, cost: { kind: "unknown", reason: "the response's usage was missing or invalid" } };
  const usd = priceUsage(model, u);
  return {
    model,
    // The CLI adapter's convention: input is fresh plus cache-creation tokens, cache reads are reported on their own.
    inputTokens: u.fresh + u.creation5m + u.creation1h,
    outputTokens: u.output,
    cacheReadTokens: u.read,
    cost: usd === null ? { kind: "unknown", reason: `no price for model ${model}` } : { kind: "estimated", usd, basis: COST_BASIS },
  };
}

/**
 * Passes streamed text on with the key removed. A key split across two deltas is still found, because a tail that could be
 * the start of the key is held until the next delta shows whether it is.
 */
function redactingSink(secret: string, emit: (text: string) => void) {
  let held = "";
  return {
    push(delta: unknown) {
      if (typeof delta !== "string") return;
      const text = (held + delta).split(secret).join("[redacted]");
      let keep = 0;
      for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
        if (secret.startsWith(text.slice(text.length - n))) {
          keep = n;
          break;
        }
      }
      held = text.slice(text.length - keep);
      const out = text.slice(0, text.length - keep);
      if (out !== "") emit(out);
    },
    flush() {
      if (held !== "") emit(held);
      held = "";
    },
  };
}

/** An HTTP status, or null for anything else a thrown value might carry in that field. */
const statusOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null);

/** The text of a thrown value, which may be anything, including a value whose own accessors throw. */
function textOfError(err: unknown): string {
  try {
    const text = err instanceof Error ? err.message : String(err);
    return typeof text === "string" ? text : "unreadable error";
  } catch {
    return "unreadable error";
  }
}

export function createClaudeApi(opts: ClaudeApiOptions): ClaudeCli {
  if (opts.apiKey === "") throw new Error("createClaudeApi needs a non-empty apiKey");
  const client = opts.client ?? sdkClient(opts.apiKey);
  const limiter = createLimiter(opts.maxConcurrent);
  const safe = (text: string, max?: number) => redactThenClip(text, opts.apiKey, max);

  /** Typed errors only, never message text: a retryable failure is overload, a rate limit, a 5xx or the connection. The only fields read from the error are its class, its status and its message. */
  function failureOf(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const text = safe(textOfError(err));
    // The connection can fail before or after the request was sent, and nothing says which, so it may have been billed.
    if (err instanceof Anthropic.APIConnectionError) return new ApiCallError(`claude api connection error: ${text}`, null, true, "maybe_billed", null);
    if (err instanceof Anthropic.APIError) {
      // No status means the error arrived inside a stream that had started.
      const status = statusOf(err.status);
      const retryable = err instanceof Anthropic.RateLimitError || err instanceof Anthropic.RequestTimeoutError || err instanceof Anthropic.InternalServerError || (status !== null && status >= 500);
      return new ApiCallError(`claude api error (${status ?? "no status"}): ${text}`, null, retryable, billingOfStatus(status), status);
    }
    // A stream that ended without a message is the SDK's own error for an interrupted connection.
    if (err instanceof Anthropic.AnthropicError) return new ApiCallError(`claude api error: ${text}`, null, true, "maybe_billed", null);
    return new ApiCallError(`claude api call failed: ${text}`, null, false, "maybe_billed", null);
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
      if (timedOut) throw new ApiCallError(`claude api timed out after ${req.timeoutMs}ms`, null, true, "maybe_billed", null);
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
    // Nothing has been sent when these throw, so none of them can be billed.
    if (model === undefined) throw new ApiCallError(`claude api backend serves only "opus" and "sonnet", got "${safe(req.model, 80)}"`, null, false, "not_billed", null);
    if (req.webTools) throw new ApiCallError("claude api backend does not support web tools; this trial covers the tutor turn and the wrap-up only", null, false, "not_billed", null);
    if (req.images.length > 0) throw new ApiCallError("claude api backend does not support images; this trial covers the tutor turn and the wrap-up only", null, false, "not_billed", null);
    // One stable block, cached for an hour, so a review's lecture context is read from cache on its later turns.
    const system: TextBlockParam[] = [{ type: "text", text: req.system, cache_control: { type: "ephemeral", ttl: "1h" } }];
    return { model, system, messages: [{ role: "user", content: req.prompt }] as const };
  }

  /** Parse the response, report it, then check the stop reason: only a finished answer is an answer. */
  function settle(raw: unknown): { readonly parsed: Parsed; readonly usage: UsageReport } {
    const parsed = parseMessage(raw, opts.apiKey);
    const usage = usageOf(parsed);
    opts.onResponse?.({ model: parsed.model, stopReason: parsed.stop, usage: parsed.usage, costUsd: usage.cost.kind === "estimated" ? usage.cost.usd : null });
    if (parsed.stop === "end_turn" || parsed.stop === "stop_sequence") return { parsed, usage };
    if (parsed.stop === "refusal") throw new ProviderError(`claude refused the request${parsed.refusal ? ` (${parsed.refusal})` : ""}`, usage, false);
    throw new ProviderError(`claude stopped with ${parsed.stop === null ? "no stop reason" : parsed.stop}, not a finished answer`, usage, false);
  }

  return {
    async structured<O>(req: ClaudeRequest, schema: z.ZodType<O>, signal: AbortSignal) {
      const { model, system, messages } = prepare(req);
      let format: JSONOutputFormat;
      try {
        format = outputFormatOf(schema);
      } catch (err) {
        throw new ApiCallError(`output schema cannot be expressed as JSON Schema: ${safe(err instanceof Error ? err.message : String(err))}`, null, false, "not_billed", null);
      }
      return call(req, signal, async (callSignal) => {
        const message = await client.messages.create(
          { model, max_tokens: STRUCTURED_MAX_TOKENS, system, messages: [...messages], output_config: { effort: req.effort, format } },
          { signal: callSignal },
        );
        const { parsed: reply, usage } = settle(message);
        let payload: unknown;
        try {
          payload = JSON.parse(reply.text);
        } catch {
          throw new ProviderError("claude returned text that is not JSON", usage, false);
        }
        const parsed = schema.safeParse(payload);
        if (!parsed.success) throw new ProviderError(`claude output failed validation: ${safe(parsed.error.message)}`, usage, false);
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
        const sink = redactingSink(opts.apiKey, onText);
        stream.on("text", (delta) => sink.push(delta));
        const message = await stream.finalMessage();
        const { parsed: reply, usage } = settle(message);
        sink.flush();
        return { text: reply.text, usage };
      });
    },
  };
}
