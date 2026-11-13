/**
 * Pure capture-control policy (W2). No chrome.* here, so the whole table is unit-tested.
 * service-worker.ts re-exports the frozen names.
 */
import { randomId } from "../../shared/ids";
import type { CaptureId } from "../../shared/ids";
import type { CaptureFactBody, ControlReason, InviteAnswer } from "../../shared/domain";
import type { ConnectMessage, IngestAck } from "../../shared/wire";
import type { ContentSignal } from "../content/capture";
import { backend, reviewOrigins } from "./backend";
import type { Backend } from "./backend";

export type TabCaptureState = {
  readonly tabId: number;
  readonly captureId: CaptureId; // randomId("cap"), minted once on Start
  readonly state: "capturing" | "paused" | "stopped";
  readonly pauseReason: ControlReason | null;
  readonly nextClientSeq: number;
  readonly lastAck: IngestAck | null;
  readonly uploadBacklog: number;
  readonly lastError: string | null;
  /** A closing span was lost at the last pause; the playback channel is reported failed until capture resumes. */
  readonly playbackGap: boolean;
  /** Facts the backend refused and the outbox set aside (a placeholder went in their place). Never dropped silently. */
  readonly deadLetters: DeadLetterSummary;
};

export type DeadLetterSummary = { readonly count: number; readonly latestReason: string | null };

export type PopupRequest =
  | { readonly type: "start"; readonly tabId: number }
  | { readonly type: "pause" | "resume" | "stop"; readonly tabId: number }
  | { readonly type: "status"; readonly tabId: number }
  | { readonly type: "invite_answer"; readonly tabId: number; readonly answer: InviteAnswer }
  | { readonly type: "transcription_choice"; readonly tabId: number; readonly videoId: string; readonly choice: "accept_asr" | "continue_with_gap" }
  | { readonly type: "retry_transcript"; readonly tabId: number }
  /** Frame or playback channel failed: re-attach the content script if needed and send the observe state again. */
  | { readonly type: "retry_observe"; readonly tabId: number };

/**
 * Worker to content script. `captureId` is the capture the tab is in, so the content script can tell a
 * pause/resume (same capture, nothing to redo) from a stop/start (new capture, transcript needed again).
 * `flush` asks it to close its open span and answer `flushed`, so the closing span reaches the worker
 * before the pause or stop fact does.
 */
export type ToContent =
  | { readonly type: "observe"; readonly on: boolean; readonly captureId: CaptureId | null }
  | { readonly type: "read_transcript" }
  | { readonly type: "flush" };

/** Content script to worker, besides fact bodies. Same port, so a `flushed` always follows the spans sent before it. */
export type FromContent = CaptureFactBody | ContentSignal | { readonly type: "flushed" };

/** How long the worker waits for the content script's closing span before pausing without it. */
export const FLUSH_TIMEOUT_MS = 1000;

/** Ends the failure `closingSpanGap` opened. Evidence-neutral: an ok channel fact only closes a failure episode. */
export function playbackRecovered(): CaptureFactBody {
  return { kind: "channel", channel: "playback", health: "ok", videoId: null, atMediaS: null, detail: "capture resumed" };
}

/** The visible gap when a closing span could not be had; the backend turns a failed playback channel into a gap. */
export function closingSpanGap(why: string): CaptureFactBody {
  return { kind: "channel", channel: "playback", health: "failed", videoId: null, atMediaS: null, detail: `the last seconds before the pause or stop were not captured: ${why}`.slice(0, 500) };
}

/** Options page → worker. */
export type OptionsRequest = { readonly type: "test_backend" };

/**
 * Hosted builds keep one record in chrome.storage.local: the device token and the account it was issued for. A 401
 * empties `token` and keeps `userId`, so the popup can say Reconnect and the captures stay that account's.
 */
export type StoredConnection = { readonly token: string | null; readonly userId: string };

/** What the popup and options page show: a local build, or whether a hosted build holds a working device token. */
export type Connection = { readonly kind: "local" | "connected" | "not_connected" | "disconnected" };

/** Popup or options page → worker. */
export type ConnectionRequest = { readonly type: "connection" };

export function connectionOf(backend: Backend, stored: StoredConnection | null): Connection {
  if (backend.kind === "local") return { kind: "local" };
  if (stored === null) return { kind: "not_connected" };
  return { kind: stored.token === null ? "disconnected" : "connected" };
}

export function isStoredConnection(v: unknown): v is StoredConnection {
  const c = v as Partial<StoredConnection> | null;
  return typeof c === "object" && c !== null && (c.token === null || typeof c.token === "string") && typeof c.userId === "string";
}

/**
 * Only the hosted web app's own pages may hand the worker a connect code. Chrome sets `origin` for a web page sender
 * (Chrome 80 and later); `url` is the fallback.
 */
export function acceptsConnectSender(backend: Backend, sender: { readonly origin?: string; readonly url?: string; readonly id?: string }): boolean {
  if (backend.kind !== "hosted") return false;
  let origin = sender.origin;
  if (origin === undefined && sender.url !== undefined) {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      return false;
    }
  }
  return origin === backend.origin;
}

export function isConnectMessage(v: unknown): v is ConnectMessage {
  const m = v as Partial<ConnectMessage> | null;
  return typeof m === "object" && m !== null && m.type === "afterclass_connect" && typeof m.code === "string" && m.code.length > 0 && m.code.length <= 200;
}

/**
 * Whether a capture's facts may go up with this connection. A hosted capture belongs to the account that was connected
 * when it started, so a browser later connected to another account never uploads it into that account.
 */
export function mayUpload(owner: string | undefined, stored: StoredConnection): boolean {
  return owner !== undefined && owner === stored.userId;
}

export type ControlEvent =
  | { readonly kind: "start"; readonly tabId: number }
  | { readonly kind: "pause" | "resume" | "stop" | "left_watch_page" | "returned_to_watch_page" | "tab_closed" };

/**
 * Pure control transition. One table, unit-tested; the only place auto-pause policy lives.
 *   start  : none | stopped → capturing (new captureId)
 *   pause  : capturing → paused("user")
 *   resume : paused → capturing
 *   left_watch_page : capturing → paused("left_watch_page")
 *   returned_to_watch_page : no-op; capture waits for Derek to resume (SYNTHESIS open question 1)
 *   stop / tab_closed : capturing|paused → stopped
 * Returns the control fact to emit, or null if the request is a no-op.
 * `mintCaptureId` is injectable so tests stay deterministic.
 */
export function transition(
  current: TabCaptureState | null,
  event: ControlEvent,
  mintCaptureId: () => CaptureId = () => randomId("cap"),
): { readonly next: TabCaptureState | null; readonly fact: CaptureFactBody | null } {
  const noop = { next: current, fact: null } as const;
  const control = (action: "start" | "pause" | "resume" | "stop", reason: ControlReason) => ({ kind: "control", action, reason }) as const;
  const to = (state: TabCaptureState["state"], pauseReason: ControlReason | null): TabCaptureState => ({ ...current!, state, pauseReason });

  switch (event.kind) {
    case "start":
      if (current !== null && current.state !== "stopped") return noop;
      return {
        next: { tabId: event.tabId, captureId: mintCaptureId(), state: "capturing", pauseReason: null, nextClientSeq: 0, lastAck: null, uploadBacklog: 0, lastError: null, playbackGap: false, deadLetters: { count: 0, latestReason: null } },
        fact: control("start", "user"),
      };
    case "pause":
      return current?.state === "capturing" ? { next: to("paused", "user"), fact: control("pause", "user") } : noop;
    case "left_watch_page":
      return current?.state === "capturing" ? { next: to("paused", "left_watch_page"), fact: control("pause", "left_watch_page") } : noop;
    case "resume":
      return current?.state === "paused" ? { next: to("capturing", null), fact: control("resume", "user") } : noop;
    case "returned_to_watch_page":
      return noop;
    case "stop":
    case "tab_closed":
      return current !== null && current.state !== "stopped"
        ? { next: to("stopped", null), fact: control("stop", event.kind === "stop" ? "user" : "tab_closed") }
        : noop;
  }
}

/**
 * R1: "Evidence only comes from intervals I actually watched while capture was on."
 * The worker is the gate: playback facts from a tab whose capture is not on are dropped,
 * so a late span from a paused tab can never become evidence. Control facts are minted
 * only by `transition`, never accepted from a page.
 */
export function acceptsFact(state: TabCaptureState | null, body: CaptureFactBody): boolean {
  if (state === null || state.state === "stopped" || body.kind === "control") return false;
  if (state.state === "capturing") return true;
  return body.kind === "source" || body.kind === "transcript" || body.kind === "transcript_unavailable" || body.kind === "channel";
}

/** Capture only runs on a video watch page. */
export function isWatchUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.origin === "https://www.youtube.com" && u.pathname === "/watch" && /^[\w-]{11}$/.test(u.searchParams.get("v") ?? "");
  } catch {
    return false;
  }
}

/** The ack's reviewAppUrl is opened in a tab, so it must point at this build's backend. */
export function safeReviewUrl(candidate: string | undefined, fallback: string): string {
  try {
    if (candidate && reviewOrigins(backend()).has(new URL(candidate).origin)) return candidate;
  } catch {
    // fall through to the fallback
  }
  return fallback;
}

export function badgeFor(state: TabCaptureState | null): { readonly text: string; readonly color: string } {
  if (state?.lastAck?.invite.state === "invited" && state.state !== "stopped") return { text: "!", color: "#b45309" };
  if (state?.state === "capturing") return { text: "REC", color: "#b91c1c" };
  if (state?.state === "paused") return { text: "II", color: "#4b5563" };
  return { text: "", color: "#4b5563" };
}
