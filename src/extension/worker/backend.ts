/**
 * Which backend this build talks to, fixed at build time (scripts/build-extension.ts).
 *   local    http://127.0.0.1:4317 with the pairing token pasted into the options page, as before.
 *   hosted   AFTERCLASS_EXT_BACKEND, such as https://useafterclass.com. The extension connects through the web app's
 *            connect page and sends a device token it keeps in chrome.storage.local.
 */
export type Backend = { readonly kind: "local" | "hosted"; readonly origin: string };

export const LOCAL_ORIGIN = "http://127.0.0.1:4317";

declare const __AFTERCLASS_HOSTED_ORIGIN__: string | null;

/** typeof: the unbundled source (tests, tsc) has no such global, and that means a local build. A test sets the global to load a hosted worker. */
export function backend(): Backend {
  const hosted = typeof __AFTERCLASS_HOSTED_ORIGIN__ === "string" ? __AFTERCLASS_HOSTED_ORIGIN__ : null;
  return hosted === null ? { kind: "local", origin: LOCAL_ORIGIN } : { kind: "hosted", origin: hosted };
}

/** The web app page that connects this browser's extension to the signed-in account. */
export const connectPageUrl = (backend: Backend): string => `${backend.origin}/app/connect-extension`;

/** Where review links from the backend may point: the local backend under either name, or the hosted origin. */
export const reviewOrigins = (backend: Backend): ReadonlySet<string> =>
  new Set(backend.kind === "local" ? [LOCAL_ORIGIN, "http://localhost:4317"] : [backend.origin]);
