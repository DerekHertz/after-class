/**
 * Hosted sign-in. The backend's hosted page carries ClerkJS as `<script data-clerk-publishable-key>`, which sets
 * `window.Clerk`. The local page has no such script and keeps the pairing token. Only the part of ClerkJS used here is
 * typed: load, the signed-in user and session, the hosted sign-in UI, sign-out and change notifications.
 */
import { useEffect, useRef } from "react";
import { objectFrame } from "./room-object";

export type ClerkClient = {
  load(): Promise<void>;
  readonly user: { readonly id: string } | null | undefined;
  readonly session: { getToken(): Promise<string | null> } | null | undefined;
  mountSignIn(node: HTMLDivElement, props?: { readonly fallbackRedirectUrl?: string }): void;
  unmountSignIn(node: HTMLDivElement): void;
  signOut(): Promise<void>;
  addListener(listener: () => void): () => void;
};

const LOAD_TIMEOUT_MS = 20_000;

/** The ClerkJS script the hosted page carries, or null on the local page. */
export const clerkScript = (doc: Document): HTMLScriptElement | null => doc.querySelector<HTMLScriptElement>("script[data-clerk-publishable-key]");

/** Resolves once ClerkJS has loaded and restored any session. A script that errors or never arrives rejects. */
export function loadClerk(script: HTMLScriptElement, host: { Clerk?: ClerkClient } = globalThis as { Clerk?: ClerkClient }): Promise<ClerkClient> {
  const arrived = new Promise<ClerkClient>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sign-in did not load")), LOAD_TIMEOUT_MS);
    const ready = () => {
      clearTimeout(timer);
      if (host.Clerk) resolve(host.Clerk);
      else reject(new Error("sign-in did not load"));
    };
    if (host.Clerk) return ready();
    script.addEventListener("load", ready, { once: true });
    script.addEventListener("error", ready, { once: true });
  });
  return arrived.then(async (clerk) => {
    await clerk.load();
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

export function SignInScreen({ clerk }: { readonly clerk: ClerkClient }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = mount.current!;
    clerk.mountSignIn(node, { fallbackRedirectUrl: location.href });
    return () => clerk.unmountSignIn(node);
  }, [clerk]);
  return (
    <main className="notebook-page room-paper sign-in-page" {...objectFrame("source")}>
      <h1>Sign in to After Class</h1>
      <p>Sign in with Google to see your lectures and review them.</p>
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
