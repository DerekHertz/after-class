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
import { SignOutButton } from "../../src/app/sign-in";
import type { ClerkClient } from "../../src/app/sign-in";
import { createFixture, ids, scenarioFrom, scenarios } from "./fixtures";
import { clearReaction, play } from "../../src/app/room/reaction-store";
import type { Gesture } from "../../src/app/room/reactions";
import { ROOM_IDS, TOPICS_PER_UNLOCK, UNLOCKS_PER_ROOM, slotIds } from "../../src/app/room/progress";
import type { UnlockId } from "../../src/app/room/progress";
import { UNLOCK_ART } from "../../src/app/room/unlocks";
import type { ConceptId, ObservationId } from "../../src/shared/ids";

/** Plays a companion gesture in the room, for browser tests and screenshots: `afterClassGesture("hop")` in the console. */
(window as unknown as { afterClassGesture: (gesture: Gesture) => void }).afterClassGesture = (gesture) => play({ gesture, effects: [], instant: false });
/** Clears the reaction as a room or companion switch does, so a test can cut a gesture short. */
(window as unknown as { afterClassClearReaction: () => void }).afterClassClearReaction = clearReaction;

const scenario = scenarioFrom(location.search);
const { api: fixtureApi, speech, recordReviewId, continueFixture, dictateFixture, requestLedger } = createFixture(scenario);
/** `?loading=1` holds the first review read open, so the loading screen can be seen and tested. The Finish button releases it. */
let releaseReview: (() => void) | undefined;
const holdReview = new URLSearchParams(location.search).get("loading") === "1";
const heldApi: AppApi = holdReview ? { ...fixtureApi, review: async (id) => { await new Promise<void>((resolve) => { releaseReview = resolve; }); return fixtureApi.review(id); } } : fixtureApi;
/**
 * `?unlocks=<url>` opens every slot and draws each with the picture at `<url>?<slot>`, for browser tests, as the art step has
 * made no object yet. The record gains enough topics explained independently to open them all.
 */
const unlockArt = new URLSearchParams(location.search).get("unlocks");
if (unlockArt !== null) Object.assign(UNLOCK_ART as Record<UnlockId, string>, Object.fromEntries(ROOM_IDS.flatMap(slotIds).map((slot) => [slot, `${unlockArt}?${slot}`])));
const api: AppApi = unlockArt === null ? heldApi : {
  ...heldApi,
  record: async (query) => {
    const record = await heldApi.record(query);
    const [template] = record.observations;
    if (template === undefined) return record;
    const opened = Array.from({ length: TOPICS_PER_UNLOCK * UNLOCKS_PER_ROOM }, (_, i) => ({ ...template, id: `${template.id}-unlock-${i}` as ObservationId, status: "independent" as const, conceptIds: [`unlock-topic-${i}` as ConceptId] }));
    return { ...record, observations: [...record.observations, ...opened] };
  },
};
const unsent = createMemoryUnsent();
const speaker = { beginTurn() {}, speak() {}, stop() {} };
const clean = new URLSearchParams(location.search).get("clean") === "1";
/** `?account=1` previews the hosted app: the sign-out control, so its place in each layout can be checked, and the learner's usage page. */
const hosted = new URLSearchParams(location.search).get("account") === "1";
const account = hosted ? <SignOutButton clerk={{ signOut: async () => {} } as unknown as ClerkClient} /> : undefined;
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
    <AppearanceProvider><SceneShell account={account}>
      {page === "home" ? <HomeScreen api={api} extensionId={hosted ? "abcdefghijklmnopabcdefghijklmnop" : null} /> : page === "capture" ? <CaptureScreen api={api} captureId={ids.capture} /> : page === "record" ? <RecordScreen api={api} reviewId={recordReviewId} /> : page === "usage" ? <UsageScreen api={api} hosted={hosted} /> : <ReviewScreen api={api} reviewId={ids.review} speaker={speaker} speech={speech} unsent={unsent} />}
    </SceneShell></AppearanceProvider>
  </>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
