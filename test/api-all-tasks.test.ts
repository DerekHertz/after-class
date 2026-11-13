/**
 * With AFTERCLASS_CLAUDE_BACKEND=api every Claude task runs on the Messages API adapter. These tests run the real task factories
 * over the real adapter and a fake client, so no test opens a socket or reads a key. They check what each request carries and
 * what the ledger records, the default CLI argv, and the one thing the API adds that the CLI lacks: a per-search price.
 */
import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import { stableId } from "../src/shared/ids";
import { media } from "../src/shared/time";
import type { ClaimId, ConceptId, EvidenceId, SourceId } from "../src/shared/ids";
import type { Frame, Passage, Purpose } from "../src/shared/domain";
import { diagramSummaryTask } from "../src/backend/diagram/tasks";
import { interpretTask, resourceSearchTask, reviseTask } from "../src/backend/preparation/tasks";
import { claudeArgs } from "../src/backend/providers/claude";
import type { ClaudeCli, ClaudeRequest } from "../src/backend/providers/claude";
import { COST_BASIS, MAX_PAUSE_CONTINUATIONS, WEB_SEARCH_USD, ApiCallError, createClaudeApi, parseUsage, priceUsage } from "../src/backend/providers/claude-api";
import type { ApiClient } from "../src/backend/providers/claude-api";
import { createLedger } from "../src/backend/providers/ledger";
import { createMemo } from "../src/backend/providers/memo";
import type { Task } from "../src/backend/providers/memo";
import { testUserDb } from "./fakes";
import { OPEN } from "./providers-fixtures";

const KEY = "sk-ant-api03-all-tasks-0123456789";
const ev = (name: string) => stableId("ev", name) as EvidenceId;
const SRC = stableId("src", "yt", "VIDEO000001") as SourceId;
const JPEG_1 = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const JPEG_2 = new Uint8Array([0xff, 0xd8, 0xff, 9, 8, 7]);
const frameBytes = (id: EvidenceId): Uint8Array | null => (id === ev("f1") ? JPEG_1 : id === ev("f2") ? JPEG_2 : null);

const passage = (name: string): Passage =>
  ({ kind: "passage", id: ev(name), sourceId: SRC, interval: { start: media(1), end: media(2) }, text: `Text of ${name}.` }) as unknown as Passage;
const frame = (name: string, s: number): Frame => ({ kind: "frame", id: ev(name), sourceId: SRC, mediaS: media(s), width: 64, height: 36, teaching: "kept" }) as unknown as Frame;

const bundle = { passages: [passage("p1")], frames: [frame("f1", 3), frame("f2", 4)], gaps: [] };
const draft = { text: "Clocks order events.", evidence: [ev("f1")], visualDependent: true, assumptions: [] };

const REPLIES = {
  interpretation: { concepts: [{ label: "Clocks", summary: "s", claims: [draft], confusions: [] }], links: [], supersedes: [] },
  revision: draft,
  resources: { resources: [{ url: "https://example.org/clocks", title: "Clocks", relevance: "Covers it.", supportingPassages: [] }] },
  diagram: { title: "How do clocks order events?", lines: [{ text: "The board shows the arrow.", evidence: [ev("f1")] }] },
};

type Call = { params: Record<string, unknown>; via: "create" | "stream" };

/** A client that answers every call with `reply` as JSON text and the given usage, and keeps the request it was sent. */
function fakeApi(reply: unknown, usage: Record<string, unknown> = {}): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const message = {
    id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    content: [{ type: "text", text: JSON.stringify(reply), citations: null }],
    usage: { input_tokens: 1_000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  } as unknown as Message;
  const client: ApiClient = {
    messages: {
      stream: () => {
        throw new Error("no stream call expected");
      },
      create: (params) => {
        calls.push({ params: params as unknown as Record<string, unknown>, via: "create" });
        return Promise.resolve(message);
      },
    },
  };
  return { client, calls };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

type Case = { name: string; reply: unknown; task: (c: ClaudeCli) => Task<never, unknown>; input: unknown; purpose: Purpose; images: Uint8Array[]; web: boolean };

const CASES: readonly Case[] = [
  {
    name: "interpretTask", reply: REPLIES.interpretation, purpose: "interpretation", images: [JPEG_1, JPEG_2], web: false,
    task: (c) => interpretTask(c, frameBytes) as unknown as Task<never, unknown>,
    input: { chunkRevisionId: "chr_x", newMaterial: bundle, existingClaims: [], gaps: [] },
  },
  {
    name: "reviseTask", reply: REPLIES.revision, purpose: "claim_revision", images: [JPEG_1, JPEG_2], web: false,
    task: (c) => reviseTask(c, frameBytes) as unknown as Task<never, unknown>,
    input: { original: draft, check: { verdict: "unsupported", p: null }, evidence: bundle },
  },
  {
    name: "resourceSearchTask", reply: REPLIES.resources, purpose: "resource_search", images: [], web: true,
    task: (c) => resourceSearchTask(c) as unknown as Task<never, unknown>,
    input: { concept: { id: stableId("cpt", "clocks") as ConceptId, label: "Clocks", summary: "s" }, supportedClaims: [{ id: stableId("clm", "a") as ClaimId, text: "Clocks order events.", evidence: [ev("p1")] }] },
  },
  {
    name: "diagramSummaryTask", reply: REPLIES.diagram, purpose: "diagram_summary", images: [JPEG_1, JPEG_2], web: false,
    task: (c) => diagramSummaryTask(c, frameBytes) as unknown as Task<never, unknown>,
    input: { topic: { id: stableId("cpt", "clocks") as ConceptId, label: "Clocks" }, claims: [], passages: [passage("p1")], frames: [frame("f1", 3), frame("f2", 4)] },
  },
];

describe("every Claude task on the Messages API", () => {
  for (const c of CASES) {
    test(`${c.name}: frames become base64 image blocks and web tools appear only for resource search`, async () => {
      const { client, calls } = fakeApi(c.reply);
      await createMemo(testUserDb(), "live", { retryDelayMs: () => 0 }).run(c.task(createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client })), c.input as never);
      expect(calls).toHaveLength(1);
      const params = calls[0]!.params as { messages: { role: string; content: unknown }[]; tools?: unknown; output_config: Record<string, unknown> };
      const content = params.messages[0]!.content;
      if (c.images.length === 0) {
        expect(typeof content).toBe("string");
      } else {
        const blocks = content as { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[];
        expect(blocks.filter((x) => x.type === "image").map((x) => x.source)).toEqual(c.images.map((bytes) => ({ type: "base64", media_type: "image/jpeg", data: b64(bytes) })));
        // Each image follows a text block naming its label, and the prompt comes last.
        expect(blocks[0]).toEqual({ type: "text", text: `Image ${ev("f1")}:` });
        expect(blocks[1]!.type).toBe("image");
        expect(blocks[2]).toEqual({ type: "text", text: `Image ${ev("f2")}:` });
        expect(blocks.at(-1)!.type).toBe("text");
        expect(blocks.at(-1)!.text).toContain("image attached");
      }
      if (c.web) expect(params.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 5 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 }]);
      else expect("tools" in params).toBe(false);
      // Structured output is requested through output_config.format, except when web tools are on: citations are always on for web search.
      const config = params.output_config as Record<string, unknown>;
      if (c.web) expect("format" in config).toBe(false);
      else expect("format" in config).toBe(true);
    });

    test(`${c.name}: usage is recorded as an estimate at list prices`, async () => {
      const { client } = fakeApi(c.reply, c.web ? { server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 } } : {});
      const db = testUserDb();
      const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
      const task = c.task(createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client }));
      const result = await memo.run(task, c.input as never);
      expect(result.kind).toBe("hit");
      const events = createLedger(db).list({ memoKey: memo.key(task, c.input as never), limit: 10 });
      expect(events).toHaveLength(1);
      const tokensUsd = (1_000 * 4 + 200 * 20) / 1_000_000;
      const expected = tokensUsd + (c.web ? 3 * WEB_SEARCH_USD : 0);
      expect(events[0]!.purpose).toBe(c.purpose);
      expect(events[0]!.inputTokens).toBe(1_000);
      expect(events[0]!.outputTokens).toBe(200);
      const cost = events[0]!.cost;
      expect(cost.kind).toBe("estimated");
      if (cost.kind === "estimated") {
        expect(cost.basis).toBe(COST_BASIS);
        expect(cost.usd).toBeCloseTo(expected, 10);
      }
    });
  }
});

describe("web search pricing", () => {
  test("parseUsage reads the search count, leaves the key off when there are none, and fails closed on a bad count", () => {
    const base = { input_tokens: 1, output_tokens: 2 };
    const plain = { fresh: 1, creation5m: 0, creation1h: 0, read: 0, output: 2 };
    expect(parseUsage({ ...base, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } })).toEqual({ ...plain, webSearches: 2 });
    expect(parseUsage({ ...base, server_tool_use: { web_search_requests: 0, web_fetch_requests: 4 } })).toEqual(plain);
    expect(parseUsage({ ...base, server_tool_use: null })).toEqual(plain);
    expect(parseUsage({ ...base, server_tool_use: { web_search_requests: -1 } })).toBeNull();
    expect(parseUsage({ ...base, server_tool_use: "many" })).toBeNull();
  });

  test("priceUsage adds the per-search price to the token cost", () => {
    const tokens = { fresh: 1_000_000, creation5m: 0, creation1h: 0, read: 0, output: 0 };
    expect(priceUsage("claude-opus-5-5", tokens)).toBe(4);
    expect(priceUsage("claude-opus-5-5", { ...tokens, webSearches: 5 })).toBeCloseTo(4 + 5 * WEB_SEARCH_USD, 10);
  });

  test("a response whose server tool usage is invalid is recorded as unknown cost, not zero", async () => {
    const { client } = fakeApi(REPLIES.resources, { server_tool_use: { web_search_requests: "3" } });
    const c = CASES[2]!;
    const db = testUserDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const task = c.task(createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client }));
    await memo.run(task, c.input as never);
    const [event] = createLedger(db).list({ memoKey: memo.key(task, c.input as never), limit: 10 });
    expect(event!.cost.kind).toBe("unknown");
  });
});

describe("the default cli path", () => {
  const req = (over: Partial<ClaudeRequest>): ClaudeRequest => ({ model: "opus", effort: "high", system: "s", prompt: "p", images: [], webTools: false, timeoutMs: 1, ...over });

  test("the argv still grants web tools only to a webTools request and images only through the Read tool and --add-dir", () => {
    expect(claudeArgs(req({}), "json", null).join(" ")).toContain("--tools Read --strict-mcp-config");
    expect(claudeArgs(req({ webTools: true }), "json", null).join(" ")).toContain("--tools Read,WebSearch,WebFetch");
    const withImages = claudeArgs(req({ images: [{ label: "f", mediaType: "image/jpeg", bytes: JPEG_1 }] }), "json", null, "/tmp/images").join(" ");
    expect(withImages).toContain("--add-dir /tmp/images");
    expect(withImages).toContain("--tools Read --strict-mcp-config");
  });
});

// ───────────────────────────── the web-tools request ─────────────────────────────

/** A client that answers each create call from `script`, in order, and keeps the requests. */
function scripted(script: readonly (Message | Error)[]): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: ApiClient = {
    messages: {
      stream: () => {
        throw new Error("no stream call expected");
      },
      create: (params) => {
        calls.push({ params: JSON.parse(JSON.stringify(params)) as Record<string, unknown>, via: "create" });
        const next = script[Math.min(calls.length - 1, script.length - 1)]!;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
  };
  return { client, calls };
}

const reply = (blocks: unknown[], o: { stop?: string; input?: number; output?: number; searches?: number; model?: string; serverTool?: unknown } = {}): Message =>
  ({
    id: "msg_x", type: "message", role: "assistant", model: o.model ?? "claude-opus-5-5", stop_reason: o.stop ?? "end_turn", stop_sequence: null, stop_details: null,
    content: blocks,
    usage: { input_tokens: o.input ?? 1_000, output_tokens: o.output ?? 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: "serverTool" in o ? o.serverTool : { web_search_requests: o.searches ?? 0, web_fetch_requests: 0 } },
  }) as unknown as Message;

const text = (t: string) => ({ type: "text", text: t, citations: null });
const searchBlocks = [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] }];

describe("resource search without output_config.format", () => {
  const c = CASES[2]!;
  const run = async (script: readonly (Message | Error)[]) => {
    const { client, calls } = scripted(script);
    const db = testUserDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const task = c.task(createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client }));
    const result = await memo.run(task, c.input as never);
    const events = createLedger(db).list({ memoKey: memo.key(task, c.input as never), limit: 20 });
    return { result, calls, events };
  };
  const good = JSON.stringify(REPLIES.resources);

  test("the request has max_uses on both tools, no format, and asks for the JSON in the prompt", async () => {
    const { calls } = await run([reply([text(good)])]);
    const params = calls[0]!.params as { tools: { max_uses: number }[]; output_config: Record<string, unknown>; messages: { content: string }[] };
    expect(params.tools.map((t) => t.max_uses)).toEqual([5, 5]);
    expect("format" in params.output_config).toBe(false);
    expect(params.messages[0]!.content).toContain("only one JSON object that matches this JSON Schema");
  });

  test("prose around the JSON in the final text still parses, and text before the last tool result is ignored", async () => {
    const { result, calls } = await run([reply([text('I will search. {"resources": []}'), ...searchBlocks, text("Here you go:\n"), text(`${good}\nHope that helps.`)], { searches: 2 })]);
    expect(result.kind).toBe("hit");
    expect(calls).toHaveLength(1);
    const value = (result as unknown as { value: { url: string }[] }).value;
    expect(value.map((r) => r.url)).toEqual(["https://example.org/clocks"]);
  });

  test("invalid JSON and schema mismatches fail through the normal path and are fail once, never stored", async () => {
    for (const bad of ["no json here", '{"resources": "nope"}']) {
      const { result, calls, events } = await run([reply([text(bad)])]);
      expect(result.kind).toBe("failed");
      // Same as a malformed reply on every other path: a non-retryable ProviderError, so one attempt, one error event, nothing stored.
      expect(calls).toHaveLength(1);
      expect(events.map((e) => e.outcome)).toEqual(["error"]);
    }
  });

  test("a paused turn is continued with its blocks sent back unchanged, and every call's usage is summed", async () => {
    const paused = reply(searchBlocks, { stop: "pause_turn", input: 500, output: 50, searches: 1 });
    const { result, calls, events } = await run([paused, reply([text(good)], { input: 700, output: 100, searches: 2 })]);
    expect(result.kind).toBe("hit");
    expect(calls).toHaveLength(2);
    const second = calls[1]!.params as { messages: { role: string; content: unknown }[] };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(second.messages[1]!.content).toEqual(searchBlocks);
    expect(events).toHaveLength(1);
    expect(events[0]!.inputTokens).toBe(1_200);
    expect(events[0]!.outputTokens).toBe(150);
    const cost = events[0]!.cost;
    expect(cost.kind).toBe("estimated");
    if (cost.kind === "estimated") expect(cost.usd).toBeCloseTo((1_200 * 4 + 150 * 20) / 1_000_000 + 3 * WEB_SEARCH_USD, 10);
  });

  test("a turn that keeps pausing stops after the fixed number of continuations and fails", async () => {
    const { result, calls } = await run([reply(searchBlocks, { stop: "pause_turn" })]);
    expect(result.kind).toBe("failed");
    expect(calls).toHaveLength(MAX_PAUSE_CONTINUATIONS + 1);
  });
  test("a server_tool_use object with a missing or null search count is unknown cost, not zero searches", async () => {
    for (const serverTool of [{ web_fetch_requests: 0 }, { web_search_requests: null, web_fetch_requests: 0 }, { web_search_requests: 1 }]) {
      const { result, events } = await run([reply([text(good)], { serverTool })]);
      expect(result.kind).toBe("hit");
      expect(events[0]!.cost.kind).toBe("unknown");
    }
    const { events } = await run([reply([text(good)], { serverTool: null })]);
    expect(events[0]!.cost.kind).toBe("estimated");
  });

  test("a continuation that fails keeps the usage of the responses already billed, and is not reported as not billed", async () => {
    const paused = reply(searchBlocks, { stop: "pause_turn", input: 500, output: 50, searches: 1 });
    const failure = new Anthropic.BadRequestError(400, {}, "bad continuation", new Headers());
    const { client } = scripted([paused, failure]);
    const err = await createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client }).structured(
      { model: "opus", effort: "high", system: "s", prompt: "p", images: [], webTools: true, timeoutMs: 5_000 }, z.object({ resources: z.array(z.string()) }), OPEN,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    const failed = err as ApiCallError;
    expect(failed.billing).toBe("maybe_billed");
    expect(failed.usage?.cost.kind).toBe("estimated");
    const { result, events } = await run([paused, failure]);
    expect(result.kind).toBe("failed");
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("error");
    expect(events[0]!.inputTokens).toBe(500);
    const cost = events[0]!.cost;
    expect(cost.kind).toBe("estimated");
    if (cost.kind === "estimated") expect(cost.usd).toBeCloseTo((500 * 4 + 50 * 20) / 1_000_000 + WEB_SEARCH_USD, 10);
  });

  test("each response of a continued turn is priced with its own model, and an unpriced one makes the total unknown", async () => {
    const first = reply(searchBlocks, { stop: "pause_turn", input: 1_000, output: 100, model: "claude-sonnet-5-5" });
    const second = reply([text(good)], { input: 2_000, output: 200, model: "claude-opus-5-5" });
    const { events } = await run([first, second]);
    const cost = events[0]!.cost;
    expect(cost.kind).toBe("estimated");
    if (cost.kind === "estimated") expect(cost.usd).toBeCloseTo((1_000 * 2 + 100 * 10 + 2_000 * 4 + 200 * 20) / 1_000_000, 10);
    const odd = reply(searchBlocks, { stop: "pause_turn", model: "claude-mystery-9" });
    const { events: unknown } = await run([odd, second]);
    expect(unknown[0]!.cost.kind).toBe("unknown");
  });
  test("an abort during a continuation records an aborted event with the usage of the responses already billed", async () => {
    const paused = reply(searchBlocks, { stop: "pause_turn", input: 500, output: 50, searches: 1 });
    const ctl = new AbortController();
    let n = 0;
    const client: ApiClient = {
      messages: {
        stream: () => {
          throw new Error("no stream call expected");
        },
        create: (_params, options) => {
          n++;
          if (n === 1) return Promise.resolve(paused);
          // The second call waits until the caller cancels, then rejects the way the SDK does.
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()), { once: true });
            queueMicrotask(() => ctl.abort());
          });
        },
      },
    };
    const db = testUserDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const task = c.task(createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client }));
    const result = await memo.run(task, c.input as never, { signal: ctl.signal });
    expect(result.kind).toBe("missing");
    const events = createLedger(db).list({ memoKey: memo.key(task, c.input as never), limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("aborted");
    expect(events[0]!.inputTokens).toBe(500);
    // The aborted continuation was already sent, so it may have been billed: the total cost is unknown, not the first response's.
    expect(events[0]!.cost.kind).toBe("unknown");
  });

  test("a continuation that fails in a way that may have been billed keeps the earlier tokens and makes the total cost unknown", async () => {
    const paused = reply(searchBlocks, { stop: "pause_turn", input: 500, output: 50, searches: 1 });
    // A retryable failure lets the memo try again, and the later attempt fails on its first call; only the attempt that billed matters here.
    for (const failure of [new Anthropic.InternalServerError(500, {}, "server error", new Headers()), new Anthropic.APIConnectionError({ message: "connection reset" })]) {
      const { result, events } = await run([paused, failure]);
      expect(result.kind).toBe("failed");
      const billed = events.filter((e) => e.inputTokens === 500);
      expect(billed).toHaveLength(1);
      expect(billed[0]!.cost.kind).toBe("unknown");
      expect(events.every((e) => e.cost.kind !== "estimated")).toBe(true);
    }
    // A continuation whose response cannot be read has no usage of its own, so neither the total tokens nor the cost are known.
    const { result, events } = await run([paused, { not: "a message" } as unknown as Message]);
    expect(result.kind).toBe("failed");
    expect(events.every((e) => e.cost.kind === "unknown")).toBe(true);
  });
});
