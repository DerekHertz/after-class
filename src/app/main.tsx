import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AppearanceProvider, voiceEnabled } from "./appearance";
import { SceneShell } from "./scene";
import { parseId } from "../shared/ids";
import { followAccount, servicesFor } from "./account";
import type { Accounts, Platform, Services } from "./account";
import { CaptureScreen } from "./capture";
import { parseRoute } from "./core";
import { RecordScreen, UsageScreen } from "./record";
import { ReviewScreen } from "./review";
import { browserSpeaker, browserSpeechInput } from "./speech";
import { audioElementPlayer, synthPlayback } from "./voice";
import { LOCAL_UNSENT_DB, browserIdb } from "./unsent";
import { Link, usePathname } from "./ui";
import { HomeScreen } from "./home";
import { objectFrame } from "./room-object";
import { SignInScreen, SignInUnavailable, SignOutButton, clerkScripts, loadClerk } from "./sign-in";
import { ConnectExtensionScreen, extensionIdOf } from "./connect";
import type { ClerkClient } from "./sign-in";

/** The backend writes the pairing token into the served HTML; it is never in the URL or in storage. */
function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="afterclass-token"]')?.content;
  return meta ?? (globalThis as { __AFTERCLASS_TOKEN__?: string }).__AFTERCLASS_TOKEN__ ?? "";
}

const browser: Platform = {
  voiceEnabled,
  play: audioElementPlayer(),
  fallback: typeof speechSynthesis === "undefined" ? () => ({ done: Promise.resolve(), stop() {} }) : synthPlayback(speechSynthesis),
  browserSpeaker,
  speechInput: browserSpeechInput,
  idb: browserIdb(),
};

function NotFound() {
  return (
    <main className="notebook-page room-paper" {...objectFrame("source")}>
      <h1>Page not found</h1>
      <p>That address is not a page in After Class.</p>
      <p><Link to={{ page: "home" }}>Go to the start</Link></p>
    </main>
  );
}

/** `extensionId`: hosted, the pinned extension the connect page reaches ("" when the server names none); null locally. */
function App({ services: { api, speaker, speech, unsent }, extensionId }: { readonly services: Services; readonly extensionId: string | null }) {
  const route = parseRoute(usePathname());
  switch (route.page) {
    case "home":
      return <HomeScreen api={api} />;
    case "capture": {
      const id = parseId("cap", route.id);
      return id ? <CaptureScreen api={api} captureId={id} /> : <HomeScreen api={api} />;
    }
    case "review": {
      const id = parseId("rvw", route.id);
      return id ? <ReviewScreen key={id} api={api} reviewId={id} speaker={speaker} speech={speech} unsent={unsent} /> : <HomeScreen api={api} />;
    }
    case "record":
      return <RecordScreen api={api} reviewId={route.reviewId === null ? null : parseId("rvw", route.reviewId)} />;
    case "usage":
      return <UsageScreen api={api} hosted={extensionId !== null} />;
    case "connect_extension":
      return <ConnectExtensionScreen api={api} extensionId={extensionId} />;
    case "not_found":
      return <NotFound />;
  }
}

/** Signed out: Clerk's sign-in. Signed in: the app on that account's services, which `followAccount` disposes when the account changes. */
function Hosted({ clerk, accounts }: { readonly clerk: ClerkClient; readonly accounts: Accounts }) {
  const account = useSyncExternalStore(accounts.subscribe, accounts.current);
  return (
    <SceneShell account={account && <SignOutButton clerk={clerk} />}>
      {account ? <App key={account.userId} services={account.services} extensionId={extensionIdOf(document) ?? ""} /> : <SignInScreen clerk={clerk} />}
    </SceneShell>
  );
}

const root = createRoot(document.getElementById("root")!);
const scripts = clerkScripts(document);
if (scripts === null) {
  root.render(<AppearanceProvider><SceneShell><App services={servicesFor(readToken(), LOCAL_UNSENT_DB, browser)} extensionId={null} /></SceneShell></AppearanceProvider>);
} else {
  loadClerk(scripts).then(
    (clerk) => root.render(<AppearanceProvider><Hosted clerk={clerk} accounts={followAccount(clerk, browser)} /></AppearanceProvider>),
    () => root.render(<AppearanceProvider><SceneShell><SignInUnavailable /></SceneShell></AppearanceProvider>),
  );
}
