/**
 * With AFTERCLASS_CLAUDE_BACKEND=api every Claude task runs on the Messages API adapter. These tests run the real task factories
 * over the real adapter and a fake client, so no test opens a socket or reads a key. They check what each request carries and
 * what the ledger records, the default CLI argv, and the one thing the API adds that the CLI lacks: a per-search price.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { stableId } from "../src/shared/ids";
import { media } from "../src/shared/time";
import type { ClaimId, ConceptId, EvidenceId, SourceId } from "../src/shared/ids";
import type { Frame, Passage, Purpose } from "../src/shared/domain";
import { diagramSummaryTask } from "../src/backend/diagram/tasks";
import { interpretTask, resourceSearchTask, reviseTask } from "../src/backend/preparation/tasks";
import { claudeArgs } from "../src/backend/providers/claude";
import type { ClaudeCli, ClaudeRequest } from "../src/backend/providers/claude";
import { COST_BASIS, WEB_SEARCH_USD, createClaudeApi, parseUsage, priceUsage } from "../src/backend/providers/claude-api";
import type { ApiClient } from "../src/backend/providers/claude-api";
import { createLedger } from "../src/backend/providers/ledger";
import { createMemo } from "../src/backend/providers/memo";
import type { Task } from "../src/backend/providers/memo";
import { testDb } from "./fakes";

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
      await createMemo(testDb(), "live", { retryDelayMs: () => 0 }).run(c.task(createClaudeApi({ apiKey: KEY, maxConcurrent: 1, client })), c.input as never);
      expect(calls).toHaveLength(1);
      const params = calls[0]!.params as { messages: { role: string; content: unknown }[]; tools?: unknown };
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
      if (c.web) expect(params.tools).toEqual([{ type: "web_search_20260209", name: "web_search" }, { type: "web_fetch_20260209", name: "web_fetch" }]);
      else expect("tools" in params).toBe(false);
    });

    test(`${c.name}: usage is recorded as an estimate at list prices`, async () => {
      const { client } = fakeApi(c.reply, c.web ? { server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 } } : {});
      const db = testDb();
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
    const db = testDb();
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
