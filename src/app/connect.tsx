/**
 * Hosted only: connecting this browser's extension to the signed-in account, and the account's connected browsers.
 *
 * The connect page asks the backend for a one-time code and hands it to the extension with
 * `chrome.runtime.sendMessage(<extension id>, ...)`. Chrome gives a page `chrome.runtime` only when an installed
 * extension lists the page under `externally_connectable`, so no `chrome.runtime`, or no answer from that id, means the
 * extension is not installed here. The extension trades the code for its own device token; the page never sees one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppApi } from "./api";
import type { DeviceId } from "../shared/ids";
import type { ConnectMessage, ConnectReply } from "../shared/wire";
import { ErrorNote, Link, useAsync } from "./ui";
import { objectFrame } from "./room-object";

/** Where friends install the extension. A placeholder until the listing is published: the store's address for the pinned id. */
export const storeListing = (extensionId: string) => `https://chromewebstore.google.com/detail/${encodeURIComponent(extensionId)}`;

/** The pinned extension's id, which the hosted page carries; null on the local page. */
export const extensionIdOf = (doc: Document): string | null => doc.querySelector<HTMLMetaElement>('meta[name="afterclass-extension-id"]')?.content ?? null;

/** The part of `chrome.runtime` a web page can reach. */
export type PageRuntime = {
  sendMessage(extensionId: string, message: ConnectMessage, callback: (reply: unknown) => void): void;
  readonly lastError?: unknown;
};

export const pageRuntime = (): PageRuntime | null => {
  const runtime = (globalThis as { chrome?: { runtime?: Partial<PageRuntime> } }).chrome?.runtime;
  return typeof runtime?.sendMessage === "function" ? (runtime as PageRuntime) : null;
};

export type ConnectOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "not_installed" }
  | { readonly kind: "no_answer" }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

const isReply = (v: unknown): v is ConnectReply =>
  typeof v === "object" && v !== null && ((v as { ok?: unknown }).ok === true || ((v as { ok?: unknown }).ok === false && typeof (v as { error?: unknown }).error === "string"));

/** One message to the extension. An unknown or missing extension makes Chrome set `lastError`; a reply never sent is `no_answer` after `timeoutMs`. */
export function sendToExtension(runtime: PageRuntime | null, extensionId: string, message: ConnectMessage, timeoutMs = 20_000): Promise<ConnectOutcome> {
  if (runtime === null) return Promise.resolve({ kind: "not_installed" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "no_answer" }), timeoutMs);
    const done = (outcome: ConnectOutcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    try {
      runtime.sendMessage(extensionId, message, (reply) => {
        if (runtime.lastError !== undefined && runtime.lastError !== null) return done({ kind: "not_installed" });
        if (!isReply(reply)) return done({ kind: "no_answer" });
        done(reply.ok ? { kind: "connected" } : { kind: "refused", detail: reply.error });
      });
    } catch {
      done({ kind: "not_installed" });
    }
  });
}

/**
 * The whole connect: a code for this account, then the code to the extension. `alive` is checked after the code
 * arrives, so a code made for an account that has since signed out is never handed to the extension.
 */
export async function connectExtension(deps: {
  readonly api: Pick<AppApi, "createConnectCode">;
  readonly extensionId: string;
  readonly label: string;
  readonly runtime: PageRuntime | null;
  readonly alive: () => boolean;
}): Promise<ConnectOutcome | null> {
  if (deps.runtime === null) return { kind: "not_installed" };
  let code: string;
  try {
    ({ code } = await deps.api.createConnectCode(deps.label));
  } catch (e) {
    return { kind: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!deps.alive()) return null;
  return sendToExtension(deps.runtime, deps.extensionId, { type: "afterclass_connect", code });
}

/** How the connected browser is named in the list, from what the browser says about itself. */
export function browserLabel(nav: { readonly userAgent: string; readonly userAgentData?: { readonly platform?: string } }): string {
  const platform = nav.userAgentData?.platform || nav.userAgent;
  const os = /windows/i.test(platform) ? "Windows" : /cros|chrome ?os/i.test(platform) ? "ChromeOS" : /mac/i.test(platform) ? "macOS" : /android/i.test(platform) ? "Android" : /linux/i.test(platform) ? "Linux" : null;
  return os === null ? "Chrome" : `Chrome on ${os}`;
}

type State = { readonly kind: "ready" } | { readonly kind: "connecting" } | ConnectOutcome;

function Outcome({ state, extensionId }: { readonly state: State; readonly extensionId: string }) {
  switch (state.kind) {
    case "ready":
    case "connecting":
      return null;
    case "connected":
      return (
        <div className="note" role="status">
          <p>This browser's extension is connected. Lectures you capture in this browser now go to your account.</p>
          <p><Link to={{ page: "home" }}>Go to your lectures</Link></p>
        </div>
      );
    case "not_installed":
      return (
        <div className="note note-error" role="alert">
          <p>The After Class extension is not installed in this browser.</p>
          <p><a href={storeListing(extensionId)} target="_blank" rel="noreferrer">Get it from the Chrome Web Store</a>, then come back and press the button again.</p>
        </div>
      );
    case "no_answer":
      return <p className="note note-error" role="alert">The extension did not answer. Reload this page and try again.</p>;
    case "refused":
      return <p className="note note-error" role="alert">The extension could not connect: {state.detail} Press the button to try again.</p>;
    case "failed":
      return <p className="note note-error" role="alert">Connecting could not start: {state.detail} Press the button to try again.</p>;
  }
}

export function ConnectExtensionScreen({ api, extensionId, runtime = pageRuntime(), label = browserLabel(navigator) }: {
  readonly api: AppApi;
  readonly extensionId: string | null;
  readonly runtime?: PageRuntime | null;
  readonly label?: string;
}) {
  const [state, setState] = useState<State>({ kind: "ready" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const connect = () => {
    if (!extensionId) return;
    setState({ kind: "connecting" });
    void connectExtension({ api, extensionId, label, runtime, alive: () => alive.current }).then((outcome) => {
      if (outcome !== null && alive.current) setState(outcome);
    });
  };
  return (
    <main className="notebook-page connect-page room-paper" {...objectFrame("source")}>
      <header className="page-heading"><div><p className="page-kicker">Extension</p><h1>Connect this browser</h1></div><nav aria-label="Connect navigation"><Link to={{ page: "home" }}>Your lectures</Link><Link to={{ page: "usage" }}>Connected browsers</Link></nav></header>
      <div className="record-section">
        {extensionId === null ? (
          <p>The local app does not connect browsers. Paste the pairing token into the extension's options instead.</p>
        ) : extensionId === "" ? (
          <p className="note note-error" role="alert">This server does not name its extension yet, so no browser can connect.</p>
        ) : (
          <>
            <p className="capture-summary">The After Class extension in this browser will send the lectures you capture to your account. You can disconnect it any time from Connected browsers.</p>
            <button type="button" className="page-primary" disabled={state.kind === "connecting"} onClick={connect}>
              {state.kind === "connecting" ? "Connecting..." : "Connect this browser's extension"}
            </button>
            <Outcome state={state} extensionId={extensionId} />
          </>
        )}
      </div>
    </main>
  );
}

const dateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The account's connected browsers, each with Revoke. A revoked browser's extension has to connect again. */
export function ConnectedBrowsers({ api }: { readonly api: AppApi }) {
  const devices = useAsync(useCallback(() => api.devices(), [api]));
  const [revoking, setRevoking] = useState<DeviceId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revoke = (id: DeviceId) => {
    setRevoking(id);
    setError(null);
    api.revokeDevice(id).then(
      () => { setRevoking(null); devices.reload(); },
      (e: unknown) => { setRevoking(null); setError(e instanceof Error ? e.message : String(e)); },
    );
  };
  return (
    <div className="record-section connected-browsers">
      <h2>Connected browsers</h2>
      <ErrorNote error={devices.error ?? error} retry={devices.reload} />
      {devices.data === null && devices.error === null && <p className="page-loading" role="status">Opening the list of browsers...</p>}
      {devices.data !== null && devices.data.length === 0 && <p className="muted">No browser is connected.</p>}
      {devices.data !== null && devices.data.length > 0 && (
        <ul className="device-list">
          {devices.data.map((d) => (
            <li key={d.id}>
              <span><strong>{d.label}</strong> <span className="muted">connected {dateTime(d.createdMs)}{d.lastUsedMs === null ? ", not used yet" : `, last used ${dateTime(d.lastUsedMs)}`}</span></span>
              <button type="button" disabled={revoking !== null} onClick={() => revoke(d.id)}>{revoking === d.id ? "Revoking..." : "Revoke"}</button>
            </li>
          ))}
        </ul>
      )}
      <p><Link to={{ page: "connect_extension" }}>Connect this browser</Link></p>
    </div>
  );
}
