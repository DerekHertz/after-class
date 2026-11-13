/**
 * The Clerk session-token verifier. Each refused token differs from an accepted one in exactly one property, and the
 * test asserts the reason, so a token refused for some other reason cannot make a test pass.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { CLERK_JS_VERSION, CLOCK_SKEW_S, clerkScriptUrl, createClerkVerifier, frontendApiOf } from "../src/backend/clerk";
import type { VerifierOptions } from "../src/backend/clerk";
import type { SigningKey } from "./clerk-fixtures";
import { ISSUER, PUBLIC_ORIGIN, PUBLISHABLE_KEY, claims, fakeJwks, hs256WithPublicKey, sign, signingKey, tamper, unsigned } from "./clerk-fixtures";

const CONFIG = { issuer: ISSUER, jwksUrl: "https://clerk.afterclass.test/.well-known/jwks.json", authorizedParties: [PUBLIC_ORIGIN] };

let k1: SigningKey;
let k2: SigningKey;
beforeAll(async () => {
  [k1, k2] = await Promise.all([signingKey("k1"), signingKey("k2")]);
});

function verifier(keys: readonly SigningKey[], options: VerifierOptions = {}) {
  const jwks = fakeJwks(keys);
  return { jwks, v: createClerkVerifier(CONFIG, { fetch: jwks.fetch, ...options }) };
}

describe("a session token", () => {
  test("signed by a published key, current, from the configured issuer and origin, is accepted with its subject", async () => {
    const { v } = verifier([k1]);
    expect(await v.verify(await sign(k1))).toEqual({ ok: true, subject: "user_alice" });
  });

  const now = () => Math.floor(Date.now() / 1000);
  const refused = [
    ["expired beyond the skew", async () => sign(k1, claims({ exp: now() - CLOCK_SKEW_S - 2 })), "expired"],
    ["not yet valid beyond the skew", async () => sign(k1, claims({ nbf: now() + CLOCK_SKEW_S + 30 })), "not_yet_valid"],
    ["from another issuer", async () => sign(k1, claims({ iss: "https://clerk.evil.test" })), "issuer"],
    ["for another origin", async () => sign(k1, claims({ azp: "https://evil.test" })), "authorized_party"],
    ["with no authorized party", async () => sign(k1, claims({ azp: undefined })), "authorized_party"],
    ["with no expiry", async () => sign(k1, claims({ exp: undefined })), "malformed"],
    ["with an empty subject", async () => sign(k1, claims({ sub: "" })), "subject"],
    ["signed RS256 but labelled RS512", async () => sign(k1, claims(), { alg: "RS512" }), "algorithm"],
    ["alg none with no signature", async () => unsigned("k1"), "malformed"],
    ["alg none with a real signature", async () => sign(k1, claims(), { alg: "none" }), "algorithm"],
    ["HS256 keyed with the public key", async () => hs256WithPublicKey(k1), "algorithm"],
    ["with a critical header extension", async () => sign(k1, claims(), { crit: ["exp"] }), "malformed"],
    ["with a kid the JWKS does not publish", async () => sign(k2), "unknown_key"],
    ["with its payload changed after signing", async () => tamper(await sign(k1), claims({ sub: "user_mallory" })), "signature"],
    ["signed by an unpublished key under a published kid", async () => sign({ ...k2, kid: "k1" }), "signature"],
    ["that is not three segments", async () => "abc.def", "malformed"],
  ] as const;

  for (const [what, make, reason] of refused) {
    test(`${what} is refused (${reason})`, async () => {
      const { v } = verifier([k1]);
      expect(await v.verify(await make())).toEqual({ ok: false, reason });
    });
  }

  test("inside the skew, a just-expired or almost-valid token is still accepted", async () => {
    const { v } = verifier([k1]);
    expect((await v.verify(await sign(k1, claims({ exp: now() - CLOCK_SKEW_S + 2 })))).ok).toBe(true);
    expect((await v.verify(await sign(k1, claims({ nbf: now() + CLOCK_SKEW_S - 2 })))).ok).toBe(true);
  });
});

describe("the key cache", () => {
  test("fetches the JWKS once for many tokens with known kids", async () => {
    const { v, jwks } = verifier([k1]);
    const token = await sign(k1);
    await Promise.all(Array.from({ length: 10 }, () => v.verify(token)));
    await v.verify(token);
    expect(jwks.state.requests).toBe(1);
  });

  test("rotation: a new kid triggers a refetch and verifies; a key Clerk removed stops verifying", async () => {
    let t = 1_000_000;
    const { v, jwks } = verifier([k1], { now: () => t, minRefetchMs: 30_000 });
    const nowS = () => Math.floor(t / 1000);
    expect((await v.verify(await sign(k1, claims({}, nowS()))))).toMatchObject({ ok: true });
    jwks.state.keys = [k2];
    t += 31_000;
    expect(await v.verify(await sign(k2, claims({}, nowS()))) ).toMatchObject({ ok: true });
    expect(jwks.state.requests).toBe(2);
    t += 31_000;
    expect(await v.verify(await sign(k1, claims({}, nowS())))).toEqual({ ok: false, reason: "unknown_key" });
  });

  test("unknown kids refetch at most once per interval, however many arrive at once", async () => {
    let t = 1_000_000;
    const { v, jwks } = verifier([k1], { now: () => t, minRefetchMs: 30_000 });
    const nowS = () => Math.floor(t / 1000);
    await v.verify(await sign(k1, claims({}, nowS())));
    const stranger = await sign({ ...k2, kid: "nobody" }, claims({}, nowS()));
    await Promise.all(Array.from({ length: 20 }, () => v.verify(stranger)));
    await v.verify(stranger);
    expect(jwks.state.requests).toBe(1);
    t += 31_000;
    await Promise.all(Array.from({ length: 20 }, () => v.verify(stranger)));
    expect(jwks.state.requests).toBe(2);
  });

  test("keys older than the maximum age are refetched, and with no fresh keys every token is refused", async () => {
    let t = 1_000_000;
    const { v, jwks } = verifier([k1], { now: () => t, maxKeyAgeMs: 60_000, minRefetchMs: 1_000 });
    const nowS = () => Math.floor(t / 1000);
    expect(await v.verify(await sign(k1, claims({}, nowS())))).toMatchObject({ ok: true });
    jwks.state.failing = true;
    t += 61_000;
    expect(await v.verify(await sign(k1, claims({}, nowS())))).toEqual({ ok: false, reason: "keys_unavailable" });
    expect(jwks.state.requests).toBe(2);
    jwks.state.failing = false;
    t += 2_000;
    expect(await v.verify(await sign(k1, claims({}, nowS())))).toMatchObject({ ok: true });
  });

  test("a JWKS entry for another algorithm or use is not trusted", async () => {
    const { v, jwks } = verifier([k1]);
    jwks.state.keys = [{ ...k1, jwk: { ...k1.jwk, alg: "RS512" } }];
    expect(await v.verify(await sign(k1))).toEqual({ ok: false, reason: "unknown_key" });
    const other = verifier([{ ...k1, jwk: { ...k1.jwk, use: "enc" } }]);
    expect(await other.v.verify(await sign(k1))).toEqual({ ok: false, reason: "unknown_key" });
  });
});

describe("the publishable key", () => {
  test("names the Frontend API host that serves the pinned ClerkJS build", () => {
    expect(frontendApiOf(PUBLISHABLE_KEY)).toBe("clerk.afterclass.test");
    expect(frontendApiOf(`pk_live_${Buffer.from("clerk.example.com$").toString("base64")}`)).toBe("clerk.example.com");
    expect(clerkScriptUrl("clerk.afterclass.test")).toBe(`https://clerk.afterclass.test/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`);
    expect(CLERK_JS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("anything else is refused, including a host that could break out of the URL", () => {
    for (const bad of [
      "sk_test_abc",
      "pk_test_",
      `pk_test_${Buffer.from("clerk.example.com").toString("base64")}`,
      `pk_test_${Buffer.from("evil.test/x?$").toString("base64")}`,
      `pk_test_${Buffer.from("evil.test@good.test$").toString("base64")}`,
      `pk_test_${Buffer.from("localhost$").toString("base64")}`,
    ]) expect(frontendApiOf(bad), bad).toBeNull();
  });
});
