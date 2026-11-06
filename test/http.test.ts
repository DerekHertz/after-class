/**
 * M3: the HTTP shell. Auth (Host, Origin, token), the routes M3 mounts, and the bundled review app.
 * M4: ingest, capture view, invite answer. M7a: the review routes, over the real review and record modules on an
 * in-memory db with a fake preparation world and a scripted tutor task.
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
import type { Db } from "../src/backend/db";
import { asSeq } from "../src/backend/db";
import type { Preparation } from "../src/backend/preparation";
import { createMemo } from "../src/backend/providers/memo";
import type { Task } from "../src/backend/providers/memo";
import { createLedger } from "../src/backend/providers/ledger";
import { createRecord } from "../src/backend/record";
import { createReviews } from "../src/backend/review";
import type { Reviews } from "../src/backend/review";
import { nextThreadId } from "../src/backend/review/tutor";
import type { TutorInput, TutorOutput } from "../src/backend/review/tutor";
import type { Segmentation } from "../src/backend/segmentation";
import type {
  AssessableClaim, ChunkPrep, ChunkRevision, Claim, ClaimStatus, EvidenceBundle, Gap, InviteAnswer, InviteState, LearnerAct, Passage, Seq,
  SubjectLinkSuggestion,
} from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, ChunkId, ChunkRevisionId, ClaimId, EvidenceId, IdPart, ReviewId, TurnId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import type { Interval } from "../src/shared/time";
import {
  ROUTES, captureResponse, encodeMaterial, lecturesResponse, evidenceBundleResponse, ingestAckResponse, recordViewResponse, reviewOptionsResponse, reviewViewResponse, saveResponse, startReviewResponse, tutorStreamEvent,
} from "../src/shared/wire";
import { fakeTask, ok, testDb } from "./fakes";
import type { FakeStep } from "./fakes";
import { raceAt } from "./interleave";

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

function evidenceOn(db: Db) {
  return createEvidence(db, scratchDir("afterclass-data-"), {
    lookupFrameChange: (input) => ({ kind: "missing", key: stableId("key", input.after.frame.id) }),
    runFrameChange: async () => undefined,
    frameChangeKey: (input) => stableId("key", input.after.frame.id),
    onChange: () => {},
  });
}

/** The real evidence module on an in-memory db; reviews is a fake whose invite state a test sets. */
function world() {
  const db = testDb();
  const evidence = evidenceOn(db);
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

  test("a route whose module is not wired is 501 after auth and id validation; bad ids are 400; unknown paths are 404", async () => {
    const { base } = start();
    expect((await fetch(`${base}/captures/${CAP}`)).status).toBe(401);
    expect((await fetch(`${base}/record`, { headers: bearer })).status).toBe(501);
    expect((await fetch(`${base}/record/notes/${stableId("note", "x")}`, { method: "DELETE", headers: bearer })).status).toBe(501);
    expect((await fetch(`${base}/captures/not-an-id`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${base}/reviews/${CAP}`, { headers: bearer })).status).toBe(400);
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

// ───────────────────────────── M7a: review routes ─────────────────────────────

const SRC = stableId("src", "youtube", "lecture");
const CONCEPT = stableId("cpt", "c");
const OTHER_CONCEPT = stableId("cpt", "other");
const LINK: SubjectLinkSuggestion = {
  id: stableId("lnk", CONCEPT, OTHER_CONCEPT, "part_of"), from: CONCEPT, to: OTHER_CONCEPT, type: "part_of", evidence: [], rationale: "c is part of other",
};

type WorldClaim = { text: string; evidence: EvidenceId[]; status: ClaimStatus; checkedAt?: Seq };

/** What preparation would answer for one capture, from plain data (the review module's own tests use the same shape). */
class World {
  readonly captureId: CaptureId = randomId("cap");
  chunks: ChunkRevision[] = [];
  claims = new Map<ClaimId, WorldClaim>();
  evidence = new Map<EvidenceId, Interval>();
  gaps: Gap[] = [];
  pendingChunks = new Set<ChunkRevisionId>();
  revisions: ChunkRevision[] = [];

  constructor(readonly db: Db) {}

  close(ordinal: number, start: number, end: number): ChunkRevision {
    const rev: ChunkRevision = {
      id: stableId("crv", ordinal, start, end),
      chunkId: stableId("chk", this.captureId, ordinal),
      captureId: this.captureId,
      ordinal,
      revisionNo: 1,
      material: Material.of([[SRC, [interval(start, end)]]]),
      windows: [],
      provenance: "boundary",
      closedAtSeq: this.db.nextSeq(),
      supersedes: null,
    };
    this.chunks = [...this.chunks, rev];
    this.revisions.push(rev);
    return rev;
  }

  claim(n: number, start: number, end: number, status: ClaimStatus = "supported_by_check"): ClaimId {
    const id = stableId("clm", "k", n);
    const ev = stableId("ev", "w", n);
    this.evidence.set(ev, interval(start, end));
    this.claims.set(id, { text: `claim ${n}`, evidence: [ev], status });
    return id;
  }

  /** A check result lands: new status, stamped with the check's seq. */
  check(id: ClaimId, status: ClaimStatus): void {
    const c = this.claims.get(id)!;
    c.status = status;
    c.checkedAt = this.db.nextSeq();
  }

  private inside(material: Material, ids: readonly EvidenceId[]): boolean {
    return ids.every((e) => Material.covers(material, SRC, this.evidence.get(e)!));
  }

  readonly deps = {
    currentChunks: (_: CaptureId): readonly ChunkRevision[] => this.chunks,
    chunkHistory: (chunkId: ChunkId): readonly ChunkRevision[] => this.revisions.filter((r) => r.chunkId === chunkId),
    prep: (id: ChunkRevisionId): ChunkPrep => {
      const rev = this.chunks.find((c) => c.id === id)!;
      const claims = [...this.claims].filter(([, c]) => this.inside(rev.material, c.evidence)).map(([cid, c]) => ({ id: cid, status: c.status }) as unknown as Claim);
      return {
        chunkRevisionId: id,
        interpretation: "done",
        claims,
        finished: !this.pendingChunks.has(id) && claims.every((c) => !c.status.startsWith("awaiting")),
        supportedCount: claims.filter((c) => c.status === "supported_by_check").length,
      };
    },
    stopEarly: (_: CaptureId, ids: readonly ChunkRevisionId[]) => {
      for (const id of ids) {
        this.pendingChunks.delete(id);
        const rev = this.chunks.find((c) => c.id === id)!;
        for (const c of this.claims.values()) if (c.status.startsWith("awaiting") && this.inside(rev.material, c.evidence)) c.status = "dropped";
      }
      return this.db.nextSeq();
    },
    assessableIn: (_: CaptureId, material: Material): readonly AssessableClaim[] =>
      [...this.claims]
        .filter(([, c]) => c.status === "supported_by_check" && this.inside(material, c.evidence))
        .map(([id, c]) => ({ id, conceptId: CONCEPT, text: c.text, evidence: c.evidence, assumptions: [] }) as unknown as AssessableClaim),
    claimsIn: (_: CaptureId, material: Material): readonly Claim[] =>
      [...this.claims]
        .filter(([, c]) => this.inside(material, c.evidence))
        .map(([id, c]): Claim => ({
          id,
          sourceChunkId: stableId("chk", this.captureId, 0),
          conceptId: CONCEPT,
          original: { text: c.text, evidence: [c.evidence[0]!, ...c.evidence.slice(1)], visualDependent: false, assumptions: [] },
          originalCheck: c.checkedAt
            ? { verdict: c.status === "supported_by_check" ? "yes" : "no", p: null, reason: "jev", memoKey: stableId("key", id), atSeq: c.checkedAt }
            : null,
          revision: null,
          revisionCheck: null,
          status: c.status,
        })),
    bundle: (material: Material): EvidenceBundle => ({
      material,
      passages: [...this.evidence]
        .filter(([, i]) => Material.covers(material, SRC, i))
        .map(([id, i]) => ({ kind: "passage", id, sourceId: SRC, interval: i, text: `passage ${id}` }) as unknown as Passage),
      frames: [],
      gaps: this.gaps.filter((g) => Material.get(material, g.sourceId).overlapFraction(g.interval) > 0),
      ads: [],
    }),
    watchedSeconds: (_: CaptureId) => this.chunks.reduce((s, c) => s + Material.duration(c.material), 0),
    runWrapUp: () => Promise.reject(new Error("the record owns wrap-up in these tests")),
    nextSeq: (): Seq => this.db.nextSeq(),
  };
}

type Script = (input: TutorInput, call: number) => TutorOutput | Promise<TutorOutput>;

/** A header line then prose, which the fake task streams in 9-character pieces so the header arrives split. A script that throws is a failed model call. */
function modelTask(script: Script) {
  return fakeTask<IdPart, TutorOutput>({
    purpose: "tutor_turn",
    provider: "claude",
    answer: async (input, call): Promise<FakeStep<TutorOutput>> => {
      try {
        const out = await script(input as unknown as TutorInput, call);
        return ok(out, { deltas: `${JSON.stringify(out.move)}\n${out.say}`.match(/[\s\S]{1,9}/g) ?? [] });
      } catch (e) {
        return { kind: "error", message: e instanceof Error ? e.message : String(e), retryable: false, usage: null };
      }
    },
  });
}

/** A tutor that always takes a legal move: disclose a pending correction, wrap up when it must, else ask, follow up, then close. */
function pick(input: TutorInput): TutorOutput {
  const a = input.allowed;
  const open = input.state.openThread;
  if (a.includes("disclose_correction")) {
    const c = input.state.corrections.find((x) => !x.disclosed)!;
    return { move: { kind: "disclose_correction", correctionId: c.id, threadIds: [], evidence: [] }, say: "One question rested on a claim that did not hold up." };
  }
  if (a.includes("wrap_up")) return { move: { kind: "wrap_up" }, say: "Let's wrap up here." };
  if (a.includes("ask_main")) {
    const claim = input.claims[0]!;
    return { move: { kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [claim.id] }, say: `In your own words, what is ${claim.text}? Take your time.` };
  }
  const followed = input.turns.some((t) => t.actor === "tutor" && t.move.kind === "ask_followup" && t.move.threadId === open);
  return followed
    ? { move: { kind: "close_thread", threadId: open! }, say: "Good. Let's leave that there." }
    : { move: { kind: "ask_followup", threadId: open! }, say: "And why does that hold?" };
}

const count = (db: Db, sql: string) => db.sql.query<{ n: number }, []>(sql).get()!.n;
const learnerRows = (db: Db) => count(db, "SELECT COUNT(*) AS n FROM review_turns WHERE actor = 'learner'");
const tutorRows = (db: Db) => count(db, "SELECT COUNT(*) AS n FROM review_turns WHERE actor = 'tutor'");
const reviewRows = (db: Db) => count(db, "SELECT COUNT(*) AS n FROM reviews");

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!done()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const said = (words: string): LearnerAct => ({ kind: "answer", text: words, modality: "text" });

/**
 * The real review and record modules and the real HTTP server on one in-memory db. Preparation and segmentation are
 * answered from `world`; the tutor and wrap-up are scripted. `retries` records preparation.retry calls.
 */
function reviewRig(script: Script = pick, extra: { turnDeadlineMs?: number } = {}) {
  const db = testDb();
  const world = new World(db);
  const model = modelTask(script);
  const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
  const task: Task<TutorInput, TutorOutput> = {
    ...(model as unknown as Task<TutorInput, TutorOutput>),
    canonicalInput: (i) => ({ turns: i.turns.map((t) => t.id), repair: i.repairNote, claims: i.claims.map((c) => c.id) }),
  };
  const reviews = createReviews(db, {
    ...world.deps,
    runTutor: (input, streamTo, signal) => memo.run(task, input, { signal, streamTo }),
    clearFailures: memo.clearFailures,
  });
  const usable = (reviewId: ReviewId) => world.deps.assessableIn(world.captureId, reviews.view(reviewId).scope.material);
  const flags = { failSave: false };
  const snapshots: EvidenceId[][] = [];
  const record = createRecord(db, {
    links: () => [LINK],
    turns: (reviewId) => reviews.view(reviewId).turns,
    claims: usable,
    wrapUp: async (reviewId) => {
      const turns = reviews.view(reviewId).turns;
      const threads = turns.flatMap((t) => (t.actor === "tutor" && t.move.kind === "ask_main" ? [t.move.threadId] : []));
      return {
        observations: threads.map((threadId) => ({ threadId, proposed: "independent" as const, rationale: "explained it unaided" })),
        notes: [{ conceptId: CONCEPT, tutorSummary: "Covered the claims.", evidence: usable(reviewId).flatMap((c) => c.evidence) }],
      };
    },
    snapshotEvidenceInTx: (ids) => {
      if (flags.failSave) throw new Error("disk full");
      snapshots.push([...ids]);
    },
  });
  const retries: { captureId: CaptureId; ids: readonly ChunkRevisionId[] }[] = [];
  const preparation = {
    prep: world.deps.prep,
    retry: (captureId: CaptureId, ids: readonly ChunkRevisionId[]) => {
      retries.push({ captureId, ids });
      return db.nextSeq();
    },
  } as unknown as Preparation;
  const segmentation = { current: world.deps.currentChunks } as unknown as Segmentation;

  const evidence = evidenceOn(db);
  const server = serve({
    modules: { ledger: createLedger(db), evidence, reviews, record, preparation, segmentation },
    auth: { port: 0, extensionId: EXT_ID, token: TOKEN },
    appDir: fixtureApp(), ...extra,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const capture = world.captureId;

  /** One chunk [0, 300) holding claims A and B, both supported. */
  const prepare = () => ({ rev: world.close(0, 0, 300), a: world.claim(1, 10, 20), b: world.claim(2, 30, 40) });

  const startReview = async (reviewId: ReviewId = randomId("rvw"), choice = "prepared_only", captureId: CaptureId = capture) => {
    const r = await post(base, `/captures/${captureId}/reviews`, { reviewId, choice });
    return { reviewId, status: r.status, body: (await r.json()) as Record<string, any> };
  };

  /** POST a turn and read its whole NDJSON stream. */
  const turn = async (reviewId: ReviewId, act: LearnerAct, turnId: TurnId = randomId("turn")) => {
    const r = await post(base, `/reviews/${reviewId}/turns`, { turnId, act });
    const body = await r.text();
    const lines = body.split("\n");
    const events = body === "" ? [] : lines.slice(0, -1).map((l) => tutorStreamEvent.parse(JSON.parse(l)));
    return { turnId, status: r.status, type: r.headers.get("content-type"), body, lines, events };
  };

  const view = async (reviewId: ReviewId) => {
    const r = await fetch(`${base}/reviews/${reviewId}`, { headers: bearer });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  return { db, world, model, base, flags, retries, snapshots, evidence, capture, prepare, startReview, turn, view };
}

type Rig = ReturnType<typeof reviewRig>;
const moveOf = (events: readonly { type: string }[]) => (events.find((e) => e.type === "move") as { move: { kind: string } } | undefined)?.move.kind;
const startedIn = async (rig: Rig) => {
  rig.prepare();
  const s = await rig.startReview();
  expect(s.body.kind).toBe("started");
  return s.reviewId;
};

describe("GET /captures/:id/review-options", () => {
  test("answers nothing_to_review, processing and ready in the route's schema", async () => {
    const rig = reviewRig();
    const get = async () => reviewOptionsResponse.parse(await (await fetch(`${rig.base}/captures/${rig.capture}/review-options`, { headers: bearer })).json());
    expect(await get()).toMatchObject({ kind: "nothing_to_review", gaps: [] });

    const { rev } = rig.prepare();
    expect(await get()).toMatchObject({ kind: "ready", scope: { supportedClaims: 2 } });

    rig.world.pendingChunks.add(rev.id);
    expect(await get()).toMatchObject({ kind: "processing", pendingChunks: 1 });
    expect((await fetch(`${rig.base}/captures/${rig.capture}/review-options`)).status).toBe(401);
    expect((await fetch(`${rig.base}/captures/nope/review-options`, { headers: bearer })).status).toBe(400);
  });
});

describe("POST /captures/:id/reviews", () => {
  test("starts a review with the scope in the route's schema, Material as canonical rows", async () => {
    const rig = reviewRig();
    rig.prepare();
    const s = await rig.startReview();
    expect(s.status).toBe(200);
    expect(startReviewResponse.parse(s.body)).toMatchObject({ kind: "started", reviewId: s.reviewId });
    expect(s.body.scope.material).toEqual([[SRC, [[0, 300]]]]);
    expect(s.body.scope.claimsAtStart).toHaveLength(2);
    expect(reviewRows(rig.db)).toBe(1);
  });

  test('R15: "Retrying a save never creates a duplicate record." A resent start returns the stored scope and inserts nothing', async () => {
    const rig = reviewRig();
    rig.prepare();
    const first = await rig.startReview();
    rig.world.claim(3, 50, 60);
    const again = await rig.startReview(first.reviewId);
    expect(again.body).toEqual(first.body);
    expect(reviewRows(rig.db)).toBe(1);
    expect((await rig.startReview(first.reviewId, "prepared_only", randomId("cap"))).status).toBe(409);
    expect(reviewRows(rig.db)).toBe(1);
  });

  test('R10: "A review never starts with zero supported claims in scope." nothing_to_review carries gaps, unverified claims and rewatch, writes no review, and Retry reaches preparation', async () => {
    const rig = reviewRig();
    const rev = rig.world.close(0, 0, 300);
    const unverified = rig.world.claim(1, 10, 20, "unverified");
    rig.world.gaps.push({ sourceId: SRC, interval: interval(100, 130), channel: "transcript", reason: "no_transcript" });
    const s = await rig.startReview();
    expect(s.status).toBe(200);
    const body = startReviewResponse.parse(s.body);
    expect(body).toMatchObject({ kind: "nothing_to_review", gaps: [{ reason: "no_transcript" }], unverified: [{ id: unverified }] });
    if (body.kind === "nothing_to_review") expect(body.rewatch.length).toBeGreaterThan(0);
    expect(reviewRows(rig.db)).toBe(0);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM review_turns")).toBe(0);

    const retry = await post(rig.base, `/captures/${rig.capture}/retry-preparation`, {});
    expect(retry.status).toBe(204);
    expect(rig.retries).toEqual([{ captureId: rig.capture, ids: [rev.id] }]);
  });

  test("a stop-early start while a chunk is still preparing labels the review partial", async () => {
    const rig = reviewRig();
    rig.prepare();
    const slow = rig.world.close(1, 300, 600);
    rig.world.pendingChunks.add(slow.id);
    rig.world.claim(3, 400, 410, "awaiting_check");
    const s = await rig.startReview(randomId("rvw"), "stop_early");
    expect(startReviewResponse.parse(s.body)).toMatchObject({ kind: "started", scope: { partial: [{ kind: "stopped_early", droppedClaims: 1 }] } });
  });

  test("bad ids and bodies are 400 and a wrong token is 401; nothing is written", async () => {
    const rig = reviewRig();
    rig.prepare();
    const url = `/captures/${rig.capture}/reviews`;
    const good = { reviewId: randomId("rvw"), choice: "prepared_only" };
    expect((await post(rig.base, url, { ...good, reviewId: "rvw_nope" })).status).toBe(400);
    expect((await post(rig.base, url, { ...good, choice: "later" })).status).toBe(400);
    expect((await post(rig.base, url, { choice: "prepared_only" })).status).toBe(400);
    expect((await post(rig.base, url, "{")).status).toBe(400);
    expect((await post(rig.base, "/captures/nope/reviews", good)).status).toBe(400);
    expect((await post(rig.base, url, good, { "Content-Type": "application/json" })).status).toBe(401);
    expect((await post(rig.base, url, good, { Authorization: "Bearer nope" })).status).toBe(401);
    expect(reviewRows(rig.db)).toBe(0);
  });
});

describe("POST /reviews/:id/turns", () => {
  test("streams one JSON object per line: learner turn stored, prose, then the move, then turn_complete", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    const t = await rig.turn(reviewId, { kind: "resume" });
    expect(t.status).toBe(200);
    expect(t.type).toContain("application/x-ndjson");
    expect(t.body.endsWith("\n")).toBe(true);
    expect(t.lines.at(-1)).toBe("");
    for (const line of t.lines.slice(0, -1)) {
      expect(line).not.toBe("");
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const types = t.events.map((e) => e.type);
    expect(types[0]).toBe("learner_turn_stored");
    expect(types.at(-1)).toBe("turn_complete");
    expect(types.filter((x) => x === "turn_complete" || x === "turn_failed")).toHaveLength(1);
    expect(types.indexOf("sentence")).toBeGreaterThan(0);
    expect(types.indexOf("move")).toBeGreaterThan(types.lastIndexOf("sentence"));
    expect(moveOf(t.events)).toBe("ask_main");
    expect(t.events.filter((e) => e.type === "sentence").map((e) => (e as { text: string }).text)).toEqual([
      "In your own words, what is claim 1?",
      "Take your time.",
    ]);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test("a client that disconnects mid-stream does not corrupt the turn: it still commits once, and a resend replays it without the model", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rig = reviewRig(async (input) => {
      await gate;
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const turnId = randomId("turn");
    const ac = new AbortController();
    const res = await fetch(`${rig.base}/reviews/${reviewId}/turns`, {
      method: "POST", headers: JSON_HEADERS, signal: ac.signal, body: JSON.stringify({ turnId, act: { kind: "resume" } }),
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(tutorStreamEvent.parse(JSON.parse(new TextDecoder().decode(first.value).trim()))).toEqual({ type: "learner_turn_stored", turnId });
    ac.abort();
    await reader.read().catch(() => undefined);
    expect(tutorRows(rig.db)).toBe(0);

    release();
    await until(() => tutorRows(rig.db) === 1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(rig.model.calls).toHaveLength(1);

    const resent = await rig.turn(reviewId, { kind: "resume" }, turnId);
    expect(resent.events[0]).toEqual({ type: "learner_turn_stored", turnId });
    expect(resent.events.at(-1)?.type).toBe("turn_complete");
    expect(moveOf(resent.events)).toBe("ask_main");
    expect(rig.model.calls).toHaveLength(1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test('R15: a resent turn that already completed replays the stored reply and neither inserts nor calls the model', async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    const first = await rig.turn(reviewId, { kind: "resume" });
    const again = await rig.turn(reviewId, { kind: "resume" }, first.turnId);
    expect(again.events.at(-1)).toEqual(first.events.at(-1));
    expect(moveOf(again.events)).toBe(moveOf(first.events));
    expect(rig.model.calls).toHaveLength(1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test('R15: a resent turn racing its original asks the model once and stores one learner and one tutor turn', async () => {
    let hook: () => void = () => {};
    const rig = reviewRig((input) => {
      hook();
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const turnId = randomId("turn");
    const { first, second } = await raceAt(
      "model-called",
      (il) => {
        hook = () => il.at("model-called");
        return rig.turn(reviewId, { kind: "resume" }, turnId);
      },
      () => rig.turn(reviewId, { kind: "resume" }, turnId),
    );
    for (const t of [first, second]) {
      expect(t.events[0]).toEqual({ type: "learner_turn_stored", turnId });
      expect(t.events.at(-1)?.type).toBe("turn_complete");
      expect(moveOf(t.events)).toBe("ask_main");
    }
    expect(rig.model.calls).toHaveLength(1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test('R3: "A claim can be used to judge my answers only if it passed the evidence check." A claim that loses its check while the tutor talks is not the question that is stored', async () => {
    let hook: () => void = () => {};
    const rig = reviewRig((input) => {
      hook();
      return pick(input);
    });
    const { a } = rig.prepare();
    const started = await rig.startReview();
    const { first } = await raceAt(
      "model-called",
      (il) => {
        hook = () => il.at("model-called");
        return rig.turn(started.reviewId, { kind: "resume" });
      },
      () => rig.world.check(a, "unverified"),
    );
    expect(first.events.at(-1)?.type).toBe("turn_complete");
    expect(moveOf(first.events)).toBe("disclose_correction");
    expect(rig.model.calls).toHaveLength(2);

    const { body } = await rig.view(started.reviewId);
    const turns = body.turns as { actor: string; move?: { kind: string; claimIds?: string[] }; notice?: { kind: string } }[];
    const tutors = turns.filter((t) => t.actor === "tutor");
    expect(tutors.map((t) => t.move?.kind)).toEqual(["disclose_correction"]);
    expect(tutors.some((t) => t.move?.claimIds?.includes(a))).toBe(false);
    expect(turns.some((t) => t.actor === "code" && t.notice?.kind === "correction_pending")).toBe(true);
  });

  test("one turn at a time per review: a second turn post with a different turnId while one runs is 409 and stores nothing; the same turnId still replays", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rig = reviewRig(async (input, call) => {
      if (call === 1) await gate;
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const second = await rig.startReview(randomId("rvw"), "prepared_only", randomId("cap"));
    const other = second.reviewId;
    const turnId = randomId("turn");
    const running = await post(rig.base, `/reviews/${reviewId}/turns`, { turnId, act: { kind: "resume" } });
    await until(() => rig.model.calls.length === 1);

    const refused = await post(rig.base, `/reviews/${reviewId}/turns`, { turnId: randomId("turn"), act: said("too soon") });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: expect.any(String) });
    expect(learnerRows(rig.db)).toBe(1);
    expect(rig.model.calls).toHaveLength(1);

    // another review is not held up
    const elsewhere = await rig.turn(other, { kind: "resume" });

    expect(elsewhere.events.at(-1)?.type).toBe("turn_complete");

    const joined = post(rig.base, `/reviews/${reviewId}/turns`, { turnId, act: { kind: "resume" } });
    release();
    for (const r of [running, await joined]) {
      const events = (await r.text()).trim().split("\n").map((l) => tutorStreamEvent.parse(JSON.parse(l)));
      expect(events.at(-1)?.type).toBe("turn_complete");
    }
    expect(learnerRows(rig.db)).toBe(2);
    expect(rig.model.calls).toHaveLength(2);

    const next = await rig.turn(reviewId, said("lines meeting at a point"));
    expect(next.status).toBe(200);
    expect(next.events.at(-1)?.type).toBe("turn_complete");
  });

  test("a turn stream that outlives the server's deadline ends with turn_failed retryable; the turn goes on, holds the review until it ends, and a resend replays it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rig = reviewRig(async (input) => {
      await gate;
      return pick(input);
    }, { turnDeadlineMs: 60 });
    const reviewId = await startedIn(rig);
    const turnId = randomId("turn");
    const t0 = Date.now();
    const late = await rig.turn(reviewId, { kind: "resume" }, turnId);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    expect(late.events.map((e) => e.type)).toEqual(["learner_turn_stored", "turn_failed"]);
    expect(late.events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    expect(tutorRows(rig.db)).toBe(0);

    expect((await post(rig.base, `/reviews/${reviewId}/turns`, { turnId: randomId("turn"), act: said("meanwhile") })).status).toBe(409);

    release();
    await until(() => tutorRows(rig.db) === 1);
    let resent = await rig.turn(reviewId, { kind: "resume" }, turnId);
    for (let i = 0; i < 100 && resent.status === 409; i++) {
      await Bun.sleep(10);
      resent = await rig.turn(reviewId, { kind: "resume" }, turnId);
    }
    expect(resent.events.at(-1)?.type).toBe("turn_complete");
    expect(moveOf(resent.events)).toBe("ask_main");
    expect(rig.model.calls).toHaveLength(1);
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test("a turn that fails frees the review for the next post", async () => {
    let fail = true;
    const rig = reviewRig((input) => {
      if (fail) throw new Error("model down");
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const failed = await rig.turn(reviewId, { kind: "resume" });
    expect(failed.events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    fail = false;
    const next = await rig.turn(reviewId, { kind: "resume" });
    expect(next.status).toBe(200);
    expect(next.events.at(-1)?.type).toBe("turn_complete");
  });

  test("a failed model call reports turn_failed with retryable, keeps the learner's turn, and a resend finishes it", async () => {
    let down = true;
    const rig = reviewRig((input) => {
      if (down) throw new Error("model down");
      return pick(input);
    });
    const reviewId = await startedIn(rig);
    const failed = await rig.turn(reviewId, { kind: "resume" });
    expect(failed.events.map((e) => e.type)).toEqual(["learner_turn_stored", "turn_failed"]);
    expect(failed.events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(0);

    down = false;
    const resent = await rig.turn(reviewId, { kind: "resume" }, failed.turnId);
    expect(resent.events.at(-1)?.type).toBe("turn_complete");
    expect(learnerRows(rig.db)).toBe(1);
    expect(tutorRows(rig.db)).toBe(1);
  });

  test("an unknown review is 404 and stores nothing; bad ids and bodies are 400; a wrong token is 401", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    const turnId = randomId("turn");
    const url = `/reviews/${reviewId}/turns`;
    expect((await post(rig.base, `/reviews/${randomId("rvw")}/turns`, { turnId, act: { kind: "resume" } })).status).toBe(404);
    expect((await post(rig.base, "/reviews/nope/turns", { turnId, act: { kind: "resume" } })).status).toBe(400);
    expect((await post(rig.base, url, { turnId: "turn_nope", act: { kind: "resume" } })).status).toBe(400);
    expect((await post(rig.base, url, { turnId, act: { kind: "juggle" } })).status).toBe(400);
    expect((await post(rig.base, url, { turnId, act: { kind: "answer", text: "   ", modality: "text" } })).status).toBe(400);
    expect((await post(rig.base, url, { act: { kind: "resume" } })).status).toBe(400);
    expect((await post(rig.base, url, "{")).status).toBe(400);
    expect((await post(rig.base, url, { turnId, act: { kind: "resume" } }, { "Content-Type": "application/json" })).status).toBe(401);
    expect(learnerRows(rig.db)).toBe(0);
    expect(rig.model.calls).toHaveLength(0);
  });
});

describe("GET /reviews/:id, POST /reviews/:id/save and the replay review", () => {
  test("a review through HTTP: start, five streamed turns, wrap up, save; the view carries turns, the ended state, saved and the observations", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    const acts: LearnerAct[] = [{ kind: "resume" }, said("lines meeting at a point"), said("because both equations hold there"), { kind: "skip" }, { kind: "wrap_up" }];
    const moves: (string | undefined)[] = [];
    for (const act of acts) {
      const t = await rig.turn(reviewId, act);
      expect(t.events.at(-1)?.type).toBe("turn_complete");
      moves.push(moveOf(t.events));
    }
    expect(moves).toEqual(["ask_main", "ask_followup", "close_thread", "ask_main", "wrap_up"]);
    expect(rig.model.calls).toHaveLength(5);

    const before = await rig.view(reviewId);
    expect(before.status).toBe(200);
    reviewViewResponse.parse(before.body);
    expect(before.body).toMatchObject({ reviewId, captureId: rig.capture, saved: "unsaved", observations: [], state: { phase: "ended", mainQuestions: 2 } });
    expect(before.body.scope.material).toEqual([[SRC, [[0, 300]]]]);
    expect(before.body.turns.filter((t: { actor: string }) => t.actor === "learner")).toHaveLength(5);
    expect(before.body.turns.filter((t: { actor: string }) => t.actor === "tutor")).toHaveLength(5);

    const save = await post(rig.base, `/reviews/${reviewId}/save`, {});
    expect(save.status).toBe(200);
    expect(saveResponse.parse(await save.json())).toMatchObject({ kind: "saved", observations: 2 });

    const after = await rig.view(reviewId);
    reviewViewResponse.parse(after.body);
    expect(after.body.saved).toBe("saved");
    expect(after.body.observations).toHaveLength(2);
    const status = (thread: string) => after.body.observations.find((o: { threadId: string }) => o.threadId === thread).status;
    expect(status(nextThreadId({ reviewId, mainQuestions: 0 }))).toBe("independent");
    expect(status(nextThreadId({ reviewId, mainQuestions: 1 }))).not.toBe("independent");

    const resaved = await post(rig.base, `/reviews/${reviewId}/save`, {});
    expect(await resaved.json()).toEqual({ kind: "saved", notes: 1, observations: 2, links: 1 });
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM observations")).toBe(2);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM notes")).toBe(1);
  });

  test("GET /reviews/:id of an unknown review is 404, of a bad id 400, without the token 401", async () => {
    const rig = reviewRig();
    expect((await rig.view(randomId("rvw"))).status).toBe(404);
    expect((await fetch(`${rig.base}/reviews/nope`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${rig.base}/reviews/${randomId("rvw")}`)).status).toBe(401);
  });

  test("POST /reviews/:id/save: unknown review 404, wrong token 401, a failed save reads save_pending and a retry saves once", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    await rig.turn(reviewId, { kind: "resume" });
    await rig.turn(reviewId, { kind: "end" });
    expect((await post(rig.base, `/reviews/${randomId("rvw")}/save`, {})).status).toBe(404);
    expect((await post(rig.base, `/reviews/${reviewId}/save`, {}, { "Content-Type": "application/json" })).status).toBe(401);

    rig.flags.failSave = true;
    const failed = await post(rig.base, `/reviews/${reviewId}/save`, {});
    expect(failed.status).toBe(200);
    expect(saveResponse.parse(await failed.json())).toMatchObject({ kind: "save_failed", retryable: true });
    expect((await rig.view(reviewId)).body.saved).toBe("save_pending");
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM saved_reviews")).toBe(0);

    rig.flags.failSave = false;
    expect(saveResponse.parse(await (await post(rig.base, `/reviews/${reviewId}/save`, {})).json()).kind).toBe("saved");
    expect((await rig.view(reviewId)).body.saved).toBe("saved");
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM saved_reviews")).toBe(1);
  });
});

/** Review `reviewId` through to a saved record: two threads, one note, one link. */
async function savedRig() {
  const rig = reviewRig();
  const reviewId = await startedIn(rig);
  for (const act of [{ kind: "resume" }, said("lines meeting at a point"), said("because both equations hold there"), { kind: "skip" }, { kind: "wrap_up" }] as LearnerAct[]) await rig.turn(reviewId, act);
  expect(saveResponse.parse(await (await post(rig.base, `/reviews/${reviewId}/save`, {})).json()).kind).toBe("saved");
  const get = async (path: string) => {
    const r = await fetch(`${rig.base}${path}`, { headers: bearer });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const record = async (query = `?reviewId=${reviewId}`) => {
    const r = await get(`/record${query}`);
    expect(r.status).toBe(200);
    return recordViewResponse.parse(r.body);
  };
  return { ...rig, reviewId, get, record };
}

const send = (base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });

describe("the record routes", () => {
  test("GET /record answers the notes, observations and links of a review in the route's schema, filtered by reviewId", async () => {
    const rig = await savedRig();
    const mine = await rig.record();
    expect(mine.notes).toHaveLength(1);
    expect(mine.observations).toHaveLength(2);
    expect(mine.links).toEqual([{ ...LINK, evidence: [...LINK.evidence], decision: "suggested" }]);
    expect((await rig.record("")).notes).toHaveLength(1);
    expect((await rig.record(`?reviewId=${randomId("rvw")}`)).notes).toEqual([]);
  });

  test("GET /record: a bad reviewId or an unknown query key is 400, a wrong token 401, a page Origin 403", async () => {
    const rig = await savedRig();
    expect((await rig.get("/record?reviewId=nope")).status).toBe(400);
    expect((await rig.get(`/record?conceptId=${CONCEPT}`)).status).toBe(400);
    expect((await fetch(`${rig.base}/record`)).status).toBe(401);
    expect((await fetch(`${rig.base}/record`, { headers: { ...bearer, Origin: PAGE } })).status).toBe(403);
  });

  test("PATCH /record/notes/:id stores the learner's wording beside the generated text and answers 204", async () => {
    const rig = await savedRig();
    const note = (await rig.record()).notes[0]!;
    const r = await send(rig.base, "PATCH", `/record/notes/${note.id}`, { text: "my own wording" });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    const after = (await rig.record()).notes[0]!;
    expect(after.userEdit).toBe("my own wording");
    expect(after.generated).toEqual(note.generated);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM notes")).toBe(1);
  });

  test('R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes." Saving again keeps the edit', async () => {
    const rig = await savedRig();
    const note = (await rig.record()).notes[0]!;
    await send(rig.base, "PATCH", `/record/notes/${note.id}`, { text: "mine" });
    await post(rig.base, `/reviews/${rig.reviewId}/save`, {});
    expect((await rig.record()).notes[0]!.userEdit).toBe("mine");
  });

  test("DELETE /record/notes/:id removes the note from the view and a later save does not bring it back; answers 204", async () => {
    const rig = await savedRig();
    const note = (await rig.record()).notes[0]!;
    const r = await send(rig.base, "DELETE", `/record/notes/${note.id}`);
    expect(r.status).toBe(204);
    expect((await rig.record()).notes).toEqual([]);
    const again = saveResponse.parse(await (await post(rig.base, `/reviews/${rig.reviewId}/save`, {})).json());
    expect(again).toMatchObject({ kind: "saved", notes: 1 }); // the first save's result; the tombstone hides the note
    expect((await rig.record()).notes).toEqual([]);
  });

  test('R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry." A deleted note\'s evidence is not snapshotted again by a re-save', async () => {
    const rig = await savedRig();
    const note = (await rig.record()).notes[0]!;
    expect(note.evidence.length).toBeGreaterThan(0);
    expect(rig.snapshots.at(-1)).toEqual([...note.evidence].sort());
    await send(rig.base, "DELETE", `/record/notes/${note.id}`);
    const snapshotted = rig.snapshots.length;
    await post(rig.base, `/reviews/${rig.reviewId}/save`, {});
    expect(rig.snapshots).toHaveLength(snapshotted);
  });

  test("POST /record/links/:id accepts, rejects or corrects a suggestion; an unknown decision is 400", async () => {
    const rig = await savedRig();
    const decide = (decision: unknown) => send(rig.base, "POST", `/record/links/${LINK.id}`, { decision });
    const decision = async () => (await rig.record()).links[0]!.decision;
    expect((await decide("accepted")).status).toBe(204);
    expect(await decision()).toBe("accepted");
    expect((await decide({ corrected: "prerequisite_of" })).status).toBe(204);
    expect(await decision()).toEqual({ corrected: "prerequisite_of" });
    expect((await decide("rejected")).status).toBe(204);
    expect(await decision()).toBe("rejected");
    expect((await decide("maybe")).status).toBe(400);
    expect((await decide({ corrected: "friends_with" })).status).toBe(400);
    expect(await decision()).toBe("rejected");
  });

  test("POST /record/observations/:id/override sets the status and still passes through the clamp; a status that is not one is 400", async () => {
    const rig = await savedRig();
    const skipped = (await rig.record()).observations.find((o) => o.facts.firstSubstantiveAnswerSeq === null)!;
    expect(skipped.status).not.toBe("independent");
    const r = await send(rig.base, "POST", `/record/observations/${skipped.id}/override`, { status: "independent" });
    expect(r.status).toBe(204);
    const after = (await rig.record()).observations.find((o) => o.id === skipped.id)!;
    expect(after.status).not.toBe("independent");
    expect(after.clampedFrom).toBe("independent");
    expect((await send(rig.base, "POST", `/record/observations/${skipped.id}/override`, { status: "disputed" })).status).toBe(400);
  });

  test('R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way." Resolving an observation nobody disputed changes nothing', async () => {
    const rig = await savedRig();
    const obs = (await rig.record()).observations[0]!;
    const r = await send(rig.base, "POST", `/record/observations/${obs.id}/dispute-resolution`, { outcome: "it_was_my_gap" });
    expect(r.status).toBe(204);
    const after = (await rig.record()).observations.find((o) => o.id === obs.id)!;
    expect(after.dispute).toEqual({ kind: "none" });
    expect(after.status).toBe(obs.status);
    expect((await send(rig.base, "POST", `/record/observations/${obs.id}/dispute-resolution`, { outcome: "whatever" })).status).toBe(400);
  });

  test("R14: a dispute the learner raised is settled only by their resolution", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    await rig.turn(reviewId, { kind: "resume" });
    await rig.turn(reviewId, said("a wrong answer"));
    await rig.turn(reviewId, { kind: "dispute", text: "I think my answer was fine" });
    await rig.turn(reviewId, { kind: "end" });
    await post(rig.base, `/reviews/${reviewId}/save`, {});
    const record = async () => recordViewResponse.parse(await (await fetch(`${rig.base}/record?reviewId=${reviewId}`, { headers: bearer })).json());
    const disputed = (await record()).observations.find((o) => o.dispute.kind !== "none");
    expect(disputed).toBeDefined();
    expect(disputed!.dispute.kind).not.toBe("resolved_by_learner");
    expect(disputed!.status).toBe("disputed");
    const r = await send(rig.base, "POST", `/record/observations/${disputed!.id}/dispute-resolution`, { outcome: "learner_was_right" });
    expect(r.status).toBe(204);
    const after = (await record()).observations.find((o) => o.id === disputed!.id)!;
    expect(after.dispute).toEqual({ kind: "resolved_by_learner", outcome: "learner_was_right" });
    expect(after.status).not.toBe("disputed");
  });

  test("an unknown note, link or observation is 404 and writes nothing; a bad id is 400; a bad body is 400; a wrong token is 401", async () => {
    const rig = await savedRig();
    const note = stableId("note", "nobody");
    const obs = stableId("obs", "nobody");
    const lnk = stableId("lnk", "nobody");
    const rows = () => count(rig.db, "SELECT (SELECT COUNT(*) FROM note_edits) + (SELECT COUNT(*) FROM note_deletions) + (SELECT COUNT(*) FROM observation_decisions) + (SELECT COUNT(*) FROM link_decisions) AS n");
    expect((await send(rig.base, "PATCH", `/record/notes/${note}`, { text: "x" })).status).toBe(404);
    expect((await send(rig.base, "DELETE", `/record/notes/${note}`)).status).toBe(404);
    expect((await send(rig.base, "POST", `/record/links/${lnk}`, { decision: "accepted" })).status).toBe(404);
    expect((await send(rig.base, "POST", `/record/observations/${obs}/override`, { status: "partial" })).status).toBe(404);
    expect((await send(rig.base, "POST", `/record/observations/${obs}/dispute-resolution`, { outcome: "it_was_my_gap" })).status).toBe(404);
    expect(rows()).toBe(0);

    const real = (await rig.record()).notes[0]!.id;
    expect((await send(rig.base, "PATCH", "/record/notes/nope", { text: "x" })).status).toBe(400);
    expect((await send(rig.base, "DELETE", `/record/notes/${CAP}`)).status).toBe(400);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, "not json")).status).toBe(400);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, { text: 7 })).status).toBe(400);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, { text: "x".repeat(20_001) })).status).toBe(400);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, { text: "x" }, { "Content-Type": "application/json" })).status).toBe(401);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, { text: "x" }, { ...JSON_HEADERS, Origin: PAGE })).status).toBe(403);
    expect(rows()).toBe(0);
  });
});

describe("the evidence routes", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const FRAME_FACT = { kind: "frame", videoId: VIDEO, frameId: "f1", mediaS: 5, width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: JPEG.toString("base64") };
  const TRANSCRIPT = {
    kind: "transcript", videoId: VIDEO, origin: "panel", language: "en", autoGenerated: false,
    segments: [{ start: 0, end: 4, text: "watched words" }, { start: 30, end: 34, text: "never watched" }],
  };

  /** One capture: a watched span [0, 5), a transcript with one segment inside it and one outside, and a frame at 3 s. */
  async function captured() {
    const w = start();
    const facts = [
      ...wireFacts(0, 3),
      { ...TRANSCRIPT, clientSeq: 3, wallMs: 1100 },
      { ...FRAME_FACT, mediaS: 3, clientSeq: 4, wallMs: 1200 },
    ];
    expect((await ingest(w.base, facts)).status).toBe(200);
    const get = async (path: string) => {
      const r = await fetch(`${w.base}${path}`, { headers: bearer });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    const bundle = await get(`/evidence?captureId=${CAP}`);
    const parsed = evidenceBundleResponse.parse(bundle.body);
    return { ...w, get, bundle, parsed, passage: parsed.passages[0]!, frame: parsed.frames[0]! };
  }

  test('R1: "Evidence only comes from intervals I actually watched while capture was on." GET /evidence?captureId= answers the watched passages and frames only', async () => {
    const c = await captured();
    expect(c.bundle.status).toBe(200);
    expect(c.parsed.passages.map((p) => p.text)).toEqual(["watched words"]);
    expect(c.parsed.frames).toHaveLength(1);
    expect(c.bundle.body.material).toEqual([[expect.any(String), [[0, 5]]]]);
  });

  test("GET /evidence?ids= answers the passages and frames asked for, and leaves out ids it does not know", async () => {
    const c = await captured();
    const r = await c.get(`/evidence?ids=${c.passage.id},${c.frame.id},${stableId("ev", "unknown")}`);
    expect(r.status).toBe(200);
    const parsed = evidenceBundleResponse.parse(r.body);
    expect(parsed.passages.map((p) => p.id)).toEqual([c.passage.id]);
    expect(parsed.frames.map((f) => f.id)).toEqual([c.frame.id]);
  });

  test("GET /evidence?material= answers what lies inside the material; Material crosses as canonical rows", async () => {
    const c = await captured();
    const src = c.parsed.passages[0]!.sourceId;
    const ask = (m: Material) => c.get(`/evidence?material=${encodeURIComponent(encodeMaterial(m))}`);
    const inside = evidenceBundleResponse.parse((await ask(Material.of([[src, [interval(0, 5)]]]))).body);
    expect(inside.passages).toHaveLength(1);
    const outside = evidenceBundleResponse.parse((await ask(Material.of([[src, [interval(100, 110)]]]))).body);
    expect(outside.passages).toEqual([]);
    expect(outside.frames).toEqual([]);
  });

  test("a bad evidence query is 400: none or two of material, ids, captureId; a bad id; material that is not JSON; an unknown key; a wrong token is 401", async () => {
    const c = await captured();
    for (const q of ["", `?captureId=${CAP}&ids=${c.passage.id}`, "?ids=nope", `?ids=${CAP}`, "?ids=", "?material=not-json", "?material=%5B%5B%22x%22%5D%5D", "?captureId=nope", `?captureId=${CAP}&extra=1`]) {
      expect(`${q}: ${(await c.get(`/evidence${q}`)).status}`).toBe(`${q}: 400`);
    }
    expect((await fetch(`${c.base}/evidence?captureId=${CAP}`)).status).toBe(401);
    expect((await fetch(`${c.base}/evidence?captureId=${CAP}`, { headers: { ...bearer, Origin: PAGE } })).status).toBe(403);
  });

  test("GET /frames/:id answers the stored JPEG bytes; an unknown frame is 404, a bad id 400, a wrong token 401", async () => {
    const c = await captured();
    const r = await fetch(`${c.base}/frames/${c.frame.id}`, { headers: bearer });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(JPEG);
    expect((await fetch(`${c.base}/frames/${stableId("ev", "none")}`, { headers: bearer })).status).toBe(404);
    expect((await fetch(`${c.base}/frames/nope`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${c.base}/frames/${c.frame.id}`)).status).toBe(401);
  });

  test("POST /record/evidence/delete removes the evidence from every lookup and its frame image, and answers 204; deleting twice is the same", async () => {
    const c = await captured();
    const r = await post(c.base, "/record/evidence/delete", { evidenceIds: [c.passage.id, c.frame.id] });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(evidenceBundleResponse.parse((await c.get(`/evidence?captureId=${CAP}`)).body)).toMatchObject({ passages: [], frames: [] });
    expect(evidenceBundleResponse.parse((await c.get(`/evidence?ids=${c.passage.id}`)).body).passages).toEqual([]);
    expect((await fetch(`${c.base}/frames/${c.frame.id}`, { headers: bearer })).status).toBe(404);
    const tombstones = count(c.db, "SELECT COUNT(*) AS n FROM evidence_deletions");
    expect((await post(c.base, "/record/evidence/delete", { evidenceIds: [c.passage.id] })).status).toBe(204);
    expect(count(c.db, "SELECT COUNT(*) AS n FROM evidence_deletions")).toBe(tombstones);
  });

  test("evidence delete: an empty or bad id list, non-JSON and a wrong token write nothing", async () => {
    const c = await captured();
    for (const body of [{ evidenceIds: [] }, { evidenceIds: ["nope"] }, { evidenceIds: c.passage.id }, {}, "not json"]) {
      expect((await post(c.base, "/record/evidence/delete", body)).status).toBe(400);
    }
    expect((await post(c.base, "/record/evidence/delete", { evidenceIds: [c.passage.id] }, { "Content-Type": "application/json" })).status).toBe(401);
    expect(count(c.db, "SELECT COUNT(*) AS n FROM evidence_deletions")).toBe(0);
  });
});

describe("ReviewView.saved is the persisted save state", () => {
  test("it reads the record's tables, not this process's memory: a failure marker or a saved row from before a restart shows", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    expect((await rig.view(reviewId)).body.saved).toBe("unsaved");
    rig.db.sql.run("INSERT INTO save_failures (review_id, error, failed_ms) VALUES (?, 'earlier run', 0)", [reviewId]);
    expect((await rig.view(reviewId)).body.saved).toBe("save_pending");
    rig.db.sql.run("INSERT INTO saved_reviews (review_id, bundle_hash, saved_ms) VALUES (?, 'h', 0)", [reviewId]);
    const view = await rig.view(reviewId);
    reviewViewResponse.parse(view.body);
    expect(view.body.saved).toBe("saved");
  });
});

describe("POST /captures/:id/retry-preparation", () => {
  test("retries the chunks that are unfinished or have no supported claim, and none that are fine; answers 204", async () => {
    const rig = reviewRig();
    const fine = rig.world.close(0, 0, 300);
    rig.world.claim(1, 10, 20);
    const empty = rig.world.close(1, 300, 600);
    rig.world.claim(2, 400, 410, "unverified");
    const slow = rig.world.close(2, 600, 900);
    rig.world.pendingChunks.add(slow.id);
    const r = await post(rig.base, `/captures/${rig.capture}/retry-preparation`, {});
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(rig.retries).toEqual([{ captureId: rig.capture, ids: [empty.id, slow.id] }]);
    expect(rig.retries[0]!.ids).not.toContain(fine.id);
  });

  test("a bad capture id is 400, a wrong token 401, and with no preparation or record wired the M7a routes that need them are 501", async () => {
    const rig = reviewRig();
    expect((await post(rig.base, "/captures/nope/retry-preparation", {})).status).toBe(400);
    expect((await post(rig.base, `/captures/${rig.capture}/retry-preparation`, {}, { "Content-Type": "application/json" })).status).toBe(401);
    expect(rig.retries).toEqual([]);
    const bare = start();
    expect((await post(bare.base, `/captures/${CAP}/retry-preparation`, {})).status).toBe(501);
    expect((await post(bare.base, `/reviews/${stableId("rvw", "x")}/save`, {})).status).toBe(501);
  });
});

describe("capture and review are independent", () => {
  test('R9: "Starting a review doesn\'t stop capture, and stopping capture doesn\'t end a review." Facts keep arriving after a review starts, and a review goes on after capture stops', async () => {
    const rig = reviewRig();
    rig.prepare();
    expect((await ingest(rig.base, wireFacts(0, 4), rig.capture)).status).toBe(200);
    const started = await rig.startReview();
    expect(started.body.kind).toBe("started");
    const more = await ackOf(await ingest(rig.base, wireFacts(4, 3), rig.capture));
    expect(more).toMatchObject({ ackedThroughSeq: 6, capture: { status: { state: "capturing" } } });
    const stop = { kind: "control", action: "stop", reason: "user", clientSeq: 7, wallMs: 2000 };
    expect(await ackOf(await ingest(rig.base, [stop], rig.capture))).toMatchObject({ capture: { status: { state: "stopped" } } });
    expect((await rig.turn(started.reviewId, { kind: "resume" })).events.at(-1)?.type).toBe("turn_complete");
  });
});

describe("GET /lectures", () => {
  const OTHER = stableId("cap", "http-test-other");
  const get = async (base: string) => lecturesResponse.parse(await (await fetch(`${base}/lectures`, { headers: bearer })).json());

  test("needs the token and the loopback host, and is empty before anything is captured", async () => {
    const rig = reviewRig();
    expect((await fetch(`${rig.base}/lectures`)).status).toBe(401);
    expect((await fetch(`${rig.base}/lectures`, { headers: { ...bearer, Origin: PAGE } })).status).toBe(403);
    expect((await fetch(`${rig.base}/lectures`, { method: "POST", headers: bearer })).status).toBe(404);
    expect(await get(rig.base)).toEqual({ lectures: [] });
  });

  test("lists captures newest first with their titles, watched seconds, status and reviews (read-only)", async () => {
    const rig = reviewRig();
    await ingest(rig.base, wireFacts(0, 4), OTHER);
    await ingest(rig.base, wireFacts(0, 4), rig.capture);
    const reviewId = await startedIn(rig);
    await rig.turn(reviewId, { kind: "pause" });

    const before = rig.db.sql.query<{ n: number }, []>("SELECT (SELECT COUNT(*) FROM capture_facts) + (SELECT COUNT(*) FROM reviews) + (SELECT COUNT(*) FROM review_turns) AS n").get()!.n;
    const { lectures } = await get(rig.base);
    expect(lectures.map((l) => l.captureId)).toEqual([rig.capture, OTHER]);
    expect(lectures[0]).toMatchObject({ videos: 1, watchedSeconds: 10, sourceTitles: [expect.any(String)] });
    expect(lectures[0]!.reviews).toEqual([{ reviewId, startedMs: expect.any(Number), phase: "paused", saved: "unsaved", mainQuestions: expect.any(Number) }]);
    expect(lectures[1]!.reviews).toEqual([]);
    const after = rig.db.sql.query<{ n: number }, []>("SELECT (SELECT COUNT(*) FROM capture_facts) + (SELECT COUNT(*) FROM reviews) + (SELECT COUNT(*) FROM review_turns) AS n").get()!.n;
    expect(after).toBe(before);
  });
});
