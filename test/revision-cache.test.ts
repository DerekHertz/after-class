/**
 * A chunk's evidence is cached across its claim revisions, and a long interpretation is streamed so it is not cut at 16,000 output
 * tokens. Every test uses a fake client, so none makes a live call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { stableId } from "../src/shared/ids";
import { media } from "../src/shared/time";
import type { EvidenceId, SourceId } from "../src/shared/ids";
import type { Frame, NonEmpty, Passage } from "../src/shared/domain";
import { interpretTask, reviseTask } from "../src/backend/preparation/tasks";
import type { RevisionInput } from "../src/backend/preparation/tasks";
import { claudeArgs, promptOf } from "../src/backend/providers/claude";
import type { ClaudeCli, ClaudeRequest } from "../src/backend/providers/claude";
import { STREAM_MAX_TOKENS, STRUCTURED_MAX_TOKENS, createClaudeApi, priceUsage } from "../src/backend/providers/claude-api";
import type { ApiClient, ApiStream } from "../src/backend/providers/claude-api";
import { createLedger } from "../src/backend/providers/ledger";
import { createMemo } from "../src/backend/providers/memo";
import { testUserDb } from "./fakes";
import { OPEN } from "./providers-fixtures";

const KEY = "sk-ant-api03-revision-cache-0123456789";
const ev = (name: string) => stableId("ev", name) as EvidenceId;
const SRC = stableId("src", "yt", "VIDEO000001") as SourceId;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const frameBytes = (id: EvidenceId): Uint8Array | null => (id === ev("f1") ? JPEG : null);
const passage = (name: string): Passage => ({ kind: "passage", id: ev(name), sourceId: SRC, interval: { start: media(1), end: media(2) }, text: `Text of ${name}.` }) as unknown as Passage;
const frame = (name: string, s: number): Frame => ({ kind: "frame", id: ev(name), sourceId: SRC, mediaS: media(s), width: 64, height: 36, teaching: "kept" }) as unknown as Frame;

const bundle = { passages: [passage("p1")], frames: [frame("f1", 3)], gaps: [] };
const otherBundle = { passages: [passage("p1"), passage("p2")], frames: [frame("f1", 3)], gaps: [] };
const draftOf = (text: string) => ({ text, evidence: [ev("p1")] as unknown as NonEmpty<EvidenceId>, visualDependent: false, assumptions: [] });
/** What the model answers: it cites the bundle's first passage by its label. */
const replyOf = (text: string) => ({ ...draftOf(text), evidence: ["p1"] });
const revisionOf = (text: string, evidence: unknown = bundle): RevisionInput => ({ original: draftOf(text), check: { verdict: "no" as const, p: 0.2 }, evidence: evidence as RevisionInput["evidence"] });

/** The revision prompt: evidence by label, then the claim. */
const EXPECTED_PROMPT = [
  "Passages:",
  "- p1 [1.0s–2.0s] Text of p1.",
  "Frames:",
  "- f1 at 3.0s (image attached, labelled with this ID)",
  "Gaps (missing capture, never to be filled):",
  "- none",
  "",
  "Original claim: Clocks order events.",
  "Cited: p1",
  "Visual-dependent: false",
  "Assumptions: none",
  "Check verdict: no (p = 0.20)",
].join("\n");

function message(text: string, usage: Record<string, unknown> = {}, stop = "end_turn"): Message {
  return {
    id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: stop, stop_sequence: null, stop_details: null,
    content: [{ type: "text", text, citations: null }],
    usage: { input_tokens: 1_000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  } as unknown as Message;
}

type Sent = { readonly params: Record<string, unknown>; readonly via: "stream" | "create"; readonly signal: AbortSignal; begin(): void; finish(): void };

/** A client whose streams begin and finish only when the test says so, so the order of two requests is the test's to set. */
const live: Sent[][] = [];
/** A failed assertion must not leave a stream open, so each test's streams are begun and finished when it ends. */
afterEach(() => {
  for (const sent of live.splice(0)) for (const s of sent) {
      s.begin();
      s.finish();
    }
});

function manualClient(reply: (n: number, params: Record<string, unknown>) => Message): { client: ApiClient; sent: Sent[] } {
  const sent: Sent[] = [];
  live.push(sent);
  const client: ApiClient = {
    messages: {
      stream(params, options) {
        let onEvent: (d: string) => void = () => {};
        let done!: () => void;
        const finished = new Promise<void>((r) => (done = r));
        const p = params as unknown as Record<string, unknown>;
        const entry: Sent = { params: p, via: "stream", signal: options.signal, begin: () => onEvent(""), finish: done };
        const n = sent.push(entry) - 1;
        const stream: ApiStream = {
          on: (event, l) => {
            if (event === "streamEvent") onEvent = l;
            return stream;
          },
          // Like the SDK, a stream rejects when its request is aborted.
          finalMessage: () =>
            new Promise<Message>((resolve, reject) => {
              const aborted = () => reject(new Anthropic.APIUserAbortError());
              if (options.signal.aborted) return aborted();
              options.signal.addEventListener("abort", aborted, { once: true });
              void finished.then(() => {
                options.signal.removeEventListener("abort", aborted);
                resolve(reply(n, p));
              });
            }),
          abort: () => {},
        };
        return stream;
      },
      create(params, options) {
        const p = params as unknown as Record<string, unknown>;
        sent.push({ params: p, via: "create", signal: options.signal, begin: () => {}, finish: () => {} });
        return Promise.resolve(reply(sent.length - 1, p));
      },
    },
  };
  return { client, sent };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
type Block = { type: string; text?: string; cache_control?: unknown };
const blocksOf = (s: Sent) => (s.params.messages as { content: Block[] }[])[0]!.content;

describe("the revision's evidence is a cached head", () => {
  test("the model reads the evidence by label, and claude -p is sent that exact string", async () => {
    let seen: ClaudeRequest | undefined;
    const claude: ClaudeCli = {
      structured: (req) => {
        seen = req;
        return Promise.resolve({ output: replyOf("x"), usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cost: { kind: "unknown", reason: "t" } } }) as never;
      },
      streamText: () => Promise.reject(new Error("not used")),
    };
    await reviseTask(claude, frameBytes).attempt(revisionOf("Clocks order events."), { ...OPEN, streamTo: null });
    expect(promptOf(seen!)).toBe(EXPECTED_PROMPT);
    expect(seen!.cachedPrompt).toBe(EXPECTED_PROMPT.slice(0, EXPECTED_PROMPT.indexOf("Original claim")));
    expect(claudeArgs(seen!, "json", null)).not.toContain(EXPECTED_PROMPT);
  });

  test("the API request puts the images and the evidence first, a breakpoint after the evidence, and the claim after it", async () => {
    const { client, sent } = manualClient(() => message(JSON.stringify(replyOf("Clocks order events."))));
    const task = reviseTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes);
    const run = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 }).run(task, revisionOf("Clocks order events."));
    await tick();
    sent[0]!.begin();
    sent[0]!.finish();
    expect((await run).kind).toBe("hit");
    const blocks = blocksOf(sent[0]!);
    expect(blocks.map((b) => b.type)).toEqual(["text", "image", "text", "text"]);
    expect(blocks[2]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(blocks[3]!.cache_control).toBeUndefined();
    expect(blocks[2]!.text).toContain("Passages:");
    expect(blocks[3]!.text).toStartWith("Original claim:");
    expect(blocks.map((b) => b.text ?? "").filter((t) => !t.startsWith("Image ")).join("")).toBe(EXPECTED_PROMPT);
    expect(sent[0]!.params.system).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral", ttl: "5m" } })]);
  });

  test("a revision is sent on Sonnet at effort high on both backends, under a version no Opus revision used", async () => {
    let seen: ClaudeRequest | undefined;
    const cli: ClaudeCli = {
      structured: (req) => {
        seen = req;
        return Promise.resolve({ output: replyOf("x"), usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cost: { kind: "unknown", reason: "t" } } }) as never;
      },
      streamText: () => Promise.reject(new Error("not used")),
    };
    const cliTask = reviseTask(cli, frameBytes);
    await cliTask.attempt(revisionOf("Clocks order events."), { ...OPEN, streamTo: null });
    const argv = claudeArgs(seen!, "json", null);
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");

    const { client, sent } = manualClient(() => message(JSON.stringify(replyOf("Clocks order events."))));
    const run = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 }).run(reviseTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes), revisionOf("Clocks order events."));
    await tick();
    sent[0]!.begin();
    sent[0]!.finish();
    expect((await run).kind).toBe("hit");
    expect(sent[0]!.params.model).toBe("claude-sonnet-5-5");
    expect(sent[0]!.params.output_config).toEqual(expect.objectContaining({ effort: "high" }));

    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    const input = revisionOf("Clocks order events.");
    expect(cliTask.version).not.toBe("revise-v1");
    expect(memo.key(cliTask, input)).not.toBe(memo.key({ ...cliTask, version: "revise-v1" }, input));
  });

  test("two revisions of one chunk send a byte-identical prefix, and the second is sent only after the first has begun", async () => {
    const { client, sent } = manualClient(() => message(JSON.stringify(replyOf("r"))));
    const task = reviseTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes);
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    const a = memo.run(task, revisionOf("First claim."));
    const b = memo.run(task, revisionOf("Second claim."));
    await tick();
    expect(sent).toHaveLength(1);
    sent[0]!.begin();
    await tick();
    expect(sent).toHaveLength(2);
    sent[0]!.finish();
    sent[1]!.begin();
    sent[1]!.finish();
    expect([(await a).kind, (await b).kind]).toEqual(["hit", "hit"]);
    const [one, two] = sent.map((s) => ({ system: s.params.system, head: blocksOf(s).slice(0, 3) }));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(blocksOf(sent[0]!)[3]!.text).not.toBe(blocksOf(sent[1]!)[3]!.text);
  });

  test("a revision of a different chunk does not wait", async () => {
    const { client, sent } = manualClient(() => message(JSON.stringify(replyOf("r"))));
    const task = reviseTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes);
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    const runs = [memo.run(task, revisionOf("First claim.")), memo.run(task, revisionOf("Other chunk.", otherBundle))];
    await tick();
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      s.begin();
      s.finish();
    }
    await Promise.all(runs);
  });

  test("a first revision that fails before it begins releases its siblings", async () => {
    const { client, sent } = manualClient((n) => message(JSON.stringify(replyOf("r")), {}, n === 0 ? "refusal" : "end_turn"));
    const task = reviseTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes);
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    const a = memo.run(task, revisionOf("First claim."));
    const b = memo.run(task, revisionOf("Second claim."));
    await tick();
    expect(sent).toHaveLength(1);
    sent[0]!.finish();
    await tick();
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const s of sent.slice(1)) {
      s.begin();
      s.finish();
    }
    await Promise.all([a, b]);
  });

  test("a waiting revision that is aborted never sends", async () => {
    const { client, sent } = manualClient(() => message(JSON.stringify(replyOf("r"))));
    const claude = createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client });
    const req = (): ClaudeRequest => ({ model: "opus", effort: "high", system: "S", prompt: "tail", cachedPrompt: "head\n\n", images: [], webTools: false, timeoutMs: 5_000 });
    const schema = (await import("zod")).z.object({ text: (await import("zod")).z.string() });
    const first = claude.structured(req(), schema, OPEN);
    first.catch(() => {});
    await tick();
    const ctl = new AbortController();
    const second = claude.structured(req(), schema, { signal: ctl.signal, admit: OPEN.admit });
    await tick();
    ctl.abort();
    await expect(second).rejects.toThrow();
    expect(sent).toHaveLength(1);
    sent[0]!.finish();
  });

  test("a revision aborted before it reaches the gate is cancelled at once and never sends", async () => {
    const { client, sent } = manualClient(() => message(JSON.stringify(replyOf("r"))));
    const claude = createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client });
    const req = (): ClaudeRequest => ({ model: "opus", effort: "high", system: "S", prompt: "tail", cachedPrompt: "head\n\n", images: [], webTools: false, timeoutMs: 5_000 });
    const schema = (await import("zod")).z.object({ text: (await import("zod")).z.string() });
    const first = claude.structured(req(), schema, OPEN);
    first.catch(() => {});
    await tick();
    const ctl = new AbortController();
    ctl.abort();
    const late = Symbol("still waiting");
    const outcome = await Promise.race([claude.structured(req(), schema, { signal: ctl.signal, admit: OPEN.admit }).then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r(late), 200))]);
    expect(outcome).toBe("rejected");
    expect(sent).toHaveLength(1);
  });
});

describe("cache tokens are priced and recorded", () => {
  test("a write then a read: the read is priced at 0.05 of input, cache reads are recorded on the usage event, and the spend is lower", async () => {
    const usage = [{ input_tokens: 300, cache_creation_input_tokens: 9_000, cache_creation: { ephemeral_5m_input_tokens: 9_000, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 0 }, { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 9_000 }];
    const { client, sent } = manualClient((n) => message(JSON.stringify(replyOf("r")), { output_tokens: 200, ...usage[n]! }));
    const db = testUserDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const task = reviseTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes);
    const inputs = [revisionOf("First claim."), revisionOf("Second claim.")];
    const runs = inputs.map((i) => memo.run(task, i));
    await tick();
    sent[0]!.begin();
    sent[0]!.finish();
    await tick();
    sent[1]!.begin();
    sent[1]!.finish();
    await Promise.all(runs);
    const events = inputs.map((i) => createLedger(db).list({ memoKey: memo.key(task, i), limit: 5 })[0]!);
    expect(events.map((e) => [e.inputTokens, e.cacheReadTokens])).toEqual([[9_300, 0], [300, 9_000]]);
    const write = (300 * 4 + 9_000 * 4 * 1.25 + 200 * 20) / 1e6;
    const read = (300 * 4 + 9_000 * 0.2 + 200 * 20) / 1e6;
    expect(events[0]!.cost).toMatchObject({ kind: "estimated", usd: expect.closeTo(write, 10) });
    expect(events[1]!.cost).toMatchObject({ kind: "estimated", usd: expect.closeTo(read, 10) });
    const flat = priceUsage("claude-opus-5-5", { fresh: 9_300, creation5m: 0, creation1h: 0, read: 0, output: 200 })!;
    expect(read).toBeLessThan(flat / 2);
  });
});

describe("a long interpretation is streamed", () => {
  const interpretationInput = { chunkRevisionId: "chr_x", newMaterial: bundle, existingClaims: [], gaps: [] } as never;
  const OUTPUT = { concepts: [{ label: "Clocks", summary: "s", claims: [replyOf("Clocks order events.")], confusions: [] }], links: [], supersedes: [] };
  /** The model writes 21,501 tokens, the larger of the two local interpretations that passed 16,000, and stops at max_tokens if that is less. */
  const WRITES = 21_501;
  const capped = (_n: number, params: Record<string, unknown>) =>
    (params.max_tokens as number) < WRITES ? message("{", { output_tokens: params.max_tokens as number }, "max_tokens") : message(JSON.stringify(OUTPUT), { output_tokens: WRITES });

  test("it succeeds where the 16,000 limit would have stopped it", async () => {
    const { client, sent } = manualClient(capped);
    const task = interpretTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes);
    const run = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 }).run(task, interpretationInput);
    await tick();
    sent[0]!.begin();
    sent[0]!.finish();
    expect((await run).kind).toBe("hit");
    expect(sent.map((s) => s.via)).toEqual(["stream"]);
    expect(sent[0]!.params.max_tokens).toBe(STREAM_MAX_TOKENS);
    expect(STREAM_MAX_TOKENS).toBeGreaterThan(WRITES);
  });

  test("at the old limit the same output is cut, which is what the fix removes", async () => {
    expect(STRUCTURED_MAX_TOKENS).toBeLessThan(WRITES);
    expect((capped(0, { max_tokens: STRUCTURED_MAX_TOKENS }).stop_reason)).toBe("max_tokens");
  });

  test("a stop at max_tokens is still a failure that is not retried", async () => {
    const { client, sent } = manualClient(() => message("{", { output_tokens: STREAM_MAX_TOKENS }, "max_tokens"));
    const task = interpretTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes);
    const db = testUserDb();
    const run = createMemo(db, "live", { retryDelayMs: () => 0 }).run(task, interpretationInput);
    await tick();
    sent[0]!.begin();
    sent[0]!.finish();
    expect((await run).kind).toBe("failed");
    await tick();
    expect(sent).toHaveLength(1);
  });

  test("revisions and other short structured calls keep the 16,000 limit", async () => {
    const { client, sent } = manualClient(() => message(JSON.stringify(replyOf("r"))));
    const task = reviseTask(createClaudeApi({ apiKey: KEY, maxConcurrent: 2, client }), frameBytes);
    const run = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 }).run(task, revisionOf("x"));
    await tick();
    sent[0]!.begin();
    sent[0]!.finish();
    await run;
    expect(sent[0]!.params.max_tokens).toBe(STRUCTURED_MAX_TOKENS);
  });
});
