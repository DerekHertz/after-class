// extension/messages.ts -- the ONE runtime-message protocol between content script, service worker and popup.
// chrome.runtime messaging is JSON-only: frame bytes travel base64 and are decoded in the SW before the binary PUT.
import { z } from "zod";
import { CaptureBody } from "../shared/domain/capture";
import { CaptureId, FrameSha, SourceId } from "../shared/domain/ids";

export const ToWorker = z.discriminatedUnion("type", [
  /** content -> SW: ordered bodies. The SW allocates seq + wall, persists to the outbox, then drains. */
  z.object({ type: z.literal("emit"), captureId: CaptureId, bodies: z.array(CaptureBody) }),
  /** content -> SW: frame bytes (base64) and the event that gives them media-time meaning. SW PUTs bytes first, then enqueues the event. */
  z.object({ type: z.literal("frame"), captureId: CaptureId, sha: FrameSha, b64: z.string(), event: CaptureBody }),
  /** popup -> SW */
  z.object({ type: z.literal("start_capture"), tabId: z.number().int() }),
  z.object({ type: z.literal("control"), captureId: CaptureId, action: z.enum(["pause", "resume", "stop"]) }),
  z.object({ type: z.literal("transcription_choice"), captureId: CaptureId, sourceId: SourceId, choice: z.enum(["accept", "continue_with_gap"]) }),
]);
export type ToWorker = z.infer<typeof ToWorker>;

/** SW -> content (via chrome.tabs.sendMessage) */
export const ToContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("begin"), captureId: CaptureId }),
  z.object({ type: z.literal("pause"), cause: z.enum(["user", "left_watch_page"]) }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("stop") }),
]);
export type ToContent = z.infer<typeof ToContent>;
