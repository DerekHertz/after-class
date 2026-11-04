import { useState } from "react";
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
import { createIndexedDbUnsent } from "./unsent";
import { Link, navigate, usePathname } from "./ui";

/** The backend writes the pairing token into the served HTML; it is never in the URL or in storage. */
function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="afterclass-token"]')?.content;
  return meta ?? (globalThis as { __AFTERCLASS_TOKEN__?: string }).__AFTERCLASS_TOKEN__ ?? "";
}

const api: AppApi = createApi(readToken());
const speaker = browserSpeaker();
const speech = browserSpeechInput();
const unsent = createIndexedDbUnsent();

function Home() {
  const [id, setId] = useState("");
  const valid = parseId("cap", id.trim()) !== null;
  return (
    <main>
      <h1>After Class</h1>
      <p>Open a capture from the extension popup, or paste a capture id.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) navigate({ page: "capture", id: id.trim() });
        }}
      >
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="cap_..." aria-label="Capture id" />{" "}
        <button type="submit" disabled={!valid}>Open</button>
      </form>
      <p><Link to={{ page: "record", reviewId: null }}>Saved record</Link> · <Link to={{ page: "usage" }}>Usage</Link></p>
    </main>
  );
}

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
