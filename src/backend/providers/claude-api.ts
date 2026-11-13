/**
 * The Claude Messages API adapter, the second `ClaudeCli` implementation (the first is claude.ts, which spawns
 * `claude -p` on Derek's subscription). It runs every Claude task on the Messages API, so a machine without Claude Code
 * can run the product. main.ts routes every task here when AFTERCLASS_CLAUDE_BACKEND=api, and none otherwise. Importable only
 * inside providers/ and by main.ts (and the experiment runner under scripts/).
 *
 * Images and web tools follow the request, so each task keeps one code path. A request's images become base64 image blocks in the
 * user message, each after a text block naming its label, ahead of the prompt. A request with `webTools` adds the server tools
 * web_search_20260209 and web_fetch_20260209, and no other request carries any tool.
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
 * Nothing the client throws is trusted either, and the rule is structural. Every value caught from a client call, of any class
 * (an SDK error, a ProviderError, an ApiCallError, a Proxy, a string, null), goes through `failureOf`, which builds a new ApiCallError
 * from its redacted text and a status it read defensively. It never rethrows the caught value, never copies its billing, usage or
 * retryable flag, and a getter that throws reads as absent. The adapter's own errors (a refusal, a bad stop, a schema mismatch,
 * an unsupported model) are raised outside the `try` that wraps the client call, so no client can throw an error that looks like one.
 *
 * Structured calls use `create` plus `zodOutputFormat`, not `messages.parse`: parse throws on text that is not
 * valid JSON before the caller can look at stop_reason, so a truncated or refused answer would hide its cause.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ParseableMessageCreateParams as MessageStreamParams } from "@anthropic-ai/sdk";
import type { ContentBlockParam, JSONOutputFormat, Message, MessageCreateParamsNonStreaming, MessageParam, TextBlockParam, ToolUnion } from "@anthropic-ai/sdk/resources/messages";
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

/**
 * USD per web search request, $10 per 1,000 searches. Source: the claude-api reference, shared/managed-agents-core.md, which states
 * "web searches at $10 per 1,000" (confirmed by the coordinator on 2026-11-13). It is not in the SDK types.
 * Counted: every search the response's usage reports, at that rate, plus all tokens at the price table's rates (the text web search
 * and web fetch results add to the prompt arrives as input tokens, so it is already in `input_tokens`). Not counted: web fetch has no
 * per-request fee that this file knows of, so a fetch adds only its tokens. A response that reports no server tool usage counts zero
 * searches, and one that reports an invalid count makes the whole call's cost unknown.
 */
export const WEB_SEARCH_USD = 0.01;

export const COST_BASIS = "anthropic_api_list_price";

export type UsageParts = {
  /** Input tokens that were neither written to nor read from the cache. */
  readonly fresh: number;
  readonly creation5m: number;
  readonly creation1h: number;
  readonly read: number;
  readonly output: number;
  /** Web searches the response reports in usage.server_tool_use.web_search_requests. Absent when there were none. */
  readonly webSearches?: number;
};

function priceOf(model: string): (typeof PRICES)[keyof typeof PRICES] | null {
  for (const [name, price] of Object.entries(PRICES)) if (model === name || model.startsWith(`${name}-`)) return price;
  return null;
}

/** USD for one response from the price table, or null when the model has no price or the figure is not a finite non-negative number. */
export function priceUsage(model: string, u: UsageParts): number | null {
  const price = priceOf(model);
  if (price === null) return null;
  const tokens = (u.fresh * price.input + u.creation5m * price.input * CACHE_WRITE_5M + u.creation1h * price.input * CACHE_WRITE_1H + u.read * price.cacheRead + u.output * price.output) / 1_000_000;
  const usd = tokens + (u.webSearches ?? 0) * WEB_SEARCH_USD;
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
 *      This holds for the tutor turn and the wrap-up, the only calls the replay runner makes. A request with web tools can add
 *      searches, which this bound does not include.
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

/**
 * The user turn. Text only when there are no images, so a tutor request is the plain string it always was. With images, each is a
 * base64 block after a text block that names its label, because the task prompts cite frames by that label, and the prompt follows them.
 */
function userContent(req: ClaudeRequest, prompt: string): string | ContentBlockParam[] {
  if (req.images.length === 0) return prompt;
  return [
    ...req.images.flatMap((img): ContentBlockParam[] => [
      { type: "text", text: `Image ${img.label}:` },
      { type: "image", source: { type: "base64", media_type: img.mediaType, data: Buffer.from(img.bytes).toString("base64") } },
    ]),
    { type: "text", text: prompt },
  ];
}

/**
 * The server tools a `webTools` request adds, the API's counterpart of the CLI's WebSearch and WebFetch. Anthropic runs them.
 * max_uses caps the searches one API call may make, and so the search cost of that call at WEB_SEARCH_USD each. Fetches cost only
 * tokens, and their cap bounds how much page text one call can pull into the prompt. A continued paused turn is a new API call
 * with its own cap, so one structured call makes at most (MAX_PAUSE_CONTINUATIONS + 1) times this many searches.
 */
export const WEB_TOOL_MAX_USES = 5;
const WEB_TOOLS: ToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: WEB_TOOL_MAX_USES },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: WEB_TOOL_MAX_USES },
];

/**
 * How many times a paused turn is sent back to continue. The SDK's StopReason docs say of "pause_turn": "You may provide the response
 * back as-is in a subsequent request to let the model continue." So a continuation is the same request plus one assistant message
 * holding the paused response's content blocks unchanged. The claude-api skill's TypeScript notes could not be found here, so the
 * shape rests on that sentence and on the type check, not on a worked example.
 */
export const MAX_PAUSE_CONTINUATIONS = 3;

/** The JSON object in a reply's final text: the whole text, a fenced block, or a brace span that parses. Undefined when none does. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")];
  const end = trimmed.lastIndexOf("}");
  for (let start = trimmed.indexOf("{"); start !== -1 && end > start; start = trimmed.indexOf("{", start + 1)) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (isRecord(v) && !Array.isArray(v)) return v;
    } catch {
      // not this candidate
    }
  }
  return undefined;
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

/** A call that failed in transport or at the API, with what the runner needs to price it. Built only by `failureOf` and the adapter's own checks, never from a caught value. A refusal or a bad stop is a plain ProviderError that carries usage. */
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
  const tools = raw.server_tool_use;
  let webSearches = 0;
  if (tools !== undefined && tools !== null) {
    if (!isRecord(tools)) return null;
    // The SDK types both counts as numbers, so inside a server_tool_use object a missing or null one is malformed, not zero.
    const n = countOf(tools.web_search_requests);
    if (n === null || countOf(tools.web_fetch_requests) === null) return null;
    webSearches = n;
  }
  const parts = { fresh, creation5m, creation1h, read, output };
  if (!Object.values(parts).every((n) => countOf(n) !== null)) return null;
  return webSearches > 0 ? { ...parts, webSearches } : parts;
}

/** Everything the adapter takes from a response, each field already parsed. The reply text has the key removed. */
type Parsed = {
  readonly model: string;
  readonly stop: StopLabel | null;
  readonly usage: UsageParts | null;
  readonly text: string;
  /** The text blocks after the last server tool block, key removed. The whole text when the response has no server tool block. */
  readonly tail: string;
  /** The refusal's category and explanation, redacted and clipped. Empty when there is none. */
  readonly refusal: string;
};

/**
 * The one place a response becomes values this adapter trusts. Reads each field it uses once and no other, because a getter
 * can answer differently the second time. A response whose accessor throws makes this throw, and `settle` turns that into a failed call.
 */
function parseMessage(raw: unknown, secret: string): Parsed {
  const msg = isRecord(raw) ? raw : {};
  const rawModel = msg.model;
  const model = typeof rawModel === "string" && rawModel !== "" ? redactThenClip(rawModel, secret, 80) : "unknown";
  const rawStop = msg.stop_reason;
  const stop = rawStop === null || rawStop === undefined ? null : (KNOWN_STOPS as readonly unknown[]).includes(rawStop) ? (rawStop as StopLabel) : "unknown";
  const rawContent = msg.content;
  const content = Array.isArray(rawContent) ? (rawContent as readonly unknown[]) : [];
  let text = "";
  let tail = "";
  for (const b of content) {
    if (!isRecord(b)) continue;
    const type = b.type;
    const blockText = b.text;
    if (type === "text" && typeof blockText === "string") {
      text += blockText;
      tail += blockText;
    } else if (typeof type === "string" && (type === "server_tool_use" || type.endsWith("_tool_result"))) {
      tail = "";
    }
  }
  text = text.split(secret).join("[redacted]");
  tail = tail.split(secret).join("[redacted]");
  const rawDetails = msg.stop_details;
  const details = isRecord(rawDetails) ? rawDetails : {};
  const category = details.category;
  const explanation = details.explanation;
  const refusal = [category, explanation].filter((x): x is string => typeof x === "string" && x !== "").join(": ");
  return { model, stop, usage: parseUsage(msg.usage), text, tail, refusal: redactThenClip(refusal, secret) };
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

/** One property of a value this adapter did not make. A getter or a proxy that throws reads as absent. */
function read(v: unknown, key: string): unknown {
  try {
    return (v as Readonly<Record<string, unknown>>)[key];
  } catch {
    return undefined;
  }
}

type Class = abstract new (...args: never[]) => object;

/** `instanceof` that cannot throw, because a proxy's prototype trap can. */
function isA(v: unknown, cls: Class): boolean {
  try {
    return v instanceof cls;
  } catch {
    return false;
  }
}

/** The text of a thrown value, which may be anything, including a value whose own accessors throw. */
function textOfError(err: unknown): string {
  try {
    const text = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
    return typeof text === "string" ? text : "unreadable error";
  } catch {
    return "unreadable error";
  }
}

/** What a client call returns, held in an object so that returning it from an async function never reads a field of it a second time. */
type Untrusted = { readonly value: unknown };

export function createClaudeApi(opts: ClaudeApiOptions): ClaudeCli {
  if (opts.apiKey === "") throw new Error("createClaudeApi needs a non-empty apiKey");
  const client = opts.client ?? sdkClient(opts.apiKey);
  const limiter = createLimiter(opts.maxConcurrent);
  const safe = (text: string, max?: number) => redactThenClip(text, opts.apiKey, max);

  /**
   * The only way a value caught from a client call leaves this file. It is never returned or rethrown: a new ApiCallError is built
   * from its redacted text, a status read defensively, and its class, which only decides `retryable`. Billing comes from that status
   * alone, so a caught object cannot name its own. A caught value with no status is maybe billed, and so is any failure that arrives
   * after a text event, because a response had started.
   */
  function failureOf(caught: unknown, responseStarted: boolean): ApiCallError {
    const text = safe(textOfError(caught));
    // The connection can fail before or after the request was sent, and nothing says which, so it may have been billed.
    if (isA(caught, Anthropic.APIConnectionError)) return new ApiCallError(`claude api connection error: ${text}`, null, true, "maybe_billed", null);
    if (isA(caught, Anthropic.APIError)) {
      // No status means the error arrived inside a stream that had started.
      const status = statusOf(read(caught, "status"));
      const retryable = isA(caught, Anthropic.RateLimitError) || isA(caught, Anthropic.RequestTimeoutError) || isA(caught, Anthropic.InternalServerError) || (status !== null && status >= 500);
      const billing = responseStarted ? "maybe_billed" : billingOfStatus(status);
      return new ApiCallError(`claude api error (${status ?? "no status"}): ${text}`, null, retryable, billing, status);
    }
    // A stream that ended without a message is the SDK's own error for an interrupted connection.
    if (isA(caught, Anthropic.AnthropicError)) return new ApiCallError(`claude api error: ${text}`, null, true, "maybe_billed", null);
    return new ApiCallError(`claude api call failed: ${text}`, null, false, "maybe_billed", null);
  }

  /** The slot, the timeout and the abort wrapped around one request. An abort rejects the way the CLI adapter's does. */
  async function call(req: ClaudeRequest, signal: AbortSignal, work: (callSignal: AbortSignal, began: () => void) => Promise<unknown>): Promise<Untrusted> {
    const release = await limiter.acquire(signal);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, req.timeoutMs);
    const onAbort = () => ctl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let responseStarted = false;
    try {
      signal.throwIfAborted();
      return { value: await work(ctl.signal, () => (responseStarted = true)) };
    } catch (err) {
      if (signal.aborted) throw abortError();
      if (timedOut) throw new ApiCallError(`claude api timed out after ${req.timeoutMs}ms`, null, true, "maybe_billed", null);
      throw failureOf(err, responseStarted);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      release();
    }
  }

  /** The request pieces both paths share. Throws before any call for a model or feature this trial does not cover. */
  function prepare(req: ClaudeRequest, promptSuffix = "") {
    const model = (API_MODELS as Readonly<Record<string, string>>)[req.model];
    // Nothing has been sent when these throw, so none of them can be billed.
    if (model === undefined) throw new ApiCallError(`claude api backend serves only "opus" and "sonnet", got "${safe(req.model, 80)}"`, null, false, "not_billed", null);
    // One stable block, cached for an hour, so a review's lecture context is read from cache on its later turns.
    const system: TextBlockParam[] = [{ type: "text", text: req.system, cache_control: { type: "ephemeral", ttl: "1h" } }];
    return { model, system, messages: [{ role: "user", content: userContent(req, req.prompt + promptSuffix) }] as const, tools: req.webTools ? WEB_TOOLS : null };
  }

  /** Parse the response and report it. Throws only for a response that cannot be read. */
  function read1(raw: unknown): Parsed {
    try {
      const parsed = parseMessage(raw, opts.apiKey);
      const cost = usageOf(parsed).cost;
      opts.onResponse?.({ model: parsed.model, stopReason: parsed.stop, usage: parsed.usage, costUsd: cost.kind === "estimated" ? cost.usd : null });
      return parsed;
    } catch {
      // A response that cannot be read is a response that may have been billed. Nothing of it is quoted.
      throw new ApiCallError("claude api response could not be read", null, false, "maybe_billed", null);
    }
  }

  /** Check the stop reason: only a finished answer is an answer. Runs after the client call, outside its `try`. */
  function judge(parsed: Parsed, usage: UsageReport = usageOf(parsed)): { readonly parsed: Parsed; readonly usage: UsageReport } {
    if (parsed.stop === "end_turn" || parsed.stop === "stop_sequence") return { parsed, usage };
    if (parsed.stop === "refusal") throw new ProviderError(`claude refused the request${parsed.refusal ? ` (${parsed.refusal})` : ""}`, usage, false);
    throw new ProviderError(`claude stopped with ${parsed.stop === null ? "no stop reason" : parsed.stop}, not a finished answer`, usage, false);
  }

  const settle = (raw: unknown) => judge(read1(raw));

  /**
   * The usage of several responses of one logical call as one report. Each was priced with its own model by `usageOf`, so the cost is
   * the sum of those and is unknown when any response's cost is unknown, because a total with a missing part is not a total.
   */
  function combine(reports: readonly UsageReport[]): UsageReport {
    const last = reports[reports.length - 1]!;
    const sum = (pick: (r: UsageReport) => number | null): number | null => {
      let total = 0;
      for (const r of reports) {
        const n = pick(r);
        if (n === null) return null;
        total += n;
      }
      return total;
    };
    let usd = 0;
    let unknown: string | null = null;
    for (const r of reports) {
      if (r.cost.kind === "estimated") usd += r.cost.usd;
      else unknown ??= r.cost.kind === "unknown" ? r.cost.reason : "a response had a cost of another kind";
    }
    return {
      model: last.model,
      inputTokens: sum((r) => r.inputTokens),
      outputTokens: sum((r) => r.outputTokens),
      cacheReadTokens: sum((r) => r.cacheReadTokens),
      cost: unknown !== null ? { kind: "unknown", reason: unknown } : Number.isFinite(usd) ? { kind: "estimated", usd, basis: COST_BASIS } : { kind: "unknown", reason: "the summed cost was not a finite number" },
    };
  }

  /**
   * The call with web tools. A paused turn is sent back, up to MAX_PAUSE_CONTINUATIONS times, and the usage of every response is combined so
   * the ledger sees the whole cost. The paused response's blocks go back unchanged and are never read for anything else. A failure after
   * a response was billed carries the usage so far and is maybe billed, because that response was billed whatever the failure says.
   */
  async function structuredWithTools(req: ClaudeRequest, model: string, system: TextBlockParam[], first: readonly MessageParam[], tools: ToolUnion[], signal: AbortSignal): Promise<{ readonly parsed: Parsed; readonly usage: UsageReport }> {
    let messages: MessageParam[] = [...first];
    const reports: UsageReport[] = [];
    /** The failure as the ledger should see it: the adapter's own error, with what was already spent. */
    const afterBilled = (err: unknown): unknown => {
      if (reports.length === 0 || !(err instanceof ApiCallError)) return err;
      return new ApiCallError(err.message, combine(reports), err.retryable, "maybe_billed", err.status);
    };
    for (let n = 0; ; n++) {
      const sent = messages;
      let parsed: Parsed;
      let value: unknown;
      try {
        ({ value } = await call(req, signal, async (callSignal) =>
          client.messages.create({ model, max_tokens: STRUCTURED_MAX_TOKENS, system, messages: sent, tools, output_config: { effort: req.effort } }, { signal: callSignal }),
        ));
        parsed = read1(value);
      } catch (err) {
        throw afterBilled(err);
      }
      reports.push(usageOf(parsed));
      const total = combine(reports);
      if (parsed.stop !== "pause_turn" || n >= MAX_PAUSE_CONTINUATIONS) return judge(parsed, total);
      const content = read(value, "content");
      if (!Array.isArray(content)) return judge(parsed, total);
      messages = [...sent, { role: "assistant", content: content as ContentBlockParam[] }];
    }
  }

  return {
    async structured<O>(req: ClaudeRequest, schema: z.ZodType<O>, signal: AbortSignal) {
      if (req.webTools) {
        // Citations are always on for web search and the docs do not say output_config.format works with them, so a web request
        // sends no format. It asks for the JSON in the prompt, reads it from the final text and validates it like any other reply.
        let schemaText: string;
        try {
          schemaText = JSON.stringify(outputFormatOf(schema).schema);
        } catch (err) {
          throw new ApiCallError(`output schema cannot be expressed as JSON Schema: ${safe(textOfError(err))}`, null, false, "not_billed", null);
        }
        const suffix = `\n\nWhen you have finished searching, end your reply with only one JSON object that matches this JSON Schema, and nothing after it:\n${schemaText}`;
        const prepared = prepare(req, suffix);
        const { parsed: reply, usage } = await structuredWithTools(req, prepared.model, prepared.system, prepared.messages, prepared.tools!, signal);
        const payload = extractJsonObject(reply.tail);
        if (payload === undefined) throw new ProviderError("claude returned text that is not JSON", usage, false);
        const checked = schema.safeParse(payload);
        if (!checked.success) throw new ProviderError(`claude output failed validation: ${safe(checked.error.message)}`, usage, false);
        return { output: checked.data, usage };
      }
      const { model, system, messages } = prepare(req);
      let format: JSONOutputFormat;
      try {
        format = outputFormatOf(schema);
      } catch (err) {
        throw new ApiCallError(`output schema cannot be expressed as JSON Schema: ${safe(textOfError(err))}`, null, false, "not_billed", null);
      }
      const { value } = await call(req, signal, async (callSignal) =>
        client.messages.create({ model, max_tokens: STRUCTURED_MAX_TOKENS, system, messages: [...messages], output_config: { effort: req.effort, format } }, { signal: callSignal }),
      );
      const { parsed: reply, usage } = settle(value);
      let payload: unknown;
      try {
        payload = JSON.parse(reply.text);
      } catch {
        throw new ProviderError("claude returned text that is not JSON", usage, false);
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new ProviderError(`claude output failed validation: ${safe(parsed.error.message)}`, usage, false);
      return { output: parsed.data, usage };
    },

    async streamText(req, onText, signal) {
      const { model, system, messages, tools } = prepare(req);
      const sink = redactingSink(opts.apiKey, onText);
      const { value } = await call(req, signal, async (callSignal, began) => {
        const stream = client.messages.stream(
          { model, max_tokens: STREAM_MAX_TOKENS, system, messages: [...messages], ...(tools ? { tools } : {}), output_config: { effort: req.effort } },
          { signal: callSignal },
        );
        stream.on("text", (delta) => {
          began();
          sink.push(delta);
        });
        return stream.finalMessage();
      });
      const { parsed: reply, usage } = settle(value);
      sink.flush();
      return { text: reply.text, usage };
    },
  };
}
