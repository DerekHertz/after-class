/**
 * `bun run scripts/hosted-preview.ts`: the real backend in hosted mode, in replay mode, on a temporary data directory,
 * behind a fake Clerk. Nothing reaches Clerk or a model provider. e2e/hosted-sign-in.spec.ts drives it.
 *
 *   AFTERCLASS_HOSTED_PREVIEW_PORT (default 8774)  the backend: app and API on http://127.0.0.1:<port>
 *   AFTERCLASS_FAKE_CLERK_PORT (default 8775)      the fake Clerk: the JWKS, a stub ClerkJS and a token endpoint
 *
 * The browser asks for ClerkJS at https://clerk.afterclass.test, the host the publishable key names; the spec routes
 * that host to the fake Clerk. The stub ClerkJS is labelled as a test stub on screen, and its "sign in" mints a real
 * RS256 session token that the backend verifies exactly as it would Clerk's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLERK_JS_VERSION } from "../src/backend/clerk";
import { mainHosted } from "../src/backend/main";

const port = Number(process.env.AFTERCLASS_HOSTED_PREVIEW_PORT ?? 8774);
const clerkPort = Number(process.env.AFTERCLASS_FAKE_CLERK_PORT ?? 8775);
const origin = `http://127.0.0.1:${port}`;
const issuer = "https://clerk.afterclass.test";
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const pair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
const { n, e } = await crypto.subtle.exportKey("jwk", pair.publicKey);
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function sessionToken(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "RS256", kid: "preview", typ: "JWT" })}.${b64({ iss: issuer, azp: origin, sub, iat: now, nbf: now - 1, exp: now + 60 })}`;
  return `${input}.${Buffer.from(await crypto.subtle.sign(RSA, pair.privateKey, new TextEncoder().encode(input))).toString("base64url")}`;
}

const STUB = `(() => {
  const listeners = new Set();
  const KEY = "afterclass-stub-clerk-user";
  const clerk = {
    user: null,
    session: null,
    async load() { sync(); },
    mountSignIn(node) {
      node.innerHTML = '<div class="stub-clerk"><p><strong>Test stub</strong>, not Clerk. Clerk\\'s sign-in card appears here.</p><button type="button">Continue with Google</button></div>';
      node.querySelector("button").addEventListener("click", () => { sessionStorage.setItem(KEY, "user_preview"); sync(); });
    },
    unmountSignIn(node) { node.innerHTML = ""; },
    async signOut() { sessionStorage.removeItem(KEY); sync(); },
    addListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  function sync() {
    const sub = sessionStorage.getItem(KEY);
    clerk.user = sub ? { id: sub } : null;
    clerk.session = sub ? { getToken: () => fetch("https://clerk.afterclass.test/token?sub=" + sub).then((r) => r.text()) } : null;
    for (const listener of listeners) listener();
  }
  window.Clerk = clerk;
})();`;

const fakeClerk = Bun.serve({
  hostname: "127.0.0.1",
  port: clerkPort,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [{ kty: "RSA", n, e, kid: "preview", alg: "RS256", use: "sig" }] });
    if (url.pathname === `/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`) return new Response(STUB, { headers: { "Content-Type": "text/javascript" } });
    if (url.pathname === "/token") return new Response(await sessionToken(url.searchParams.get("sub") ?? ""), { headers: { "Access-Control-Allow-Origin": origin } });
    return new Response("not found", { status: 404 });
  },
});

const dataDir = mkdtempSync(join(tmpdir(), "afterclass-hosted-preview-"));
const running = await mainHosted({
  port,
  appDir: resolve(import.meta.dir, "../dist/hosted-preview-app"),
  env: {
    AFTERCLASS_AUTH: "clerk",
    AFTERCLASS_MODE: "replay",
    AFTERCLASS_DATA: dataDir,
    AFTERCLASS_CONFIG_DIR: join(dataDir, "config"),
    AFTERCLASS_CLERK_ISSUER: issuer,
    AFTERCLASS_CLERK_JWKS_URL: `http://127.0.0.1:${clerkPort}/.well-known/jwks.json`,
    AFTERCLASS_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.afterclass.test$").toString("base64")}`,
    AFTERCLASS_PUBLIC_ORIGIN: origin,
  },
  error: () => {},
});

// One stopped lecture for the signed-in account, so its home page has something to show.
const facts = [
  { kind: "control", action: "start", reason: "user" },
  { kind: "source", videoId: "dQw4w9WgXcQ", title: "Locks - Operating Systems", channelName: "Prof", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", durationS: 3000 },
  { kind: "span", videoId: "dQw4w9WgXcQ", start: 0, end: 600, rate: 1, tabVisible: true, wallDurationMs: 600_000 },
  { kind: "control", action: "stop", reason: "user" },
].map((f, clientSeq) => ({ ...f, clientSeq, wallMs: 1_000 + clientSeq }));
const seeded = await fetch(`${origin}/ingest`, {
  method: "POST",
  headers: { Authorization: `Bearer ${await sessionToken("user_preview")}`, "Content-Type": "application/json" },
  body: JSON.stringify({ captureId: "cap_aaaaaaaaaaaaaaaaaaaaaaaaaa", facts }),
});
if (!seeded.ok) throw new Error(`seeding the preview lecture failed: ${seeded.status} ${await seeded.text()}`);

console.log(`Hosted preview with a fake Clerk. Replay mode, temporary data. ${origin}`);
const shutdown = () =>
  void running.stop().then(() => {
    void fakeClerk.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
