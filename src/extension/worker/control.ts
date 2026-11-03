/**
 * Pure capture-control policy (W2). No chrome.* here, so the whole table is unit-tested.
 * service-worker.ts re-exports the frozen names.
 */
import { randomId } from "../../shared/ids";
import type { CaptureId } from "../../shared/ids";
import type { CaptureFactBody, ControlReason, InviteAnswer } from "../../shared/domain";
import type { IngestAck } from "../../shared/wire";

export type TabCaptureState = {
  readonly tabId: number;
  readonly captureId: CaptureId; // randomId("cap"), minted once on Start
  readonly state: "capturing" | "paused" | "stopped";
  readonly pauseReason: ControlReason | null;
  readonly nextClientSeq: number;
  readonly lastAck: IngestAck | null;
  readonly uploadBacklog: number;
  readonly lastError: string | null;
};

export type PopupRequest =
  | { readonly type: "start"; readonly tabId: number }
  | { readonly type: "pause" | "resume" | "stop"; readonly tabId: number }
  | { readonly type: "status"; readonly tabId: number }
  | { readonly type: "invite_answer"; readonly tabId: number; readonly answer: InviteAnswer }
  | { readonly type: "transcription_choice"; readonly tabId: number; readonly videoId: string; readonly choice: "accept_asr" | "continue_with_gap" }
  | { readonly type: "retry_transcript"; readonly tabId: number };

/** Options page → worker. */
export type OptionsRequest = { readonly type: "test_backend" };

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
        next: { tabId: event.tabId, captureId: mintCaptureId(), state: "capturing", pauseReason: null, nextClientSeq: 0, lastAck: null, uploadBacklog: 0, lastError: null },
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

const ALLOWED_REVIEW_ORIGINS: ReadonlySet<string> = new Set(["http://127.0.0.1:4317", "http://localhost:4317"]);

/** The ack's reviewAppUrl is opened in a tab, so it must point at the local backend. */
export function safeReviewUrl(candidate: string | undefined, fallback: string): string {
  try {
    if (candidate && ALLOWED_REVIEW_ORIGINS.has(new URL(candidate).origin)) return candidate;
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
