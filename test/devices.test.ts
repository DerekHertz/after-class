/**
 * Connected browsers: connect codes, device tokens and revocation (src/backend/devices.ts), and how hosted mode serves
 * them (src/backend/http.ts). No test calls Clerk: session tokens are signed with a key made here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createClerkVerifier } from "../src/backend/clerk";
import { userForIdentity } from "../src/backend/db";
import type { Db } from "../src/backend/db";
import { CONNECT_CODE_TTL_MS, createDevices, isDeviceToken } from "../src/backend/devices";
import type { Devices } from "../src/backend/devices";
import { bearerAllowed, serve } from "../src/backend/http";
import { clerkUsers, hostedCallers } from "../src/backend/main";
import { stableId } from "../src/shared/ids";
import type { IdKind, UserId } from "../src/shared/ids";
import { ROUTES, routeUrl } from "../src/shared/wire";
import type { RouteName } from "../src/shared/wire";
import type { SigningKey } from "./clerk-fixtures";
import { ISSUER, PUBLIC_ORIGIN, PUBLISHABLE_KEY, claims, fakeJwks, sign, signingKey } from "./clerk-fixtures";
import { testDb } from "./fakes";
import { EXTENSION_ORIGIN, EXT_ID, JSON_HEADERS, connectDevice, fixtureApp, registerCleanup, send, start, wireFacts, world } from "./http-fixtures";

registerCleanup();

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const users = (db: Db) => [userForIdentity(db, { provider: "clerk", subject: "user_alice" }), userForIdentity(db, { provider: "clerk", subject: "user_bob" })] as const;

function clock(start = 1_800_000_000_000) {
  const c = { ms: start, now: () => c.ms };
  return c;
}

function connected(devices: Devices, userId: UserId, label = "Chrome on Linux") {
  const result = devices.exchange(devices.createCode(userId, label).code);
  if (result.kind !== "connected") throw new Error(`expected a connection, got ${result.kind}`);
  return result;
}

describe("devices", () => {
  test("a connect code works once: the second exchange of the same code is refused and makes no second device", () => {
    const db = testDb();
    const [alice] = users(db);
    const devices = createDevices(db);
    const { code } = devices.createCode(alice, "Chrome on Linux");
    const first = devices.exchange(code);
    expect(first.kind).toBe("connected");
    expect(devices.exchange(code)).toEqual({ kind: "refused" });
    expect(devices.list(alice)).toHaveLength(1);
  });

  test("a connect code is refused once it expires, and works until then", () => {
    const db = testDb();
    const [alice] = users(db);
    const c = clock();
    const devices = createDevices(db, { now: c.now });
    const late = devices.createCode(alice, "Late").code;
    const onTime = devices.createCode(alice, "On time").code;
    c.ms += CONNECT_CODE_TTL_MS - 1;
    expect(devices.exchange(onTime).kind).toBe("connected");
    c.ms += 1;
    expect(devices.exchange(late)).toEqual({ kind: "refused" });
    expect(devices.list(alice).map((d) => d.label)).toEqual(["On time"]);
  });

  test("after too many wrong codes every exchange is refused, the right code included, until the window passes", () => {
    const db = testDb();
    const [alice] = users(db);
    const c = clock();
    const devices = createDevices(db, { now: c.now, maxFailures: 3, windowMs: 60_000 });
    const { code } = devices.createCode(alice, "Chrome on Linux");
    for (const wrong of ["nope", `acc_${"A".repeat(43)}`, `acc_${"B".repeat(43)}`]) expect(devices.exchange(wrong)).toEqual({ kind: "refused" });
    c.ms += 10_000;
    expect(devices.exchange(code)).toEqual({ kind: "limited", retryAfterS: 50 });
    expect(devices.list(alice)).toEqual([]);
    c.ms += 50_000;
    expect(devices.exchange(code).kind).toBe("connected");
  });

  test("the database holds a hash of the token and of the code, never either one", () => {
    const db = testDb();
    const [alice] = users(db);
    const devices = createDevices(db);
    const pending = devices.createCode(alice, "Pending").code;
    const { code } = devices.createCode(alice, "Chrome on Linux");
    const { token } = devices.exchange(code) as { token: string };
    const everything = JSON.stringify([db.sql.query("SELECT * FROM devices").all(), db.sql.query("SELECT * FROM connect_codes").all()]);
    for (const secret of [token, code, pending]) expect(everything).not.toContain(secret.slice(4));
    expect(db.sql.query<{ token_hash: string }, []>("SELECT token_hash FROM devices").get()!.token_hash).toBe(sha256(token));
    expect(db.sql.query<{ code_hash: string }, []>("SELECT code_hash FROM connect_codes").get()!.code_hash).toBe(sha256(pending));
  });

  test("a device token names its own user until it is revoked; another user can neither see nor revoke it", () => {
    const db = testDb();
    const [alice, bob] = users(db);
    const devices = createDevices(db);
    const mine = connected(devices, alice);
    const theirs = connected(devices, bob, "Bob's Chrome");
    expect(devices.userFor(mine.token)).toBe(alice);
    expect(devices.userFor(theirs.token)).toBe(bob);
    expect(devices.list(bob).map((d) => d.id)).toEqual([theirs.deviceId]);
    expect(devices.revoke(bob, mine.deviceId)).toBe(false);
    expect(devices.userFor(mine.token)).toBe(alice);
    expect(devices.revoke(alice, mine.deviceId)).toBe(true);
    expect(devices.userFor(mine.token)).toBeNull();
    expect(devices.list(alice)).toEqual([]);
    expect(devices.revoke(alice, mine.deviceId)).toBe(true);
    expect(devices.userFor(theirs.token)).toBe(bob);
  });

  test("a device token is told from a session token by its shape alone", () => {
    expect(isDeviceToken(`acd_${"x".repeat(43)}`)).toBe(true);
    expect(isDeviceToken(`acc_${"x".repeat(43)}`)).toBe(false);
    expect(isDeviceToken(`acd_${"x".repeat(42)}`)).toBe(false);
    expect(isDeviceToken("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln")).toBe(false);
  });
});

describe("which routes a device token reaches", () => {
  const device = { userId: stableId("usr", "d"), bearer: "device" } as const;
  const session = { userId: stableId("usr", "s"), bearer: "session" } as const;

  test("a device token reaches ingest and the invite answer, only from the pinned extension, and nothing else", () => {
    const reached = (Object.keys(ROUTES) as RouteName[]).filter((r) => bearerAllowed(r, device, "extension"));
    expect(reached.sort()).toEqual(["answerInvite", "ingest"]);
    for (const origin of ["review_app", "none"] as const) expect((Object.keys(ROUTES) as RouteName[]).filter((r) => bearerAllowed(r, device, origin))).toEqual([]);
  });

  test("a session token reaches every route but ingest and the exchange", () => {
    const refused = (Object.keys(ROUTES) as RouteName[]).filter((r) => !bearerAllowed(r, session, "review_app"));
    expect(refused.sort()).toEqual(["exchangeConnectCode", "ingest"]);
  });
});

// ───────────────────────────── over HTTP ─────────────────────────────

const PARAM_KIND: Record<string, IdKind> = { captureId: "cap", reviewId: "rvw", topicId: "cpt", evidenceId: "ev", noteId: "note", linkId: "lnk", observationId: "obs", deviceId: "dev" };
const sampleUrl = (name: RouteName) =>
  routeUrl(ROUTES[name] as never, Object.fromEntries([...ROUTES[name].path.matchAll(/:(\w+)/g)].map(([, p]) => [p!, stableId(PARAM_KIND[p!]!, "x")])) as never);

let key: SigningKey;
beforeAll(async () => {
  key = await signingKey("k1");
});

/** A hosted server on the real verifier, identity mapping and device store; every user shares one set of modules here. */
function hostedServer(options: Parameters<typeof createDevices>[1] = {}) {
  const w = world();
  const verifier = createClerkVerifier({ issuer: ISSUER, jwksUrl: "https://clerk.afterclass.test/.well-known/jwks.json", authorizedParties: [PUBLIC_ORIGIN] }, { fetch: fakeJwks([key]).fetch });
  const devices = createDevices(w.db, options);
  const server = serve({
    hosted: {
      publicOrigin: PUBLIC_ORIGIN, extensionId: EXT_ID, clerk: { scriptUrl: "https://clerk.afterclass.test/clerk.js", publishableKey: PUBLISHABLE_KEY },
      userFor: hostedCallers(clerkUsers(verifier, w.db), devices), devices,
    },
    port: 0,
    modulesFor: () => ({ ledger: { summary: () => ({ byKind: {}, byPurpose: {} }) } as never, evidence: w.evidence, reviews: w.reviews }),
    appDir: fixtureApp(),
  });
  return { ...w, devices, server, base: `http://127.0.0.1:${server.port}` };
}

const sessionOf = async (sub: string) => ({ Authorization: `Bearer ${await sign(key, claims({ sub }))}`, "Content-Type": "application/json" });

describe("connecting over HTTP", () => {
  let s: ReturnType<typeof hostedServer>;
  beforeAll(() => {
    s = hostedServer();
  });
  afterAll(() => s.server.stop(true));

  test("the extension connects, ingests with its device token, and the token reaches no route of the review app", async () => {
    const d = await connectDevice(s.base, await sessionOf("user_alice"));
    expect(d.userId).toBe(userForIdentity(s.db, { provider: "clerk", subject: "user_alice" }));
    const ingest = await send(s.base, "POST", "/ingest", { captureId: stableId("cap", "device-ingest"), facts: wireFacts(0, 3) }, d.headers);
    expect(ingest.status).toBe(200);
    for (const name of Object.keys(ROUTES) as RouteName[]) {
      if (ROUTES[name].bearer.includes("device") || ROUTES[name].bearer.length === 0) continue;
      const r = await send(s.base, ROUTES[name].method, sampleUrl(name), ROUTES[name].method === "GET" ? undefined : {}, d.headers);
      expect(r.status, name).toBe(401);
    }
  });

  test("a device token from the app's origin or with no Origin is 401, so a page that got hold of one cannot use it", async () => {
    const d = await connectDevice(s.base, await sessionOf("user_alice"));
    const body = { captureId: stableId("cap", "device-origin"), facts: wireFacts(0, 3) };
    for (const origin of [{ Origin: PUBLIC_ORIGIN }, {}]) {
      const r = await send(s.base, "POST", "/ingest", body, { Authorization: d.headers.Authorization, "Content-Type": "application/json", ...origin });
      expect(r.status, JSON.stringify(origin)).toBe(401);
    }
  });

  test("only the pinned extension may exchange a code: the app's origin, another extension or no Origin is 403 and leaves the code unspent", async () => {
    const alice = await sessionOf("user_alice");
    const { code } = (await (await send(s.base, "POST", "/devices/connect-codes", { label: "Chrome on Linux" }, alice)).json()) as { code: string };
    for (const origin of [{ Origin: PUBLIC_ORIGIN }, { Origin: "chrome-extension://someoneelseextensionidaaaaaaaaaa" }, {}]) {
      const r = await send(s.base, "POST", "/devices/exchange", { code }, { "Content-Type": "application/json", ...origin });
      expect(r.status, JSON.stringify(origin)).toBe(403);
    }
    expect((await send(s.base, "POST", "/devices/exchange", { code }, { "Content-Type": "application/json", ...EXTENSION_ORIGIN })).status).toBe(200);
    expect((await send(s.base, "POST", "/devices/exchange", { code }, { "Content-Type": "application/json", ...EXTENSION_ORIGIN })).status).toBe(401);
  });

  test("a connect code needs a session: a device token cannot mint one", async () => {
    const d = await connectDevice(s.base, await sessionOf("user_alice"));
    expect((await send(s.base, "POST", "/devices/connect-codes", { label: "Chrome on Linux" }, d.headers)).status).toBe(401);
  });

  test("a revoked device's token is 401 at once; another user cannot list or revoke it", async () => {
    const alice = await sessionOf("user_alice");
    const bob = await sessionOf("user_bob");
    const d = await connectDevice(s.base, alice, "Alice's laptop");
    await connectDevice(s.base, bob, "Bob's laptop");
    const list = async (headers: Record<string, string>) => ((await (await send(s.base, "GET", "/devices", undefined, headers)).json()) as { devices: { id: string; label: string }[] }).devices;
    const mine = (await list(alice)).find((x) => x.label === "Alice's laptop")!;
    expect((await list(bob)).map((x) => x.label)).toEqual(["Bob's laptop"]);
    expect((await send(s.base, "DELETE", `/devices/${mine.id}`, undefined, bob)).status).toBe(404);
    const capture = { captureId: stableId("cap", "revoked"), facts: wireFacts(0, 3) };
    expect((await send(s.base, "POST", "/ingest", capture, d.headers)).status).toBe(200);
    expect((await send(s.base, "DELETE", `/devices/${mine.id}`, undefined, alice)).status).toBe(204);
    expect((await send(s.base, "POST", "/ingest", capture, d.headers)).status).toBe(401);
    expect((await list(alice)).some((x) => x.id === mine.id)).toBe(false);
  });

  test("the app page names the pinned extension, so the connect page can reach it", async () => {
    const html = await (await fetch(`${s.base}/app/`)).text();
    expect(html).toContain(`<meta name="afterclass-extension-id" content="${EXT_ID}">`);
  });
});

test("too many wrong codes over HTTP answer 429 with Retry-After, the right code included", async () => {
  const s = hostedServer({ maxFailures: 2 });
  try {
    const alice = await sessionOf("user_alice");
    const { code } = (await (await send(s.base, "POST", "/devices/connect-codes", { label: "Chrome on Linux" }, alice)).json()) as { code: string };
    const exchange = (c: string) => send(s.base, "POST", "/devices/exchange", { code: c }, { "Content-Type": "application/json", ...EXTENSION_ORIGIN });
    expect((await exchange("acc_wrong")).status).toBe(401);
    expect((await exchange(`acc_${"Z".repeat(43)}`)).status).toBe(401);
    const limited = await exchange(code);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  } finally {
    await s.server.stop(true);
  }
});

test("local mode is unchanged: the device routes answer 501 behind the pairing token, and the app page names no extension", async () => {
  const s = start();
  for (const name of ["createConnectCode", "exchangeConnectCode", "devices", "revokeDevice"] as const) {
    const r = await send(s.base, ROUTES[name].method, sampleUrl(name), ROUTES[name].method === "GET" ? undefined : {}, JSON_HEADERS);
    expect(r.status, name).toBe(501);
  }
  expect(await (await fetch(`${s.base}/app/`, { headers: { Host: `127.0.0.1:${s.port}` } })).text()).not.toContain("afterclass-extension-id");
});
