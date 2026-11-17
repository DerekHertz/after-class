/**
 * The companion's first-run tutorial: a speech bubble near the companion and a ring on the control each step is about.
 * Pages say where the learner is with `useTutorialPlace`; the bubble and ring only read the page and draw over it, so the
 * learner can click anything under them.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppApi } from "./api";
import { COMPANIONS, useAppearance } from "./appearance";
import { useFullRoom } from "./front-row";
import { BUBBLE_MODES, PLACES, capturePlace, clampStep, clearSeen, homePlace, placeBubble, readSeen, selectSteps, writeSeen } from "./tutorial-view";
import type { Box, Place, Report, SeenStorage, Step } from "./tutorial-view";
import { useAsync } from "./ui";

type View = {
  readonly place: Place;
  readonly steps: readonly Step[];
  readonly index: number;
  next(): void;
  back(): void;
  skipAll(): void;
  skipPlace(): void;
};

/** What a page needs: to say where the learner is, and to start the tutorial over. Stable, so a page never re-renders for a step. */
type Actions = { report(next: Report | null): void; restart(): void };
type State = { readonly enabled: boolean; readonly seen: ReadonlySet<Place>; readonly view: View | null };

const ActionsContext = createContext<Actions>({ report() {}, restart() {} });
const StateContext = createContext<State>({ enabled: false, seen: new Set(), view: null });

function browserStorage(): SeenStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/**
 * `storageKey` is per learner (see `tutorialKey`). `storage` defaults to the browser's and can be any object with the
 * three methods, so a preview can keep the seen state in memory. Off, the provider shows nothing and pages report to no one.
 */
export function TutorialProvider({ storageKey, storage, enabled = true, children }: { readonly storageKey: string; readonly storage?: SeenStorage | null | undefined; readonly enabled?: boolean; readonly children: ReactNode }) {
  const [store] = useState(() => (storage === undefined ? browserStorage() : storage));
  const [seen, setSeen] = useState(() => readSeen(store, storageKey));
  const seenRef = useRef(seen);
  const [report, setReport] = useState<Report | null>(null);
  const [at, setAt] = useState<{ readonly place: Place | null; readonly index: number }>({ place: null, index: 0 });
  /** The place whose bubble is on screen. Leaving it counts as seeing it. */
  const shown = useRef<Place | null>(null);

  const mark = useCallback((places: readonly Place[]) => {
    const next = new Set(seenRef.current);
    for (const p of places) next.add(p);
    seenRef.current = next;
    setSeen(next);
    writeSeen(store, storageKey, next);
  }, [store, storageKey]);

  const onReport = useCallback((next: Report | null) => {
    const left = shown.current;
    if (left !== null && left !== next?.place) {
      shown.current = null;
      mark([left]);
    }
    setReport((prev) => (prev?.place === next?.place && prev?.variant === next?.variant ? prev : next));
  }, [mark]);

  const restart = useCallback(() => {
    seenRef.current = new Set();
    setSeen(seenRef.current);
    clearSeen(store, storageKey);
    setAt({ place: report?.place ?? null, index: 0 });
  }, [store, storageKey, report]);

  const steps = selectSteps(report, seen, enabled);
  const place = steps === null || report === null ? null : report.place;
  useEffect(() => { shown.current = place; }, [place]);
  const index = steps === null || at.place !== place ? 0 : clampStep(at.index, steps.length);

  const view = useMemo<View | null>(() => {
    if (steps === null || place === null) return null;
    return {
      place, steps, index,
      next: () => (index + 1 >= steps.length ? mark([place]) : setAt({ place, index: index + 1 })),
      back: () => setAt({ place, index: Math.max(0, index - 1) }),
      skipAll: () => mark(PLACES),
      skipPlace: () => mark([place]),
    };
  }, [steps, place, index, mark]);

  const actions = useMemo<Actions>(() => ({ report: onReport, restart }), [onReport, restart]);
  const state = useMemo<State>(() => ({ enabled, seen, view }), [enabled, seen, view]);
  return <ActionsContext.Provider value={actions}><StateContext.Provider value={state}>{children}</StateContext.Provider></ActionsContext.Provider>;
}

/** Says where the learner is, while this page shows it. `null` says the page has nothing to teach right now. */
export function useTutorialPlace(report: Report | null): void {
  const { report: send } = useContext(ActionsContext);
  const place = report?.place ?? null;
  const variant = report?.variant;
  useEffect(() => {
    send(place === null ? null : { place, variant });
  }, [send, place, variant]);
  useEffect(() => () => send(null), [send]);
}

/**
 * `useTutorialPlace` for a page that also appears inside a dialog, as the notebook does in a review's Saved notes. Inside a
 * dialog it reports nothing, so it never replaces the review's own place.
 */
export function TutorialPlace({ report }: { readonly report: Report | null }) {
  const { report: send } = useContext(ActionsContext);
  const marker = useRef<HTMLSpanElement>(null);
  const sent = useRef(false);
  const place = report?.place ?? null;
  const variant = report?.variant;
  useEffect(() => {
    if (marker.current?.closest("dialog") != null) return;
    sent.current = true;
    send(place === null ? null : { place, variant });
  }, [send, place, variant]);
  useEffect(() => () => { if (sent.current) send(null); }, [send]);
  return <span ref={marker} hidden />;
}

/** Home's place: no lectures yet. Hosted, which of the two first steps depends on whether the account has a connected browser. */
export function HomeTutorial({ api, extensionId, lectures }: { readonly api: Pick<AppApi, "devices">; readonly extensionId: string | null; readonly lectures: number }) {
  const { enabled, seen } = useContext(StateContext);
  const hosted = extensionId !== null;
  const wanted = enabled && lectures === 0 && hosted && !(seen.has("home_connect") && seen.has("home_capture"));
  const devices = useAsync(useCallback(() => (wanted ? api.devices() : Promise.resolve(null)), [api, wanted]));
  useTutorialPlace(enabled ? homePlace({ lectures, hosted, connected: !hosted || devices.data === null ? null : devices.data.length > 0 }) : null);
  return null;
}

/** The lecture page's place, from the review options it shows. */
export function useCaptureTutorial(screen: Parameters<typeof capturePlace>[0] | null): void {
  useTutorialPlace(screen === null ? null : capturePlace(screen));
}

/** The control that starts the tutorial over. It is not there when the tutorial is off. */
export function ShowTutorialAgain({ className }: { readonly className?: string }) {
  const { enabled } = useContext(StateContext);
  const { restart } = useContext(ActionsContext);
  if (!enabled) return null;
  return <button type="button" className={className} onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); restart(); }}>Show the tutorial again</button>;
}

// ───────────────────────────── The bubble ───────────────────────────────────

/** What the bubble stays off: where the learner types and presses to act, and the text the page is showing. */
const AVOID = [
  ".composer textarea", ".composer button", ".topic-checklist textarea", ".topic-checklist button", ".capture-answer button", ".invitation-offers button",
  ".room-paper > *", '.front-row-area[data-area="board"] .line', '.front-row-area[data-area="board"] .front-row-heading-box', ".setup-choices > *",
];
const POLL_MS = 400;
const MARGIN = 16;

const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height });
const sameBoxes = (a: readonly Box[], b: readonly Box[]): boolean => a.length === b.length && a.every((x, i) => x.left === b[i]!.left && x.top === b[i]!.top && x.width === b[i]!.width && x.height === b[i]!.height);
const visible = (selectors: readonly string[]): HTMLElement[] => selectors.flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)]).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });

/** The boxes of the elements `selectors` match, kept current as the page scrolls, resizes and changes. */
function useBoxes(selectors: readonly string[]): Box[] {
  const [boxes, setBoxes] = useState<Box[]>([]);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = visible(selectors).map((e) => boxOf(e.getBoundingClientRect()));
      setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "open", "class"] });
    const timer = setInterval(schedule, POLL_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer.disconnect();
      clearInterval(timer);
    };
  }, [selectors]);
  return boxes;
}

/** Brings the ringed controls into view when a step starts, if any is out of view or under the bubble. `inset` is the bottom of the window the bubble takes. */
function useReveal(selectors: readonly string[], key: string, inset: number): void {
  useEffect(() => {
    const shown = visible(selectors);
    const first = shown[0];
    const last = shown.at(-1);
    if (first === undefined || last === undefined) return;
    if (first.getBoundingClientRect().top < 0) first.scrollIntoView({ block: "start", behavior: "auto" });
    else if (last.getBoundingClientRect().bottom > window.innerHeight - inset) last.scrollIntoView({ block: "end", behavior: "auto" });
  }, [selectors, key, inset]);
}

function CompanionBubble({ view }: { readonly view: View }) {
  const { appearance } = useAppearance();
  const full = useFullRoom();
  const step = view.steps[view.index]!;
  const root = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ readonly left: number; readonly top: number; readonly tail: boolean } | null>(null);
  /** The spot being tried for one layout of the page. It starts at the first and moves on while its spot covers something. */
  const [tried, setTried] = useState({ key: "", mode: 0 });
  const [height, setHeight] = useState(0);
  const targets = useBoxes(step.target);
  const guarded = useBoxes(AVOID);
  const key = `${view.place}:${step.id}`;
  // The spots are tried again from the first whenever the page's layout moves, so a page still settling never leaves the bubble in a worse spot.
  const layout = `${key}:${full}:${JSON.stringify(targets)}:${JSON.stringify(guarded)}`;
  const mode = tried.key === layout ? tried.mode : 0;
  const last = view.index + 1 >= view.steps.length;
  const name = COMPANIONS[appearance.companion].name;

  useLayoutEffect(() => {
    const node = root.current;
    if (node === null) return;
    const size = { width: node.offsetWidth, height: node.offsetHeight };
    setHeight(size.height);
    if (!full) { setSpot(null); return; }
    const companion = [...document.querySelectorAll<HTMLElement>(".study-companion")].map((e) => e.getBoundingClientRect()).find((r) => r.width > 0 && r.height > 0);
    const next = placeBubble({ mode: BUBBLE_MODES[mode]!, size, window: { width: window.innerWidth, height: window.innerHeight }, companion: companion === undefined ? null : boxOf(companion), avoid: [...targets, ...guarded] });
    if (!next.clear && mode + 1 < BUBBLE_MODES.length) { setTried({ key: layout, mode: mode + 1 }); return; }
    setSpot((prev) => (prev !== null && prev.left === next.left && prev.top === next.top && prev.tail === next.tail ? prev : next));
  }, [full, step, targets, guarded, layout, mode]);

  // On a phone the bubble sits on the bottom edge. The page leaves room for it, so everything can still scroll above it.
  useEffect(() => {
    if (full) return;
    document.documentElement.style.scrollPaddingBottom = `${height + MARGIN}px`;
    return () => { document.documentElement.style.removeProperty("scroll-padding-bottom"); };
  }, [full, height]);

  // The page scrolls a ringed control clear of the bubble. This comes after the padding above, which the scroll respects.
  useReveal(step.target, key, full ? 0 : height + MARGIN);

  // Focus moves to the bubble when a place's tutorial opens and goes back where it was when that tutorial ends.
  const placeKey = view.place;
  const placed = !full || spot !== null;
  useEffect(() => {
    if (!placed) return;
    const node = root.current;
    const before = document.activeElement;
    node?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (before instanceof HTMLElement && before.isConnected && (now === document.body || now === null || node?.contains(now))) before.focus({ preventScroll: true });
    };
  }, [placeKey, placed]);

  // Escape skips this place. It leaves Escape alone when something else is open that Escape closes.
  const { skipPlace } = view;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]") !== null) return;
      const active = document.activeElement;
      if (active === document.body || active === null || root.current?.contains(active)) skipPlace();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [skipPlace]);

  return <>
    {targets.map((box, i) => <div key={i} className="tutorial-ring" aria-hidden="true" style={{ left: box.left - 5, top: box.top - 5, width: box.width + 10, height: box.height + 10 }} />)}
    <div
      ref={root} role="dialog" aria-modal="false" aria-label={`Tutorial from ${name}`} tabIndex={-1}
      className="tutorial-bubble" data-compact={full ? undefined : ""} data-mode={full ? BUBBLE_MODES[mode] : undefined} data-tail={spot?.tail ? "" : undefined}
      style={full ? { left: spot?.left ?? 0, top: spot?.top ?? 0, visibility: spot === null ? "hidden" : undefined } : undefined}
    >
      <p className="tutorial-kicker">{name} · {view.index + 1} of {view.steps.length}</p>
      <p className="tutorial-text" aria-live="polite" aria-atomic="true">{step.text}</p>
      <div className="tutorial-actions">
        <button type="button" onClick={view.back} disabled={view.index === 0}>Back</button>
        <button type="button" className="tutorial-next" onClick={view.next}>{last ? "Got it" : "Next"}</button>
        <button type="button" className="tutorial-skip" onClick={view.skipAll}>Skip tutorial</button>
      </div>
    </div>
    {!full && <div className="tutorial-spacer" aria-hidden="true" style={{ height: height + MARGIN }} />}
  </>;
}

/** Draws the tutorial when there is a step to show. Rendered once, by the scene. */
export function TutorialBubble() {
  const { view } = useContext(StateContext);
  return view === null ? null : <CompanionBubble view={view} />;
}
