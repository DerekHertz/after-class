/**
 * Clerk stand-ins: RSA keys generated in the test, tokens signed with them, and a JWKS that a test can rotate. Nothing
 * here talks to Clerk.
 */

export const ISSUER = "https://clerk.afterclass.test";
export const PUBLIC_ORIGIN = "https://afterclass.test";
/** pk_test_ + base64("clerk.afterclass.test$"), so the Frontend API host is clerk.afterclass.test. */
export const PUBLISHABLE_KEY = `pk_test_${Buffer.from("clerk.afterclass.test$").toString("base64")}`;

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

type Jwk = { readonly kty: string; readonly n: string; readonly e: string; readonly kid: string; readonly alg: string; readonly use: string };

export type SigningKey = { readonly kid: string; readonly privateKey: CryptoKey; readonly jwk: Jwk };

export async function signingKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  const { n, e } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: "RSA", n: n!, e: e!, kid, alg: "RS256", use: "sig" } };
}

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const segment = (value: unknown) => b64(JSON.stringify(value));

/** A session token's claims as Clerk issues them, valid at `nowS`, with any of them replaced. */
export function claims(over: Record<string, unknown> = {}, nowS = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  return { iss: ISSUER, azp: PUBLIC_ORIGIN, sub: "user_alice", sid: "sess_1", iat: nowS - 1, nbf: nowS - 1, exp: nowS + 60, ...over };
}

/** An RS256 token signed by `key`. `header` replaces fields of the header (alg, kid). */
export async function sign(key: SigningKey, body: Record<string, unknown> = claims(), header: Record<string, unknown> = {}): Promise<string> {
  const signingInput = `${segment({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })}.${segment(body)}`;
  const signature = new Uint8Array(await crypto.subtle.sign(RSA, key.privateKey, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64(signature)}`;
}

/** An HS256 token whose HMAC secret is the public key: the classic algorithm-confusion forgery. */
export async function hs256WithPublicKey(key: SigningKey, body: Record<string, unknown> = claims()): Promise<string> {
  const signingInput = `${segment({ alg: "HS256", kid: key.kid, typ: "JWT" })}.${segment(body)}`;
  const secret = await crypto.subtle.importKey("raw", new TextEncoder().encode(JSON.stringify(key.jwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64(mac)}`;
}

/** `alg: none` with no signature, as an attacker sends it. */
export const unsigned = (kid: string, body: Record<string, unknown> = claims()) => `${segment({ alg: "none", kid, typ: "JWT" })}.${segment(body)}.`;

/** The payload segment swapped for another, the signature kept. */
export function tamper(token: string, body: Record<string, unknown>): string {
  const [h, , s] = token.split(".");
  return `${h}.${segment(body)}.${s}`;
}

/** A JWKS endpoint as a `fetch`: it serves whatever keys are current, counts requests, and can be made to fail. */
export function fakeJwks(keys: readonly SigningKey[]) {
  const state = { keys: [...keys], requests: 0, failing: false };
  const fetch = (async () => {
    state.requests += 1;
    if (state.failing) return new Response("down", { status: 503 });
    return Response.json({ keys: state.keys.map((k) => k.jwk) });
  }) as unknown as typeof globalThis.fetch;
  return { state, fetch };
}

/** The same JWKS over real HTTP on 127.0.0.1, for booting `mainHosted`. */
export function jwksServer(keys: readonly SigningKey[]) {
  const state = { keys: [...keys], requests: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.requests += 1;
      return Response.json({ keys: state.keys.map((k) => k.jwk) });
    },
  });
  return { state, url: `http://127.0.0.1:${server.port}/.well-known/jwks.json`, stop: () => server.stop(true) };
}
