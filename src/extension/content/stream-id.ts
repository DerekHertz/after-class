/**
 * The id of the stream the player has loaded, shared between worlds as a DOM attribute.
 *
 * Why not the URL: YouTube flips location only after an SPA navigation finishes, and the
 * <video> can reset to the new stream before that. A tracker that labels time by URL then
 * credits new-stream time to the old video (R1: "Evidence only comes from intervals I
 * actually watched while capture was on."). The player knows which video it loaded, but
 * its methods live in the page's JS world, so main-world.ts mirrors the answer here.
 */
export const STREAM_ID_ATTR = "data-afterclass-stream-id";

const VIDEO_ID = /^[\w-]{11}$/;

/** The mirrored stream id when it is a plausible video id, else the URL's. */
export function pickVideoId(streamAttr: string | null, urlId: string): string {
  return streamAttr !== null && VIDEO_ID.test(streamAttr) ? streamAttr : urlId;
}

export const isVideoId = (s: unknown): s is string => typeof s === "string" && VIDEO_ID.test(s);
