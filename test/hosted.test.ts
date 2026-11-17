/**
 * Hosted mode: Clerk sign-in in front of the same routes. No test calls Clerk: the keys are generated here and the JWKS
 * is a fake `fetch` or a local server. Local mode is covered, unchanged, by the http, main and ownership tests.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClerkVerifier } from "../src/backend/clerk";
import { createDevices } from "../src/backend/devices";
import { serve } from "../src/backend/http";
import { clerkUsers, hostedCallers, main, mainHosted, resolveAuth } from "../src/backend/main";
import type { HostedRunning } from "../src/backend/main";
import { ESTIMATE_USD } from "../src/backend/providers/budget";
import type { Memo } from "../src/backend/providers/memo";
import type { Allowance, Cost } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { IdKind, UserId } from "../src/shared/ids";
import { UNKNOWN_COST, fakeTask, ok, usage } from "./fakes";
import { ROUTES, routeUrl } from "../src/shared/wire";
import type { RouteName } from "../src/shared/wire";
import type { SigningKey } from "./clerk-fixtures";
import { ISSUER, PUBLIC_ORIGIN, PUBLISHABLE_KEY, claims, fakeJwks, jwksServer, sign, signingKey } from "./clerk-fixtures";
import { EXTENSION_ORIGIN, EXT_ID, TOKEN, connectDevice, fixtureApp, raw, registerCleanup, wireFacts, world } from "./http-fixtures";

registerCleanup();

const SCRIPT = "https://clerk.afterclass.test/npm/@clerk/clerk-js@6.42.3/dist/clerk.browser.js";
const UI_SCRIPT = "https://clerk.afterclass.test/npm/@clerk/ui@1.42.4/dist/ui.browser.js";
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
  const appDir = fixtureApp();
  const server = serve({
    hosted: { publicOrigin: PUBLIC_ORIGIN, extensionId: EXT_ID, clerk: { scriptUrl: SCRIPT, uiScriptUrl: UI_SCRIPT, publishableKey: PUBLISHABLE_KEY }, userFor: hostedCallers(clerkUsers(verifier, w.db), devices), devices },
    port: 0,
    modulesFor: () => ({ ledger: { summary: () => ({ total: { known: 0, unknown: 0 } }) } as never, evidence: w.evidence, reviews: w.reviews }),
    appDir,
  });
  const port = server.port as number;
  return { ...w, server, port, appDir, base: `http://127.0.0.1:${port}`, stop: () => server.stop(true) };
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
    expect(page.body).toContain(
      `<script defer crossorigin="anonymous" data-clerk-ui src="${UI_SCRIPT}"></script><script defer crossorigin="anonymous" data-clerk-publishable-key="${PUBLISHABLE_KEY}" src="${SCRIPT}"></script></head>`,
    );
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self' https://clerk.afterclass.test https://challenges.cloudflare.com https://*.protect.clerk.com;");
    expect(csp).toContain("connect-src 'self' https://clerk.afterclass.test https://*.protect.clerk.com:* https://clerk-telemetry.com;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000");
    const asset = await raw(s.port, "/app/main.js", { "Sec-Fetch-Site": "cross-site" });
    expect(asset.status).toBe(200);
  });

  test("GET / is the public landing page, /health answers anyone, and an unrouted path is still a 404", async () => {
    const home = await raw(s.port, "/", { Host: "afterclass.test" });
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(home.body).toContain("<h1>After Class</h1>");
    expect(home.body).toMatch(/invite-only/i);
    expect(home.body).toContain("ask the person who invited you");
    expect(home.body).toContain(`<a class="button" href="/app/">Sign in</a>`);
    expect(home.body).toContain("<title>After Class: study YouTube lectures by explaining them</title>");
    expect(home.body).toContain('<meta name="description" content="After Class is a study companion');
    expect(home.body).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/">`);
    expect((await raw(s.port, "/health", { Host: "10.0.0.7:8080" })).status).toBe(200);
    expect((await raw(s.port, "/nope", {})).status).toBe(404);
  });

  test("the public pages run no script, load nothing from another site, and carry HSTS and a strict policy", async () => {
    for (const path of ["/", "/privacy"]) {
      const r = await raw(s.port, path, { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" });
      expect(r.status, path).toBe(200);
      expect(r.body, path).not.toMatch(/<script|<iframe|<form|\bon[a-z]+=|https?:\/\/(?!afterclass\.test)/i);
      expect(r.headers.get("strict-transport-security"), path).toBe("max-age=31536000");
      const csp = r.headers.get("content-security-policy")!;
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).not.toMatch(/script-src|unsafe-eval/);
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(r.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    expect((await raw(s.port, "/", {}, "POST")).status).toBe(405);
  });

  test("the public pages draw with the built app's room art and fonts when it has them, and read fine without", async () => {
    expect((await raw(s.port, "/", {})).body).not.toContain("url('/app/");
    writeFileSync(join(s.appDir, "last-desk-0a1b2c3d.webp"), "x");
    writeFileSync(join(s.appDir, "pixelify-sans-0a1b2c3d.ttf"), "x");
    writeFileSync(join(s.appDir, "dm-sans-400-0a1b2c3d.ttf"), "x");
    const page = (await raw(s.port, "/", {})).body;
    expect(page).toContain("--plate:url('/app/last-desk-0a1b2c3d.webp')");
    expect(page).toContain("url('/app/pixelify-sans-0a1b2c3d.ttf')");
    expect(page).toContain("url('/app/dm-sans-400-0a1b2c3d.ttf')");
  });

  test("the public pages link the built favicons, and /favicon.ico answers without a login", async () => {
    expect((await raw(s.port, "/", {})).body).not.toContain('rel="icon"');
    expect((await raw(s.port, "/favicon.ico", {})).status).toBe(404);
    for (const name of ["favicon-16-0a1b2c3d.png", "favicon-32-0a1b2c3d.png", "apple-touch-icon-0a1b2c3d.png"]) writeFileSync(join(s.appDir, name), "x");
    writeFileSync(join(s.appDir, "favicon-0a1b2c3d.ico"), "ico-bytes");
    for (const path of ["/", "/privacy"]) {
      const body = (await raw(s.port, path, {})).body;
      expect(body, path).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/app/favicon-32-0a1b2c3d.png">');
      expect(body, path).toContain('<link rel="icon" type="image/png" sizes="16x16" href="/app/favicon-16-0a1b2c3d.png">');
      expect(body, path).toContain('<link rel="apple-touch-icon" href="/app/apple-touch-icon-0a1b2c3d.png">');
    }
    const ico = await raw(s.port, "/favicon.ico", { "Sec-Fetch-Site": "cross-site" });
    expect(ico.status).toBe(200);
    expect(ico.body).toBe("ico-bytes");
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
    expect(ico.headers.get("cache-control")).toBe("public, max-age=86400");
    expect((await raw(s.port, "/favicon.ico", {}, "POST")).status).toBe(405);
  });

  test("/privacy names who processes the data, canonicalises to itself and links back", async () => {
    const r = await raw(s.port, "/privacy", {});
    for (const name of ["Clerk", "Anthropic", "TypeSafe", "us-east-2", "speech recognition", "Limited Use", "30 days", "cookies", "14 days", "database keeps its text", "not built yet"]) expect(r.body).toContain(name);
    expect(r.body).not.toContain("search the web");
    expect(r.body).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/privacy">`);
    expect(r.body).toContain('href="/"');
    expect(r.body).not.toMatch(/@[a-z0-9-]+\.[a-z]|mailto:/);
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
  test("hosted sign-in requires HTTPS for a public origin and permits HTTP on loopback", () => {
    const env = hostedEnv("https://clerk.afterclass.test/.well-known/jwks.json", "/unused");
    for (const origin of ["http://afterclass.test", "http://203.0.113.1", "http://localhost.example", "ftp://localhost"]) {
      expect(() => resolveAuth({ ...env, AFTERCLASS_PUBLIC_ORIGIN: origin })).toThrow(/requires HTTPS/);
    }
    for (const origin of ["https://afterclass.test", "http://localhost:4317", "http://127.0.0.1:4317", "http://[::1]:4317"]) {
      expect(resolveAuth({ ...env, AFTERCLASS_PUBLIC_ORIGIN: origin })).toMatchObject({ publicOrigin: origin });
    }
  });

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

  describe("budgets", () => {
    /** Live mode with a keys file, so the one shared budget runs. Every provider call is refused and counted. */
    async function bootLive(extraKeys = "") {
      const configDir = dir("afterclass-hosted-config-");
      const dataDir = dir("afterclass-hosted-data-");
      writeFileSync(join(configDir, "keys.env"), `TYPESAFE_API_KEY=sk-hosted-budget\n${extraKeys}`, { mode: 0o600 });
      const logs: string[] = [];
      let providerCalls = 0;
      const refuse = () => {
        providerCalls++;
        throw new Error("a hosted budget test reached a provider");
      };
      const r = await mainHosted({ port: 0, buildApp: false, configDir, appDir: fixtureApp(), env: hostedEnv(jwks.url, dataDir), fetch: refuse as unknown as typeof fetch, spawn: refuse, log: (t) => void logs.push(t), error: () => {} });
      expect(r.mode).toBe("live");
      const base = `http://127.0.0.1:${r.port}`;
      const signIn = async (sub: string) => {
        const headers = await as(sub);
        expect((await fetch(`${base}/lectures`, { headers })).status).toBe(200);
        const db = new Database(join(dataDir, "afterclass.sqlite"), { readonly: true });
        try {
          const userId = db.query<{ id: UserId }, [string]>("SELECT id FROM users WHERE auth_subject = ?").get(sub)!.id;
          return {
            headers,
            memo: r.modulesFor(userId).memo,
            allowance: async () => ((await (await fetch(`${base}/usage`, { headers })).json()) as { allowance: Allowance | null }).allowance,
          };
        } finally {
          db.close();
        }
      };
      return { r, base, logs, signIn, providerCalls: () => providerCalls };
    }

    test("ElevenLabs stays off even with its key in keys.env: voice is unavailable, nothing is sent, and the log says the key is ignored", async () => {
      const b = await bootLive("ELEVENLABS_API_KEY=sk-eleven-hosted\n");
      try {
        const alice = await b.signIn("user_alice");
        expect(await (await fetch(`${b.base}/voice`, { headers: alice.headers })).json()).toEqual({ available: false });
        const speech = await fetch(`${b.base}/voice/speech`, { method: "POST", headers: { ...alice.headers, "content-type": "application/json" }, body: JSON.stringify({ text: "Hello." }) });
        expect(speech.status).toBe(503);
        expect(b.providerCalls()).toBe(0);
        expect(b.logs.join("\n")).toContain("voice: ELEVENLABS_API_KEY is ignored in hosted mode");
      } finally {
        await b.r.stop();
      }
    });

    const turns = (cost: Cost = UNKNOWN_COST) => fakeTask<{ n: number }, string>({ purpose: "tutor_turn", provider: "claude", answer: () => ok("turn", { usage: usage(cost) }) });
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    /** Unknown-cost tutor turns that fit under a cap of `usd`, each counted at its reservation. */
    const fitting = (usd: number) => Math.floor(usd / ESTIMATE_USD.tutor_turn + 1e-9);
    /** What `n` such turns add up to in the allowance, which counts whole micro-dollars. */
    const usd = (n: number) => Math.round(n * ESTIMATE_USD.tutor_turn * 1e6) / 1e6;
    const run = (memo: Memo, task: ReturnType<typeof turns>, ns: readonly number[]) => Promise.all(ns.map((n) => memo.run(task, { n }).then((r) => r.kind)));

    test("each signed-in user is held at their own $5 a month, and one user's spending never holds another", async () => {
      const b = await bootLive();
      try {
        const alice = await b.signIn("user_alice");
        const bob = await b.signIn("user_bob");
        const aliceTurns = turns();
        const fits = fitting(5);
        const bobTurns = turns();
        expect(await run(alice.memo, aliceTurns, upTo(fits))).toEqual(Array(fits).fill("hit"));
        expect(await alice.memo.run(aliceTurns, { n: fits + 1 })).toMatchObject({ kind: "held", hold: { reason: "user_budget" } });
        expect(await bob.allowance()).toMatchObject({ usedUsd: 0, limitUsd: 5, held: null });
        expect(await run(bob.memo, bobTurns, upTo(fits))).toEqual(Array(fits).fill("hit"));
        expect(await bob.memo.run(bobTurns, { n: fits + 1 })).toMatchObject({ kind: "held", hold: { reason: "user_budget" } });
        expect(aliceTurns.calls).toHaveLength(fits);
        expect(bobTurns.calls).toHaveLength(fits);
        for (const user of [alice, bob]) expect(await user.allowance()).toMatchObject({ usedUsd: usd(fits), limitUsd: 5, held: { reason: "user_budget" } });
        expect(b.providerCalls()).toBe(0);
      } finally {
        await b.r.stop();
      }
    });

    test("an account listed in AFTERCLASS_BUDGET_UNCAPPED_USERS in keys.env passes both caps, and a friend's total is not drawn down by it", async () => {
      const b = await bootLive("AFTERCLASS_BUDGET_UNCAPPED_USERS= user_admin , user_other\n");
      try {
        const admin = await b.signIn("user_admin");
        const bob = await b.signIn("user_bob");
        expect(await admin.allowance()).toMatchObject({ limitUsd: null, uncapped: true, held: null });
        expect(await run(admin.memo, turns({ kind: "measured", usd: 49 }), [1])).toEqual(["hit"]);
        expect(await run(admin.memo, turns({ kind: "measured", usd: 49 }), [2])).toEqual(["hit"]);
        const bobTurns = turns();
        expect(await run(bob.memo, bobTurns, [1, 2, 3, 4, 5, 6])).toEqual(Array(6).fill("hit"));
        expect(await bob.allowance()).toMatchObject({ usedUsd: expect.closeTo(6 * ESTIMATE_USD.tutor_turn, 9), limitUsd: 5, uncapped: false });
        expect(b.logs.join("\n")).toContain("2 uncapped accounts");
        expect(b.logs.join("\n")).not.toContain("user_admin");
        expect(b.providerCalls()).toBe(0);
      } finally {
        await b.r.stop();
      }
    });

    test("once both users' calls together reach $50, the total holds a user who still has allowance left", async () => {
      const b = await bootLive();
      try {
        const alice = await b.signIn("user_alice");
        const bob = await b.signIn("user_bob");
        expect(await run(alice.memo, turns({ kind: "measured", usd: 46 }), [1])).toEqual(["hit"]);
        expect(await alice.memo.run(turns(), { n: 2 })).toMatchObject({ kind: "held", hold: { reason: "user_budget" } });
        const bobTurns = turns();
        const fits = fitting(4);
        expect(await run(bob.memo, bobTurns, upTo(fits))).toEqual(Array(fits).fill("hit"));
        expect(await bob.memo.run(bobTurns, { n: fits + 1 })).toMatchObject({ kind: "held", hold: { reason: "total_budget" } });
        expect(bobTurns.calls).toHaveLength(fits);
        expect(await bob.allowance()).toMatchObject({ usedUsd: usd(fits), limitUsd: 5, held: { reason: "total_budget" } });
        expect(b.providerCalls()).toBe(0);
      } finally {
        await b.r.stop();
      }
    });
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
