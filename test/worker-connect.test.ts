/**
 * A hosted build of the real service worker on fakes (worker-harness.ts): connecting through the web app's code, the
 * device token as bearer, a 401, and captures that belong to one account. The build-time origin is set as the global
 * the bundler would replace.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { boot, connectPort, feed, newEnv, restoreGlobals, sendPopup, span, wait } from "./worker-harness";
import type { Env } from "./worker-harness";

const ORIGIN = "https://useafterclass.test";
const g = globalThis as { __AFTERCLASS_HOSTED_ORIGIN__?: string; fetch: typeof fetch };

type Sent = { readonly path: string; readonly authorization: string | null; readonly body: { captureId?: string; facts?: unknown[]; code?: string } };

/** The hosted backend as the worker sees it: codes that name an account, device tokens, and ingest that answers 401 to a token it does not hold. */
function hostedBackend() {
  const b = {
    sent: [] as Sent[],
    codes: new Map<string, string>([["acc_alice", "usr_alice"], ["acc_alice2", "usr_alice"], ["acc_bob", "usr_bob"]]),
    tokens: new Map<string, string>(),
    stored: new Map<string, Set<number>>(),
    issued: 0,
    /** Holds the next ingest's answer until released, to interleave a reconnect with a request in flight. */
    hold: null as Promise<void> | null,
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const authorization = new Headers(init.headers).get("authorization");
      const body = JSON.parse(String(init.body ?? "{}")) as Sent["body"];
      b.sent.push({ path, authorization, body });
      if (path === "/devices/exchange") {
        const userId = b.codes.get(body.code ?? "");
        if (userId === undefined) return new Response(JSON.stringify({ error: "bad code" }), { status: 401 });
        b.codes.delete(body.code!);
        const token = `acd_${userId}_${++b.issued}`;
        b.tokens.set(token, userId);
        return Response.json({ token, userId });
      }
      if (path === "/ingest") {
        const held = b.hold;
        b.hold = null;
        if (held) await held;
        const token = authorization?.replace(/^Bearer /, "") ?? "";
        if (!b.tokens.has(token)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        const seen = b.stored.get(body.captureId!) ?? new Set<number>();
        b.stored.set(body.captureId!, seen);
        for (const f of (body.facts ?? []) as { clientSeq: number }[]) seen.add(f.clientSeq);
        let acked = -1;
        while (seen.has(acked + 1)) acked++;
        return Response.json({
          ackedThroughSeq: acked,
          invite: { state: "none" },
          capture: { captureId: body.captureId, status: { state: "capturing" }, sources: [], currentSourceId: null, transcript: "unknown", health: [], watchedSeconds: 0 },
          reviewAppUrl: `${ORIGIN}/app/capture/${body.captureId}`,
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
  };
  return b;
}

async function hostedWorker(env: Env = { ...newEnv(), local: {} }) {
  const backend = hostedBackend();
  const { c } = await boot(env);
  g.fetch = backend.fetch;
  const external = (msg: unknown, sender: Record<string, unknown>) =>
    new Promise<{ readonly handled: boolean; readonly reply: unknown }>((resolve) => {
      let reply: unknown;
      const [handled] = c.runtime.onMessageExternal.fire(msg, sender, (r: unknown) => {
        reply = r;
        resolve({ handled: true, reply });
      });
      if (handled !== true) resolve({ handled: false, reply });
    });
  const fromApp = { origin: ORIGIN, url: `${ORIGIN}/app/connect-extension` };
  const connect = (code: string) => external({ type: "afterclass_connect", code }, fromApp);
  const status = async () => (await sendPopup(c, { type: "status", tabId: 1 })).state;
  const connection = () => sendPopup(c, { type: "connection" });
  return { c, env, backend, external, fromApp, connect, status, connection };
}

const ingests = (b: ReturnType<typeof hostedBackend>) => b.sent.filter((s) => s.path === "/ingest" && (s.body.facts?.length ?? 0) > 0);

beforeEach(() => {
  g.__AFTERCLASS_HOSTED_ORIGIN__ = ORIGIN;
});
afterEach(() => {
  delete g.__AFTERCLASS_HOSTED_ORIGIN__;
});
afterAll(restoreGlobals);

describe("connecting a hosted build", () => {
  test("a connect message is taken only from the configured origin; any other page or extension is ignored and nothing is sent", async () => {
    const w = await hostedWorker();
    for (const sender of [
      { origin: "https://evil.test", url: "https://evil.test/app/connect-extension" },
      { origin: "http://useafterclass.test", url: "http://useafterclass.test/app/connect-extension" },
      { id: "anotherextension", origin: "chrome-extension://anotherextension", url: "chrome-extension://anotherextension/page.html" },
      { url: "https://useafterclass.test.evil.test/app/" },
      {},
    ]) {
      const r = await w.external({ type: "afterclass_connect", code: "acc_alice" }, sender);
      expect(r, JSON.stringify(sender)).toEqual({ handled: false, reply: undefined });
    }
    expect(w.backend.sent).toEqual([]);
    expect(w.env.local.connection).toBeUndefined();
  });

  test("the code is exchanged with no bearer, and the device token is kept in chrome.storage.local with its account", async () => {
    const w = await hostedWorker();
    expect(await w.connection()).toEqual({ kind: "not_connected" });
    expect(await w.connect("acc_alice")).toEqual({ handled: true, reply: { ok: true } });
    expect(w.backend.sent[0]).toEqual({ path: "/devices/exchange", authorization: null, body: { code: "acc_alice" } });
    expect(w.env.local.connection).toEqual({ token: "acd_usr_alice_1", userId: "usr_alice" });
    expect(await w.connection()).toEqual({ kind: "connected" });
    expect(await w.connect("acc_unknown")).toEqual({ handled: true, reply: { ok: false, error: "the connect code was not accepted." } });
    expect(w.env.local.connection).toEqual({ token: "acd_usr_alice_1", userId: "usr_alice" });
  });

  test("a URL-only sender from the configured origin is taken, for a Chrome that sets no sender.origin", async () => {
    const w = await hostedWorker();
    expect((await w.external({ type: "afterclass_connect", code: "acc_alice" }, { url: `${ORIGIN}/app/connect-extension` })).reply).toEqual({ ok: true });
  });

  test("Start waits for a connection", async () => {
    const w = await hostedWorker();
    connectPort(w.c, 1);
    const r = await sendPopup(w.c, { type: "start", tabId: 1 });
    expect(r.error).toContain("connect After Class to your account first");
    expect(w.env.session.tabs?.[1]).toBeUndefined();
  });

  test("captures go up with the device token; a 401 empties it and keeps every fact, and reconnecting the same account sends them", async () => {
    const w = await hostedWorker();
    await w.connect("acc_alice");
    const p = connectPort(w.c, 1);
    await sendPopup(w.c, { type: "start", tabId: 1 });
    feed(p, span(0, 5));
    await wait(120);
    expect(ingests(w.backend).every((s) => s.authorization === "Bearer acd_usr_alice_1")).toBe(true);
    expect((await w.status()).uploadBacklog).toBe(0);

    w.backend.tokens.clear();
    feed(p, span(5, 10));
    await wait(120);
    expect(w.env.local.connection).toEqual({ token: null, userId: "usr_alice" });
    expect(await w.connection()).toEqual({ kind: "disconnected" });
    const held = await w.status();
    expect(held.uploadBacklog).toBeGreaterThan(0);
    expect(held.lastError).toContain("Reconnect");

    await w.connect("acc_alice2");
    await wait(120);
    expect((await w.status()).uploadBacklog).toBe(0);
    expect(ingests(w.backend).at(-1)!.authorization).toBe("Bearer acd_usr_alice_2");
  });

  test("a 401 that answers a request sent before a reconnect does not empty the new token", async () => {
    const w = await hostedWorker();
    await w.connect("acc_alice");
    const p = connectPort(w.c, 1);
    await sendPopup(w.c, { type: "start", tabId: 1 });
    await wait(120);
    let release: () => void = () => {};
    w.backend.hold = new Promise<void>((r) => (release = r));
    w.backend.tokens.clear();
    feed(p, span(0, 5));
    await wait(30);
    await w.connect("acc_alice2");
    release();
    await wait(120);
    expect(w.env.local.connection).toEqual({ token: "acd_usr_alice_2", userId: "usr_alice" });
  });

  test("a capture started under one account never goes up with another account's token", async () => {
    const w = await hostedWorker();
    await w.connect("acc_alice");
    const p = connectPort(w.c, 1);
    await sendPopup(w.c, { type: "start", tabId: 1 });
    await wait(120);
    const aliceCapture = (await w.status()).captureId as string;
    w.backend.tokens.clear();
    feed(p, span(0, 5));
    await wait(120);
    await w.connect("acc_bob");
    feed(p, span(5, 10));
    w.c.alarms.onAlarm.fire({ name: "afterclass-flush" });
    await wait(150);
    const bobToken = (w.env.local.connection as { token: string }).token;
    expect(ingests(w.backend).filter((s) => s.authorization === `Bearer ${bobToken}` && s.body.captureId === aliceCapture)).toEqual([]);
    const s = await w.status();
    expect(s.uploadBacklog).toBeGreaterThan(0);
    expect(s.lastError).toContain("belongs to another account");
  });
});

describe("a local build", () => {
  test("ignores connect messages from any page, and keeps the pairing token flow", async () => {
    delete g.__AFTERCLASS_HOSTED_ORIGIN__;
    const env = newEnv();
    const { c } = await boot(env);
    const [handled] = c.runtime.onMessageExternal.fire({ type: "afterclass_connect", code: "acc_alice" }, { origin: "http://127.0.0.1:4317", url: "http://127.0.0.1:4317/app/" }, () => {});
    expect(handled).toBe(false);
    expect(env.local.connection).toBeUndefined();
    expect(await sendPopup(c, { type: "connection" })).toEqual({ kind: "local" });
    const p = connectPort(c, 1);
    await sendPopup(c, { type: "start", tabId: 1 });
    feed(p, span(0, 5));
    await wait(120);
    expect(env.backend.calls).toBeGreaterThan(0);
    expect((await sendPopup(c, { type: "status", tabId: 1 })).state.uploadBacklog).toBe(0);
  });
});
