// backend/server/auth.ts -- the backend is reachable from every web page in the browser, so it must not trust "localhost".
// Checks, all required (pure function over request headers; unit-tested):
//   1. Host header is exactly 127.0.0.1:<port> or localhost:<port>        (blocks DNS rebinding)
//   2. Origin is absent (curl, tests) OR in the allow-list { chrome-extension://<pinned id>, http://127.0.0.1:<port> (the review app) }
//   3. Authorization: Bearer <pairing token>  -- generated at first run into ~/.config/afterclass/token (0600), pasted once into the
//      extension options page; the review app receives it via a same-origin cookie set when it is served by this same server.
// CORS: respond to preflight only for allow-listed origins; never `*`.
export interface Allowed { readonly origin: "extension" | "review_app" | "none" }
export function authorize(headers: Headers, expected: { readonly port: number; readonly extensionId: string; readonly token: string }): Allowed | { readonly denied: 401 | 403 } {
  throw new Error("not implemented");
}
