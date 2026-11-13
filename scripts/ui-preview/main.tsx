import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AppearanceProvider } from "../../src/app/appearance";
import { SceneShell } from "../../src/app/scene";
import { ReviewScreen } from "../../src/app/review";
import { CaptureScreen } from "../../src/app/capture";
import { RecordScreen, UsageScreen } from "../../src/app/record";
import { HomeScreen } from "../../src/app/home";
import { Link, usePathname } from "../../src/app/ui";
import { createMemoryUnsent } from "../../src/app/unsent";
import type { AppApi } from "../../src/app/api";
import { createFixture, ids, scenarioFrom, scenarios } from "./fixtures";

const scenario = scenarioFrom(location.search);
const { api: fixtureApi, speech, recordReviewId, continueFixture, dictateFixture, requestLedger } = createFixture(scenario);
/** `?loading=1` holds the first review read open, so the loading screen can be seen and tested. The Finish button releases it. */
let releaseReview: (() => void) | undefined;
const holdReview = new URLSearchParams(location.search).get("loading") === "1";
const api: AppApi = holdReview ? { ...fixtureApi, review: async (id) => { await new Promise<void>((resolve) => { releaseReview = resolve; }); return fixtureApi.review(id); } } : fixtureApi;
const unsent = createMemoryUnsent();
const speaker = { beginTurn() {}, speak() {}, stop() {} };
const clean = new URLSearchParams(location.search).get("clean") === "1";
function Preview() {
  const path = usePathname();
  const calls = useSyncExternalStore(requestLedger.subscribe, requestLedger.snapshot);
  const home = path === "/app/" || path === "/app" || (path === "/" && scenario.startsWith("home"));
  const page = home ? "home" : path.includes("/record") || scenario.startsWith("record") ? "record" : path.includes("/capture") || scenario.startsWith("capture") ? "capture" : path.includes("/usage") || scenario.startsWith("usage") ? "usage" : "review";
  return <>
    <aside className="fixture-toolbar" aria-label="Preview fixtures" hidden={clean}>
      <strong>Deterministic UI fixture</strong><span>No live lecture or model calls.</span>
      <label>Scenario <select value={scenario} onChange={event => { location.href = `/?scenario=${event.target.value}`; }}>{scenarios.map(value => <option key={value}>{value}</option>)}</select></label>
      <button type="button" onClick={() => { continueFixture(); releaseReview?.(); releaseReview = undefined; }}>Finish pending fixture operation</button>
      <button type="button" onClick={dictateFixture}>Simulate speech transcript</button>
      <Link to={{ page: "home" }}>Home</Link>
      <Link to={{ page: "review", id: ids.review }}>Review</Link>
      <Link to={{ page: "capture", id: ids.capture }}>Capture</Link>
      <Link to={{ page: "record", reviewId: null }}>Notebook</Link>
      <details><summary>Request ledger</summary><pre>{calls || "No requests"}</pre></details>
    </aside>
    <AppearanceProvider><SceneShell>
      {page === "home" ? <HomeScreen api={api} /> : page === "capture" ? <CaptureScreen api={api} captureId={ids.capture} /> : page === "record" ? <RecordScreen api={api} reviewId={recordReviewId} /> : page === "usage" ? <UsageScreen api={api} /> : <ReviewScreen api={api} reviewId={ids.review} speaker={speaker} speech={speech} unsent={unsent} />}
    </SceneShell></AppearanceProvider>
  </>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
