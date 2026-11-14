/**
 * Hosted sign-in. The backend's hosted page carries Clerk's UI as `<script data-clerk-ui>`, which sets
 * `window.__internal_ClerkUICtor`, and ClerkJS as `<script data-clerk-publishable-key>`, which sets `window.Clerk`.
 * ClerkJS 6 mounts its sign-in only when its first `load` is handed that UI. The local page has no such scripts and
 * keeps the pairing token. Only the part of ClerkJS used here is typed: load, the signed-in user and session, the
 * hosted sign-in UI, sign-out and change notifications.
 */
import { Component, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { objectFrame } from "./room-object";

export type ClerkClient = {
  load(options: { readonly ui: { readonly ClerkUI: unknown } }): Promise<void>;
  readonly user: { readonly id: string } | null | undefined;
  readonly session: { getToken(): Promise<string | null> } | null | undefined;
  mountSignIn(node: HTMLDivElement, props?: { readonly fallbackRedirectUrl?: string }): void;
  unmountSignIn(node: HTMLDivElement): void;
  signOut(): Promise<void>;
  addListener(listener: () => void): () => void;
};

const LOAD_TIMEOUT_MS = 20_000;

export type ClerkScripts = { readonly clerk: HTMLScriptElement; readonly ui: HTMLScriptElement | null };
export type ClerkHost = { Clerk?: ClerkClient; __internal_ClerkUICtor?: unknown };

/** The ClerkJS and Clerk UI scripts the hosted page carries, or null on the local page. */
export function clerkScripts(doc: Document): ClerkScripts | null {
  const clerk = doc.querySelector<HTMLScriptElement>("script[data-clerk-publishable-key]");
  return clerk && { clerk, ui: doc.querySelector<HTMLScriptElement>("script[data-clerk-ui]") };
}

/** Resolves once `script` has run or failed, or at once when what it sets is already there or there is no script. */
const settled = (script: HTMLScriptElement | null, arrived: boolean) =>
  arrived || script === null
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => resolve(), { once: true });
    });

/**
 * Resolves once ClerkJS has loaded with its UI and restored any session. A script that errors or never arrives, or a
 * UI that is missing once both have run, rejects.
 */
export function loadClerk(scripts: ClerkScripts, host: ClerkHost = globalThis as ClerkHost): Promise<ClerkClient> {
  const arrived = new Promise<{ clerk: ClerkClient; ClerkUI: unknown }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sign-in did not load")), LOAD_TIMEOUT_MS);
    void Promise.all([settled(scripts.ui, host.__internal_ClerkUICtor !== undefined), settled(scripts.clerk, host.Clerk !== undefined)]).then(() => {
      clearTimeout(timer);
      const { Clerk: clerk, __internal_ClerkUICtor: ClerkUI } = host;
      if (clerk && ClerkUI !== undefined) resolve({ clerk, ClerkUI });
      else reject(new Error("sign-in did not load"));
    });
  });
  return arrived.then(async ({ clerk, ClerkUI }) => {
    await clerk.load({ ui: { ClerkUI } });
    return clerk;
  });
}

/**
 * The session token for one request of `userId`'s account. It refuses once another account, or nobody, is signed in,
 * before and after asking Clerk, so no request of one account carries another account's token.
 */
export async function accountToken(clerk: ClerkClient, userId: string): Promise<string> {
  const stillSignedIn = () => {
    if (clerk.user?.id !== userId) throw new Error("This account is signed out.");
  };
  stillSignedIn();
  const token = (await clerk.session?.getToken()) ?? "";
  stillSignedIn();
  return token;
}

/** Shows `SignInUnavailable` in place of a sign-in screen that threw, such as Clerk refusing to mount its card. */
class SignInBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <SignInUnavailable /> : this.props.children;
  }
}

export function SignInScreen({ clerk }: { readonly clerk: ClerkClient }) {
  return (
    <SignInBoundary>
      <SignInCard clerk={clerk} />
    </SignInBoundary>
  );
}

function SignInCard({ clerk }: { readonly clerk: ClerkClient }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = mount.current!;
    clerk.mountSignIn(node, { fallbackRedirectUrl: location.href });
    return () => clerk.unmountSignIn(node);
  }, [clerk]);
  return (
    <main className="notebook-page room-paper sign-in-page" {...objectFrame("source")}>
      <h1>Sign in to After Class</h1>
      <p>Sign in to see your lectures and review them.</p>
      <div ref={mount} className="sign-in-widget" />
    </main>
  );
}

export function SignInUnavailable() {
  return (
    <main className="notebook-page room-paper sign-in-page" {...objectFrame("source")}>
      <h1>Sign-in could not load</h1>
      <p role="alert">Check your connection, then reload this page.</p>
    </main>
  );
}

export function SignOutButton({ clerk }: { readonly clerk: ClerkClient }) {
  return <button type="button" className="sign-out" onClick={() => void clerk.signOut()}>Sign out</button>;
}
