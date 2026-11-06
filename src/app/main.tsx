import { createRoot } from "react-dom/client";
import { AppearanceProvider } from "./appearance";
import { SceneShell } from "./scene";
import { parseId } from "../shared/ids";
import { createApi } from "./api";
import type { AppApi } from "./api";
import { CaptureScreen } from "./capture";
import { parseRoute } from "./core";
import { RecordScreen, UsageScreen } from "./record";
import { ReviewScreen } from "./review";
import { browserSpeaker, browserSpeechInput } from "./speech";
import { audioElementPlayer, chooseSpeaker, createElevenLabsSpeaker, synthPlayback } from "./voice";
import { createIndexedDbUnsent } from "./unsent";
import { Link, usePathname } from "./ui";
import { HomeScreen } from "./home";

/** The backend writes the pairing token into the served HTML; it is never in the URL or in storage. */
function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="afterclass-token"]')?.content;
  return meta ?? (globalThis as { __AFTERCLASS_TOKEN__?: string }).__AFTERCLASS_TOKEN__ ?? "";
}

const api: AppApi = createApi(readToken());
const chromeVoice = browserSpeaker();
const speaker = chooseSpeaker(
  api.voiceAvailable().catch(() => false),
  createElevenLabsSpeaker({
    fetchAudio: (text, signal) => api.speech(text, signal),
    play: audioElementPlayer(),
    fallback: typeof speechSynthesis === "undefined" ? () => ({ done: Promise.resolve(), stop() {} }) : synthPlayback(speechSynthesis),
  }),
  chromeVoice,
);
const speech = browserSpeechInput();
const unsent = createIndexedDbUnsent();

const Home = () => <HomeScreen api={api} />;

function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <p>That address is not a page in After Class.</p>
      <p><Link to={{ page: "home" }}>Go to the start</Link></p>
    </main>
  );
}

function App() {
  const route = parseRoute(usePathname());
  switch (route.page) {
    case "home":
      return <Home />;
    case "capture": {
      const id = parseId("cap", route.id);
      return id ? <CaptureScreen api={api} captureId={id} /> : <Home />;
    }
    case "review": {
      const id = parseId("rvw", route.id);
      return id ? <ReviewScreen key={id} api={api} reviewId={id} speaker={speaker} speech={speech} unsent={unsent} /> : <Home />;
    }
    case "record":
      return <RecordScreen api={api} reviewId={route.reviewId === null ? null : parseId("rvw", route.reviewId)} />;
    case "usage":
      return <UsageScreen api={api} />;
    case "not_found":
      return <NotFound />;
  }
}

createRoot(document.getElementById("root")!).render(<AppearanceProvider><SceneShell><App /></SceneShell></AppearanceProvider>);
