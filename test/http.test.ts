/**
 * M3: the HTTP shell. Auth (Host, Origin, token), the routes M3 mounts, and the bundled review app.
 * Fetch cannot send an arbitrary Host or an unnormalised path, so requests that need either go over a raw socket.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../scripts/build-app";
import { MAX_BODY_BYTES, authorize, serve } from "../src/backend/http";
import type { AuthConfig } from "../src/backend/http";
import { createEvidence } from "../src/backend/evidence";
import { createLedger } from "../src/backend/providers/ledger";
import type { Reviews } from "../src/backend/review";
import type { InviteAnswer, InviteState } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import { ROUTES, captureResponse, ingestAckResponse } from "../src/shared/wire";
import { testDb } from "./fakes";

const TOKEN = "tok-9f3a1c77e0b24d5aa8c1";
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const PAGE = "https://evil.test";
const CAP = stableId("cap", "http-test");

const scratch: string[] = [];
const servers: { stop(force?: boolean): void | Promise<void> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop(true);
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

function fixtureApp(): string {
  const dir = scratchDir("afterclass-app-");
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><head><meta name="afterclass-token" content="" /><title>t</title><script type="module" src="/app/main.js"></script></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, "main.js"), "console.log('app');");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "a.css"), "body{}");
  return dir;
}

/** The real evidence module on an in-memory db; reviews is a fake whose invite state a test sets. */
function world() {
  const db = testDb();
  const dir = scratchDir("afterclass-data-");
  const evidence = createEvidence(db, dir, {
    lookupFrameChange: (input) => ({ kind: "missing", key: stableId("key", input.after.frame.id) }),
    runFrameChange: async () => undefined,
    frameChangeKey: (input) => stableId("key", input.after.frame.id),
    onChange: () => {},
  });
  const invite = { state: { state: "none" } as InviteState, answers: [] as InviteAnswer[] };
  const reviews = {
    invite: () => invite.state,
    answerInvite: (_: unknown, a: InviteAnswer) => {
      invite.answers.push(a);
      if (a === "later") invite.state = { state: "later" };
      return invite.state;
    },
  } as unknown as Reviews;
  const stored = () => db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM capture_facts").get()!.n;
  return { db, evidence, reviews, invite, stored };
}

function start(appDir = fixtureApp(), extra: { maxBodyBytes?: number } = {}) {
  const w = world();
  const server = serve({
    modules: { ledger: createLedger(w.db), evidence: w.evidence, reviews: w.reviews },
    auth: { port: 0, extensionId: EXT_ID, token: TOKEN }, appDir, ...extra,
  });
  servers.push(server);
  return { server, port: server.port as number, base: `http://127.0.0.1:${server.port}`, ...w };
}

type Raw = { status: number; headers: Headers; body: string };

/** One HTTP/1.1 request with exactly the given path and headers (`null` omits a header). */
function raw(port: number, path: string, headers: Record<string, string | null>, method = "GET"): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const lines = [`${method} ${path} HTTP/1.1`, ...Object.entries({ Host: `127.0.0.1:${port}`, ...headers }).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`), "Connection: close", "", ""];
    const chunks: Uint8Array[] = [];
    const sock = connect(port, "127.0.0.1", () => sock.write(lines.join("\r\n")));
    sock.on("data", (c: Uint8Array) => chunks.push(c));
    sock.on("error", reject);
    sock.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const head = text.slice(0, split).split("\r\n");
      const h = new Headers();
      for (const l of head.slice(1)) h.append(l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim());
      resolve({ status: Number(head[0]!.split(" ")[1]), headers: h, body: text.slice(split + 4) });
    });
  });
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

describe("authorize", () => {
  const cfg: AuthConfig = { port: 4317, extensionId: EXT_ID, token: TOKEN };
  const h = (init: Record<string, string>) => new Headers({ Host: "127.0.0.1:4317", ...init });

  test("accepts the loopback hosts with the token and no Origin", () => {
    expect(authorize(h({ Authorization: `Bearer ${TOKEN}` }), cfg)).toEqual({ ok: true, origin: "none" });
    expect(authorize(h({ Host: "localhost:4317", Authorization: `Bearer ${TOKEN}` }), cfg)).toEqual({ ok: true, origin: "none" });
  });

  test("rejects any other Host with 403, even with a valid token (DNS rebinding)", () => {
    for (const host of ["evil.test", "evil.test:4317", "127.0.0.1:9999", "127.0.0.1", "localhost", "127.0.0.1.evil.test:4317", "localhost.evil.test:4317", "[::1]:4317", ""]) {
      expect(authorize(h({ Host: host, Authorization: `Bearer ${TOKEN}` }), cfg)).toEqual({ ok: false, status: 403 });
    }
    const noHost = new Headers({ Authorization: `Bearer ${TOKEN}` });
    expect(authorize(noHost, cfg)).toEqual({ ok: false, status: 403 });
  });

  test("allows only the pinned extension and the app origin; any other Origin is 403 even with a valid token", () => {
    expect(authorize(h({ Origin: `chrome-extension://${EXT_ID}`, Authorization: `Bearer ${TOKEN}` }), cfg)).toEqual({ ok: true, origin: "extension" });
    expect(authorize(h({ Origin: "http://127.0.0.1:4317", Authorization: `Bearer ${TOKEN}` }), cfg)).toEqual({ ok: true, origin: "review_app" });
    for (const origin of [PAGE, "null", "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "http://127.0.0.1:4318", "http://127.0.0.1", "https://127.0.0.1:4317", "http://127.0.0.1:4317.evil.test", `chrome-extension://${EXT_ID}.evil.test`]) {
      expect(authorize(h({ Origin: origin, Authorization: `Bearer ${TOKEN}` }), cfg)).toEqual({ ok: false, status: 403 });
    }
  });

  test("a request that arrives without Origin but is marked cross-site by the browser is 403", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(authorize(h({ "Sec-Fetch-Site": site, Authorization: `Bearer ${TOKEN}` }), cfg)).toEqual({ ok: false, status: 403 });
    }
    expect(authorize(h({ "Sec-Fetch-Site": "same-origin", Authorization: `Bearer ${TOKEN}` }), cfg).ok).toBe(true);
  });

  test("requires the exact bearer token (401), and not a prefix, suffix or other scheme", () => {
    for (const auth of [null, "", `Bearer`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer x${TOKEN}`, `Bearer ${"a".repeat(TOKEN.length)}`, `Basic ${TOKEN}`, TOKEN]) {
      expect(authorize(h(auth === null ? {} : { Authorization: auth }), cfg)).toEqual({ ok: false, status: 401 });
    }
    expect(authorize(h({ Authorization: `bearer ${TOKEN}` }), cfg).ok).toBe(true);
  });

  test("origin failures are reported before a missing token", () => {
    expect(authorize(h({ Origin: PAGE }), cfg)).toEqual({ ok: false, status: 403 });
  });

  test("with requireToken false the token is not needed, Host and Origin still are", () => {
    expect(authorize(h({}), cfg, { requireToken: false })).toEqual({ ok: true, origin: "none" });
    expect(authorize(h({ Host: "evil.test" }), cfg, { requireToken: false })).toEqual({ ok: false, status: 403 });
    expect(authorize(h({ Origin: PAGE }), cfg, { requireToken: false })).toEqual({ ok: false, status: 403 });
  });
});

describe("health and the API", () => {
  test("GET /health is {\"ok\":true} on both loopback names without a token", async () => {
    const { port, base } = start();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"ok":true}');
    expect((await raw(port, "/health", { Host: `localhost:${port}` })).body).toBe('{"ok":true}');
  });

  test("a rebinding Host or a page Origin gets 403 on every kind of route", async () => {
    const { port } = start();
    for (const path of ["/health", "/usage", "/app/", "/app/main.js", `/captures/${CAP}`]) {
      expect((await raw(port, path, { Host: "evil.test", ...bearer })).status).toBe(403);
      expect((await raw(port, path, { Host: `evil.test:${port}`, ...bearer })).status).toBe(403);
      expect((await raw(port, path, { Origin: PAGE, ...bearer })).status).toBe(403);
    }
  });

  test("GET /usage needs the token and answers with the ledger summary in the route's schema", async () => {
    const { base } = start();
    expect((await fetch(`${base}/usage`)).status).toBe(401);
    expect((await fetch(`${base}/usage`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    const r = await fetch(`${base}/usage`, { headers: bearer });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const parsed = ROUTES.usage.reply.kind === "json" ? ROUTES.usage.reply.schema.parse(await r.json()) : null;
    expect(parsed).toMatchObject({ byKind: { measured: { calls: 0 } } });
  });

  test("the extension origin may call with the token and gets CORS headers for itself only", async () => {
    const { base } = start();
    const origin = `chrome-extension://${EXT_ID}`;
    const r = await fetch(`${base}/usage`, { headers: { ...bearer, Origin: origin } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(origin);
    expect(r.headers.get("vary")).toContain("Origin");
    const plain = await fetch(`${base}/usage`, { headers: bearer });
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("preflight is answered for allow-listed origins and refused for others", async () => {
    const { base } = start();
    const origin = `chrome-extension://${EXT_ID}`;
    const ok = await fetch(`${base}/ingest`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
    expect(ok.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(ok.headers.get("access-control-allow-origin")).not.toBe("*");
    const bad = await fetch(`${base}/ingest`, { method: "OPTIONS", headers: { Origin: PAGE, "Access-Control-Request-Method": "POST" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("other ROUTES are 501 after auth and id validation; bad ids are 400; unknown paths are 404", async () => {
    const { base } = start();
    expect((await fetch(`${base}/captures/${CAP}`)).status).toBe(401);
    expect((await fetch(`${base}/captures/${CAP}/review-options`, { headers: bearer })).status).toBe(501);
    expect((await fetch(`${base}/captures/not-an-id`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${base}/reviews/${CAP}`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${base}/reviews/${stableId("rvw", "x")}`, { headers: bearer })).status).toBe(501);
    expect((await fetch(`${base}/nope`, { headers: bearer })).status).toBe(404);
    expect((await fetch(`${base}/usage`, { method: "POST", headers: bearer })).status).toBe(404);
  });

  test("the token never appears in a response outside /app, whatever the status", async () => {
    const { port } = start();
    const probes: [string, Record<string, string | null>, string?][] = [
      ["/health", {}],
      ["/health", { Host: "evil.test" }],
      ["/usage", bearer],
      ["/usage", {}],
      ["/usage", { Origin: PAGE, ...bearer }],
      [`/captures/${CAP}`, bearer],
      ["/captures/bad", bearer],
      ["/nope", bearer],
      ["/ingest", { Origin: `chrome-extension://${EXT_ID}`, "Access-Control-Request-Method": "POST" }, "OPTIONS"],
      ["/ingest", { Origin: PAGE }, "OPTIONS"],
    ];
    for (const [path, headers, method] of probes) {
      const r = await raw(port, path, headers, method);
      const everything = r.body + [...r.headers.values()].join("\n");
      expect(everything).not.toContain(TOKEN);
    }
  });
});

describe("the review app under /app", () => {
  test("serves index.html with the token in the afterclass-token meta tag, uncached", async () => {
    const { base } = start();
    for (const path of ["/app", "/app/", "/app/index.html"]) {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("cache-control")).toContain("no-store");
      expect(await r.text()).toContain(`<meta name="afterclass-token" content="${TOKEN}"`);
    }
  });

  test("injects the token even when the page has no placeholder, and escapes it", async () => {
    const dir = scratchDir("afterclass-app-");
    writeFileSync(join(dir, "index.html"), "<html><head><title>t</title></head><body></body></html>");
    const { base } = start(dir);
    const text = await (await fetch(`${base}/app/`)).text();
    expect(text).toContain(`<meta name="afterclass-token" content="${TOKEN}">`);
    expect(text.match(/afterclass-token/g)?.length).toBe(1);
  });

  test("falls back to index.html for client routes, with the token", async () => {
    const { base } = start();
    for (const path of [`/app/capture/${CAP}`, "/app/record", "/app/usage", "/app/a/b/c"]) {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(await r.text()).toContain(`content="${TOKEN}"`);
    }
  });

  test("serves real files byte-for-byte with their type and never the token; a missing file is 404, not index.html", async () => {
    const { base } = start();
    const js = await fetch(`${base}/app/main.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toBe("console.log('app');");
    expect((await fetch(`${base}/app/nested/a.css`)).headers.get("content-type")).toContain("text/css");
    expect((await fetch(`${base}/app/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/app/nested/`)).status).toBe(200);
  });

  test("path traversal cannot leave the app directory (literal, encoded and double-encoded)", async () => {
    const { port } = start();
    const paths = [
      "/app/../../etc/passwd",
      "/app/..%2f..%2fetc/passwd",
      "/app/%2e%2e/%2e%2e/etc/passwd",
      "/app/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/app/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
      "/app/..%5c..%5cetc%5cpasswd",
      "/app/%252e%252e/%252e%252e/etc/passwd",
      "/app/nested/../../../etc/passwd",
      "/app//etc/passwd",
      "/app/%00",
      "/app/main.js%00.png",
      "/app/../package.json",
      "/app/..%2fpackage.json",
    ];
    for (const path of paths) {
      const r = await raw(port, path, {});
      expect(`${path} ${r.status}`).toMatch(/ 404$/);
      expect(r.body).not.toContain("root:");
      expect(r.body).not.toContain(TOKEN);
    }
  });

  test("only GET and HEAD reach the app", async () => {
    const { base } = start();
    expect((await fetch(`${base}/app/`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/app/`, { method: "HEAD" })).status).toBe(200);
  });

  test("a symlink out of the app directory is not followed", async () => {
    const dir = fixtureApp();
    const outside = scratchDir("afterclass-outside-");
    writeFileSync(join(outside, "secret.txt"), "root:x:0:0");
    symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
    const { base } = start(dir);
    const r = await fetch(`${base}/app/leak.txt`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("root:");
  });

  test("serves the real bundle: index.html carries the token and its script is served", async () => {
    const out = scratchDir("afterclass-bundle-");
    await buildApp(out);
    const { base } = start(out);
    const html = await (await fetch(`${base}/app/capture/${CAP}`)).text();
    expect(html).toContain(`<meta name="afterclass-token" content="${TOKEN}"`);
    const src = html.match(/<script[^>]*src="(\/app\/[^"]+\.js)"/)?.[1];
    expect(src).toBeDefined();
    const js = await fetch(`${base}${src}`);
    expect(js.status).toBe(200);
    expect(await js.text()).not.toContain(TOKEN);
  }, 60_000);
});

// ───────────────────────────── M4: ingest ─────────────────────────────

const VIDEO = "dQw4w9WgXcQ";
const JSON_HEADERS = { ...bearer, "Content-Type": "application/json" };

/** A wire fact stream with consecutive clientSeqs from `from`: start, source, then one watched span per further seq. */
function wireFacts(from: number, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => {
    const clientSeq = from + i;
    const wallMs = 1000 + clientSeq;
    if (clientSeq === 0) return { kind: "control", action: "start", reason: "user", clientSeq, wallMs };
    if (clientSeq === 1) return { kind: "source", videoId: VIDEO, title: "Lecture", channelName: "Prof", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", durationS: 6000, clientSeq, wallMs };
    const start = (clientSeq - 2) * 5;
    return { kind: "span", videoId: VIDEO, start, end: start + 5, rate: 1, tabVisible: true, wallDurationMs: 5000, clientSeq, wallMs };
  });
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

const ingest = (base: string, facts: unknown[], captureId: string = CAP) => post(base, "/ingest", { captureId, facts });

type Ack = { ackedThroughSeq: number; invite: InviteState; capture: { captureId: string; watchedSeconds: number }; reviewAppUrl: string };
const ackOf = async (r: Response) => (await r.json()) as Ack;

describe("POST /ingest", () => {
  test("stores a fact stream and acks through its last contiguous seq, in the route's schema", async () => {
    const { base, invite, stored } = start();
    invite.state = { state: "invited", atChunk: stableId("crv", "c1") };
    const r = await ingest(base, wireFacts(0, 6));
    expect(r.status).toBe(200);
    const ack = ingestAckResponse.parse(await r.json());
    expect(ack).toMatchObject({ ackedThroughSeq: 5, invite: { state: "invited" }, capture: { captureId: CAP, status: { state: "capturing" }, watchedSeconds: 20 } });
    expect(ack.reviewAppUrl).toBe(`${base}/app/capture/${CAP}`);
    expect(stored()).toBe(6);
  });

  test('R15: "Retrying a save never creates a duplicate record." A resent batch changes nothing', async () => {
    const { base, evidence, stored } = start();
    const facts = wireFacts(0, 8);
    const first = await ackOf(await ingest(base, facts));
    const bundle = evidence.captureBundle(CAP);
    expect(stored()).toBe(8);
    expect(await ackOf(await ingest(base, facts))).toEqual(first);
    expect(stored()).toBe(8);
    expect(evidence.captureBundle(CAP)).toEqual(bundle);
    // a partly overlapping resend stores only the new facts
    const overlapping = await ackOf(await ingest(base, wireFacts(4, 6)));
    expect(overlapping).toMatchObject({ ackedThroughSeq: 9, capture: { watchedSeconds: 40 } });
    expect(stored()).toBe(10);
  });

  test("an empty facts array is a heartbeat: ack -1 before anything arrives, then unchanged", async () => {
    const { base, stored } = start();
    const hb = await ingest(base, []);
    expect(hb.status).toBe(200);
    expect(await hb.json()).toMatchObject({ ackedThroughSeq: -1, invite: { state: "none" }, capture: { captureId: CAP, watchedSeconds: 0 } });
    expect(stored()).toBe(0);
    await ingest(base, wireFacts(0, 3));
    expect((await ackOf(await ingest(base, []))).ackedThroughSeq).toBe(2);
    expect(stored()).toBe(3);
  });

  test("ack is -1 when seq 0 has not arrived, and stalls at a gap until the gap is filled", async () => {
    const { base, stored } = start();
    expect((await ackOf(await ingest(base, wireFacts(1, 3)))).ackedThroughSeq).toBe(-1);
    expect((await ackOf(await ingest(base, wireFacts(0, 1)))).ackedThroughSeq).toBe(3);
    // 4 and 5 are missing; 6 and 7 arrive anyway, are stored, and are not acked past the gap
    expect((await ackOf(await ingest(base, wireFacts(6, 2)))).ackedThroughSeq).toBe(3);
    expect(stored()).toBe(6);
    expect((await ackOf(await ingest(base, wireFacts(4, 2)))).ackedThroughSeq).toBe(7);
  });

  test("a batch with a fact for another capture is 400 and stores nothing, not even its good facts", async () => {
    const { base, stored } = start();
    const facts = wireFacts(0, 4);
    facts[2] = { ...facts[2]!, captureId: stableId("cap", "someone-else") };
    const r = await ingest(base, facts);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("different capture");
    expect(stored()).toBe(0);
    // a per-fact captureId that matches the batch is fine
    expect((await ingest(base, wireFacts(0, 2).map((f) => ({ ...f, captureId: CAP })))).status).toBe(200);
    expect(stored()).toBe(2);
  });

  test("malformed bodies are 400 and store nothing: not JSON, bad capture id, bad fact, too many facts", async () => {
    const { base, stored } = start();
    expect((await post(base, "/ingest", "{nope")).status).toBe(400);
    expect((await ingest(base, wireFacts(0, 2), "cap_nope")).status).toBe(400);
    expect((await ingest(base, [...wireFacts(0, 2), { kind: "span", clientSeq: 2, wallMs: 1 }])).status).toBe(400);
    expect((await ingest(base, wireFacts(0, 501))).status).toBe(400);
    expect(stored()).toBe(0);
  });

  test("a body over the limit is 413 and stores nothing; the default holds a 500-fact batch with room to spare", async () => {
    const small = start(fixtureApp(), { maxBodyBytes: 4096 });
    const big = wireFacts(0, 200);
    expect(JSON.stringify({ captureId: CAP, facts: big }).length).toBeGreaterThan(4096);
    expect((await ingest(small.base, big)).status).toBe(413);
    expect(small.stored()).toBe(0);

    const { base, stored } = start();
    const batch = wireFacts(0, 500);
    expect(JSON.stringify({ captureId: CAP, facts: batch }).length).toBeLessThan(MAX_BODY_BYTES / 16);
    expect((await ingest(base, batch)).status).toBe(200);
    expect(stored()).toBe(500);
  });

  test("a bad or missing token is 401 and stores nothing; a page Origin is 403", async () => {
    const { base, stored } = start();
    const body = { captureId: CAP, facts: wireFacts(0, 2) };
    expect((await post(base, "/ingest", body, { "Content-Type": "application/json" })).status).toBe(401);
    expect((await post(base, "/ingest", body, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(base, "/ingest", body, { ...bearer, Origin: PAGE })).status).toBe(403);
    expect(stored()).toBe(0);
  });

  test("ingest latency for a 500-fact batch (logged, not asserted)", async () => {
    const { base } = start();
    const times: number[] = [];
    for (let run = 0; run < 10; run++) {
      const t0 = performance.now();
      const r = await ingest(base, wireFacts(0, 500), stableId("cap", `lat-${run}`));
      times.push(performance.now() - t0);
      expect(r.status).toBe(200);
    }
    times.sort((a, b) => a - b);
    console.log(`ingest 500 facts: median ${times[5]!.toFixed(1)} ms, max ${times[9]!.toFixed(1)} ms`);
  });
});

describe("GET /captures/:id and the invite answer", () => {
  test("GET /captures/:id answers capture and invite in the route's schema, empty for a capture with no facts", async () => {
    const { base } = start();
    const empty = await fetch(`${base}/captures/${CAP}`, { headers: bearer });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ capture: { captureId: CAP, sources: [], watchedSeconds: 0 }, invite: { state: "none" } });
    await ingest(base, wireFacts(0, 4));
    const body = captureResponse.parse(await (await fetch(`${base}/captures/${CAP}`, { headers: bearer })).json());
    expect(body).toMatchObject({ capture: { watchedSeconds: 10, sources: [{ videoId: VIDEO }] } });
    expect((await fetch(`${base}/captures/${CAP}`)).status).toBe(401);
  });

  test("POST /captures/:id/invite answers the new InviteState and rejects an answer that is not one", async () => {
    const { base, invite } = start();
    const r = await post(base, `/captures/${CAP}/invite`, { answer: "later" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ state: "later" });
    expect(invite.answers).toEqual(["later"]);
    expect((await post(base, `/captures/${CAP}/invite`, { answer: "maybe" })).status).toBe(400);
    expect((await post(base, `/captures/${CAP}/invite`, "{")).status).toBe(400);
    expect((await post(base, "/captures/not-an-id/invite", { answer: "later" })).status).toBe(400);
    expect(invite.answers).toEqual(["later"]);
  });
});
