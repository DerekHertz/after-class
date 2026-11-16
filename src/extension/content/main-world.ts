/**
 * MAIN-world script (document_start). Wraps window.fetch and XMLHttpRequest to
 * copy /api/timedtext json3 responses and forward them to the isolated content
 * script with window.postMessage({ source: "afterclass", kind: "timedtext", scope, videoId, lang, asr, text }).
 *
 * It never sends anything off the page and holds no secrets: the pairing token
 * lives only in the service worker.
 */

import { CAPTION_SCOPE_EVENT, MAX_CAPTION_BYTES } from "./caption-scope";
import { STREAM_ID_ATTR, isVideoId } from "./stream-id";

export type TimedTextRequest = { readonly videoId: string; readonly lang: string; readonly asr: boolean };

/** Pure: null for anything that is not the player's own json3 track request (translations are skipped). */
export function parseTimedTextUrl(raw: string, base = "https://www.youtube.com"): TimedTextRequest | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.origin !== "https://www.youtube.com" || url.pathname !== "/api/timedtext") return null;
  const p = url.searchParams;
  const videoId = p.get("v");
  if (!videoId || p.has("tlang") || (p.get("fmt") !== null && p.get("fmt") !== "json3")) return null;
  return { videoId, lang: p.get("lang") ?? "", asr: p.get("kind") === "asr" };
}

function matchesResponse(req: TimedTextRequest, url: string): boolean {
  if (!url) return true; // Synthetic responses can omit a final URL.
  const track = parseTimedTextUrl(url);
  return track !== null && track.videoId === req.videoId && track.lang === req.lang && track.asr === req.asr;
}

type CaptionScope = { readonly key: string; readonly videoId: string; readonly life: AbortController };

/** Read only a bounded copy. Cancelling a tee branch must never delay the player's own response. */
async function forwardFetch(req: TimedTextRequest, response: Response, scope: CaptionScope): Promise<void> {
  if (scope.life.signal.aborted || !matchesResponse(req, response.url) || Number(response.headers.get("content-length")) > MAX_CAPTION_BYTES) return;
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  scope.life.signal.addEventListener("abort", cancel, { once: true });
  try {
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    while (!scope.life.signal.aborted) {
      const chunk = await reader.read();
      if (scope.life.signal.aborted) return;
      if (chunk.done) {
        forward(req, text + decoder.decode(), scope);
        return;
      }
      size += chunk.value.byteLength;
      if (size > MAX_CAPTION_BYTES) {
        cancel();
        return;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    scope.life.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function forward(req: TimedTextRequest, text: string, scope: CaptionScope): void {
  if (scope.life.signal.aborted || text.length > MAX_CAPTION_BYTES || new TextEncoder().encode(text).byteLength > MAX_CAPTION_BYTES) return;
  window.postMessage({ source: "afterclass", kind: "timedtext", ...req, scope: scope.key, text }, window.location.origin);
}

export function installTimedTextTap(): void {
  let active: CaptionScope | null = null;
  document.addEventListener(CAPTION_SCOPE_EVENT, (event) => {
    active?.life.abort();
    const key: unknown = (event as CustomEvent).detail;
    const videoId = typeof key === "string" ? key.split(":")[1] : undefined;
    active = typeof key === "string" && key.length <= 64 && isVideoId(videoId) ? { key, videoId, life: new AbortController() } : null;
  });
  const originalFetch = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const scope = active;
    const input = args[0];
    const req = scope && parseTimedTextUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, document.baseURI);
    const response = await originalFetch.apply(this, args);
    if (scope && req?.videoId === scope.videoId) void forwardFetch(req, response, scope).catch(() => {});
    return response;
  } as typeof fetch;

  const open = XMLHttpRequest.prototype.open;
  const listeners = new WeakMap<XMLHttpRequest, () => void>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const previous = listeners.get(this);
    if (previous) {
      this.removeEventListener("load", previous);
      listeners.delete(this);
    }
    const scope = active;
    const req = scope && parseTimedTextUrl(String(url), document.baseURI);
    if (scope && req?.videoId === scope.videoId) {
      const loaded = () => {
        listeners.delete(this);
        try {
          if (!scope.life.signal.aborted && matchesResponse(req, this.responseURL) && (this.responseType === "" || this.responseType === "text")) {
            forward(req, this.responseText, scope);
          }
        } catch {
          // Same: never break the player.
        }
      };
      listeners.set(this, loaded);
      this.addEventListener("load", loaded, { once: true, signal: scope.life.signal });
    }
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
}

/**
 * Keeps STREAM_ID_ATTR on <html> equal to the id the player has loaded. Media events do not
 * bubble but do pass through document in the capture phase, ahead of any listener on the
 * <video> itself, so the attribute is already current when the tracker reacts to the same event.
 */
const STREAM_EVENTS = ["loadstart", "emptied", "loadedmetadata", "durationchange", "playing", "seeking", "timeupdate"] as const;

const NAVIGATION_EVENTS = ["yt-navigate-finish", "yt-page-data-updated"] as const;

export function installStreamIdMirror(doc: Document = document): void {
  const mirror = () => {
    let id: unknown;
    try {
      id = (doc.getElementById("movie_player") as { getVideoData?: () => { video_id?: unknown } } | null)?.getVideoData?.()?.video_id;
    } catch {
      id = undefined;
    }
    if (isVideoId(id)) doc.documentElement.setAttribute(STREAM_ID_ATTR, id);
    else doc.documentElement.removeAttribute(STREAM_ID_ATTR);
  };
  for (const e of STREAM_EVENTS) doc.addEventListener(e, mirror, true);
  // The content script's navigation check listens on window in the capture phase and registers later, so this runs first.
  for (const e of NAVIGATION_EVENTS) (doc.defaultView ?? doc).addEventListener(e, mirror, true);
  mirror();
}

declare global {
  interface Window {
    __afterclassTap?: true;
  }
}

if (typeof window !== "undefined" && typeof XMLHttpRequest !== "undefined" && !window.__afterclassTap) {
  window.__afterclassTap = true;
  installTimedTextTap();
  installStreamIdMirror();
}
