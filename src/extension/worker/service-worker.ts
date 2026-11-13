/**
 * MV3 service worker (W2). Single owner of two things:
 *   1. Capture CONTROL per tab (the user's intent: capturing / paused / stopped).
 *   2. The OUTBOX: every fact gets (captureId, clientSeq) here and is persisted
 *      in IndexedDB before upload, so a SW restart or backend outage loses nothing
 *      and a resend is idempotent on the backend.
 *
 * Why route through the SW instead of fetching from the content script: content
 * script fetches carry the youtube.com origin, and the pairing token must never
 * be reachable from the page.
 *
 * A hosted build (backend.ts) has no pairing token. The web app's connect page hands
 * the worker a one-time code (onMessageExternal, from that origin only); the worker
 * trades it for a device token, keeps it in chrome.storage.local with the account it
 * belongs to, and sends it as its bearer. A 401 empties the token and the popup says
 * Reconnect. Each capture belongs to the account connected when it started, and its
 * facts go up only while that account is connected.
 *
 * Control state is in chrome.storage.session (survives SW restarts, not browser
 * restarts: a browser restart ends capture, which is the visible, honest outcome).
 * The policy itself is in control.ts and the upload loop in outbox.ts, both pure.
 */
import type { CaptureId } from "../../shared/ids";
import type { CaptureFactBody, InviteAnswer, InviteState } from "../../shared/domain";
import type { ConnectReply, IngestAck } from "../../shared/wire";
import { backend } from "./backend";
import {
  FLUSH_TIMEOUT_MS, acceptsConnectSender, acceptsFact, badgeFor, closingSpanGap, connectionOf, isConnectMessage, isStoredConnection, isWatchUrl, mayUpload,
  playbackRecovered, safeReviewUrl, transition,
} from "./control";
import type {
  Connection, ConnectionRequest, ControlEvent, DeadLetterSummary, FromContent, OptionsRequest, PopupRequest, StoredConnection, TabCaptureState, ToContent,
} from "./control";
import { classifyStatus, createFlusher, createIdbOutbox, isIngestAck } from "./outbox";
import type { FlushOutcome, Transport } from "./outbox";

export { transition } from "./control";
export type { PopupRequest, TabCaptureState } from "./control";

const BACKEND = backend();
const TOKEN_KEY = "pairingToken";
const CONNECTION_KEY = "connection";
const OWNERS_KEY = "captureOwners";
const TABS_KEY = "tabs";
const FLUSH_ALARM = "afterclass-flush";
const HEARTBEAT_MIN_MS = 3000;

export type WorkerResponse = { readonly state: TabCaptureState | null; readonly error?: string };

const store = createIdbOutbox();
const ports = new Map<number, chrome.runtime.Port>();
const lastHeartbeat = new Map<number, number>();

// ───────────────────────────── State (chrome.storage.session) ───────────────

type Tabs = Record<string, TabCaptureState>;

async function loadTabs(): Promise<Tabs> {
  return ((await chrome.storage.session.get(TABS_KEY))[TABS_KEY] as Tabs | undefined) ?? {};
}

const saveTabs = (tabs: Tabs) => chrome.storage.session.set({ [TABS_KEY]: tabs });

let chain: Promise<unknown> = Promise.resolve();
/** MV3 events interleave, so every read-modify-write of control state runs one at a time. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function readState(tabId: number): Promise<TabCaptureState | null> {
  return (await loadTabs())[tabId] ?? null;
}

function renderBadge(tabId: number, state: TabCaptureState | null): void {
  const { text, color } = badgeFor(state);
  void chrome.action.setBadgeText({ tabId, text });
  void chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function post(tabId: number, msg: ToContent): void {
  try {
    ports.get(tabId)?.postMessage(msg);
  } catch {
    ports.delete(tabId);
  }
}

// ───────────────────────────── Backend ──────────────────────────────────────

async function pairingToken(): Promise<string | null> {
  const t = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
  return typeof t === "string" && t !== "" ? t : null;
}

async function storedConnection(): Promise<StoredConnection | null> {
  const c: unknown = (await chrome.storage.local.get(CONNECTION_KEY))[CONNECTION_KEY];
  return isStoredConnection(c) ? c : null;
}

async function captureOwners(): Promise<Record<string, string>> {
  return ((await chrome.storage.local.get(OWNERS_KEY))[OWNERS_KEY] as Record<string, string> | undefined) ?? {};
}

let connectionChain: Promise<unknown> = Promise.resolve();
/** Connecting and the 401 that empties a token both rewrite the stored connection; one at a time, so a late 401 cannot undo a new connection. */
function connectionWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = connectionChain.then(fn, fn);
  connectionChain = run.catch(() => {});
  return run;
}

/** Empties the token only if it is still the one the backend refused. */
const forgetToken = (refused: string) =>
  connectionWrite(async () => {
    const c = await storedConnection();
    if (c?.token === refused) await chrome.storage.local.set({ [CONNECTION_KEY]: { token: null, userId: c.userId } satisfies StoredConnection });
  });

type Fetched = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly retryable: boolean; readonly error: string; readonly rejected?: boolean };

/** The bearer this request carries, or why it has none. A hosted request for a capture also needs that capture's account to be the connected one. */
async function credential(capture: CaptureId | undefined): Promise<{ readonly token: string } | { readonly error: string }> {
  if (BACKEND.kind === "local") {
    const token = await pairingToken();
    return token === null ? { error: "no pairing token: paste it in After Class options" } : { token };
  }
  const c = await storedConnection();
  if (c === null) return { error: "not connected: press Connect in the After Class popup" };
  if (c.token === null) return { error: "disconnected from your account: press Reconnect in the After Class popup" };
  if (capture !== undefined && !mayUpload((await captureOwners())[capture], c)) return { error: "this capture belongs to another account; connect that account to upload it" };
  return { token: c.token };
}

/** `bearer: false` sends no token: the connect-code exchange, whose code is its credential. */
async function backendFetch(method: "GET" | "POST", path: string, body?: unknown, opts: { readonly capture?: CaptureId; readonly bearer?: false } = {}): Promise<Fetched> {
  const cred = opts.bearer === false ? null : await credential(opts.capture);
  if (cred !== null && "error" in cred) return { ok: false, retryable: false, error: cred.error };
  try {
    const res = await fetch(`${BACKEND.origin}${path}`, {
      method,
      headers: { ...(cred === null ? {} : { Authorization: `Bearer ${cred.token}` }), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      if (BACKEND.kind === "hosted" && cred !== null && res.status === 401) {
        await forgetToken(cred.token);
        return { ok: false, retryable: false, error: "disconnected from your account: press Reconnect in the After Class popup" };
      }
      const c = classifyStatus(res.status);
      // The backend says which fact it refused; keep that with the dead letter.
      const detail = c.rejected ? (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200) : "";
      return { ok: false, ...c, error: detail === "" ? c.error : `${c.error}: ${detail}` };
    }
    return { ok: true, json: await res.json().catch(() => null) };
  } catch {
    return { ok: false, retryable: true, error: "backend unreachable" };
  }
}

const transport: Transport = async (captureId, facts) => {
  const r = await backendFetch("POST", "/ingest", { captureId, facts }, { capture: captureId });
  if (!r.ok) return r;
  return isIngestAck(r.json) ? { ok: true, ack: r.json } : { ok: false, retryable: false, error: "backend sent an unexpected acknowledgement" };
};

const flusher = createFlusher({
  store,
  transport,
  schedule: (fn, ms) => void setTimeout(fn, ms),
  onOutcome: (captureId, outcome) => void serialized(() => applyOutcome(captureId, outcome)),
});

async function deadLetterSummary(captureId: CaptureId): Promise<DeadLetterSummary> {
  const dead = await store.deadLetters(captureId);
  return { count: dead.length, latestReason: dead.at(-1)?.reason ?? null };
}

async function applyOutcome(captureId: CaptureId, outcome: FlushOutcome): Promise<void> {
  const tabs = await loadTabs();
  for (const [id, s] of Object.entries(tabs)) {
    if (s.captureId !== captureId) continue;
    const next: TabCaptureState = { ...s, lastAck: outcome.ack ?? s.lastAck, uploadBacklog: outcome.remaining, lastError: outcome.error, deadLetters: await deadLetterSummary(captureId) };
    tabs[id] = next;
    renderBadge(s.tabId, next);
  }
  await saveTabs(tabs);
}

export const flushOutbox = async (captureId: CaptureId): Promise<IngestAck | null> => (await flusher.flush(captureId)).ack;

// ───────────────────────────── Facts ────────────────────────────────────────

async function appendIn(tabs: Tabs, tabId: number, body: CaptureFactBody): Promise<void> {
  const s = tabs[tabId];
  if (!s) return;
  const fact = await store.append(s.captureId, body, Date.now());
  tabs[tabId] = { ...s, nextClientSeq: fact.clientSeq + 1, uploadBacklog: s.uploadBacklog + 1 };
}

/** Stamp clientSeq, persist to the IndexedDB outbox, schedule flush. */
export function enqueueFact(tabId: number, body: CaptureFactBody): Promise<void> {
  return serialized(async () => {
    const tabs = await loadTabs();
    await appendIn(tabs, tabId, body);
    await saveTabs(tabs);
    const s = tabs[tabId];
    if (s) void flusher.flush(s.captureId);
  });
}

const flushWaiters = new Map<number, Set<() => void>>();

/** Why a closing span could not be had, or null when the content script flushed it. */
async function requestFlush(tabId: number): Promise<string | null> {
  const port = ports.get(tabId);
  if (!port) return "the page was already gone";
  return new Promise((resolve) => {
    const waiters = flushWaiters.get(tabId) ?? new Set<() => void>();
    flushWaiters.set(tabId, waiters);
    const finish = (why: string | null) => {
      clearTimeout(timer);
      waiters.delete(onFlushed);
      resolve(why);
    };
    const onFlushed = () => finish(null);
    const timer = setTimeout(() => finish(`the page did not answer within ${FLUSH_TIMEOUT_MS} ms`), FLUSH_TIMEOUT_MS);
    waiters.add(onFlushed);
    try {
      port.postMessage({ type: "flush" } satisfies ToContent);
    } catch {
      ports.delete(tabId);
      finish("the page was already gone");
    }
  });
}

const tabQueues = new Map<number, Promise<unknown>>();

/**
 * Control events for one tab run one at a time, each from its flush through its transition. Without this a
 * Resume arriving during a Pause's flush wait sees a still-capturing tab, is a no-op, and the Pause lands after it.
 * Not the global `serialized` chain: the closing spans the flush waits for arrive through that one.
 */
function applyEvent(tabId: number, event: ControlEvent): Promise<TabCaptureState | null> {
  const run = (tabQueues.get(tabId) ?? Promise.resolve()).then(() => applyEventNow(tabId, event));
  tabQueues.set(tabId, run.catch(() => {}));
  return run;
}

/**
 * Applies a control event, persists its control fact, and tells the content script whether to observe.
 * R1: "Evidence only comes from intervals I actually watched while capture was on." The span the page is
 * still holding when capture stops is such an interval, so the worker asks for it before the pause or stop
 * fact is written (while the gate still accepts it). If it cannot be had, the control fact still goes
 * in and a gap is logged ahead of it, never a silent loss.
 */
async function applyEventNow(tabId: number, event: ControlEvent): Promise<TabCaptureState | null> {
  let gap: string | null = null;
  if (event.kind === "pause" || event.kind === "stop" || event.kind === "left_watch_page" || event.kind === "tab_closed") {
    if ((await readState(tabId))?.state === "capturing") gap = event.kind === "tab_closed" ? "the tab was closed" : await requestFlush(tabId);
  }
  return serialized(async () => {
    const tabs = await loadTabs();
    const { next, fact } = transition(tabs[tabId] ?? null, event);
    if (next === null) return null;
    if (BACKEND.kind === "hosted" && next.captureId !== tabs[tabId]?.captureId) await ownCapture(next.captureId);
    tabs[tabId] = next;
    if (fact && gap !== null) {
      await appendIn(tabs, tabId, closingSpanGap(gap));
      tabs[tabId] = { ...tabs[tabId]!, playbackGap: true };
    }
    if (fact) await appendIn(tabs, tabId, fact);
    // The gap lasts until capture resumes; without this ok every later span would be reported as a channel failure.
    if (fact?.kind === "control" && fact.action === "resume" && tabs[tabId]!.playbackGap) {
      await appendIn(tabs, tabId, playbackRecovered());
      tabs[tabId] = { ...tabs[tabId]!, playbackGap: false };
    }
    await saveTabs(tabs);
    const saved = tabs[tabId]!;
    renderBadge(tabId, saved);
    post(tabId, { type: "observe", on: saved.state === "capturing", captureId: saved.captureId });
    if (fact) void flusher.flush(saved.captureId);
    return saved;
  });
}

// ───────────────────────────── Content scripts ──────────────────────────────

async function ensureContentScript(tabId: number): Promise<void> {
  if (ports.has(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["main-world.js"], world: "MAIN" });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  for (let i = 0; i < 20 && !ports.has(tabId); i++) await new Promise((r) => setTimeout(r, 100));
  if (!ports.has(tabId)) throw new Error("could not attach to the page: reload the YouTube tab and try again");
}

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name !== "capture" || tabId === undefined || port.sender?.id !== chrome.runtime.id) return;
  ports.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
  port.onMessage.addListener((msg: FromContent) => void onContentMessage(tabId, msg));
  void readState(tabId).then((s) => post(tabId, { type: "observe", on: s?.state === "capturing", captureId: s?.captureId ?? null }));
});

async function onContentMessage(tabId: number, msg: FromContent): Promise<void> {
  if ("type" in msg) {
    if (msg.type === "flushed") {
      for (const wake of Array.from(flushWaiters.get(tabId) ?? [])) wake();
      return;
    }
    await applyEvent(tabId, { kind: msg.type });
    return;
  }
  await serialized(async () => {
    const tabs = await loadTabs();
    if (!acceptsFact(tabs[tabId] ?? null, msg)) return;
    await appendIn(tabs, tabId, msg);
    await saveTabs(tabs);
    void flusher.flush(tabs[tabId]!.captureId);
  });
}

// A full page navigation destroys the content script, so the tab URL is the second detector.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url === undefined || isWatchUrl(change.url)) return;
  void applyEvent(tabId, { kind: "left_watch_page" });
});

/**
 * TEST BUILD ONLY. `AFTERCLASS_TEST_AUTOSTART=1 bun run build:ext` replaces this constant with true; the normal build
 * replaces it with false and the bundler drops this block. Capture starts on its own only for a watch page opened with
 * `ac_autostart=1` in its URL, so a tab the person opens normally is never captured. It also brings that tab and its
 * window to the front, and restarts a tab left paused by an earlier run. It exists so an unattended
 * experiment (a driven playlist) needs no click on the popup, which no automation tool can reach.
 */
declare const __AFTERCLASS_TEST_AUTOSTART__: boolean;
// typeof: the unbundled source (tests, tsc) has no such global, and that means off.
if (typeof __AFTERCLASS_TEST_AUTOSTART__ !== "undefined" && __AFTERCLASS_TEST_AUTOSTART__) {
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status !== "complete" || !isWatchUrl(tab.url) || new URL(tab.url!).searchParams.get("ac_autostart") !== "1") return;
    void readState(tabId).then(async (state) => {
      if (state?.state === "capturing") return;
      // Leaving a watch page pauses; a driven run reuses its tab, so end that capture and begin a new one.
      if (state?.state === "paused") await handlePopup({ type: "stop", tabId });
      await handlePopup({ type: "start", tabId });
      // The extension only sees frames from a visible tab, so a driven tab must not sit in the background or behind another window.
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }).catch((e: unknown) => console.error("After Class test autostart failed", e));
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void applyEvent(tabId, { kind: "tab_closed" });
  ports.delete(tabId);
});

// ───────────────────────────── Popup requests ───────────────────────────────

/**
 * Answer an invite. Review now opens the review app tab and never touches capture state.
 * R9: "Starting a review doesn't stop capture, and stopping capture doesn't end a review."
 * Every answer is also posted to the backend, which records it as a fact.
 */
export async function answerInvite(tabId: number, answer: InviteAnswer): Promise<InviteState> {
  const state = await readState(tabId);
  if (answer === "review_now" || answer === "stop_early") await chrome.tabs.create({ url: safeReviewUrl(state?.lastAck?.reviewAppUrl, `${BACKEND.origin}/app/`) });
  const current: InviteState = state?.lastAck?.invite ?? { state: "none" };
  if (state === null || (answer === "review_now" && current.state !== "invited")) return current;
  const r = await backendFetch("POST", `/captures/${state.captureId}/invite`, { answer }, { capture: state.captureId });
  if (!r.ok) throw new Error(r.error);
  const s = (r.json as { state?: unknown } | null)?.state;
  return s === "none" || s === "invited" || s === "later" || s === "waiting" ? (r.json as InviteState) : current;
}

async function ensureWatchPage(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!isWatchUrl(tab.url)) throw new Error("open a YouTube video page (youtube.com/watch) first");
}

async function handlePopup(req: PopupRequest): Promise<WorkerResponse> {
  switch (req.type) {
    case "start":
    case "resume": {
      // A new capture belongs to the connected account, so a hosted build needs one before it starts.
      if (req.type === "start" && !["local", "connected"].includes((await connection()).kind)) throw new Error("connect After Class to your account first: press Connect");
      await ensureWatchPage(req.tabId);
      await ensureContentScript(req.tabId);
      return { state: await applyEvent(req.tabId, req.type === "start" ? { kind: "start", tabId: req.tabId } : { kind: "resume" }) };
    }
    case "pause":
    case "stop":
      return { state: await applyEvent(req.tabId, { kind: req.type }) };
    case "status": {
      const state = await readState(req.tabId);
      if (state === null) return { state };
      const now = Date.now();
      if (now - (lastHeartbeat.get(req.tabId) ?? 0) >= HEARTBEAT_MIN_MS) {
        lastHeartbeat.set(req.tabId, now);
        void flusher.flush(state.captureId, { heartbeat: true });
      }
      return { state: { ...state, uploadBacklog: await store.backlog(state.captureId), deadLetters: await deadLetterSummary(state.captureId) } };
    }
    case "invite_answer": {
      const invite = await answerInvite(req.tabId, req.answer);
      return { state: await serialized(async () => {
        const tabs = await loadTabs();
        const s = tabs[req.tabId];
        if (!s?.lastAck) return s ?? null;
        tabs[req.tabId] = { ...s, lastAck: { ...s.lastAck, invite } };
        await saveTabs(tabs);
        renderBadge(req.tabId, tabs[req.tabId]!);
        return tabs[req.tabId]!;
      }) };
    }
    case "transcription_choice":
      await enqueueFact(req.tabId, { kind: "transcription_choice", videoId: req.videoId, choice: req.choice });
      return { state: await readState(req.tabId) };
    case "retry_transcript":
      await ensureContentScript(req.tabId);
      post(req.tabId, { type: "read_transcript" });
      return { state: await readState(req.tabId) };
    case "retry_observe": {
      await ensureContentScript(req.tabId);
      const state = await readState(req.tabId);
      post(req.tabId, { type: "observe", on: state?.state === "capturing", captureId: state?.captureId ?? null });
      return { state };
    }
  }
}

async function handleOptions(_req: OptionsRequest): Promise<{ readonly ok: boolean; readonly detail: string }> {
  // Hosted, a device token reaches only the capture routes, and the stored connection already says whether it works.
  if (BACKEND.kind === "hosted") {
    const c = await connection();
    return { ok: c.kind === "connected", detail: c.kind };
  }
  const r = await backendFetch("GET", "/usage");
  if (r.ok) {
    void recover();
    return { ok: true, detail: "connected" };
  }
  return { ok: false, detail: r.error };
}

chrome.runtime.onMessage.addListener((msg: PopupRequest | OptionsRequest | ConnectionRequest, sender, sendResponse) => {
  // Content scripts also carry sender.tab; the options page opens in a tab too, so tell them apart by URL.
  if (sender.id !== chrome.runtime.id || (sender.tab !== undefined && sender.url?.startsWith(chrome.runtime.getURL("")) !== true)) return false;
  const work =
    msg.type === "test_backend" ? handleOptions(msg)
    : msg.type === "connection" ? connection()
    : handlePopup(msg).catch((e: unknown): WorkerResponse => ({ state: null, error: e instanceof Error ? e.message : String(e) }));
  void work.then(sendResponse);
  return true;
});

// ───────────────────────────── Connecting (hosted builds) ───────────────────

export const connection = async (): Promise<Connection> => connectionOf(BACKEND, BACKEND.kind === "hosted" ? await storedConnection() : null);

/** Runs inside the control chain, as the start fact is written: the new capture is the connected account's. */
async function ownCapture(captureId: CaptureId): Promise<void> {
  const c = await storedConnection();
  if (c === null) return;
  await chrome.storage.local.set({ [OWNERS_KEY]: { ...(await captureOwners()), [captureId]: c.userId } });
}

/** Trades the connect page's code for a device token and keeps it with its account. Captures of another account stay where they are. */
async function connect(code: string): Promise<ConnectReply> {
  const r = await backendFetch("POST", "/devices/exchange", { code }, { bearer: false });
  if (!r.ok) return { ok: false, error: r.error.includes("HTTP 401") ? "the connect code was not accepted." : `${r.error}.` };
  const reply = r.json as { token?: unknown; userId?: unknown } | null;
  if (typeof reply?.token !== "string" || typeof reply.userId !== "string") return { ok: false, error: "the backend sent an unexpected answer." };
  const stored: StoredConnection = { token: reply.token, userId: reply.userId };
  await connectionWrite(() => chrome.storage.local.set({ [CONNECTION_KEY]: stored }));
  void recover();
  return { ok: true };
}

chrome.runtime.onMessageExternal?.addListener((msg: unknown, sender, sendResponse) => {
  if (!acceptsConnectSender(BACKEND, sender)) return false;
  if (!isConnectMessage(msg)) {
    sendResponse({ ok: false, error: "the message was not a connect request." } satisfies ConnectReply);
    return false;
  }
  void connect(msg.code).then(sendResponse);
  return true;
});

// ───────────────────────────── Lifecycle ────────────────────────────────────

/** Re-send anything the outbox still holds, e.g. after a browser restart or an outage. */
async function recover(): Promise<void> {
  for (const captureId of await store.captureIds()) void flusher.flush(captureId);
}

// The pairing token must stay out of reach of content scripts.
chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch((e: unknown) => {
  console.error("After Class: could not restrict the pairing token to trusted contexts; content scripts may be able to read it", e);
});
void chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === FLUSH_ALARM) void recover();
});
chrome.runtime.onStartup.addListener(() => void recover());
void recover();
