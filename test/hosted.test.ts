/**
 * Hosted mode: Clerk sign-in in front of the same routes. No test calls Clerk: the keys are generated here and the JWKS
 * is a fake `fetch` or a local server. Local mode is covered, unchanged, by the http, main and ownership tests.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClerkVerifier } from "../src/backend/clerk";
import { createDevices } from "../src/backend/devices";
import { serve } from "../src/backend/http";
import { clerkUsers, hostedCallers, main, mainHosted, resolveAuth } from "../src/backend/main";
import type { HostedRunning } from "../src/backend/main";
import { stableId } from "../src/shared/ids";
import type { IdKind } from "../src/shared/ids";
import { ROUTES, routeUrl } from "../src/shared/wire";
import type { RouteName } from "../src/shared/wire";
import type { SigningKey } from "./clerk-fixtures";
import { ISSUER, PUBLIC_ORIGIN, PUBLISHABLE_KEY, claims, fakeJwks, jwksServer, sign, signingKey } from "./clerk-fixtures";
import { EXTENSION_ORIGIN, EXT_ID, TOKEN, connectDevice, fixtureApp, raw, registerCleanup, wireFacts, world } from "./http-fixtures";

registerCleanup();

const SCRIPT = "https://clerk.afterclass.test/npm/@clerk/clerk-js@6.42.2/dist/clerk.browser.js";
const PARAM_KIND: Record<string, IdKind> = { captureId: "cap", reviewId: "rvw", topicId: "cpt", evidenceId: "ev", noteId: "note", linkId: "lnk", observationId: "obs", deviceId: "dev" };

let key: SigningKey;
beforeAll(async () => {
  key = await signingKey("k1");
});

/** A hosted server on the real verifier and the real identity mapping; every user shares one set of modules here. */
function hostedServer() {
  const w = world();
  const verifier = createClerkVerifier({ issuer: ISSUER, jwksUrl: "https://clerk.afterclass.test/.well-known/jwks.json", authorizedParties: [PUBLIC_ORIGIN] }, { fetch: fakeJwks([key]).fetch });
  const devices = createDevices(w.db);
  const server = serve({
    hosted: { publicOrigin: PUBLIC_ORIGIN, extensionId: EXT_ID, clerk: { scriptUrl: SCRIPT, publishableKey: PUBLISHABLE_KEY }, userFor: hostedCallers(clerkUsers(verifier, w.db), devices), devices },
    port: 0,
    modulesFor: () => ({ ledger: { summary: () => ({ total: { known: 0, unknown: 0 } }) } as never, evidence: w.evidence, reviews: w.reviews }),
    appDir: fixtureApp(),
  });
  const port = server.port as number;
  return { ...w, server, port, base: `http://127.0.0.1:${port}`, stop: () => server.stop(true) };
}

const bearerFor = async (over: Record<string, unknown> = {}) => `Bearer ${await sign(key, claims(over))}`;

function sampleUrl(name: RouteName): string {
  const route = ROUTES[name];
  const params = Object.fromEntries([...route.path.matchAll(/:(\w+)/g)].map(([, p]) => [p!, stableId(PARAM_KIND[p!]!, "x")]));
  return routeUrl(route as never, params as never);
}

describe("hosted requests", () => {
  let s: ReturnType<typeof hostedServer>;
  beforeAll(() => {
    s = hostedServer();
  });
  afterAll(() => s.stop());

  test("every route that takes a bearer answers 401 with no token, a pairing token, a refused session token or an unknown device token", async () => {
    const expired = await bearerFor({ exp: Math.floor(Date.now() / 1000) - 600 });
    const otherOrigin = await bearerFor({ azp: "https://evil.test" });
    const unknownDevice = `Bearer acd_${"A".repeat(43)}`;
    for (const name of Object.keys(ROUTES) as RouteName[]) {
      if (ROUTES[name].bearer.length === 0) continue;
      for (const authorization of [null, `Bearer ${TOKEN}`, expired, otherOrigin, unknownDevice]) {
        const r = await raw(s.port, sampleUrl(name), { Authorization: authorization, "Content-Type": "application/json" }, ROUTES[name].method);
        expect(r.status, `${name} with ${authorization?.slice(0, 20)}`).toBe(401);
      }
    }
  });

  test("a valid session token is served whatever the Host, from the public origin or with no Origin", async () => {
    const authorization = await bearerFor();
    for (const headers of [{}, { Host: "afterclass.test" }, { Host: "evil.test", Origin: PUBLIC_ORIGIN }]) {
      const r = await raw(s.port, "/lectures", { Authorization: authorization, ...headers });
      expect(r.status, JSON.stringify(headers)).toBe(200);
    }
  });

  test("a valid session token from any other origin, or a cross-site request with none, is 403", async () => {
    const authorization = await bearerFor();
    for (const headers of [
      { Origin: "https://evil.test" },
      { Origin: `http://127.0.0.1:${s.port}` },
      { Origin: "chrome-extension://someoneelseextensionidaaaaaaaaaa" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      const r = await raw(s.port, "/lectures", { Authorization: authorization, ...headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
    }
  });

  test("the pinned extension passes the Origin check, but a pairing token or a session token on ingest is 401", async () => {
    for (const authorization of [`Bearer ${TOKEN}`, await bearerFor()]) {
      for (const origin of [EXTENSION_ORIGIN, { Origin: PUBLIC_ORIGIN }, {}]) {
        const r = await raw(s.port, "/ingest", { ...origin, Authorization: authorization, "Content-Type": "application/json" }, "POST");
        expect(r.status, JSON.stringify(origin)).toBe(401);
      }
    }
  });

  test("ingest from a connected extension links back to the app on the public origin", async () => {
    const device = await connectDevice(s.base, { Authorization: await bearerFor(), "Content-Type": "application/json" });
    const res = await fetch(`${s.base}/ingest`, {
      method: "POST",
      headers: device.headers,
      body: JSON.stringify({ captureId: stableId("cap", "hosted"), facts: wireFacts(0, 2) }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reviewAppUrl: string }).reviewAppUrl).toBe(`${PUBLIC_ORIGIN}/app/capture/${stableId("cap", "hosted")}`);
  });

  test("the app page loads with no token, even as a cross-site navigation, carries no pairing token and loads the pinned ClerkJS", async () => {
    const page = await raw(s.port, "/app/", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" });
    expect(page.status).toBe(200);
    expect(page.body).not.toContain("afterclass-token");
    expect(page.body).toContain(`<script async crossorigin="anonymous" data-clerk-publishable-key="${PUBLISHABLE_KEY}" src="${SCRIPT}"></script></head>`);
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const asset = await raw(s.port, "/app/main.js", { "Sec-Fetch-Site": "cross-site" });
    expect(asset.status).toBe(200);
  });

  test("GET / redirects to the app, /health answers anyone, and an unrouted path is still a 404", async () => {
    const home = await raw(s.port, "/", { Host: "afterclass.test" });
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/app/");
    expect((await raw(s.port, "/health", { Host: "10.0.0.7:8080" })).status).toBe(200);
    expect((await raw(s.port, "/nope", {})).status).toBe(404);
  });

  test("CORS preflight is answered only for the public origin and the pinned extension", async () => {
    const ask = (origin: string) => raw(s.port, "/lectures", { Origin: origin, "Access-Control-Request-Method": "GET" }, "OPTIONS");
    expect((await ask(PUBLIC_ORIGIN)).status).toBe(204);
    expect((await ask(`chrome-extension://${EXT_ID}`)).status).toBe(204);
    expect((await ask("https://evil.test")).status).toBe(403);
  });
});

// ───────────────────────────── mainHosted ─────────────────────────────

const scratch: string[] = [];
const dir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

function hostedEnv(jwksUrl: string, dataDir: string) {
  return {
    AFTERCLASS_AUTH: "clerk",
    AFTERCLASS_CLERK_ISSUER: ISSUER,
    AFTERCLASS_CLERK_JWKS_URL: jwksUrl,
    AFTERCLASS_CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    AFTERCLASS_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    AFTERCLASS_EXTENSION_ID: EXT_ID,
    AFTERCLASS_DATA: dataDir,
  };
}

describe("resolveAuth", () => {
  test("unset or local keeps local mode; clerk needs every setting and refuses a malformed one", () => {
    expect(resolveAuth({})).toEqual({ kind: "local" });
    expect(resolveAuth({ AFTERCLASS_AUTH: "local" })).toEqual({ kind: "local" });
    const env = hostedEnv("https://clerk.afterclass.test/.well-known/jwks.json", "/unused");
    expect(resolveAuth(env)).toMatchObject({ kind: "clerk", frontendApi: "clerk.afterclass.test", clerk: { authorizedParties: [PUBLIC_ORIGIN] } });
    expect(() => resolveAuth({ AFTERCLASS_AUTH: "google" })).toThrow(/must be "local" or "clerk"/);
    expect(() => resolveAuth({ ...env, AFTERCLASS_CLERK_ISSUER: "" })).toThrow(/needs AFTERCLASS_CLERK_ISSUER/);
    expect(() => resolveAuth({ ...env, AFTERCLASS_PUBLIC_ORIGIN: `${PUBLIC_ORIGIN}/` })).toThrow(/bare origin/);
    expect(() => resolveAuth({ ...env, AFTERCLASS_CLERK_JWKS_URL: "http://clerk.afterclass.test/jwks" })).toThrow(/https URL/);
    expect(() => resolveAuth({ ...env, AFTERCLASS_CLERK_PUBLISHABLE_KEY: "sk_test_secret" })).toThrow(/not a Clerk publishable key/);
  });
});

describe("mainHosted", () => {
  let jwks: ReturnType<typeof jwksServer>;
  beforeAll(() => {
    jwks = jwksServer([key]);
  });
  afterAll(() => jwks.stop());

  async function boot(dataDir = dir("afterclass-hosted-data-")) {
    const configDir = dir("afterclass-hosted-config-");
    const logs: string[] = [];
    const r: HostedRunning = await mainHosted({ port: 0, buildApp: false, configDir, appDir: fixtureApp(), env: hostedEnv(jwks.url, dataDir), log: (t) => void logs.push(t), error: () => {} });
    return { r, logs, configDir, dataDir, base: `http://127.0.0.1:${r.port}` };
  }

  const as = async (sub: string) => ({ Authorization: `Bearer ${await sign(key, claims({ sub }))}`, "Content-Type": "application/json" });
  const extensionOf = async (base: string, sub: string) => (await connectDevice(base, await as(sub))).headers;
  const usersIn = (dataDir: string) => {
    const db = new Database(join(dataDir, "afterclass.sqlite"), { readonly: true });
    try {
      return db.query<{ auth_subject: string }, []>("SELECT auth_subject FROM users ORDER BY auth_subject").all().map((u) => u.auth_subject);
    } finally {
      db.close();
    }
  };

  test("starts with no pairing token, prints none, and main refuses hosted settings", async () => {
    const b = await boot();
    try {
      expect(existsSync(join(b.configDir, "pairing-token"))).toBe(false);
      expect(b.logs.join("\n")).not.toContain("pairing token");
      expect(b.logs.join("\n")).toContain(`sign-in: Clerk for ${PUBLIC_ORIGIN}`);
      expect((await fetch(`${b.base}/lectures`)).status).toBe(401);
    } finally {
      await b.r.stop();
    }
    await expect(main({ port: 0, buildApp: false, env: hostedEnv(jwks.url, dir("afterclass-hosted-data-")) })).rejects.toThrow(/mainHosted/);
  });

  test("concurrent first requests from one new account create exactly one user, and a second account its own", async () => {
    const b = await boot();
    try {
      const alice = await as("user_alice");
      const bob = await as("user_bob");
      const replies = await Promise.all(Array.from({ length: 24 }, (_, i) => fetch(`${b.base}/lectures`, { headers: i % 3 === 2 ? bob : alice })));
      expect(replies.map((r) => r.status)).toEqual(Array(24).fill(200));
      expect(usersIn(b.dataDir)).toEqual(["user_alice", "user_bob"]);
    } finally {
      await b.r.stop();
    }
  });

  test("each account sees only its own captures, and after a restart its data is still its own", async () => {
    const dataDir = dir("afterclass-hosted-data-");
    const cap = stableId("cap", "alice-lecture");
    let b = await boot(dataDir);
    const alice = await as("user_alice");
    const bob = await as("user_bob");
    const lectures = async (headers: Record<string, string>) => ((await (await fetch(`${b.base}/lectures`, { headers })).json()) as { lectures: { captureId: string }[] }).lectures.map((l) => l.captureId);
    try {
      const ingest = await fetch(`${b.base}/ingest`, { method: "POST", headers: await extensionOf(b.base, "user_alice"), body: JSON.stringify({ captureId: cap, facts: wireFacts(0, 3) }) });
      expect(ingest.status).toBe(200);
      expect(await lectures(alice)).toEqual([cap]);
      expect(await lectures(bob)).toEqual([]);
      expect((await fetch(`${b.base}/captures/${cap}`, { headers: bob })).status).toBe(404);
      expect((await fetch(`${b.base}/captures/${cap}`, { headers: alice })).status).toBe(200);
      const stolen = await fetch(`${b.base}/ingest`, { method: "POST", headers: await extensionOf(b.base, "user_bob"), body: JSON.stringify({ captureId: cap, facts: wireFacts(0, 3) }) });
      expect(stolen.status).toBe(404);
    } finally {
      await b.r.stop();
    }
    b = await boot(dataDir);
    try {
      expect(await lectures(alice)).toEqual([cap]);
      expect(await lectures(bob)).toEqual([]);
    } finally {
      await b.r.stop();
    }
  });

  test("a restart runs the expiry sweep for every signed-in user, as the local app does for its one user", async () => {
    const dataDir = dir("afterclass-hosted-data-");
    const cap = stableId("cap", "old-lecture");
    let b = await boot(dataDir);
    try {
      expect((await fetch(`${b.base}/ingest`, { method: "POST", headers: await extensionOf(b.base, "user_alice"), body: JSON.stringify({ captureId: cap, facts: wireFacts(0, 3) }) })).status).toBe(200);
    } finally {
      await b.r.stop();
    }
    const later = Date.now() + 40 * 24 * 60 * 60 * 1000;
    setSystemTime(new Date(later));
    try {
      b = await boot(dataDir);
      const aliceLater = { Authorization: `Bearer ${await sign(key, claims({ sub: "user_alice" }, Math.floor(later / 1000)))}` };
      const { lectures } = (await (await fetch(`${b.base}/lectures`, { headers: aliceLater })).json()) as { lectures: unknown[] };
      expect(lectures).toEqual([]);
    } finally {
      setSystemTime();
      await b.r.stop();
    }
  });
});
