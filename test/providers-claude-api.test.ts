/**
 * The Messages API backend for Claude. Every test uses a fake client, so none of them opens a socket
 * or reads a real key. The SDK is imported only for its typed error classes.
 */
import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { ParseableMessageCreateParams as MessageStreamParams } from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { ClaudeRequest } from "../src/backend/providers/claude";
import {
  API_MODELS, MAX_TOKEN_COUNT, REQUEST_OVERHEAD_TOKENS, STREAM_MAX_TOKENS, STRUCTURED_MAX_TOKENS, ApiCallError, billingOfStatus, clientOptions, createClaudeApi, outputFormatOf, parseUsage, priceUsage, worstCaseUsd,
} from "../src/backend/providers/claude-api";
import type { ApiCallDetail, ApiClient, ApiStream } from "../src/backend/providers/claude-api";
import { ProviderError, unbudgeted } from "../src/backend/providers/memo";
import { OPEN } from "./providers-fixtures";

const KEY = "sk-ant-api03-test-key-0123456789";

const req = (over: Partial<ClaudeRequest> = {}): ClaudeRequest => ({
  model: "opus", effort: "medium", system: "You are the tutor.", prompt: "Ask a question.", images: [], webTools: false, timeoutMs: 5_000, ...over,
});

type Usage = {
  input?: number; output?: number; creation?: number | null; read?: number | null;
  breakdown?: { m5: number; h1: number } | null;
};

function message(o: { text?: string; blocks?: readonly unknown[]; stop?: string | null; model?: string; usage?: Usage; details?: unknown } = {}): Message {
  const u = o.usage ?? {};
  return {
    id: "msg_test", type: "message", role: "assistant", model: o.model ?? "claude-opus-5-5",
    content: o.blocks ?? [{ type: "text", text: o.text ?? "hello", citations: null }],
    stop_reason: o.stop === undefined ? "end_turn" : o.stop,
    stop_sequence: null,
    stop_details: o.details ?? null,
    usage: {
      input_tokens: u.input ?? 100, output_tokens: u.output ?? 20,
      cache_creation_input_tokens: u.creation === undefined ? 0 : u.creation,
      cache_read_input_tokens: u.read === undefined ? 0 : u.read,
      cache_creation: u.breakdown === undefined || u.breakdown === null ? null : { ephemeral_5m_input_tokens: u.breakdown.m5, ephemeral_1h_input_tokens: u.breakdown.h1 },
    },
  } as unknown as Message;
}

type Script = {
  readonly deltas?: readonly string[];
  readonly final?: Message;
  /** Rejects finalMessage after the deltas. */
  readonly fail?: unknown;
  /** Never settles until the request's signal aborts. */
  readonly hold?: boolean;
};

type Seen = { readonly params: MessageStreamParams | MessageCreateParamsNonStreaming; readonly signal: AbortSignal; readonly via: "stream" | "create" };

function fakeClient(script: Script | ((n: number) => Script)): { client: ApiClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const next = (): Script => (typeof script === "function" ? script(seen.length) : script);
  const settle = (s: Script, signal: AbortSignal, onDelta: (d: string) => void): Promise<Message> =>
    new Promise((resolve, reject) => {
      const aborted = () => reject(new Anthropic.APIUserAbortError());
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted, { once: true });
      if (s.hold) return;
      for (const d of s.deltas ?? []) onDelta(d);
      signal.removeEventListener("abort", aborted);
      if (s.fail !== undefined) reject(s.fail);
      else resolve(s.final ?? message({ text: (s.deltas ?? []).join("") }));
    });
  const client: ApiClient = {
    messages: {
      stream(params, options) {
        const s = next();
        seen.push({ params, signal: options.signal, via: "stream" });
        let listener: (d: string) => void = () => {};
        const stream: ApiStream = {
          on: (_event, l) => {
            listener = l;
            return stream;
          },
          finalMessage: () => settle(s, options.signal, (d) => listener(d)),
          abort: () => {},
        };
        return stream;
      },
      create(params, options) {
        const s = next();
        seen.push({ params, signal: options.signal, via: "create" });
        return settle(s, options.signal, () => {});
      },
    },
  };
  return { client, seen };
}

const api = (script: Script | ((n: number) => Script), extra: { maxConcurrent?: number; onResponse?: (d: ApiCallDetail) => void } = {}) => {
  const { client, seen } = fakeClient(script);
  return { claude: createClaudeApi({ apiKey: KEY, maxConcurrent: extra.maxConcurrent ?? 2, client, ...(extra.onResponse ? { onResponse: extra.onResponse } : {}) }), seen };
};

const Out = z.object({ concepts: z.array(z.string()) });

describe("request shape", () => {
  test("model ids map exactly, with no date suffix", () => {
    expect(API_MODELS).toEqual({ opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" });
  });

  test("streamText sends the model, one system block cached for 5 minutes unless the request asks for 1 hour, the prompt as the one user message and the effort", async () => {
    const { claude, seen } = api({ deltas: ["hi"] });
    await claude.streamText(req({ effort: "high" }), () => {}, OPEN);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.via).toBe("stream");
    const p = seen[0]!.params;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.system).toEqual([{ type: "text", text: "You are the tutor.", cache_control: { type: "ephemeral", ttl: "5m" } }]);
    expect(p.messages).toEqual([{ role: "user", content: "Ask a question." }]);
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.max_tokens).toBe(STREAM_MAX_TOKENS);
    expect(STREAM_MAX_TOKENS).toBeGreaterThanOrEqual(16_000);
    await claude.streamText(req({ cacheTtl: "1h" }), () => {}, OPEN);
    expect(seen[1]!.params.system).toEqual([{ type: "text", text: "You are the tutor.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  });

  test("sonnet maps to claude-sonnet-5-5", async () => {
    const { claude, seen } = api({ deltas: ["hi"] });
    await claude.streamText(req({ model: "sonnet" }), () => {}, OPEN);
    expect(seen[0]!.params.model).toBe("claude-sonnet-5-5");
  });

  test("no sampling, thinking, budget or forced tool parameter is sent, on either path", async () => {
    const { claude, seen } = api((n) => (n === 0 ? { deltas: ["x"] } : { final: message({ text: '{"concepts":[]}' }) }));
    await claude.streamText(req(), () => {}, OPEN);
    await claude.structured(req(), Out, OPEN);
    expect(seen.map((s) => s.via)).toEqual(["stream", "create"]);
    for (const s of seen) {
      const keys = Object.keys(s.params);
      for (const banned of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools"]) expect(keys).not.toContain(banned);
      expect(JSON.stringify(s.params)).not.toContain("budget_tokens");
    }
  });

  test("a model other than opus or sonnet throws a non-retryable error and sends nothing", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    const err = await claude.streamText(req({ model: "haiku" }), () => {}, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("haiku");
    expect((await claude.structured(req({ model: "claude-opus-5-5" }), Out, OPEN).catch((e) => e)).retryable).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("the SDK client has no retries of its own and cannot read a billing endpoint from the environment", () => {
    const options = clientOptions(KEY);
    expect(options.maxRetries).toBe(0);
    expect(options.apiKey).toBe(KEY);
    expect(options.authToken).toBeNull();
    expect(options.baseURL).toBe("https://api.anthropic.com");
    expect(options.logLevel).toBe("off");
    const sdk = new Anthropic(options);
    expect(sdk.maxRetries).toBe(0);
    expect(sdk.baseURL).toBe("https://api.anthropic.com");
  });
});

describe("streamText", () => {
  test("deltas reach onText in order and the final text is returned", async () => {
    const { claude } = api({ deltas: ["Hel", "lo ", "there"] });
    const got: string[] = [];
    const out = await claude.streamText(req(), (d) => got.push(d), OPEN);
    expect(got).toEqual(["Hel", "lo ", "there"]);
    expect(out.text).toBe("Hello there");
  });

  test("the returned text is the text blocks of the final message, and thinking blocks are skipped", async () => {
    const { claude } = api({
      deltas: ["a"],
      final: message({ blocks: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "first ", citations: null }, { type: "text", text: "second", citations: null }] }),
    });
    expect((await claude.streamText(req(), () => {}, OPEN)).text).toBe("first second");
  });
});

describe("structured", () => {
  test("asks for the schema through output_config.format and returns the validated output", async () => {
    const { claude, seen } = api({ final: message({ text: '{"concepts":["row picture"]}' }) });
    const { output } = await claude.structured(req({ effort: "low" }), Out, OPEN);
    expect(output).toEqual({ concepts: ["row picture"] });
    const p = seen[0]!.params;
    expect(seen[0]!.via).toBe("create");
    expect(p.max_tokens).toBe(STRUCTURED_MAX_TOKENS);
    expect(STRUCTURED_MAX_TOKENS).toBe(16_000);
    expect(p.system).toEqual([{ type: "text", text: "You are the tutor.", cache_control: { type: "ephemeral", ttl: "5m" } }]);
    const format = p.output_config?.format as { type: string; schema: { type: string; properties: Record<string, unknown> } };
    expect(p.output_config?.effort).toBe("low");
    expect(format.type).toBe("json_schema");
    expect(format.schema.type).toBe("object");
    expect(Object.keys(format.schema.properties)).toEqual(["concepts"]);
    // Nothing that cannot be serialised goes on the wire.
    expect(JSON.parse(JSON.stringify(p)).output_config.format).toEqual(format);
  });

  test("output that does not match the schema is a non-retryable error that still carries usage", async () => {
    const { claude } = api({ final: message({ text: '{"concepts":"not a list"}', usage: { input: 10, output: 4 } }) });
    const err = await claude.structured(req(), Out, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("failed validation");
    expect(err.usage.outputTokens).toBe(4);
  });

  test("text that is not JSON is a non-retryable error", async () => {
    const { claude } = api({ final: message({ text: "Sure, here you go." }) });
    const err = await claude.structured(req(), Out, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });

  test("a schema that cannot be expressed as JSON Schema is refused before any call", async () => {
    const { claude, seen } = api({ final: message() });
    const unrepresentable = z.object({ when: z.date() });
    const err = await claude.structured(req(), unrepresentable, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("usage and cost", () => {
  test("opus: fresh input, 1 hour cache writes, cache reads and output, priced from the table", async () => {
    const { claude } = api({ deltas: ["x"], final: message({ usage: { input: 1000, creation: 2000, read: 5000, output: 500, breakdown: { m5: 0, h1: 2000 } } }) });
    const { usage } = await claude.streamText(req(), () => {}, OPEN);
    // 1000 * 4 + 2000 * 8 + 5000 * 0.2 + 500 * 20, per million
    expect(usage.cost.kind).toBe("estimated");
    if (usage.cost.kind !== "estimated") throw new Error("unreachable");
    expect(usage.cost.usd).toBeCloseTo(0.031, 9);
    expect(usage.cost.basis).toBe("anthropic_api_list_price");
    expect(usage.model).toBe("claude-opus-5-5");
    // Same convention as the CLI adapter: input counts fresh plus cache-creation tokens, cache reads are separate.
    expect(usage.inputTokens).toBe(3000);
    expect(usage.cacheReadTokens).toBe(5000);
    expect(usage.outputTokens).toBe(500);
  });

  test("sonnet prices, and a 5 minute write costs 1.25 times input", () => {
    // 1000 * 2 + 1000 * 2.5 + 2000 * 4 + 4000 * 0.1 + 100 * 10, per million
    expect(priceUsage("claude-sonnet-5-5", { fresh: 1000, creation5m: 1000, creation1h: 2000, read: 4000, output: 100 })).toBeCloseTo(0.0139, 9);
    expect(priceUsage("claude-opus-5-5", { fresh: 1_000_000, creation5m: 0, creation1h: 0, read: 0, output: 0 })).toBeCloseTo(4, 9);
    expect(priceUsage("claude-opus-5-5", { fresh: 0, creation5m: 0, creation1h: 0, read: 1_000_000, output: 1_000_000 })).toBeCloseTo(20.2, 9);
  });

  test("a cache write with no TTL breakdown is priced at the dearer 1 hour rate", async () => {
    const { claude } = api({ deltas: ["x"], final: message({ usage: { input: 0, creation: 1_000_000, read: 0, output: 0, breakdown: null } }) });
    const { usage } = await claude.streamText(req(), () => {}, OPEN);
    expect(usage.cost).toEqual({ kind: "estimated", usd: 8, basis: "anthropic_api_list_price" });
  });

  test("a response that omits cache fields still reports usage", async () => {
    const { claude } = api({ deltas: ["x"], final: message({ usage: { input: 50, output: 5, creation: null, read: null } }) });
    const { usage } = await claude.streamText(req(), () => {}, OPEN);
    expect(usage.inputTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cost.kind).toBe("estimated");
  });

  test("a model with no price is reported as unknown cost, never zero", async () => {
    const { claude } = api({ deltas: ["x"], final: message({ model: "claude-mystery-9" }) });
    const { usage } = await claude.streamText(req(), () => {}, OPEN);
    expect(usage.cost.kind).toBe("unknown");
  });

  test("onResponse sees every completed response, with the split the memo does not store", async () => {
    const seen: ApiCallDetail[] = [];
    const { claude } = api({ deltas: ["x"], final: message({ usage: { input: 10, creation: 20, read: 30, output: 40, breakdown: { m5: 5, h1: 15 } } }) }, { onResponse: (d) => seen.push(d) });
    await claude.streamText(req(), () => {}, OPEN);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model: "claude-opus-5-5", stopReason: "end_turn", usage: { fresh: 10, creation5m: 5, creation1h: 15, read: 30, output: 40 } });
  });
});

describe("worstCaseUsd", () => {
  test("prices every byte of input and schema as a 1 hour cache write, plus the fixed overhead, plus the whole output limit", () => {
    // (100 + 40 + overhead) * 8 + 1000 * 20, per million, on opus
    expect(worstCaseUsd("claude-opus-5-5", 100, 1000, 40)).toBeCloseTo(((140 + REQUEST_OVERHEAD_TOKENS) * 8 + 1000 * 20) / 1_000_000, 12);
    expect(worstCaseUsd("claude-sonnet-5-5", 0, 0, 0)).toBeCloseTo((REQUEST_OVERHEAD_TOKENS * 4) / 1_000_000, 12);
    expect(worstCaseUsd("claude-mystery-9", 1, 1, 1)).toBeNull();
  });

  test("is above the cost of a response that reports more input tokens than the text has bytes", () => {
    // The old estimate counted only the text, so 2 bytes and 100 reported input tokens went over it.
    const reported = priceUsage("claude-opus-5-5", { fresh: 100, creation5m: 0, creation1h: 0, read: 0, output: 32_000 })!;
    expect(worstCaseUsd("claude-opus-5-5", 2, 32_000, 0)!).toBeGreaterThan(reported);
  });

  test("the schema the runner reserves for is the one the adapter sends", async () => {
    const { claude, seen } = api({ final: message({ text: '{"concepts":[]}' }) });
    await claude.structured(req(), Out, OPEN);
    expect(seen[0]!.params.output_config?.format).toEqual(outputFormatOf(Out));
  });
});

describe("stop reasons", () => {
  const stopped = (stop: string | null, details: unknown = null) => api({ deltas: ["partial"], final: message({ text: "partial", stop, details, usage: { input: 7, output: 3 } }) });

  test("a refusal is a non-retryable failure that names the category and carries usage", async () => {
    const { claude } = stopped("refusal", { type: "refusal", category: "cyber", explanation: "declined" });
    const err = await claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("refus");
    expect(err.message).toContain("cyber");
    expect(err.usage.outputTokens).toBe(3);
  });

  test("a max_tokens stop is a non-retryable failure, on both paths", async () => {
    const { claude } = stopped("max_tokens");
    for (const run of [() => claude.streamText(req(), () => {}, OPEN), () => claude.structured(req(), Out, OPEN)]) {
      const err = await run().catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("max_tokens");
    }
  });

  test("any other stop that is not a finished answer fails", async () => {
    for (const stop of ["tool_use", "pause_turn", "model_context_window_exceeded", null]) {
      const err = await stopped(stop).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
    }
  });

  test("end_turn and stop_sequence are answers", async () => {
    for (const stop of ["end_turn", "stop_sequence"]) {
      expect((await stopped(stop).claude.streamText(req(), () => {}, OPEN)).text).toBe("partial");
    }
  });

  test("a failed stop is still reported to onResponse, so a runner can record it", async () => {
    const seen: ApiCallDetail[] = [];
    const { claude } = api({ deltas: ["p"], final: message({ stop: "refusal" }) }, { onResponse: (d) => seen.push(d) });
    await claude.streamText(req(), () => {}, OPEN).catch(() => {});
    expect(seen.map((d) => d.stopReason)).toEqual(["refusal"]);
  });
});

/** The SDK builds an error's message from the response body, so the text under test goes in the body. */
const body = (text: string) => ({ type: "error", error: { type: "test_error", message: text } });

describe("errors", () => {
  const headers = new Headers();
  const status = (Class: new (status: never, error: never, message: string, headers: Headers) => Error, code: number) => new Class(code as never, {} as never, `http ${code}`, headers);
  const retryable: readonly [string, unknown][] = [
    ["429 rate limit", new Anthropic.RateLimitError(429, {}, "slow down", headers)],
    ["529 overloaded", new Anthropic.OverloadedError(529, {}, "overloaded", headers)],
    ["500", new Anthropic.InternalServerError(500, {}, "boom", headers)],
    ["503", new Anthropic.ServiceUnavailableError(503, {}, "unavailable", headers)],
    ["504", new Anthropic.GatewayTimeoutError(504, {}, "gateway", headers)],
    ["408", status(Anthropic.RequestTimeoutError as never, 408)],
    ["connection error", new Anthropic.APIConnectionError({ message: "socket closed" })],
    ["SDK timeout", new Anthropic.APIConnectionTimeoutError()],
  ];
  const terminal: readonly [string, unknown][] = [
    ["400", new Anthropic.BadRequestError(400, {}, "bad request", headers)],
    ["401", new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", headers)],
    ["403", new Anthropic.PermissionDeniedError(403, {}, "forbidden", headers)],
    ["404", new Anthropic.NotFoundError(404, {}, "model: nope", headers)],
    ["413", new Anthropic.ContentTooLargeError(413, {}, "too big", headers)],
    ["422", new Anthropic.UnprocessableEntityError(422, {}, "unprocessable", headers)],
  ];

  test.each(retryable)("%s is retryable", async (_name, fail) => {
    const { claude } = api({ fail });
    const err = await claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect((await api({ fail }).claude.structured(req(), Out, OPEN).catch((e) => e)).retryable).toBe(true);
  });

  test.each(terminal)("%s is not retryable", async (_name, fail) => {
    const { claude } = api({ fail });
    const err = await claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect((await api({ fail }).claude.structured(req(), Out, OPEN).catch((e) => e)).retryable).toBe(false);
  });

  test("a stream that ends without a message is retryable, and an unknown error is not", async () => {
    expect((await api({ fail: new Anthropic.AnthropicError("stream ended without producing a Message") }).claude.streamText(req(), () => {}, OPEN).catch((e) => e)).retryable).toBe(true);
    const odd = await api({ fail: new TypeError("bug") }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(odd).toBeInstanceOf(ProviderError);
    expect(odd.retryable).toBe(false);
  });

  test("the error message carries the status and the SDK text, truncated", async () => {
    const long = "z".repeat(2_000);
    const err = await api({ fail: new Anthropic.BadRequestError(400, body(long), undefined, headers) }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(err.message).toContain("400");
    expect(err.message.length).toBeLessThan(700);
  });
});

describe("which failures may have been billed", () => {
  const headers = new Headers();
  const http = (Class: new (status: never, error: never, message: string, headers: Headers) => Error, code: number) => new Class(code as never, {} as never, `http ${code}`, headers);
  const notBilled: readonly [string, unknown, number][] = [
    ["400", http(Anthropic.BadRequestError as never, 400), 400],
    ["401", http(Anthropic.AuthenticationError as never, 401), 401],
    ["403", http(Anthropic.PermissionDeniedError as never, 403), 403],
    ["404", http(Anthropic.NotFoundError as never, 404), 404],
    ["413", http(Anthropic.ContentTooLargeError as never, 413), 413],
    ["422", http(Anthropic.UnprocessableEntityError as never, 422), 422],
    ["429", http(Anthropic.RateLimitError as never, 429), 429],
  ];
  const maybeBilled: readonly [string, unknown][] = [
    ["408", http(Anthropic.RequestTimeoutError as never, 408)],
    ["500", http(Anthropic.InternalServerError as never, 500)],
    ["529", http(Anthropic.OverloadedError as never, 529)],
    ["connection error", new Anthropic.APIConnectionError({ message: "closed" })],
    ["SDK timeout", new Anthropic.APIConnectionTimeoutError()],
    ["an error event inside an open stream", new Anthropic.APIError(undefined as never, body("overloaded") as never, undefined as never, headers)],
    ["a stream with no message", new Anthropic.AnthropicError("stream ended without producing a Message")],
    ["an unknown error", new TypeError("bug")],
  ];

  test.each(notBilled)("HTTP %s is not billed and carries its status", async (_name, fail, status) => {
    const err = await api({ fail }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect(err.billing).toBe("not_billed");
    expect(err.status).toBe(status);
  });

  test.each(maybeBilled)("%s may have been billed", async (_name, fail) => {
    for (const run of [(c: ReturnType<typeof api>["claude"]) => c.streamText(req(), () => {}, OPEN), (c: ReturnType<typeof api>["claude"]) => c.structured(req(), Out, OPEN)]) {
      const err = await run(api({ fail }).claude).catch((e) => e);
      expect(err).toBeInstanceOf(ApiCallError);
      expect(err.billing).toBe("maybe_billed");
    }
  });

  test("our own timeout may have been billed, and a refusal to send anything is not billed", async () => {
    const timedOut = await api({ hold: true }).claude.streamText(req({ timeoutMs: 20 }), () => {}, OPEN).catch((e) => e);
    expect(timedOut.billing).toBe("maybe_billed");
    const refused = await api({ deltas: ["x"] }).claude.streamText(req({ model: "haiku" }), () => {}, OPEN).catch((e) => e);
    expect(refused.billing).toBe("not_billed");
  });
});

describe("abort and timeout", () => {
  test("abort rejects with an AbortError, so the memo records it as aborted, and cancels the request", async () => {
    const { claude, seen } = api({ hold: true });
    const c = new AbortController();
    const pending = claude.streamText(req(), () => {}, unbudgeted(c.signal)).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    const err = await pending;
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(seen[0]!.signal.aborted).toBe(true);
  });

  test("abort on the structured path rejects the same way", async () => {
    const { claude } = api({ hold: true });
    const c = new AbortController();
    const pending = claude.structured(req(), Out, unbudgeted(c.signal)).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    expect((await pending).name).toBe("AbortError");
  });

  test("an already aborted signal sends nothing", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    const c = new AbortController();
    c.abort();
    expect((await claude.streamText(req(), () => {}, unbudgeted(c.signal)).catch((e) => e)).name).toBe("AbortError");
    expect(seen).toHaveLength(0);
  });

  test("timeoutMs rejects with a retryable ProviderError and cancels the request", async () => {
    const { claude, seen } = api({ hold: true });
    const err = await claude.streamText(req({ timeoutMs: 20 }), () => {}, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("timed out");
    expect(seen[0]!.signal.aborted).toBe(true);
  });

  test("a caller aborted while waiting for a slot never sends, and the slot it never held is not freed", async () => {
    const { claude, seen } = api((n) => (n === 0 ? { hold: true } : { deltas: ["ok"] }), { maxConcurrent: 1 });
    const first = new AbortController();
    const holding = claude.streamText(req(), () => {}, unbudgeted(first.signal)).catch((e) => e);
    await Bun.sleep(5);
    const queued = new AbortController();
    const waiting = claude.streamText(req(), () => {}, unbudgeted(queued.signal)).catch((e) => e);
    await Bun.sleep(5);
    queued.abort();
    expect((await waiting).name).toBe("AbortError");
    expect(seen).toHaveLength(1);
    first.abort();
    expect((await holding).name).toBe("AbortError");
    expect((await claude.streamText(req(), () => {}, OPEN)).text).toBe("ok");
  });

  test("at most maxConcurrent calls run at once", async () => {
    let active = 0;
    let peak = 0;
    const client: ApiClient = {
      messages: {
        stream: () => ({
          on: () => ({}),
          abort: () => {},
          finalMessage: async () => {
            active++;
            peak = Math.max(peak, active);
            await Bun.sleep(10);
            active--;
            return message();
          },
        }),
        create: () => Promise.reject(new Error("unused")),
      },
    };
    const claude = createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client });
    await Promise.all(Array.from({ length: 6 }, () => claude.streamText(req(), () => {}, OPEN)));
    expect(peak).toBe(2);
  });

  test("maxConcurrent must be a positive integer, and the key must not be empty", () => {
    expect(() => createClaudeApi({ apiKey: KEY, maxConcurrent: 0, client: fakeClient({}).client })).toThrow(RangeError);
    expect(() => createClaudeApi({ apiKey: "", maxConcurrent: 1, client: fakeClient({}).client })).toThrow("apiKey");
  });
});

describe("images and web tools", () => {
  test("a text-only request keeps the plain string prompt and carries no tools", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    await claude.streamText(req(), () => {}, OPEN);
    const p = seen[0]!.params as MessageStreamParams;
    expect(p.messages).toEqual([{ role: "user", content: "Ask a question." }]);
    expect("tools" in p).toBe(false);
  });

  test("images and web tools reach the stream request as base64 blocks and the two server tools", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    const images = [{ label: "frame", mediaType: "image/png" as const, bytes: new Uint8Array([1, 2]) }];
    await claude.streamText(req({ images, webTools: true }), () => {}, OPEN);
    const p = seen[0]!.params as MessageStreamParams;
    expect(p.messages[0]!.content).toEqual([
      { type: "text", text: "Image frame:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQI=" } },
      { type: "text", text: "Ask a question." },
    ]);
    expect(p.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 5 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 }]);
  });
});

describe("the key", () => {
  test("appears in no thrown message, even when the SDK error text contains it", async () => {
    const headers = new Headers();
    const leaky = [
      new Anthropic.AuthenticationError(401, body(`invalid x-api-key ${KEY}`), undefined, headers),
      new Anthropic.APIConnectionError({ message: `connect failed for ${KEY}` }),
      new Anthropic.InternalServerError(500, body(`echo ${KEY}`), undefined, headers),
    ];
    for (const fail of leaky) {
      const err = await api({ fail }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).not.toContain(KEY);
      expect(err.message).toContain("[redacted]");
      expect(JSON.stringify(err.usage)).not.toContain(KEY);
    }
  });

  test("is not in the request, the usage report or a refusal message", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    const { usage } = await claude.streamText(req(), () => {}, OPEN);
    expect(JSON.stringify(seen[0]!.params)).not.toContain(KEY);
    expect(JSON.stringify(usage)).not.toContain(KEY);
    const err = await createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client: fakeClient({ final: message({ stop: "refusal" }) }).client }).streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(err.message).not.toContain(KEY);
  });
});

describe("the key where messages are clipped", () => {
  const headers = new Headers();
  /** Any prefix of the key, from "sk-ant" on, left in a message is a leak. */
  const leaks = (text: string) => Array.from({ length: KEY.length - 5 }, (_, i) => KEY.slice(0, i + 6)).some((prefix) => text.includes(prefix));
  /** The key starts at every offset across the 500 character clip, so one of them straddles it whatever text the message adds in front. */
  const offsets = Array.from({ length: 150 }, (_, i) => 380 + i);
  const at = (offset: number) => "a".repeat(offset) + KEY;
  const Strict = z.strictObject({});

  async function messages(name: string, offset: number): Promise<string[]> {
    const text = at(offset);
    const ask = (script: Script, run: "stream" | "structured" = "stream", schema: z.ZodType = Out, r = req()) => {
      const { claude } = api(script);
      return (run === "stream" ? claude.streamText(r, () => {}, OPEN) : claude.structured(r, schema, OPEN)).then(
        (ok) => [JSON.stringify(ok)],
        (e: ProviderError) => [e.message, JSON.stringify(e.usage)],
      );
    };
    switch (name) {
      case "refusal explanation":
        return ask({ deltas: ["p"], final: message({ stop: "refusal", details: { type: "refusal", category: "x", explanation: text } }) });
      case "refusal category":
        return ask({ deltas: ["p"], final: message({ stop: "refusal", details: { type: "refusal", category: text, explanation: "e" } }) });
      case "API error body":
        return ask({ fail: new Anthropic.BadRequestError(400, body(text), undefined, headers) });
      case "connection error":
        return ask({ fail: new Anthropic.APIConnectionError({ message: text }) });
      case "unknown error":
        return ask({ fail: new TypeError(text) });
      case "validation failure":
        return ask({ final: message({ text: JSON.stringify({ [text]: 1 }) }) }, "structured", Strict);
      case "stop reason":
        return ask({ deltas: ["p"], final: message({ stop: text }) });
      case "unsupported model":
        return ask({ deltas: ["x"] }, "stream", Out, req({ model: text }));
      case "unpriced model":
        return ask({ deltas: ["x"], final: message({ model: text }) });
      default:
        throw new Error(name);
    }
  }

  test.each([
    "refusal explanation", "refusal category", "API error body", "connection error", "unknown error", "validation failure", "stop reason", "unsupported model", "unpriced model",
  ])("%s: no part of the key survives, wherever it falls against the clip", async (name) => {
    for (const offset of offsets) {
      for (const text of await messages(name, offset)) expect(leaks(text)).toBe(false);
    }
  });
});

describe("what leaves the adapter is parsed at the boundary", () => {
  /** Every string the adapter hands out, in one place: a thrown error, the usage report, the callback detail and the result. */
  const everything = (parts: unknown) => JSON.stringify(parts);
  const stopOf = async (stop: unknown) => {
    const seen: ApiCallDetail[] = [];
    const { claude } = api({ deltas: ["p"], final: message({ stop: stop as string }) }, { onResponse: (d) => seen.push(d) });
    const err = await claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    return { seen, err };
  };

  test("a stop reason that is the key reaches no callback, error or usage report, and is reported as unknown", async () => {
    const { seen, err } = await stopOf(KEY);
    expect(seen[0]!.stopReason).toBe("unknown");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("unknown");
    expect(everything([seen, err.message, err.usage])).not.toContain(KEY);
  });

  test.each([
    ["a made-up string", "something_new"],
    ["a number", 7],
    ["an object", { x: 1 }],
    ["a very long string", "e".repeat(10_000)],
  ])("%s as the stop reason is mapped to unknown, never passed on", async (_name, stop) => {
    const { seen } = await stopOf(stop);
    expect(seen[0]!.stopReason).toBe("unknown");
  });

  test("every known stop reason passes through as itself, and an absent one stays null", async () => {
    for (const stop of ["end_turn", "stop_sequence", "max_tokens", "refusal", "tool_use", "pause_turn", "model_context_window_exceeded"]) {
      expect((await stopOf(stop)).seen[0]!.stopReason).toBe(stop as never);
    }
    expect((await stopOf(null)).seen[0]!.stopReason).toBeNull();
  });

  test("the model name is redacted and clipped in the callback and in the usage report", async () => {
    const seen: ApiCallDetail[] = [];
    const { claude } = api({ deltas: ["x"], final: message({ model: `claude-x-${KEY}-${"m".repeat(200)}` }) }, { onResponse: (d) => seen.push(d) });
    const { usage } = await claude.streamText(req(), () => {}, OPEN);
    expect(seen[0]!.model.length).toBeLessThanOrEqual(80);
    expect(usage.model.length).toBeLessThanOrEqual(80);
    expect(everything([seen, usage])).not.toContain(KEY);
    const odd = api({ deltas: ["x"], final: message({ model: { toString: () => KEY } as never }) });
    const report = await odd.claude.streamText(req(), () => {}, OPEN);
    expect(typeof report.usage.model).toBe("string");
    expect(everything(report.usage)).not.toContain(KEY);
  });

  test("a refusal's category and explanation are redacted, and values that are not strings are ignored", async () => {
    const leaky = await api({ final: message({ stop: "refusal", details: { type: "refusal", category: KEY, explanation: `why ${KEY}` } }) }).claude.structured(req(), Out, OPEN).catch((e) => e);
    expect(leaky.message).toContain("refus");
    expect(everything([leaky.message, leaky.usage])).not.toContain(KEY);
    const odd = await api({ final: message({ stop: "refusal", details: { type: "refusal", category: { k: KEY }, explanation: 5 } }) }).claude.structured(req(), Out, OPEN).catch((e) => e);
    expect(odd.message).toBe("claude refused the request");
  });

  test("the reply text has the key removed, in the returned text and in every delta, even when the key is split across deltas", async () => {
    const heard: string[] = [];
    const { claude } = api({ deltas: ["say ", KEY.slice(0, 9), KEY.slice(9), " now"], final: message({ text: `say ${KEY} now` }) });
    const out = await claude.streamText(req(), (d) => heard.push(d), OPEN);
    expect(out.text).toBe("say [redacted] now");
    expect(heard.join("")).toBe("say [redacted] now");
    expect(everything(heard)).not.toContain(KEY);
  });

  test("text that only looks like the start of the key is still delivered whole", async () => {
    const heard: string[] = [];
    const { claude } = api({ deltas: ["use sk-an", "t tools"], final: message({ text: "use sk-ant tools" }) });
    await claude.streamText(req(), (d) => heard.push(d), OPEN);
    expect(heard.join("")).toBe("use sk-ant tools");
  });

  test("a structured answer is validated on text with the key removed, so the key is not in the returned output", async () => {
    const { claude } = api({ final: message({ text: JSON.stringify({ concepts: [`a ${KEY}`] }) }) });
    const { output } = await claude.structured(req(), Out, OPEN);
    expect(everything(output)).not.toContain(KEY);
  });

  test("content that is not text blocks is skipped, and a message that is not an object is a failed call with unknown fields", async () => {
    const mixed = await api({ deltas: [], final: message({ blocks: [{ type: "text", text: 5 }, null, "x", { type: "text", text: "ok" }] }) }).claude.streamText(req(), () => {}, OPEN);
    expect(mixed.text).toBe("ok");
    for (const bad of [[], "nope", 7, { content: "x" }]) {
      const seen: ApiCallDetail[] = [];
      const err = await api({ deltas: [], final: bad as never }, { onResponse: (d) => seen.push(d) }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(seen[0]).toMatchObject({ stopReason: null, usage: null, costUsd: null });
    }
  });

  test("an SDK error's status is read only when it is an HTTP status, and its message is redacted", async () => {
    const headers = new Headers({ "x-echo": KEY });
    const err = new Anthropic.APIError(400, body(`bad ${KEY}`), `bad ${KEY}`, headers);
    (err as { cause?: unknown }).cause = new Error(`cause ${KEY}`);
    const out = await api({ fail: err }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(out.status).toBe(400);
    expect(everything([out.message, out.status, out.usage])).not.toContain(KEY);
    for (const status of ["504", Number.NaN, 1000, -1, 200.5, KEY, null]) {
      const weird = Object.assign(new Anthropic.APIError(undefined as never, {} as never, "x", headers), { status });
      const got = await api({ fail: weird }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
      expect(got.status).toBeNull();
      expect(got.billing).toBe("maybe_billed");
      expect(got.message).not.toContain(KEY);
    }
  });
});

describe("the billing table, one row per status", () => {
  const headers = new Headers();
  /** Rejected before any model ran: the request was invalid, unauthenticated, forbidden, aimed at nothing, too large or unprocessable, or the caller was rate limited. */
  const free = [400, 401, 403, 404, 413, 422, 429];
  /** Everything else keeps its reservation. 408 and 409 do not say whether the work started, and a 5xx may come after a model ran. */
  const kept = [402, 405, 408, 409, 410, 418, 500, 501, 502, 503, 504, 507, 529, 599];

  test.each(free)("HTTP %i is not billed, on both paths", async (status) => {
    const fail = Anthropic.APIError.generate(status, body("x") as never, "x", headers);
    for (const run of [(c: ReturnType<typeof api>["claude"]) => c.streamText(req(), () => {}, OPEN), (c: ReturnType<typeof api>["claude"]) => c.structured(req(), Out, OPEN)]) {
      const err = await run(api({ fail }).claude).catch((e) => e);
      expect(err).toBeInstanceOf(ApiCallError);
      expect(err.status).toBe(status);
      expect(err.billing).toBe("not_billed");
    }
  });

  test.each(kept)("HTTP %i keeps its reservation, on both paths", async (status) => {
    const fail = Anthropic.APIError.generate(status, body("x") as never, "x", headers);
    for (const run of [(c: ReturnType<typeof api>["claude"]) => c.streamText(req(), () => {}, OPEN), (c: ReturnType<typeof api>["claude"]) => c.structured(req(), Out, OPEN)]) {
      const err = await run(api({ fail }).claude).catch((e) => e);
      expect(err).toBeInstanceOf(ApiCallError);
      expect(err.status).toBe(status);
      expect(err.billing).toBe("maybe_billed");
    }
  });

  test("the table function agrees, and a missing status is maybe billed", () => {
    for (const s of free) expect(billingOfStatus(s)).toBe("not_billed");
    for (const s of kept) expect(billingOfStatus(s)).toBe("maybe_billed");
    expect(billingOfStatus(null)).toBe("maybe_billed");
  });

  test("an abort, a caller timeout and a broken stream keep their reservation", async () => {
    const ctl = new AbortController();
    const held = api({ hold: true }).claude.streamText(req(), () => {}, unbudgeted(ctl.signal)).catch((e) => e);
    ctl.abort();
    const aborted = await held;
    expect(aborted.name).toBe("AbortError");
    const timedOut = await api({ hold: true }).claude.structured(req({ timeoutMs: 20 }), Out, OPEN).catch((e) => e);
    expect(timedOut.billing).toBe("maybe_billed");
    const broken = await api({ fail: new Anthropic.AnthropicError("stream ended without producing a Message") }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(broken.billing).toBe("maybe_billed");
  });
});

describe("usage is parsed into non-negative safe integers or it is unknown", () => {
  const good = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null };
  const withUsage = (usage: unknown) => ({ ...message({ text: "x" }), usage } as unknown as Message);
  const without = (key: string) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== key));
  const invalid: readonly [string, unknown][] = [
    ["input_tokens missing", without("input_tokens")],
    ["output_tokens missing", without("output_tokens")],
    ["usage missing", undefined],
    ["usage null", null],
    ["usage a string", "lots"],
    ["input_tokens a numeric string", { ...good, input_tokens: "100" }],
    ["input_tokens NaN", { ...good, input_tokens: Number.NaN }],
    ["output_tokens Infinity", { ...good, output_tokens: Number.POSITIVE_INFINITY }],
    ["input_tokens negative", { ...good, input_tokens: -1 }],
    ["output_tokens negative", { ...good, output_tokens: -5_000_000 }],
    ["output_tokens fractional", { ...good, output_tokens: 1.5 }],
    ["output_tokens one billion", { ...good, output_tokens: 1_000_000_000 }],
    ["output_tokens past the safe integer range", { ...good, output_tokens: 2 ** 53 }],
    ["output_tokens just over the bound", { ...good, output_tokens: MAX_TOKEN_COUNT + 1 }],
    ["cache read negative", { ...good, cache_read_input_tokens: -1 }],
    ["cache read not a number", { ...good, cache_read_input_tokens: "7" }],
    ["cache creation negative", { ...good, cache_creation_input_tokens: -1 }],
    ["cache breakdown not an object", { ...good, cache_creation: 5 }],
    ["cache breakdown with a negative part", { ...good, cache_creation: { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 0 } }],
    ["cache breakdown with a missing part", { ...good, cache_creation: { ephemeral_5m_input_tokens: 1 } }],
  ];

  test.each(invalid)("%s: unknown cost, no tokens reported, and no NaN or negative number anywhere", async (_name, usage) => {
    const seen: ApiCallDetail[] = [];
    const { claude } = api({ deltas: ["x"], final: withUsage(usage) }, { onResponse: (d) => seen.push(d) });
    const { usage: report } = await claude.streamText(req(), () => {}, OPEN);
    expect(report.cost.kind).toBe("unknown");
    expect([report.inputTokens, report.outputTokens, report.cacheReadTokens]).toEqual([null, null, null]);
    expect(seen[0]).toMatchObject({ usage: null, costUsd: null });
    expect(JSON.stringify([report, seen])).not.toMatch(/NaN|Infinity|:-\d/);
  });

  test("the same on the structured path and on a failing stop, which still carries an unknown cost", async () => {
    const bad = withUsage({ ...good, output_tokens: -1 });
    const ok = await api({ final: { ...bad, content: [{ type: "text", text: '{"concepts":[]}' }] } as Message }).claude.structured(req(), Out, OPEN);
    expect(ok.usage.cost.kind).toBe("unknown");
    const refused = await api({ deltas: [], final: { ...bad, stop_reason: "refusal" } as Message }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(refused.usage.cost.kind).toBe("unknown");
    expect(refused.usage.outputTokens).toBeNull();
  });

  test("the bound is inclusive, and the cache fields may be absent or null", () => {
    expect(parseUsage({ input_tokens: MAX_TOKEN_COUNT, output_tokens: 0 })).toEqual({ fresh: MAX_TOKEN_COUNT, creation5m: 0, creation1h: 0, read: 0, output: 0 });
    expect(parseUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, cache_creation: null })).toEqual({ fresh: 0, creation5m: 0, creation1h: 0, read: 0, output: 0 });
    expect(parseUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 20, cache_read_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 } })).toEqual({ fresh: 1, creation5m: 5, creation1h: 15, read: 3, output: 2 });
  });

  test("priceUsage never returns NaN, Infinity or a negative figure", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(priceUsage("claude-opus-5-5", { fresh: bad, creation5m: 0, creation1h: 0, read: 0, output: 0 })).toBeNull();
      expect(priceUsage("claude-opus-5-5", { fresh: 0, creation5m: 0, creation1h: 0, read: 0, output: bad })).toBeNull();
    }
  });
});

describe("nothing caught from the client is rethrown or trusted", () => {
  const headers = new Headers();
  const boom = () => {
    throw new Error(KEY);
  };
  /** An object whose every trap throws, so any property read, prototype check or key listing on it throws the key. */
  const hostile = (target: object = {}) => new Proxy(target, new Proxy({}, { get: () => boom }));
  /** The same, but only `get` throws, so `instanceof` still sees the target's class. */
  const hostileGet = (target: object) => new Proxy(target, { get: boom });
  const getter = <T extends object>(target: T, key: string): T => Object.defineProperty(target, key, { get: boom, configurable: true });
  const runs = [
    ["streamText", (c: ReturnType<typeof api>["claude"]) => c.streamText(req(), () => {}, OPEN)],
    ["structured", (c: ReturnType<typeof api>["claude"]) => c.structured(req(), Out, OPEN)],
  ] as const;
  const clean = (err: ApiCallError) => {
    expect(err).toBeInstanceOf(ApiCallError);
    expect(err.usage).toBeNull();
    expect(JSON.stringify([err.message, err.usage, err.status])).not.toContain(KEY);
  };

  test("a ProviderError the client throws is rebuilt: its text is redacted, its usage is dropped, and it is maybe billed", async () => {
    const usage = { model: KEY, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cost: { kind: "unknown", reason: KEY } } as const;
    const fail = new ProviderError(KEY, usage, false);
    for (const [, run] of runs) {
      const err = await run(api({ fail }).claude).catch((e) => e);
      expect(err).not.toBe(fail);
      clean(err);
      expect(err.message).toContain("[redacted]");
      expect(err.billing).toBe("maybe_billed");
    }
  });

  test("an ApiCallError the client throws cannot claim not_billed or a status, before or after text", async () => {
    const forged = () => new ApiCallError(KEY, null, false, "not_billed", 400);
    for (const [, run] of runs) {
      const err = await run(api({ fail: forged() }).claude).catch((e) => e);
      clean(err);
      expect(err.billing).toBe("maybe_billed");
      expect(err.status).toBeNull();
    }
    const after = await api({ deltas: ["some text"], fail: forged() }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    clean(after);
    expect(after.billing).toBe("maybe_billed");
  });

  test("a real 4xx that arrives after text was streamed is maybe billed, because a response had started", async () => {
    const fail = new Anthropic.BadRequestError(400, body("x"), undefined, headers);
    const seen: string[] = [];
    const err = await api({ deltas: ["some text"], fail }).claude.streamText(req(), (t) => seen.push(t), OPEN).catch((e) => e);
    expect(seen.join("")).toBe("some text");
    expect(err.billing).toBe("maybe_billed");
    const before = await api({ fail }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(before.billing).toBe("not_billed");
    expect(before.status).toBe(400);
  });

  test.each([
    ["a plain object with a message and a free-looking status", { message: KEY, status: 400, billing: "not_billed" }],
    ["a string", KEY],
    ["null", null],
    ["a number", 0],
    ["a proxy whose every trap throws", hostile()],
    ["a proxy over an SDK error whose gets throw", hostileGet(new Anthropic.BadRequestError(400, body(KEY), undefined, headers))],
  ])("%s is rebuilt as a maybe-billed error with no status and no key", async (_name, fail) => {
    for (const [, run] of runs) {
      const err = await run(api({ fail }).claude).catch((e) => e);
      clean(err);
      expect(err.billing).toBe("maybe_billed");
      expect(err.status).toBeNull();
    }
  });

  test.each(["status", "message", "name", "cause"])("an error whose %s getter throws the key does not escape", async (key) => {
    const fails = [getter(new Anthropic.BadRequestError(400, body("x"), "x", headers), key), getter(new Error("plain"), key), getter(new Anthropic.APIConnectionError({ message: "x" }), key)];
    for (const fail of fails) {
      for (const [, run] of runs) {
        const err = await run(api({ fail }).claude).catch((e) => e);
        clean(err);
        expect(err.billing === "maybe_billed" || err.status === 400).toBe(true);
      }
    }
  });

  test("a throwing status getter is no status, so it is maybe billed", async () => {
    const err = await api({ fail: getter(new Anthropic.BadRequestError(400, body("x"), "x", headers), "status") }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    clean(err);
    expect(err.status).toBeNull();
    expect(err.billing).toBe("maybe_billed");
  });

  test("the adapter's own errors are not told apart from a client's by class: refusal, max_tokens, schema and refused features all come from outside the client call", async () => {
    const swallowed = new ProviderError("claude refused the request", null, false);
    for (const [, run] of runs) {
      const err = await run(api({ fail: swallowed }).claude).catch((e) => e);
      expect(err).not.toBe(swallowed);
      expect(err).toBeInstanceOf(ApiCallError);
    }
    const refusal = await api({ deltas: ["x"], final: message({ stop: "refusal" }) }).claude.streamText(req(), () => {}, OPEN).catch((e) => e);
    expect(refusal).toBeInstanceOf(ProviderError);
    expect(refusal).not.toBeInstanceOf(ApiCallError);
    expect(refusal.usage).not.toBeNull();
    const schema = await api({ final: message({ text: '{"concepts":1}' }) }).claude.structured(req(), Out, OPEN).catch((e) => e);
    expect(schema.message).toContain("failed validation");
    expect(schema.usage).not.toBeNull();
  });

  test("a response whose fields throw is a maybe-billed failed call with no key and nothing reported", async () => {
    const reported: ApiCallDetail[] = [];
    const responses = [
      getter({ model: "claude-opus-5-5", content: [], stop_reason: "end_turn", usage: {} }, "stop_reason"),
      getter({ model: "claude-opus-5-5", content: [], stop_reason: "end_turn" }, "usage"),
      { model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [getter({ type: "text" }, "text")] },
      { model: "claude-opus-5-5", stop_reason: "end_turn", usage: getter({ input_tokens: 1 }, "output_tokens"), content: [] },
      hostile(),
      hostileGet(message({})),
    ];
    for (const final of responses) {
      for (const [, run] of runs) {
        const err = await run(api({ deltas: ["t"], final: final as Message }, { onResponse: (d) => reported.push(d) }).claude).catch((e) => e);
        clean(err);
        expect(err.billing).toBe("maybe_billed");
      }
    }
    expect(JSON.stringify(reported)).not.toContain(KEY);
  });

  test("a client, a stream or a method that throws on access is a maybe-billed error with no key", async () => {
    const stream = (over: object) => hostile({ ...over });
    const shapes: readonly [string, () => ApiClient][] = [
      ["messages", () => ({ get messages(): never { return boom(); } }) as ApiClient],
      ["stream method", () => ({ messages: { get stream(): never { return boom(); }, get create(): never { return boom(); } } }) as ApiClient],
      ["stream object", () => ({ messages: { stream: () => stream({}), create: () => Promise.reject(hostile()) } }) as unknown as ApiClient],
      ["stream.on", () => ({ messages: { stream: () => ({ get on(): never { return boom(); }, finalMessage: () => Promise.resolve(message({})), abort() {} }), create: boom } }) as unknown as ApiClient],
      ["stream.finalMessage", () => ({ messages: { stream: () => ({ on: () => ({}), get finalMessage(): never { return boom(); }, abort() {} }), create: boom } }) as unknown as ApiClient],
      ["a thenable that throws", () => ({ messages: { stream: () => ({ on: () => ({}), finalMessage: () => hostile(), abort() {} }), create: () => hostile() } }) as unknown as ApiClient],
    ];
    for (const [, make] of shapes) {
      for (const [, run] of runs) {
        const err = await run(createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client: make() })).catch((e) => e);
        clean(err);
        expect(err.billing).toBe("maybe_billed");
      }
    }
  });

  test("a delta that is not a string is dropped, and the deltas and the text that were streamed stay complete and in order", async () => {
    const seen: string[] = [];
    const { claude } = api({ deltas: ["a", "b", "c"] });
    const out = await claude.streamText(req(), (t) => seen.push(t), OPEN);
    expect(seen.join("")).toBe("abc");
    expect(out.text).toBe("abc");
  });
});
