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
import { authorize, serve } from "../src/backend/http";
import type { AuthConfig } from "../src/backend/http";
import { createLedger } from "../src/backend/providers/ledger";
import { stableId } from "../src/shared/ids";
import { ROUTES } from "../src/shared/wire";
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

function start(appDir = fixtureApp()) {
  const server = serve({ modules: { ledger: createLedger(testDb()) }, auth: { port: 0, extensionId: EXT_ID, token: TOKEN }, appDir });
  servers.push(server);
  return { server, port: server.port as number, base: `http://127.0.0.1:${server.port}` };
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
    expect((await fetch(`${base}/captures/${CAP}`, { headers: bearer })).status).toBe(501);
    expect((await fetch(`${base}/captures/not-an-id`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${base}/reviews/${CAP}`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${base}/ingest`, { method: "POST", headers: bearer, body: "{}" })).status).toBe(501);
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
