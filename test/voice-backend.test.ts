/**
 * Tutor voice, backend side: keys.env, the ElevenLabs client and its two routes. Every call is a fake fetch; nothing
 * here reaches ElevenLabs, Jev or Claude.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKeys, main } from "../src/backend/main";
import type { Running } from "../src/backend/main";
import { serve } from "../src/backend/http";
import { createLedger } from "../src/backend/providers/ledger";
import { DEFAULT_VOICE_ID, DEFAULT_VOICE_MODEL, createVoice, unavailableVoice } from "../src/backend/providers/elevenlabs";
import type { Voice } from "../src/backend/providers/elevenlabs";
import type { Db } from "../src/backend/db";
import { ROUTES, VOICE_TEXT_MAX, voiceStatusResponse } from "../src/shared/wire";
import { testDb } from "./fakes";

const TOKEN = "tok-voice-test-77aa";
const EL_KEY = "xi-secret-key-DO-NOT-LEAK-0123";
const JEV_KEY = "jev-secret-0123";

const scratch: string[] = [];
const servers: { stop(force?: boolean): void | Promise<void> }[] = [];
const mains: Running[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop(true);
  for (const r of mains) await r.stop();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function dir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const AUDIO = [new Uint8Array([0xff, 0xfb, 1, 2]), new Uint8Array([3, 4, 5])];
type Call = { url: string; init: RequestInit };

/** A fake ElevenLabs: records each request and streams AUDIO, or whatever `respond` says. */
function fakeEleven(respond?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    if (respond) return respond(call);
    return new Response(new ReadableStream({ start(c) { for (const b of AUDIO) c.enqueue(b); c.close(); } }), { headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** A body that never ends, and a flag for when the request's signal fired. */
function hanging() {
  const seen = { aborted: false, started: false };
  const e = fakeEleven((call) => {
    seen.started = true;
    call.init.signal?.addEventListener("abort", () => (seen.aborted = true));
    return new Response(new ReadableStream({ start(c) { c.enqueue(AUDIO[0]!); } }));
  });
  return { ...e, seen };
}

function rows(db: Db) {
  return db.sql.query<Record<string, unknown>, []>("SELECT * FROM voice_usage_events ORDER BY started_ms").all();
}

const until = async (done: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
};

function start(voice: Voice | undefined, db: Db = testDb()) {
  const server = serve({
    modules: { ledger: createLedger(db), evidence: {} as never, reviews: {} as never, ...(voice ? { voice } : {}) },
    auth: { port: 0, extensionId: "abcdefghijklmnopabcdefghijklmnop", token: TOKEN }, appDir: dir("afterclass-app-"),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (text: unknown, init: { token?: string | null; signal?: AbortSignal } = {}) =>
    fetch(`${base}/voice/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }) },
      body: JSON.stringify(text === undefined ? {} : { text }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  const status = (token: string | null = TOKEN) => fetch(`${base}/voice`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  return { db, base, post, status };
}

describe("keys.env", () => {
  test("picks up ELEVENLABS_API_KEY next to TYPESAFE_API_KEY and still ignores every other name", () => {
    const path = join(dir("afterclass-config-"), "keys.env");
    writeFileSync(path, `# k\nANTHROPIC_API_KEY=nope\nTYPESAFE_API_KEY=${JEV_KEY}\nexport ELEVENLABS_API_KEY="${EL_KEY}"\nELEVENLABS_VOICE=x\nOTHER=1\n`, { mode: 0o600 });
    expect(readKeys(path)).toEqual({ TYPESAFE_API_KEY: JEV_KEY, ELEVENLABS_API_KEY: EL_KEY });
  });

  test("the ElevenLabs key is optional, and an empty value is no key", () => {
    const path = join(dir("afterclass-config-"), "keys.env");
    writeFileSync(path, `TYPESAFE_API_KEY=${JEV_KEY}\nELEVENLABS_API_KEY=\n`, { mode: 0o600 });
    expect(readKeys(path)).toEqual({ TYPESAFE_API_KEY: JEV_KEY });
  });

  test("a keys file with the ElevenLabs key is still refused above mode 0600, without echoing the key", () => {
    const path = join(dir("afterclass-config-"), "keys.env");
    writeFileSync(path, `ELEVENLABS_API_KEY=${EL_KEY}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => readKeys(path)).toThrow("0644");
    try {
      readKeys(path);
    } catch (e) {
      expect((e as Error).message).not.toContain(EL_KEY);
    }
  });
});

describe("POST /voice/speech", () => {
  const make = (fetchFn: typeof fetch, extra: { timeoutMs?: number } = {}, db: Db = testDb()) =>
    start(createVoice({ apiKey: EL_KEY, voiceId: DEFAULT_VOICE_ID, model: DEFAULT_VOICE_MODEL, db, fetch: fetchFn, ...extra }), db);

  test("forwards the sentence with the key in xi-api-key, and streams the audio back as audio/mpeg", async () => {
    const e = fakeEleven();
    const s = make(e.fetchFn);
    const res = await s.post("What did the lecturer say about ordering?");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xfb, 1, 2, 3, 4, 5]));
    expect(e.calls).toHaveLength(1);
    const call = e.calls[0]!;
    expect(call.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE_ID}/stream?output_format=mp3_44100_128`);
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["xi-api-key"]).toBe(EL_KEY);
    expect(JSON.parse(call.init.body as string)).toEqual({ text: "What did the lecturer say about ordering?", model_id: DEFAULT_VOICE_MODEL });
  });

  test("the configured voice and model go upstream", async () => {
    const e = fakeEleven();
    const db = testDb();
    const s = start(createVoice({ apiKey: EL_KEY, voiceId: "AbCdEfGh1234", model: "eleven_multilingual_v2", db, fetch: e.fetchFn }), db);
    await (await s.post("Hi.")).arrayBuffer();
    expect(e.calls[0]!.url).toContain("/AbCdEfGh1234/stream");
    expect(JSON.parse(e.calls[0]!.init.body as string).model_id).toBe("eleven_multilingual_v2");
  });

  test("a bad voice id or model is refused when the voice is built, not at the first sentence", () => {
    expect(() => createVoice({ apiKey: EL_KEY, voiceId: "../x", model: DEFAULT_VOICE_MODEL, db: testDb() })).toThrow("VOICE_ID");
    expect(() => createVoice({ apiKey: EL_KEY, voiceId: DEFAULT_VOICE_ID, model: "Bad Model", db: testDb() })).toThrow("MODEL");
  });

  test("refuses an unauthenticated request, empty text, a missing field and oversized text, and never calls upstream", async () => {
    const e = fakeEleven();
    const s = make(e.fetchFn);
    expect((await s.post("Hello.", { token: null })).status).toBe(401);
    expect((await s.post("Hello.", { token: "wrong" })).status).toBe(401);
    expect((await s.post("")).status).toBe(400);
    expect((await s.post("   \n")).status).toBe(400);
    expect((await s.post(undefined)).status).toBe(400);
    expect((await s.post("x".repeat(VOICE_TEXT_MAX + 1))).status).toBe(400);
    expect((await s.post("x".repeat(VOICE_TEXT_MAX))).status).toBe(200);
    expect(e.calls).toHaveLength(1);
  });

  test("reports unavailable, and calls nothing, when no voice is wired or it has no key", async () => {
    for (const voice of [undefined, unavailableVoice]) {
      const s = start(voice);
      expect(voiceStatusResponse.parse(await (await s.status()).json())).toEqual({ available: false });
      const res = await s.post("Hello.");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "voice unavailable" });
      expect((await s.status(null)).status).toBe(401);
    }
  });

  test("GET /voice says available when the voice is wired", async () => {
    const s = make(fakeEleven().fetchFn);
    expect(voiceStatusResponse.parse(await (await s.status()).json())).toEqual({ available: true });
  });

  test("records one usage event per call: characters sent, cost unknown (R17), never zero", async () => {
    const db = testDb();
    const s = make(fakeEleven().fetchFn, {}, db);
    await (await s.post("Héllo there.")).arrayBuffer();
    await until(() => rows(db).length === 1);
    const [row] = rows(db);
    expect(row).toMatchObject({ provider: "elevenlabs", model: DEFAULT_VOICE_MODEL, voice_id: DEFAULT_VOICE_ID, characters: 12, outcome: "ok", cost_kind: "unknown" });
    expect(String(row!.cost_reason)).not.toBe("");
    expect(Object.keys(row!)).not.toContain("cost_usd");
    expect(() => db.sql.run("UPDATE voice_usage_events SET characters = 0")).toThrow("append-only");
    expect(() => db.sql.run("DELETE FROM voice_usage_events")).toThrow("never deleted");
    expect(() => db.sql.run("UPDATE voice_usage_events SET cost_kind = 'measured'")).toThrow();
  });

  test("an upstream error is a 502 with no upstream text, and still a usage event with outcome error", async () => {
    const db = testDb();
    const e = fakeEleven(() => new Response(`{"detail":"invalid key ${EL_KEY}"}`, { status: 401 }));
    const s = make(e.fetchFn, {}, db);
    const res = await s.post("Hello.");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(EL_KEY);
    expect(text).not.toContain("invalid key");
    expect(rows(db).map((r) => r.outcome)).toEqual(["error"]);
  });

  test("a network failure upstream is a 502 and an error event", async () => {
    const db = testDb();
    const s = make((() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch, {}, db);
    expect((await s.post("Hello.")).status).toBe(502);
    expect(rows(db).map((r) => r.outcome)).toEqual(["error"]);
  });

  test("aborts the upstream call when the client disconnects, and records it as aborted", async () => {
    const db = testDb();
    const h = hanging();
    const s = make(h.fetchFn, {}, db);
    const ctrl = new AbortController();
    const res = await s.post("A long sentence.", { signal: ctrl.signal });
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(h.seen.aborted).toBe(false);
    ctrl.abort();
    await until(() => h.seen.aborted);
    await until(() => rows(db).length === 1);
    expect(rows(db)[0]!.outcome).toBe("aborted");
  });

  test("times out a stalled upstream and answers 504", async () => {
    const db = testDb();
    const e = fakeEleven((call) => new Promise<Response>((_, reject) => call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const s = make(e.fetchFn, { timeoutMs: 50 }, db);
    const res = await s.post("Hello.");
    expect(res.status).toBe(504);
    expect(rows(db).map((r) => r.outcome)).toEqual(["error"]);
  });

  test("the key is in no response body or header", async () => {
    const e = fakeEleven();
    const s = make(e.fetchFn);
    for (const res of [await s.post("Hello."), await s.post(""), await s.post("Hello.", { token: null }), await s.status()]) {
      const dump = `${[...res.headers].join("\n")}\n${await res.text()}`;
      expect(dump).not.toContain(EL_KEY);
    }
  });

  test("the route is in ROUTES as the audio reply, with the sentence bound", () => {
    expect(ROUTES.speak.reply.kind).toBe("audio");
    expect(ROUTES.speak.request!.safeParse({ text: "x".repeat(VOICE_TEXT_MAX + 1) }).success).toBe(false);
  });
});

describe("main wiring", () => {
  async function boot(keysText: string | null, env: Record<string, string>) {
    const configDir = dir("afterclass-config-");
    if (keysText !== null) writeFileSync(join(configDir, "keys.env"), keysText, { mode: 0o600 });
    const urls: string[] = [];
    const e = fakeEleven();
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return e.fetchFn(input, init);
    }) as typeof fetch;
    const logs: string[] = [];
    const r = await main({
      port: 0, buildApp: false, configDir, fetch: fetchFn, log: (t) => void logs.push(t), error: (t) => void logs.push(t),
      env: { AFTERCLASS_DATA: dir("afterclass-data-"), ...env },
    });
    mains.push(r);
    const base = `http://127.0.0.1:${r.port}`;
    const headers = { authorization: `Bearer ${r.token}` };
    return { r, logs, urls, base, headers };
  }

  test("live mode with the key: voice is available, speaks through the configured voice, and the key is in no log line", async () => {
    const b = await boot(`TYPESAFE_API_KEY=${JEV_KEY}\nELEVENLABS_API_KEY=${EL_KEY}\n`, { AFTERCLASS_MODE: "live", AFTERCLASS_ELEVENLABS_VOICE_ID: "VoiceId12345" });
    expect(await (await fetch(`${b.base}/voice`, { headers: b.headers })).json()).toEqual({ available: true });
    const res = await fetch(`${b.base}/voice/speech`, { method: "POST", headers: b.headers, body: JSON.stringify({ text: "Hello." }) });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(b.urls).toEqual(["https://api.elevenlabs.io/v1/text-to-speech/VoiceId12345/stream?output_format=mp3_44100_128"]);
    const all = b.logs.join("\n");
    expect(all).not.toContain(EL_KEY);
    expect(all).not.toContain(JEV_KEY);
    expect(all).toContain(`voice: ElevenLabs (model ${DEFAULT_VOICE_MODEL}, voice VoiceId12345)`);
  });

  test("live mode without the key: unavailable, so the app falls back", async () => {
    const b = await boot(`TYPESAFE_API_KEY=${JEV_KEY}\n`, { AFTERCLASS_MODE: "live" });
    expect(await (await fetch(`${b.base}/voice`, { headers: b.headers })).json()).toEqual({ available: false });
    expect((await fetch(`${b.base}/voice/speech`, { method: "POST", headers: b.headers, body: JSON.stringify({ text: "Hello." }) })).status).toBe(503);
    expect(b.urls).toEqual([]);
  });

  test("replay mode is unavailable even with a key in keys.env, and makes no call", async () => {
    const b = await boot(`TYPESAFE_API_KEY=${JEV_KEY}\nELEVENLABS_API_KEY=${EL_KEY}\n`, { AFTERCLASS_MODE: "replay" });
    expect(await (await fetch(`${b.base}/voice`, { headers: b.headers })).json()).toEqual({ available: false });
    expect((await fetch(`${b.base}/voice/speech`, { method: "POST", headers: b.headers, body: JSON.stringify({ text: "Hello." }) })).status).toBe(503);
    expect(b.urls).toEqual([]);
    expect(b.logs.join("\n")).not.toContain(EL_KEY);
  });

  test("a malformed voice id refuses to start, without echoing the key", async () => {
    const error = await boot(`TYPESAFE_API_KEY=${JEV_KEY}\nELEVENLABS_API_KEY=${EL_KEY}\n`, { AFTERCLASS_MODE: "live", AFTERCLASS_ELEVENLABS_VOICE_ID: "../../x" }).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("AFTERCLASS_ELEVENLABS_VOICE_ID");
    expect(error?.message).not.toContain(EL_KEY);
  });
});
