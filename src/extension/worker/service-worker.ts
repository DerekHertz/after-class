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
 * Control state is in chrome.storage.session (survives SW restarts, not browser
 * restarts: a browser restart ends capture, which is the visible, honest outcome).
 */
import type { CaptureId } from "../../shared/ids";
import type { CaptureFactBody, ControlReason, InviteAnswer, InviteState } from "../../shared/domain";
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
  | { readonly type: "transcription_choice"; readonly tabId: number; readonly videoId: string; readonly choice: "accept_asr" | "continue_with_gap" };

/**
 * Pure control transition. One table, unit-tested; the only place auto-pause policy lives.
 *   start  : none → capturing (new captureId)
 *   pause  : capturing → paused(reason)
 *   resume : paused → capturing
 *   left_watch_page : capturing → paused("left_watch_page")
 *   returned_to_watch_page : no-op; capture waits for Derek to resume (SYNTHESIS open question 1)
 *   stop / tab_closed : capturing|paused → stopped
 * Returns the control fact to emit, or null if the request is a no-op.
 */
export function transition(
  current: TabCaptureState | null,
  event: { readonly kind: "start" | "pause" | "resume" | "stop" } | { readonly kind: "left_watch_page" | "returned_to_watch_page" | "tab_closed" },
): { readonly next: TabCaptureState | null; readonly fact: CaptureFactBody | null } {
  throw new Error("not implemented");
}

/** Stamp clientSeq, persist to the IndexedDB outbox, schedule flush. */
export function enqueueFact(tabId: number, body: CaptureFactBody): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Upload pending facts in clientSeq order, ≤ 500 per batch (frames counted by bytes, ≤ 8 MiB).
 * On 2xx: delete through ack.ackedThroughSeq, store ack (invite → badge + popup).
 * On failure: exponential backoff 1 s → 30 s; health shows "backend unreachable".
 */
export function flushOutbox(captureId: CaptureId): Promise<IngestAck | null> {
  throw new Error("not implemented");
}

/** Answer an invite: Review now opens the review app tab; the others are facts for the backend. */
export function answerInvite(tabId: number, answer: InviteAnswer): Promise<InviteState> {
  throw new Error("not implemented");
}
