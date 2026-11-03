// extension/background/outbox.ts -- durable, ordered, idempotent delivery of capture events to the backend.
// MV3 service workers are killed after ~30 s idle, so NOTHING lives only in memory: every item is in chrome.storage.local before the
// content script's message is acknowledged. (manifest: "unlimitedStorage" because queued frames are base64 JPEGs.)
//
//   key  outbox:<captureId>  -> { nextSeq: number, items: OutboxItem[] }      seq allocated here, so it is monotone across content-script reloads
//   item = { seq, wall, body } | { frame: { sha, b64 }, then event item }       frame bytes are delivered BEFORE their event
import type { CaptureEventBody } from "../../shared/domain/capture";
import type { CaptureId } from "../../shared/domain/ids";
import type { Client } from "../../shared/api/contract";

export interface Outbox {
  /** assigns seq to each body, persists, schedules a drain. Returns after the write is durable (storage.local.set resolved). */
  append(captureId: CaptureId, bodies: readonly CaptureEventBody[]): Promise<void>;
  appendFrame(captureId: CaptureId, sha: string, b64: string, event: CaptureEventBody): Promise<void>;
  /**
   * drain pseudocode (single-flight; runs on append, on alarm every 30 s, on SW start):
   *   loop: batch = first <=200 items (frames split out)
   *     for frame items: PUT bytes (api["capture.putFrame"]); 'stored'|'exists' => drop the frame item
   *     r = api["capture.ingest"]({ events: batch })
   *     drop every item with seq <= r.ackedThrough; for r.needBytes re-attach the frame item and retry
   *     r.rejected => keep in a `rejected` list shown in the popup (never silently dropped, never retried forever)
   *   network error / backend down: exponential backoff 1 s .. 60 s, popup shows "Backend unreachable: N events queued"
   * Idempotent by (captureId, seq): re-sending after a crash between PUT and ack is a no-op on the backend.
   */
  drain(api: Client): Promise<{ readonly queued: number; readonly rejected: number }>;
  pending(captureId: CaptureId): Promise<number>;
}
export function createOutbox(store: chrome.storage.LocalStorageArea, now: () => number): Outbox {
  throw new Error("not implemented");
}
