/**
 * Preparation and the learner-facing Claude calls run on separate lanes, each with its own concurrency limit. These tests run the real
 * task set over the real Messages API adapter and a fake client that answers only when the test says so.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { buildTasks, claudeLanes } from "../src/backend/main";
import { createBudget } from "../src/backend/providers/budget";
import { createClaudeApi } from "../src/backend/providers/claude-api";
import type { ApiClient } from "../src/backend/providers/claude-api";
import { DEFAULT_LIMITS } from "../src/backend/scheduler";
import { createMemo } from "../src/backend/providers/memo";
import { deferred, testUserDb } from "./fakes";

const KEY = "sk-ant-api03-lanes-0123456789";
const empty = { passages: [], frames: [], gaps: [] };
const interpretInput = { chunkRevisionId: "chr_x", newMaterial: empty, existingClaims: [], gaps: [] } as never;
const wrapUpInput = { turns: [], claims: [], threads: [] } as never;

const answer = (text: string): Message =>
  ({
    id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    content: [{ type: "text", text, citations: null }],
    usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as unknown as Message;

function world() {
  const db = testUserDb();
  const budget = createBudget(db, { limits: { userUsd: 5, totalUsd: 50 }, stopped: () => false });
  const memo = createMemo(db, "live", { retryDelayMs: () => 0, budget });
  const sent: { system: string; answer: (m: Message) => void }[] = [];
  const client: ApiClient = {
    messages: {
      // Interpretation is streamed because it can be long, so a stream answers the same way a create does.
      stream: (params: { system: unknown }) => {
        const d = deferred<Message>();
        sent.push({ system: JSON.stringify(params.system), answer: d.resolve });
        const stream = { on: () => stream, finalMessage: () => d.promise, abort: () => {} };
        return stream;
      },
      create: (params: { system: unknown }) => {
        const d = deferred<Message>();
        sent.push({ system: JSON.stringify(params.system), answer: d.resolve });
        return d.promise;
      },
    },
  } as unknown as ApiClient;
  const lanes = claudeLanes((maxConcurrent) => createClaudeApi({ apiKey: KEY, maxConcurrent, client }));
  const tasks = buildTasks({ ask: () => Promise.reject(new Error("no Jev call in this test")) }, lanes, () => null, { read: () => null } as never);
  const holds = () => db.sql.query<{ n: number }, []>("SELECT count(*) AS n FROM budget_holds").get()!.n;
  return { tasks, memo, sent, holds };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Claude lanes", () => {
  test("a wrap-up leaves at once while preparation holds every preparation slot", async () => {
    const w = world();
    for (let i = 0; i < DEFAULT_LIMITS.claude + 1; i++) void w.memo.run(w.tasks.preparation.interpret, { ...(interpretInput as object), chunkRevisionId: `chr_${i}` } as never);
    await tick();
    expect(w.sent).toHaveLength(DEFAULT_LIMITS.claude);
    void w.memo.run(w.tasks.wrapUp, wrapUpInput);
    await tick();
    expect(w.sent).toHaveLength(DEFAULT_LIMITS.claude + 1);
  });

  test("preparation is still capped at its own limit", async () => {
    const w = world();
    for (let i = 0; i < DEFAULT_LIMITS.claude + 3; i++) void w.memo.run(w.tasks.preparation.interpret, { ...(interpretInput as object), chunkRevisionId: `chr_${i}` } as never);
    await tick();
    expect(w.sent).toHaveLength(DEFAULT_LIMITS.claude);
    w.sent[0]!.answer(answer("{}"));
    await tick();
    expect(w.sent).toHaveLength(DEFAULT_LIMITS.claude + 1);
  });

  test("an interactive request reserves in the budget before it leaves", async () => {
    const w = world();
    void w.memo.run(w.tasks.wrapUp, wrapUpInput);
    await tick();
    expect(w.sent).toHaveLength(1);
    expect(w.holds()).toBe(1);
  });
});
