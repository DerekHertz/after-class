/**
 * MAIN-world script (document_start). Wraps window.fetch and XMLHttpRequest to
 * copy /api/timedtext json3 responses and forward them to the isolated content
 * script with window.postMessage({ source: "afterclass", kind: "timedtext", videoId, lang, asr, payload }).
 *
 * It never sends anything off the page and holds no secrets: the pairing token
 * lives only in the service worker.
 */

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
  if (!/\/api\/timedtext\b/.test(url.pathname)) return null;
  const p = url.searchParams;
  const videoId = p.get("v");
  if (!videoId || p.has("tlang") || (p.get("fmt") !== null && p.get("fmt") !== "json3")) return null;
  return { videoId, lang: p.get("lang") ?? "", asr: p.get("kind") === "asr" };
}

function forward(req: TimedTextRequest, text: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray((payload as { events?: unknown } | null)?.events)) return;
  window.postMessage({ source: "afterclass", kind: "timedtext", ...req, payload }, window.location.origin);
}

export function installTimedTextTap(): void {
  const originalFetch = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const response = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const req = parseTimedTextUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (req) void response.clone().text().then((t) => forward(req, t), () => {});
    } catch {
      // The tap must never break the player's own request.
    }
    return response;
  } as typeof fetch;

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const req = parseTimedTextUrl(String(url));
    if (req) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") forward(req, this.responseText);
        } catch {
          // Same: never break the player.
        }
      });
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
