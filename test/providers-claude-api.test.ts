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
  API_MODELS, STREAM_MAX_TOKENS, STRUCTURED_MAX_TOKENS, clientOptions, createClaudeApi, priceUsage,
} from "../src/backend/providers/claude-api";
import type { ApiCallDetail, ApiClient, ApiStream } from "../src/backend/providers/claude-api";
import { ProviderError } from "../src/backend/providers/memo";
import { NEVER } from "./providers-fixtures";

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

  test("streamText sends the model, one cached system block, the prompt as the one user message and the effort", async () => {
    const { claude, seen } = api({ deltas: ["hi"] });
    await claude.streamText(req({ effort: "high" }), () => {}, NEVER);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.via).toBe("stream");
    const p = seen[0]!.params;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.system).toEqual([{ type: "text", text: "You are the tutor.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(p.messages).toEqual([{ role: "user", content: "Ask a question." }]);
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.max_tokens).toBe(STREAM_MAX_TOKENS);
    expect(STREAM_MAX_TOKENS).toBeGreaterThanOrEqual(16_000);
  });

  test("sonnet maps to claude-sonnet-5-5", async () => {
    const { claude, seen } = api({ deltas: ["hi"] });
    await claude.streamText(req({ model: "sonnet" }), () => {}, NEVER);
    expect(seen[0]!.params.model).toBe("claude-sonnet-5-5");
  });

  test("no sampling, thinking, budget or forced tool parameter is sent, on either path", async () => {
    const { claude, seen } = api((n) => (n === 0 ? { deltas: ["x"] } : { final: message({ text: '{"concepts":[]}' }) }));
    await claude.streamText(req(), () => {}, NEVER);
    await claude.structured(req(), Out, NEVER);
    expect(seen.map((s) => s.via)).toEqual(["stream", "create"]);
    for (const s of seen) {
      const keys = Object.keys(s.params);
      for (const banned of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools"]) expect(keys).not.toContain(banned);
      expect(JSON.stringify(s.params)).not.toContain("budget_tokens");
    }
  });

  test("a model other than opus or sonnet throws a non-retryable error and sends nothing", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    const err = await claude.streamText(req({ model: "haiku" }), () => {}, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("haiku");
    expect((await claude.structured(req({ model: "claude-opus-5-5" }), Out, NEVER).catch((e) => e)).retryable).toBe(false);
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
    const out = await claude.streamText(req(), (d) => got.push(d), NEVER);
    expect(got).toEqual(["Hel", "lo ", "there"]);
    expect(out.text).toBe("Hello there");
  });

  test("the returned text is the text blocks of the final message, and thinking blocks are skipped", async () => {
    const { claude } = api({
      deltas: ["a"],
      final: message({ blocks: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "first ", citations: null }, { type: "text", text: "second", citations: null }] }),
    });
    expect((await claude.streamText(req(), () => {}, NEVER)).text).toBe("first second");
  });
});

describe("structured", () => {
  test("asks for the schema through output_config.format and returns the validated output", async () => {
    const { claude, seen } = api({ final: message({ text: '{"concepts":["row picture"]}' }) });
    const { output } = await claude.structured(req({ effort: "low" }), Out, NEVER);
    expect(output).toEqual({ concepts: ["row picture"] });
    const p = seen[0]!.params;
    expect(seen[0]!.via).toBe("create");
    expect(p.max_tokens).toBe(STRUCTURED_MAX_TOKENS);
    expect(STRUCTURED_MAX_TOKENS).toBe(16_000);
    expect(p.system).toEqual([{ type: "text", text: "You are the tutor.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
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
    const err = await claude.structured(req(), Out, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("failed validation");
    expect(err.usage.outputTokens).toBe(4);
  });

  test("text that is not JSON is a non-retryable error", async () => {
    const { claude } = api({ final: message({ text: "Sure, here you go." }) });
    const err = await claude.structured(req(), Out, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });

  test("a schema that cannot be expressed as JSON Schema is refused before any call", async () => {
    const { claude, seen } = api({ final: message() });
    const unrepresentable = z.object({ when: z.date() });
    const err = await claude.structured(req(), unrepresentable, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("usage and cost", () => {
  test("opus: fresh input, 1 hour cache writes, cache reads and output, priced from the table", async () => {
    const { claude } = api({ deltas: ["x"], final: message({ usage: { input: 1000, creation: 2000, read: 5000, output: 500, breakdown: { m5: 0, h1: 2000 } } }) });
    const { usage } = await claude.streamText(req(), () => {}, NEVER);
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

  test("a cache write with no TTL breakdown is priced as the 1 hour write the request asked for", async () => {
    const { claude } = api({ deltas: ["x"], final: message({ usage: { input: 0, creation: 1_000_000, read: 0, output: 0, breakdown: null } }) });
    const { usage } = await claude.streamText(req(), () => {}, NEVER);
    expect(usage.cost).toEqual({ kind: "estimated", usd: 8, basis: "anthropic_api_list_price" });
  });

  test("a response that omits cache fields still reports usage", async () => {
    const { claude } = api({ deltas: ["x"], final: message({ usage: { input: 50, output: 5, creation: null, read: null } }) });
    const { usage } = await claude.streamText(req(), () => {}, NEVER);
    expect(usage.inputTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cost.kind).toBe("estimated");
  });

  test("a model with no price is reported as unknown cost, never zero", async () => {
    const { claude } = api({ deltas: ["x"], final: message({ model: "claude-mystery-9" }) });
    const { usage } = await claude.streamText(req(), () => {}, NEVER);
    expect(usage.cost.kind).toBe("unknown");
  });

  test("onResponse sees every completed response, with the split the memo does not store", async () => {
    const seen: ApiCallDetail[] = [];
    const { claude } = api({ deltas: ["x"], final: message({ usage: { input: 10, creation: 20, read: 30, output: 40, breakdown: { m5: 5, h1: 15 } } }) }, { onResponse: (d) => seen.push(d) });
    await claude.streamText(req(), () => {}, NEVER);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model: "claude-opus-5-5", stopReason: "end_turn", fresh: 10, creation5m: 5, creation1h: 15, read: 30, output: 40 });
  });
});

describe("stop reasons", () => {
  const stopped = (stop: string | null, details: unknown = null) => api({ deltas: ["partial"], final: message({ text: "partial", stop, details, usage: { input: 7, output: 3 } }) });

  test("a refusal is a non-retryable failure that names the category and carries usage", async () => {
    const { claude } = stopped("refusal", { type: "refusal", category: "cyber", explanation: "declined" });
    const err = await claude.streamText(req(), () => {}, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("refus");
    expect(err.message).toContain("cyber");
    expect(err.usage.outputTokens).toBe(3);
  });

  test("a max_tokens stop is a non-retryable failure, on both paths", async () => {
    const { claude } = stopped("max_tokens");
    for (const run of [() => claude.streamText(req(), () => {}, NEVER), () => claude.structured(req(), Out, NEVER)]) {
      const err = await run().catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("max_tokens");
    }
  });

  test("any other stop that is not a finished answer fails", async () => {
    for (const stop of ["tool_use", "pause_turn", "model_context_window_exceeded", null]) {
      const err = await stopped(stop).claude.streamText(req(), () => {}, NEVER).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
    }
  });

  test("end_turn and stop_sequence are answers", async () => {
    for (const stop of ["end_turn", "stop_sequence"]) {
      expect((await stopped(stop).claude.streamText(req(), () => {}, NEVER)).text).toBe("partial");
    }
  });

  test("a failed stop is still reported to onResponse, so a runner can record it", async () => {
    const seen: ApiCallDetail[] = [];
    const { claude } = api({ deltas: ["p"], final: message({ stop: "refusal" }) }, { onResponse: (d) => seen.push(d) });
    await claude.streamText(req(), () => {}, NEVER).catch(() => {});
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
    const err = await claude.streamText(req(), () => {}, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect((await api({ fail }).claude.structured(req(), Out, NEVER).catch((e) => e)).retryable).toBe(true);
  });

  test.each(terminal)("%s is not retryable", async (_name, fail) => {
    const { claude } = api({ fail });
    const err = await claude.streamText(req(), () => {}, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect((await api({ fail }).claude.structured(req(), Out, NEVER).catch((e) => e)).retryable).toBe(false);
  });

  test("a stream that ends without a message is retryable, and an unknown error is not", async () => {
    expect((await api({ fail: new Anthropic.AnthropicError("stream ended without producing a Message") }).claude.streamText(req(), () => {}, NEVER).catch((e) => e)).retryable).toBe(true);
    const odd = await api({ fail: new TypeError("bug") }).claude.streamText(req(), () => {}, NEVER).catch((e) => e);
    expect(odd).toBeInstanceOf(ProviderError);
    expect(odd.retryable).toBe(false);
  });

  test("the error message carries the status and the SDK text, truncated", async () => {
    const long = "z".repeat(2_000);
    const err = await api({ fail: new Anthropic.BadRequestError(400, body(long), undefined, headers) }).claude.streamText(req(), () => {}, NEVER).catch((e) => e);
    expect(err.message).toContain("400");
    expect(err.message.length).toBeLessThan(700);
  });
});

describe("abort and timeout", () => {
  test("abort rejects with an AbortError, so the memo records it as aborted, and cancels the request", async () => {
    const { claude, seen } = api({ hold: true });
    const c = new AbortController();
    const pending = claude.streamText(req(), () => {}, c.signal).catch((e) => e);
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
    const pending = claude.structured(req(), Out, c.signal).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    expect((await pending).name).toBe("AbortError");
  });

  test("an already aborted signal sends nothing", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    const c = new AbortController();
    c.abort();
    expect((await claude.streamText(req(), () => {}, c.signal).catch((e) => e)).name).toBe("AbortError");
    expect(seen).toHaveLength(0);
  });

  test("timeoutMs rejects with a retryable ProviderError and cancels the request", async () => {
    const { claude, seen } = api({ hold: true });
    const err = await claude.streamText(req({ timeoutMs: 20 }), () => {}, NEVER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("timed out");
    expect(seen[0]!.signal.aborted).toBe(true);
  });

  test("a caller aborted while waiting for a slot never sends, and the slot it never held is not freed", async () => {
    const { claude, seen } = api((n) => (n === 0 ? { hold: true } : { deltas: ["ok"] }), { maxConcurrent: 1 });
    const first = new AbortController();
    const holding = claude.streamText(req(), () => {}, first.signal).catch((e) => e);
    await Bun.sleep(5);
    const queued = new AbortController();
    const waiting = claude.streamText(req(), () => {}, queued.signal).catch((e) => e);
    await Bun.sleep(5);
    queued.abort();
    expect((await waiting).name).toBe("AbortError");
    expect(seen).toHaveLength(1);
    first.abort();
    expect((await holding).name).toBe("AbortError");
    expect((await claude.streamText(req(), () => {}, NEVER)).text).toBe("ok");
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
    await Promise.all(Array.from({ length: 6 }, () => claude.streamText(req(), () => {}, NEVER)));
    expect(peak).toBe(2);
  });

  test("maxConcurrent must be a positive integer, and the key must not be empty", () => {
    expect(() => createClaudeApi({ apiKey: KEY, maxConcurrent: 0, client: fakeClient({}).client })).toThrow(RangeError);
    expect(() => createClaudeApi({ apiKey: "", maxConcurrent: 1, client: fakeClient({}).client })).toThrow("apiKey");
  });
});

describe("what this trial does not cover", () => {
  test("web tools are refused with a clear non-retryable error and nothing is sent", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    for (const run of [() => claude.streamText(req({ webTools: true }), () => {}, NEVER), () => claude.structured(req({ webTools: true }), Out, NEVER)]) {
      const err = await run().catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("web tools");
    }
    expect(seen).toHaveLength(0);
  });

  test("images are refused with a clear non-retryable error and nothing is sent", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    const images = [{ label: "frame", mediaType: "image/png" as const, bytes: new Uint8Array([1]) }];
    for (const run of [() => claude.streamText(req({ images }), () => {}, NEVER), () => claude.structured(req({ images }), Out, NEVER)]) {
      const err = await run().catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("images");
    }
    expect(seen).toHaveLength(0);
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
      const err = await api({ fail }).claude.streamText(req(), () => {}, NEVER).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).not.toContain(KEY);
      expect(err.message).toContain("[redacted]");
      expect(JSON.stringify(err.usage)).not.toContain(KEY);
    }
  });

  test("is not in the request, the usage report or a refusal message", async () => {
    const { claude, seen } = api({ deltas: ["x"] });
    const { usage } = await claude.streamText(req(), () => {}, NEVER);
    expect(JSON.stringify(seen[0]!.params)).not.toContain(KEY);
    expect(JSON.stringify(usage)).not.toContain(KEY);
    const err = await createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client: fakeClient({ final: message({ stop: "refusal" }) }).client }).streamText(req(), () => {}, NEVER).catch((e) => e);
    expect(err.message).not.toContain(KEY);
  });
});
