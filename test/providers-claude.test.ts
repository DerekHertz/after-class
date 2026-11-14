import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeProcess, SpawnFn } from "../src/backend/providers/claude";
import { claudeArgs, createClaudeCli } from "../src/backend/providers/claude";
import { ProviderError, unbudgeted } from "../src/backend/providers/memo";
import { deferred } from "./fakes";
import { cli, fakeSpawn, jpeg, OPEN, Out, req, successEnvelope } from "./providers-fixtures";

describe("claudeArgs", () => {
  test("structured call: the exact argv", () => {
    expect(claudeArgs(req(), "json", '{"type":"object"}')).toEqual([
      "-p", "--model", "opus", "--effort", "high", "--system-prompt", "You are a careful tutor.",
      "--restricted", "--tools", "Read", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
      "--output-format", "json", "--json-schema", '{"type":"object"}',
    ]);
  });

  test("streaming call adds verbose partials and no schema", () => {
    const args = claudeArgs(req({ model: "sonnet", effort: "medium" }), "stream-json", null);
    expect(args.slice(-4)).toEqual(["--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(args).not.toContain("--json-schema");
    expect(args.slice(0, 5)).toEqual(["-p", "--model", "sonnet", "--effort", "medium"]);
  });

  test("web tools are added only when asked, and the dir grant only with images", () => {
    expect(claudeArgs(req({ webTools: true }), "json", null)).toContain("Read,WebSearch,WebFetch");
    expect(claudeArgs(req(), "json", null)).not.toContain("--add-dir");
    expect(claudeArgs(req(), "json", null, "/tmp/frames").slice(-2)).toEqual(["--add-dir", "/tmp/frames"]);
  });

  test("auth policy: restricted, no bare, no MCP, no skills, no session, never the prompt", () => {
    const args = claudeArgs(req(), "json", null);
    for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) expect(args).toContain(flag);
    for (const flag of ["--bare", "--resume", "--continue", "--dangerously-skip-permissions", "--mcp-config", "--input-format"]) expect(args).not.toContain(flag);
    expect(args).not.toContain("Summarise the chunk.");
  });
});

describe("claude structured", () => {
  test("parses the recorded result envelope into validated output and notional usage", async () => {
    const { claude, calls } = cli({ stdout: [JSON.stringify(successEnvelope) + "\n"] });
    const { output, usage } = await claude.structured(req(), Out, OPEN);
    expect(output).toEqual({ concepts: ["row picture", "column picture"] });
    expect(usage).toEqual({
      model: "claude-opus-5-5",
      inputTokens: 150,
      outputTokens: 75,
      cacheReadTokens: 900,
      cost: { kind: "notional", usd: 0.0421, basis: "claude_subscription" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[0]).toBe("claude");
    expect(calls[0]!.cwd).toBe("/work");
    expect(calls[0]!.argv).toContain("--json-schema");
    const schema = JSON.parse(calls[0]!.argv[calls[0]!.argv.indexOf("--json-schema") + 1]!);
    expect(schema).toMatchObject({ type: "object", properties: { concepts: { type: "array" } } });
    expect(schema.$schema).toBeUndefined();
  });

  test("the prompt goes on stdin, so its size is not bounded by argv", async () => {
    const big = "x".repeat(500_000);
    const { claude, calls } = cli({ stdout: [JSON.stringify(successEnvelope)] });
    await claude.structured(req({ prompt: big }), Out, OPEN);
    expect(calls[0]!.stdin.join("")).toBe(big);
    expect(calls[0]!.ended).toBe(true);
    expect(calls[0]!.argv.join("").length).toBeLessThan(2_000);
  });

  test("unknown cost when total_cost_usd is absent, never zero", async () => {
    const { total_cost_usd: _drop, ...noCost } = successEnvelope;
    const { claude } = cli({ stdout: [JSON.stringify(noCost)] });
    const { usage } = await claude.structured(req(), Out, OPEN);
    expect(usage.cost).toEqual({ kind: "unknown", reason: "claude did not report total_cost_usd" });
    expect(usage.inputTokens).toBe(150);
  });

  test("unknown fields and missing usage are tolerated", async () => {
    const lean = { type: "result", subtype: "success", is_error: false, structured_output: { concepts: [] }, brand_new: true };
    const { claude } = cli({ stdout: [JSON.stringify(lean)] });
    const { output, usage } = await claude.structured(req({ model: "sonnet" }), Out, OPEN);
    expect(output).toEqual({ concepts: [] });
    expect(usage).toMatchObject({ model: "sonnet", inputTokens: null, outputTokens: null, cacheReadTokens: null });
  });

  test("reads the result out of an array of messages and out of NDJSON", async () => {
    const msgs = [{ type: "system", subtype: "init" }, { type: "assistant", message: { content: [] } }, successEnvelope];
    const asArray = await cli({ stdout: [JSON.stringify(msgs)] }).claude.structured(req(), Out, OPEN);
    const asLines = await cli({ stdout: msgs.map((m) => JSON.stringify(m) + "\n") }).claude.structured(req(), Out, OPEN);
    expect(asArray.output).toEqual(asLines.output);
    expect(asArray.usage.cost).toEqual({ kind: "notional", usd: 0.0421, basis: "claude_subscription" });
  });

  test("falls back to JSON text in the answer, fenced or not", async () => {
    const { structured_output: _s, ...bare } = successEnvelope;
    const fenced = { ...bare, result: '```json\n{"concepts":["a"]}\n```' };
    const plain = { ...bare, result: '{"concepts":["b"]}' };
    expect((await cli({ stdout: [JSON.stringify(fenced)] }).claude.structured(req(), Out, OPEN)).output).toEqual({ concepts: ["a"] });
    expect((await cli({ stdout: [JSON.stringify(plain)] }).claude.structured(req(), Out, OPEN)).output).toEqual({ concepts: ["b"] });
  });

  test("the CLI's own validation is not trusted: output failing our schema is a non-retryable error that keeps usage", async () => {
    const bad = { ...successEnvelope, structured_output: { concepts: "not a list" } };
    const err = await cli({ stdout: [JSON.stringify(bad)] }).claude.structured(req(), Out, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.usage?.cost).toEqual({ kind: "notional", usd: 0.0421, basis: "claude_subscription" });
  });

  test("no structured output at all is an error", async () => {
    const { structured_output: _s, ...bare } = successEnvelope;
    const err = await cli({ stdout: [JSON.stringify({ ...bare, result: "I could not." })] }).claude.structured(req(), Out, OPEN).catch((e) => e);
    expect(err.message).toMatch(/no structured output/);
  });

  describe("failures", () => {
    const failing = (over: object, code = 1) => cli({ stdout: [JSON.stringify({ ...successEnvelope, structured_output: undefined, is_error: true, ...over })], code });

    test("is_error with an overloaded message is retryable and keeps the billed usage", async () => {
      const err = await failing({ subtype: "success", result: "API Error: 529 Overloaded" }).claude.structured(req(), Out, OPEN).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
      expect(err.usage?.outputTokens).toBe(75);
    });

    test("an api_error_status decides retryability over the text", async () => {
      const server = await failing({ result: "something", api_error_status: 500 }).claude.structured(req(), Out, OPEN).catch((e) => e);
      const client = await failing({ result: "overloaded?", api_error_status: 400 }).claude.structured(req(), Out, OPEN).catch((e) => e);
      expect([server.retryable, client.retryable]).toEqual([true, false]);
    });

    test("an error subtype is an error even when is_error is false", async () => {
      const err = await failing({ is_error: false, subtype: "error_max_structured_output_retries", result: undefined }).claude.structured(req(), Out, OPEN).catch((e) => e);
      expect(err.message).toContain("error_max_structured_output_retries");
      expect(err.retryable).toBe(false);
    });

    test("a login problem is not retryable", async () => {
      const err = await failing({ result: "Invalid API key · Please run /login" }).claude.structured(req(), Out, OPEN).catch((e) => e);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("/login");
    });

    test("a crash with no result carries stderr, with null usage", async () => {
      const err = await cli({ stdout: [], stderr: "boom: segfault", code: 139 }).claude.structured(req(), Out, OPEN).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toMatch(/exited 139.*segfault/);
      expect(err.usage).toBeNull();
      expect(err.retryable).toBe(false);
    });

    test("a crash that says the service is overloaded is retryable", async () => {
      const err = await cli({ stdout: [], stderr: "Error: 529 overloaded_error", code: 1 }).claude.structured(req(), Out, OPEN).catch((e) => e);
      expect(err.retryable).toBe(true);
    });

    test("a hung process is killed at the timeout and the error is retryable", async () => {
      const { claude, calls } = cli({ hold: new Promise(() => {}) });
      const err = await claude.structured(req({ timeoutMs: 20 }), Out, OPEN).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
      expect(calls[0]!.killed).toBe(true);
    });
  });

  test("abort kills the process and rejects with an abort, so the memo records it as aborted", async () => {
    const { claude, calls, spawned } = cli({ hold: new Promise(() => {}) });
    const c = new AbortController();
    const pending = claude.structured(req(), Out, unbudgeted(c.signal)).catch((e) => e);
    await spawned();
    c.abort();
    const err = await pending;
    expect(err.name).toBe("AbortError");
    expect(calls[0]!.killed).toBe(true);
  });

  test("a child that ignores SIGTERM is SIGKILLed after the grace, so the call ends and the slot is released", async () => {
    const stubborn = { hold: new Promise<void>(() => {}), ignoreSigterm: true };
    const { claude, calls, spawned } = cli((n) => (n === 1 ? stubborn : { stdout: [JSON.stringify(successEnvelope)] }), { maxConcurrent: 1, killGraceMs: 20 });
    const c = new AbortController();
    const first = claude.structured(req(), Out, unbudgeted(c.signal)).catch((e) => e);
    await spawned();
    c.abort();
    expect((await first).name).toBe("AbortError");
    expect(calls[0]!.signals).toEqual([undefined, "SIGKILL"]);
    expect((await claude.structured(req(), Out, OPEN)).output.concepts).toHaveLength(2);
  });

  test("a timed-out child that ignores SIGTERM is SIGKILLed and the error stays retryable", async () => {
    const { claude, calls } = cli({ hold: new Promise(() => {}), ignoreSigterm: true }, { killGraceMs: 20 });
    const err = await claude.structured(req({ timeoutMs: 20 }), Out, OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(calls[0]!.signals).toEqual([undefined, "SIGKILL"]);
  });

  test("a child that exits on SIGTERM is never SIGKILLed", async () => {
    const { claude, calls, spawned } = cli({ hold: new Promise(() => {}) }, { killGraceMs: 5 });
    const c = new AbortController();
    const pending = claude.structured(req(), Out, unbudgeted(c.signal)).catch((e) => e);
    await spawned();
    c.abort();
    await pending;
    // Timers fire in deadline order, so a SIGKILL still armed at the 5 ms grace lands before this 50 ms sleep ends.
    await Bun.sleep(50);
    expect(calls[0]!.signals).toEqual([undefined]);
  });

  test("a real child that has exited gets no late kill while its pipes are still draining", async () => {
    const kills: (NodeJS.Signals | undefined)[] = [];
    // The shell prints the envelope and exits at once, but its background sleep holds stdout open for 400ms, well past the 100ms timeout.
    const script = `printf '%s' "$ENVELOPE"; sleep 0.4 &`;
    const spawn: SpawnFn = (_argv, opts) => {
      const child = Bun.spawn(["/bin/sh", "-c", script], { cwd: opts.cwd, env: { ...opts.env, ENVELOPE: JSON.stringify(successEnvelope) }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const proc = child as unknown as ClaudeProcess;
      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: proc.exited,
        kill(signal) {
          kills.push(signal);
          child.kill(signal);
        },
      };
    };
    const claude = createClaudeCli({ bin: "/bin/sh", cwd: "/tmp", maxConcurrent: 1, spawn });
    const { output } = await claude.structured(req({ timeoutMs: 100 }), Out, OPEN);
    expect(output.concepts).toHaveLength(2);
    expect(kills.length).toBe(0);
  });

  test("an already-aborted signal never spawns", async () => {
    const { claude, calls } = cli({ stdout: [JSON.stringify(successEnvelope)] });
    const c = new AbortController();
    c.abort();
    await expect(claude.structured(req(), Out, unbudgeted(c.signal))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("no Anthropic credential or endpoint override reaches the child, so billing stays on the subscription", async () => {
    const { claude, calls } = cli(
      { stdout: [JSON.stringify(successEnvelope)] },
      { env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-secret", ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://proxy.example", HOME: "/h" } },
    );
    await claude.structured(req(), Out, OPEN);
    expect(calls[0]!.env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("claude over a real process (a stand-in script, not the claude binary)", () => {
  function standIn(body: string) {
    const dir = mkdtempSync(join(tmpdir(), "ac-standin-"));
    const bin = join(dir, "fake-claude");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return { bin, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("default spawn feeds the prompt on stdin, passes argv, strips ANTHROPIC_API_KEY and reads the envelope", async () => {
    const s = standIn(
      `IN=$(cat | wc -c | tr -d ' ')\nprintf '{"type":"result","is_error":false,"structured_output":{"concepts":["stdin=%s","key=%s","args=%s"]},"total_cost_usd":0.001}' "$IN" "\${ANTHROPIC_API_KEY:-none}" "$#"`,
    );
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const claude = createClaudeCli({ bin: s.bin, cwd: tmpdir(), maxConcurrent: 1 });
      const { output, usage } = await claude.structured(req({ prompt: "x".repeat(300_000) }), Out, OPEN);
      expect(output.concepts).toEqual(["stdin=300000", "key=none", `args=${claudeArgs(req(), "json", "{}").length}`]);
      expect(usage.cost).toEqual({ kind: "notional", usd: 0.001, basis: "claude_subscription" });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      s.done();
    }
  });

  test("abort kills a real hung process", async () => {
    const s = standIn("exec sleep 30");
    try {
      const claude = createClaudeCli({ bin: s.bin, cwd: tmpdir(), maxConcurrent: 1 });
      const c = new AbortController();
      const started = Date.now();
      const pending = claude.structured(req(), Out, unbudgeted(c.signal)).catch((e) => e);
      await Bun.sleep(50);
      c.abort();
      expect((await pending).name).toBe("AbortError");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      s.done();
    }
  });
});

describe("claude images", () => {
  test("images are staged as files the Read tool can open, granted by --add-dir, and removed afterwards", async () => {
    const bytes = jpeg(640, 360);
    let seenDuring: { dir: string; paths: string[]; same: boolean } | null = null;
    const fake = fakeSpawn({ stdout: [JSON.stringify(successEnvelope)] });
    const spawn: SpawnFn = (argv, opts) => {
      const dir = argv[argv.indexOf("--add-dir") + 1]!;
      const proc = fake.spawn(argv, opts);
      const paths = [...(fake.calls[0]!.stdin.join("") + "").matchAll(/: (\/\S+)/g)].map((m) => m[1]!);
      seenDuring = { dir, paths, same: false };
      const write = proc.stdin.write;
      proc.stdin.write = (c: string) => {
        write(c);
        const listed = [...c.matchAll(/: (\/\S+)/g)].map((m) => m[1]!);
        seenDuring = { dir, paths: listed, same: listed.every((p) => existsSync(p) && readFileSync(p).equals(Buffer.from(bytes))) };
      };
      return proc;
    };
    const claude = createClaudeCli({ bin: "claude", cwd: "/work", maxConcurrent: 1, spawn });
    await claude.structured(req({ images: [{ label: "frame 12 (board)", mediaType: "image/jpeg", bytes }, { label: "second", mediaType: "image/png", bytes }] }), Out, OPEN);
    expect(seenDuring).not.toBeNull();
    const seen = seenDuring!;
    expect(seen.paths).toHaveLength(2);
    expect(seen.paths.every((p) => p.startsWith(seen.dir + "/"))).toBe(true);
    expect(seen.paths[0]).toMatch(/0-frame_12_board_\.jpg$/);
    expect(seen.paths[1]).toMatch(/1-second\.png$/);
    expect(seen.same).toBe(true);
    expect(existsSync(seen.dir)).toBe(false);
    expect(fake.calls[0]!.stdin.join("")).toContain("Read tool");
    expect(fake.calls[0]!.stdin.join("")).toContain("frame 12 (board):");
  });

  test("the staging dir is removed when the call fails", async () => {
    const fake = fakeSpawn({ stdout: [], code: 1, stderr: "nope" });
    const claude = createClaudeCli({ bin: "claude", cwd: "/work", maxConcurrent: 1, spawn: fake.spawn });
    await claude.structured(req({ images: [{ label: "a", mediaType: "image/jpeg", bytes: jpeg(300, 300) }] }), Out, OPEN).catch(() => {});
    const dir = fake.calls[0]!.argv[fake.calls[0]!.argv.indexOf("--add-dir") + 1]!;
    expect(existsSync(dir)).toBe(false);
  });
});

describe("claude system prompt file", () => {
  test("a large system prompt goes through a private file that is removed afterwards, not argv", async () => {
    const system = "claims and evidence ".repeat(15_000);
    let seen: { file: string; same: boolean } | null = null;
    const fake = fakeSpawn({ stdout: [JSON.stringify(successEnvelope)] });
    const spawn: SpawnFn = (argv, opts) => {
      const file = argv[argv.indexOf("--system-prompt-file") + 1]!;
      seen = { file, same: existsSync(file) && readFileSync(file, "utf8") === system };
      return fake.spawn(argv, opts);
    };
    const claude = createClaudeCli({ bin: "claude", cwd: "/work", maxConcurrent: 1, spawn });
    await claude.structured(req({ system }), Out, OPEN);
    expect(seen!.same).toBe(true);
    expect(fake.calls[0]!.argv).not.toContain("--system-prompt");
    expect(fake.calls[0]!.argv.join("").length).toBeLessThan(2_000);
    expect(existsSync(seen!.file)).toBe(false);
  });
});

describe("claude concurrency", () => {
  test("never runs more than maxConcurrent processes, and serves everyone", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const { claude, live, peak, calls, spawned } = cli((n) => ({ stdout: [JSON.stringify(successEnvelope)], hold: gates[n - 1]!.promise }), { maxConcurrent: 2 });
    const all = Array.from({ length: 5 }, () => claude.structured(req(), Out, OPEN));
    await spawned(2);
    await Bun.sleep(10);
    expect(live()).toBe(2);
    for (const g of gates) {
      g.resolve();
      await Bun.sleep(5);
    }
    const done = await Promise.all(all);
    expect(done).toHaveLength(5);
    expect(peak()).toBe(2);
    expect(calls).toHaveLength(5);
  });

  test("a caller aborted while waiting for a slot never spawns, and frees nothing it did not hold", async () => {
    const gate = deferred<void>();
    const { claude, calls } = cli((n) => ({ stdout: [JSON.stringify(successEnvelope)], ...(n === 1 ? { hold: gate.promise } : {}) }), { maxConcurrent: 1 });
    const first = claude.structured(req(), Out, OPEN);
    const c = new AbortController();
    const queued = claude.structured(req(), Out, unbudgeted(c.signal)).catch((e) => e);
    await Bun.sleep(5);
    c.abort();
    expect((await queued).name).toBe("AbortError");
    gate.resolve();
    await first;
    expect(calls).toHaveLength(1);
    await claude.structured(req(), Out, OPEN);
    expect(calls).toHaveLength(2);
  });

  test("a killed call releases its slot", async () => {
    const { claude, spawned } = cli((n) => (n === 1 ? { hold: new Promise(() => {}) } : { stdout: [JSON.stringify(successEnvelope)] }), { maxConcurrent: 1 });
    const c = new AbortController();
    const first = claude.structured(req(), Out, unbudgeted(c.signal)).catch((e) => e);
    const second = claude.structured(req(), Out, OPEN);
    await spawned();
    c.abort();
    await first;
    expect((await second).output.concepts).toHaveLength(2);
  });

  test("rejects a nonsense limit", () => {
    expect(() => createClaudeCli({ bin: "claude", cwd: "/", maxConcurrent: 0 })).toThrow(RangeError);
  });
});

describe("claude streamText", () => {
  const ev = (event: unknown) => JSON.stringify({ type: "stream_event", session_id: "s", parent_tool_use_id: null, event }) + "\n";
  const delta = (text: string) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  const done = (result: string, over: object = {}) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 }, ...over }) + "\n";

  test("emits each text delta in order, ignores thinking and other events, resolves with the final text", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }) + "\n",
      ev({ type: "message_start", message: { id: "m1" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      delta('{"move":"probe"}\n'),
      delta("Why does "),
      delta("that hold?"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: '{"move":"probe"}\nWhy does that hold?' }] } }) + "\n",
      "not json at all\n",
      done('{"move":"probe"}\nWhy does that hold?'),
    ];
    const { claude, calls } = cli({ stdout: lines });
    const got: string[] = [];
    const res = await claude.streamText(req(), (d) => got.push(d), OPEN);
    expect(got).toEqual(['{"move":"probe"}\n', "Why does ", "that hold?"]);
    expect(res.text).toBe('{"move":"probe"}\nWhy does that hold?');
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, cost: { kind: "notional", usd: 0.5, basis: "claude_subscription" } });
    expect(calls[0]!.argv.slice(-4)).toEqual(["--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(calls[0]!.argv).not.toContain("--json-schema");
  });

  test("lines and multi-byte characters split across chunks still arrive whole", async () => {
    const bytes = new TextEncoder().encode(delta("héllo") + done("héllo"));
    const accent = bytes.indexOf(0xc3);
    const { claude } = cli({ stdout: [bytes.slice(0, 10), bytes.slice(10, accent + 1), bytes.slice(accent + 1, accent + 20), bytes.slice(accent + 20)] });
    const got: string[] = [];
    const res = await claude.streamText(req(), (d) => got.push(d), OPEN);
    expect(got).toEqual(["héllo"]);
    expect(res.text).toBe("héllo");
  });

  test("with no partial events, the whole assistant message is emitted once", async () => {
    const { claude } = cli({ stdout: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "all at once" }] } }) + "\n", done("all at once")] });
    const got: string[] = [];
    await claude.streamText(req(), (d) => got.push(d), OPEN);
    expect(got).toEqual(["all at once"]);
  });

  test("an assistant message only adds what the deltas did not already deliver", async () => {
    const { claude } = cli({
      stdout: [
        ev({ type: "message_start", message: {} }),
        delta("Hel"),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }) + "\n",
        done("Hello"),
      ],
    });
    const got: string[] = [];
    await claude.streamText(req(), (d) => got.push(d), OPEN);
    expect(got.join("")).toBe("Hello");
  });

  test("subagent text is not spoken", async () => {
    const { claude } = cli({
      stdout: [JSON.stringify({ type: "stream_event", parent_tool_use_id: "tool_1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "internal" } } }) + "\n", delta("spoken"), done("spoken")],
    });
    const got: string[] = [];
    await claude.streamText(req(), (d) => got.push(d), OPEN);
    expect(got).toEqual(["spoken"]);
  });

  test("a stream that ends in an error result throws with the usage so far", async () => {
    const { claude } = cli({ stdout: [delta("par"), done("API Error: 529 overloaded", { is_error: true })], code: 1 });
    const got: string[] = [];
    const err = await claude.streamText(req(), (d) => got.push(d), OPEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.usage?.outputTokens).toBe(20);
    expect(got).toEqual(["par"]);
  });

  test("the final text falls back to the streamed deltas when the result carries none", async () => {
    const { claude } = cli({ stdout: [delta("abc"), JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n"] });
    const res = await claude.streamText(req(), () => {}, OPEN);
    expect(res.text).toBe("abc");
    expect(res.usage.cost.kind).toBe("unknown");
  });

  test("abort mid-stream kills the process", async () => {
    const { claude, calls, spawned } = cli({ stdout: [delta("start")], hold: new Promise(() => {}) });
    const c = new AbortController();
    const pending = claude.streamText(req(), () => {}, unbudgeted(c.signal)).catch((e) => e);
    await spawned();
    c.abort();
    expect((await pending).name).toBe("AbortError");
    expect(calls[0]!.killed).toBe(true);
  });
});
