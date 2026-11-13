import { useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AppearanceProvider, voiceEnabled } from "./appearance";
import { SceneShell } from "./scene";
import { parseId } from "../shared/ids";
import { createApi } from "./api";
import type { AppApi } from "./api";
import { CaptureScreen } from "./capture";
import { parseRoute } from "./core";
import { RecordScreen, UsageScreen } from "./record";
import { ReviewScreen } from "./review";
import { browserSpeaker, browserSpeechInput } from "./speech";
import { audioElementPlayer, chooseSpeaker, createElevenLabsSpeaker, gateSpeaker, synthPlayback } from "./voice";
import { createIndexedDbUnsent } from "./unsent";
import { Link, usePathname } from "./ui";
import { HomeScreen } from "./home";
import { objectFrame } from "./room-object";
import { SignInScreen, SignInUnavailable, SignOutButton, clerkScript, loadClerk, sessionToken } from "./sign-in";
import type { ClerkClient } from "./sign-in";

/** The backend writes the pairing token into the served HTML; it is never in the URL or in storage. */
function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="afterclass-token"]')?.content;
  return meta ?? (globalThis as { __AFTERCLASS_TOKEN__?: string }).__AFTERCLASS_TOKEN__ ?? "";
}

function NotFound() {
  return (
    <main className="notebook-page room-paper" {...objectFrame("source")}>
      <h1>Page not found</h1>
      <p>That address is not a page in After Class.</p>
      <p><Link to={{ page: "home" }}>Go to the start</Link></p>
    </main>
  );
}

type Services = {
  readonly api: AppApi;
  readonly speaker: ReturnType<typeof gateSpeaker>;
  readonly speech: ReturnType<typeof browserSpeechInput>;
  readonly unsent: ReturnType<typeof createIndexedDbUnsent>;
};

/** One API client and the voice, speech and unsent-turn services that go with it. */
function servicesFor(api: AppApi): Services {
  /** Chat-first: nothing is spoken (and no voice request is made) unless the voice setting is on. */
  const speaker = gateSpeaker(voiceEnabled, () => chooseSpeaker(
    api.voiceAvailable().catch(() => false),
    createElevenLabsSpeaker({
      fetchAudio: (text, signal) => api.speech(text, signal),
      play: audioElementPlayer(),
      fallback: typeof speechSynthesis === "undefined" ? () => ({ done: Promise.resolve(), stop() {} }) : synthPlayback(speechSynthesis),
    }),
    browserSpeaker(),
  ));
  return { api, speaker, speech: browserSpeechInput(), unsent: createIndexedDbUnsent() };
}

function App({ services: { api, speaker, speech, unsent } }: { readonly services: Services }) {
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
      return <UsageScreen api={api} />;
    case "not_found":
      return <NotFound />;
  }
}

/** Signed out: Clerk's sign-in. Signed in: the app, with fresh services per account so nothing carries over between accounts. */
function Hosted({ clerk }: { readonly clerk: ClerkClient }) {
  const userId = useSyncExternalStore((changed) => clerk.addListener(changed), () => clerk.user?.id ?? null);
  const services = useMemo(() => (userId === null ? null : servicesFor(createApi(() => sessionToken(clerk)))), [clerk, userId]);
  return (
    <SceneShell account={services && <SignOutButton clerk={clerk} />}>
      {services ? <App key={userId} services={services} /> : <SignInScreen clerk={clerk} />}
    </SceneShell>
  );
}

const root = createRoot(document.getElementById("root")!);
const script = clerkScript(document);
if (script === null) {
  root.render(<AppearanceProvider><SceneShell><App services={servicesFor(createApi(readToken()))} /></SceneShell></AppearanceProvider>);
} else {
  loadClerk(script).then(
    (clerk) => root.render(<AppearanceProvider><Hosted clerk={clerk} /></AppearanceProvider>),
    () => root.render(<AppearanceProvider><SceneShell><SignInUnavailable /></SceneShell></AppearanceProvider>),
  );
}
