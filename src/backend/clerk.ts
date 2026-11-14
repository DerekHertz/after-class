/**
 * Clerk session tokens, verified without Clerk's SDK (hosted mode only). A session token is a JWT signed RS256 by one
 * of the keys published at the instance's JWKS URL. `verify` accepts a token only when all of these hold:
 *   - three base64url segments, a JSON header with `alg` exactly "RS256", a `kid`, and no `crit`
 *   - the signature verifies under the JWKS key with that `kid`
 *   - `exp` is a number and has not passed, and `nbf`, when present, has arrived (both with CLOCK_SKEW_S of slack)
 *   - `iss` equals the configured issuer, and `azp` is one of the configured authorized parties
 *   - `sub` is a non-empty string, which is the identity the caller is mapped from
 *
 * Keys are fetched on first use and cached. A `kid` the cache lacks triggers a refetch, and so does a cache older than
 * `maxKeyAgeMs`, so a key Clerk removes stops verifying. Refetches are at least `minRefetchMs` apart and share one
 * request, so a flood of unknown kids cannot turn into a flood of fetches. With no fresh keys, every token is refused.
 *
 * Also here: what the review app needs to load ClerkJS. The publishable key encodes the Frontend API host, which serves
 * the pinned ClerkJS build and the pinned build of its UI.
 */

export type ClerkConfig = {
  readonly issuer: string;
  readonly jwksUrl: string;
  /** Origins whose tokens are accepted, matched against `azp`. */
  readonly authorizedParties: readonly string[];
};

export type VerifierOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly minRefetchMs?: number;
  readonly maxKeyAgeMs?: number;
};

export type Rejection =
  | "malformed" | "algorithm" | "keys_unavailable" | "unknown_key" | "signature" | "expired" | "not_yet_valid" | "issuer" | "authorized_party" | "subject";

export type Verified = { readonly ok: true; readonly subject: string } | { readonly ok: false; readonly reason: Rejection };

export type Verifier = { verify(token: string): Promise<Verified> };

export const CLOCK_SKEW_S = 5;
export const MIN_REFETCH_MS = 30_000;
export const MAX_KEY_AGE_MS = 60 * 60 * 1000;
const JWKS_TIMEOUT_MS = 5_000;
const SUBJECT_MAX = 256;

/** The ClerkJS build the review app loads. Pinned to an exact version at least 7 days old. */
export const CLERK_JS_VERSION = "6.42.2";
/** ClerkJS 6 ships its prebuilt UI as this separate package, released together with ClerkJS: keep the two from one release. */
export const CLERK_UI_VERSION = "1.42.3";

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const utf8 = new TextEncoder();

type Header = { readonly kid: string };
type Claims = Record<string, unknown>;

const no = (reason: Rejection): Verified => ({ ok: false, reason });

function segmentJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseHeader(raw: unknown): Header | Rejection {
  if (!isObject(raw)) return "malformed";
  if (raw.alg !== "RS256") return "algorithm";
  if ("crit" in raw) return "malformed";
  return typeof raw.kid === "string" && raw.kid !== "" ? { kid: raw.kid } : "malformed";
}

/** Pure: the claims of a token whose signature already verified, checked against the config at `nowS`. */
function checkClaims(claims: Claims, config: ClerkConfig, nowS: number): Verified {
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return no("malformed");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf))) return no("malformed");
  if (nowS > claims.exp + CLOCK_SKEW_S) return no("expired");
  if (typeof claims.nbf === "number" && nowS + CLOCK_SKEW_S < claims.nbf) return no("not_yet_valid");
  if (claims.iss !== config.issuer) return no("issuer");
  if (typeof claims.azp !== "string" || !config.authorizedParties.includes(claims.azp)) return no("authorized_party");
  if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > SUBJECT_MAX) return no("subject");
  return { ok: true, subject: claims.sub };
}

type KeySet = { readonly keys: ReadonlyMap<string, CryptoKey>; readonly fetchedAt: number };

async function importKeys(body: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  if (!isObject(body) || !Array.isArray(body.keys)) throw new Error("JWKS has no keys array");
  for (const jwk of body.keys) {
    if (!isObject(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, RSA, false, ["verify"]));
    } catch {
      // a key that does not import cannot verify anything; the others still can
    }
  }
  return keys;
}

export function createClerkVerifier(config: ClerkConfig, options: VerifierOptions = {}): Verifier {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const minRefetchMs = options.minRefetchMs ?? MIN_REFETCH_MS;
  const maxKeyAgeMs = options.maxKeyAgeMs ?? MAX_KEY_AGE_MS;
  let current: KeySet | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | null = null;

  const fresh = (): KeySet | null => (current !== null && now() - current.fetchedAt <= maxKeyAgeMs ? current : null);

  function refresh(): Promise<void> {
    if (pending) return pending;
    if (now() - lastAttempt < minRefetchMs) return Promise.resolve();
    lastAttempt = now();
    pending = (async () => {
      try {
        const res = await doFetch(config.jwksUrl, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
        current = { keys: await importKeys(await res.json()), fetchedAt: now() };
      } catch {
        // keep what we had; `fresh` decides whether it may still be used
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  async function keyFor(kid: string): Promise<CryptoKey | "keys_unavailable" | "unknown_key"> {
    if (!fresh()?.keys.has(kid)) await refresh();
    const keys = fresh();
    if (keys === null) return "keys_unavailable";
    return keys.keys.get(kid) ?? "unknown_key";
  }

  return {
    async verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return no("malformed");
      const [h, p, s] = parts as [string, string, string];
      const header = parseHeader(segmentJson(h));
      if (typeof header === "string") return no(header);
      const key = await keyFor(header.kid);
      if (typeof key === "string") return no(key);
      const signed = await crypto.subtle.verify(RSA, key, Buffer.from(s, "base64url"), utf8.encode(`${h}.${p}`));
      if (!signed) return no("signature");
      const claims = segmentJson(p);
      return isObject(claims) ? checkClaims(claims, config, now() / 1000) : no("malformed");
    },
  };
}

/** The Frontend API host a publishable key names (`pk_test_` or `pk_live_`, then base64 of `<host>$`), or null. */
export function frontendApiOf(publishableKey: string): string | null {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/]+={0,2})$/.exec(publishableKey);
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  if (!decoded.endsWith("$")) return null;
  const host = decoded.slice(0, -1);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(host) ? host.toLowerCase() : null;
}

export const clerkScriptUrl = (frontendApi: string) => `https://${frontendApi}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`;
export const clerkUiScriptUrl = (frontendApi: string) => `https://${frontendApi}/npm/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js`;
