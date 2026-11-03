// extension/background/sw.ts -- MV3 service worker: a thin relay. No state of its own beyond what the outbox persists.
//   * receives ToWorker messages (content script, popup), validates with zod at the boundary
//   * allocates captureId on start_capture (crypto.randomUUID), tells the content script to begin, appends session_started
//   * is the ONLY component that talks to the backend (host_permissions http://localhost:<port>/*): content scripts on youtube.com would be
//     cross-origin and subject to CORS/Private Network Access; the SW is not
//   * adds the pairing token (Authorization) from chrome.storage.local; the token is pasted once in the options page
//   * opens an SSE-like long fetch to events.subscribe for the popup's health display (reconnects with backoff)
import type { ToWorker } from "../messages";

export function onMessage(msg: ToWorker, sender: chrome.runtime.MessageSender): Promise<unknown> {
  throw new Error("not implemented");
  // emit/frame -> outbox.append*;  start_capture -> new captureId, chrome.tabs.sendMessage(tabId,{type:'begin'}), outbox.append(session_started)
  // control -> forward to content + append {type:'control', action, cause:'user'};  transcription_choice -> append event
}

/** chrome.tabs.onUpdated/onRemoved: leaving /watch => ToContent pause(left_watch_page); tab closed => stop(tab_closed) + control event. Also chrome.alarms 30 s drain. */
export function registerListeners(): void {
  throw new Error("not implemented");
}
