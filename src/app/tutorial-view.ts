/**
 * The first-run tutorial the companion speaks. This file holds what it says and the rules for which steps show; it never
 * touches the page. A tutorial only reads the screen and draws over it, so it cannot change what is captured, prepared,
 * asked or saved.
 */

/** The places a learner reaches for the first time, in the order a first lecture reaches them. */
export const PLACES = ["home_connect", "home_capture", "capture", "checklist", "question", "notebook"] as const;
export type Place = (typeof PLACES)[number];

/** A page's report of where the learner is. `variant` picks the steps that fit what the page shows. */
export type Report = { readonly place: Place; readonly variant?: string | undefined };

/** One thing the companion says. `target` is the CSS selectors of the controls the highlight rings. */
export type Step = {
  readonly id: string;
  readonly text: string;
  readonly target: readonly string[];
  /** The step shows only for this variant. A step with none shows for every variant. */
  readonly variant?: string;
};

export const STEPS: Readonly<Record<Place, readonly Step[]>> = {
  home_connect: [
    { id: "install", text: "Lectures are captured by the After Class extension for Chrome. Install it first.", target: ['a[href*="chromewebstore.google.com"]'] },
    { id: "connect", text: "Then connect it to your account. Click the extension and choose Connect, or use Connect this browser here.", target: ['a[href$="/connect-extension"]'] },
  ],
  home_capture: [
    { id: "open", text: "Open a YouTube lecture in Chrome and turn on its captions. Then click the After Class extension and choose Start capture.", target: [".home-empty ol"] },
    { id: "only-while", text: "Capture runs only after you choose Start capture. You can pause or stop it from the extension at any time.", target: [] },
  ],
  capture: [
    { id: "watched", text: "Watched is how much of the lecture you played. After Class prepares topics from that part only.", target: [".capture-summary"] },
    { id: "choose-ready", variant: "ready", text: "Start review begins now with what is prepared. Later keeps preparing, and you can start from this page whenever you like.", target: [".invitation-offers .page-primary", ".capture-answer button"] },
    { id: "choose-partial", variant: "processing_partial", text: "Some of the lecture is still being prepared. Start now with the ready topics, or press Wait to stay here until all of it is ready.", target: [".invitation-offers .page-primary", ".capture-answer button"] },
    { id: "choose-wait", variant: "processing", text: "The lecture is still being prepared. Wait stays on this page until it is ready.", target: [".capture-answer button"] },
  ],
  checklist: [
    { id: "topics", text: "Tick the topics that feel fuzzy and the tutor starts there, then quickly checks a few others. Tick none and it starts with open questions.", target: [".topic-list"] },
    { id: "start", text: "Add a note if you like, then press Start review. Nothing begins until you do.", target: [".setup-start .primary-action"] },
  ],
  question: [
    { id: "answer", text: "Answer in your own words, then press Share my thinking. Ctrl or ⌘ plus Enter works too.", target: [".composer textarea", ".composer .primary-actions"] },
    { id: "help", text: "Stuck? Hint asks for a hint. I don't know tells the tutor you can't answer this one.", target: [".assist-actions"] },
    { id: "source", text: "Lecture source opens the part of the lecture behind a reply. Show diagram shows a frame and short steps for the topic.", target: [".current-exchange .show-diagram", ".front-row-object[data-object=\"source\"]"] },
    { id: "finish", text: "To stop, open Menu and choose Finish & save. Your review goes to your notebook, and you can reread it later.", target: [".bar-menu > button"] },
  ],
  notebook: [
    { id: "notebook", text: "Your saved reviews live here, one section per lecture. Revisit review opens that review again.", target: [".notebook-reviews a"] },
  ],
};

/** The steps a report shows, in order. */
export function stepsFor(report: Report): readonly Step[] {
  return STEPS[report.place].filter((s) => s.variant === undefined || s.variant === report.variant);
}

/** What the tutorial shows now: the steps of the place the page reported, unless the learner has seen that place or the tutorial is off. */
export function selectSteps(report: Report | null, seen: ReadonlySet<Place>, enabled: boolean): readonly Step[] | null {
  if (!enabled || report === null || seen.has(report.place)) return null;
  const steps = stepsFor(report);
  return steps.length === 0 ? null : steps;
}

/** The step to show: `index` kept inside the steps, which can shrink when a page changes its variant. */
export const clampStep = (index: number, count: number): number => Math.max(0, Math.min(index, count - 1));

/** What home reports. Hosted, `connected` is whether the account has a connected browser, or null until that is known. */
export function homePlace(input: { readonly lectures: number; readonly hosted: boolean; readonly connected: boolean | null }): Report | null {
  if (input.lectures > 0) return null;
  if (!input.hosted) return { place: "home_capture" };
  if (input.connected === null) return null;
  return { place: input.connected ? "home_capture" : "home_connect" };
}

/** What the lecture page reports, from the review options it shows. Nothing while it has no review to offer. */
export function capturePlace(screen: { readonly kind: "ready" | "processing" | "nothing"; readonly offers?: readonly unknown[] | undefined }): Report | null {
  if (screen.kind === "ready") return { place: "capture", variant: "ready" };
  if (screen.kind === "processing") return { place: "capture", variant: (screen.offers?.length ?? 0) > 0 ? "processing_partial" : "processing" };
  return null;
}

// ───────────────────────────── Seen state ───────────────────────────────────

const KEY = "afterclass.tutorial.v1";

/** The local app has one learner and a fixed key. Hosted, each signed-in user has their own. */
export const tutorialKey = (userId: string | null): string => (userId === null ? `${KEY}:local` : `${KEY}:user:${userId}`);

export type SeenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isPlace = (v: unknown): v is Place => typeof v === "string" && (PLACES as readonly string[]).includes(v);

/** The places this learner has seen. Storage that throws or holds something unreadable counts as nothing seen. */
export function readSeen(storage: SeenStorage | null, key: string): ReadonlySet<Place> {
  try {
    const raw = storage?.getItem(key) ?? null;
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter(isPlace) : []);
  } catch {
    return new Set();
  }
}

/** Saves the seen places. Returns false when the browser would not keep them, which only means the tutorial can show again next visit. */
export function writeSeen(storage: SeenStorage | null, key: string, seen: ReadonlySet<Place>): boolean {
  try {
    if (storage === null) return false;
    storage.setItem(key, JSON.stringify([...seen]));
    return true;
  } catch {
    return false;
  }
}

/** Forgets what the learner has seen, so every place shows again. */
export function clearSeen(storage: SeenStorage | null, key: string): boolean {
  try {
    if (storage === null) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── Where the bubble sits ────────────────────────

export type Box = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

/**
 * The spots the bubble tries in the full room, in order. `tall` is a narrow bubble above the companion, `wide` a short
 * wide one in the same place, and `side` a narrow one at the top right, away from the companion.
 */
export const BUBBLE_MODES = ["tall", "wide", "side"] as const;
export type BubbleMode = (typeof BUBBLE_MODES)[number];

const overlaps = (a: Box, b: Box, gap: number): boolean =>
  a.left < b.left + b.width + gap && b.left < a.left + a.width + gap && a.top < b.top + b.height + gap && b.top < a.top + a.height + gap;

/**
 * Where the bubble goes in the full room for `mode`. Above the companion the tail points down at it. `clear` says whether
 * the bubble there stays off every box in `avoid`, which holds the highlighted controls, what the learner types and presses,
 * and the page's text. The bubble stays inside the window.
 */
export function placeBubble(input: { readonly mode: BubbleMode; readonly size: { readonly width: number; readonly height: number }; readonly window: { readonly width: number; readonly height: number }; readonly companion: Box | null; readonly avoid: readonly Box[] }): { readonly left: number; readonly top: number; readonly tail: boolean; readonly clear: boolean } {
  const { mode, size, window, companion, avoid } = input;
  const margin = 8;
  const inside = (left: number, top: number) => ({ left: Math.max(margin, Math.min(left, window.width - size.width - margin)), top: Math.max(margin, Math.min(top, window.height - size.height - margin)) });
  const above = mode !== "side" && companion !== null;
  const at = above
    ? inside(companion.left - 16, companion.top + companion.height * 0.16 - size.height - 14)
    : mode === "side" ? inside(window.width - size.width - margin, 120) : inside(margin, 72);
  return { ...at, tail: above, clear: !avoid.some((a) => overlaps({ ...at, ...size }, a, 4)) };
}
