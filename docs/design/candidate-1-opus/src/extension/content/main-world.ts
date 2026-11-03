/**
 * MAIN-world script (document_start). Wraps window.fetch and XMLHttpRequest to
 * copy /api/timedtext json3 responses and forward them to the isolated content
 * script with window.postMessage({ source: "afterclass", kind: "timedtext", videoId, payload }).
 *
 * It never sends anything off the page and holds no secrets: the pairing token
 * lives only in the service worker.
 */
export function installTimedTextTap(): void {
  // TODO: wrap fetch/XHR; on URL matching /\/api\/timedtext/ clone the response,
  //       parse JSON, read `v` param as videoId, postMessage to window (same origin only).
  throw new Error("not implemented");
}
