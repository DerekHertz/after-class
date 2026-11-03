// extension/content/transcript.ts -- transcript acquisition (stack: "YouTube transcript panel first, player caption interception as fallback").
// Output is always TranscriptSegment[] in media time + provenance. The extension reports the WHOLE track as "available";
// only the backend decides which segments are evidence (watched coverage, R1). Nothing here filters by watching.
//
// Layout: two thin DOM readers (untestable without a browser, kept tiny) feeding two pure parsers (fixture-tested) and one pure chooser.
import type { CaptureEventBody, TranscriptProvenance, TranscriptSegment } from "../../shared/domain/capture";
import type { MediaMs } from "../../shared/domain/time";
import type { SourceId } from "../../shared/domain/ids";

export interface PanelRow { readonly stamp: string; readonly text: string } // "1:23" or "1:02:03", raw text

/** DOM: click "Show transcript" if the panel is closed (needs the description expander), wait for ytd-transcript-segment-renderer rows, read .segment-timestamp / .segment-text. */
export async function readPanelRows(doc: Document, signal: AbortSignal): Promise<readonly PanelRow[] | null> {
  throw new Error("not implemented");
}

/**
 * pure. The panel gives only START stamps (second resolution): end[i] = start[i+1]; last end = min(start + 5 s, duration).
 * Drops empty/[Music]-only rows only when marked as such by the panel's own class (never by guessing text). Collapses duplicate stamps.
 */
export function rowsToSegments(rows: readonly PanelRow[], duration: MediaMs): readonly TranscriptSegment[] {
  throw new Error("not implemented");
}

/**
 * Fallback. A MAIN-world script (manifest `world: "MAIN"`) wraps fetch/XMLHttpRequest and forwards the response BODY of the player's
 * own /api/timedtext request (it carries the request token the page computed; fetching timedtext ourselves would not) via
 * window.postMessage to the isolated-world script. We never issue our own timedtext requests.
 */
export function listenForCaptionResponses(onBody: (url: string, body: string) => void): () => void {
  throw new Error("not implemented");
}

/** pure: json3 `events[{tStartMs, dDurationMs, segs[{utf8}]}]` -> segments; joins segs, strips newlines, skips events without segs (window markers). */
export function parseJson3(body: string, duration: MediaMs): readonly TranscriptSegment[] {
  throw new Error("not implemented");
}

export interface Candidate { readonly provenance: TranscriptProvenance; readonly segments: readonly TranscriptSegment[] }

/**
 * pure. pseudocode:
 *   usable(c) = c.segments.length >= 5 && spanOf(c) >= 0.5 * duration     // a track that covers a sliver is "unusable", not "available"
 *   panel usable            -> panel         (primary)
 *   else intercept usable   -> intercept     (fallback)
 *   else                    -> unusable{ why: 'missing' | 'empty' | 'panel_unavailable' } => backend event transcript_unusable; popup offers opt-in transcription
 * revision = sha256(normalized segments) computed by the caller (async) and sent with the track so a re-fetched, different track
 * never aliases earlier evidence ids.
 */
export function chooseTranscript(panel: Candidate | null, intercept: Candidate | null, duration: MediaMs):
  | { readonly kind: "track"; readonly chosen: Candidate }
  | { readonly kind: "unusable"; readonly why: Extract<CaptureEventBody, { type: "transcript_unusable" }>["why"] } {
  throw new Error("not implemented");
}

export async function trackEvent(sourceId: SourceId, c: Candidate): Promise<Extract<CaptureEventBody, { type: "transcript_track" }>> {
  throw new Error("not implemented"); // revision = sha256Hex(JSON.stringify(segments))
}
