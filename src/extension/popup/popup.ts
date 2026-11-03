/**
 * Popup (W2). Shows source, caption status, frame health, invites; Start /
 * Pause / Resume / Stop; Review now (always available); the opt-in
 * transcription offer when captions are unusable. Talks only to the SW via
 * PopupRequest; never to the backend directly.
 */
import type { PopupRequest, TabCaptureState } from "../worker/service-worker";

export function renderPopup(root: HTMLElement, send: (req: PopupRequest) => Promise<TabCaptureState | null>): () => void {
  throw new Error("not implemented");
}
