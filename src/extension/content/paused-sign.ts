/**
 * The sign the learner sees on the YouTube page while capture is paused. Playing again never resumes capture
 * (control.ts), so without it the rest of the lecture is lost without a word.
 *
 * It sits inside the player, absolutely positioned, so it never moves the player or the page. It lives in a closed
 * shadow root so YouTube's styles cannot reach it, ours cannot reach YouTube, and the page cannot query its buttons.
 * Its buttons act only on a click the learner made (`isTrusted`), so page script cannot press Resume for them.
 * Hide removes it for the current pause only: `remove` takes the DOM away, `reset` also forgets the dismissal.
 */

export type PausedSign = {
  /** Shows the sign, or keeps it where it is, and sets what Resume does. Safe to call again on every update. */
  show(onResume: () => void): void;
  /** Takes the sign off the page. A Hide the learner pressed still holds, so it stays away when shown again. */
  remove(): void;
  /** Takes the sign off the page and forgets a Hide: the pause it was for is over. */
  reset(): void;
};

export const PAUSED_SIGN_ID = "afterclass-paused-sign";

/** While the sign should be visible, how often to check that it is still inside the page's current player. */
export const PAUSED_SIGN_RECHECK_MS = 1000;

const STYLE = `
:host { all: initial; position: absolute; left: 12px; bottom: 64px; z-index: 2147483000; font: 14px/1.3 system-ui, sans-serif; }
.sign { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; color: #fff; background: rgba(23, 23, 23, 0.92); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 6px; }
button { font: inherit; cursor: pointer; border-radius: 4px; padding: 4px 10px; }
.resume { color: #111; background: #fff; border: 1px solid #fff; font-weight: 600; }
.hide { color: #fff; background: transparent; border: 1px solid transparent; padding: 4px 8px; }
button:hover { filter: brightness(0.9); }
button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
`;

const CONTAINED_KEYS = ["keydown", "keyup", "keypress"] as const;

/**
 * `locatePlayer` is where the sign goes; with none found it falls back to a fixed corner of the page.
 * YouTube replaces the player element on some navigations, which drops the sign with it, so while the sign is
 * wanted a timer checks one selector per `recheckMs` and puts it back. Nothing runs while it is hidden or dismissed.
 */
export function createPausedSign(getDocument: () => Document, locatePlayer: () => HTMLElement | null, recheckMs = PAUSED_SIGN_RECHECK_MS): PausedSign {
  const doc = getDocument;
  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let dismissed = false;
  let onResume: () => void = () => {};
  let watch: ReturnType<typeof setInterval> | null = null;

  function build(): HTMLElement {
    const el = doc().createElement("div");
    el.id = PAUSED_SIGN_ID;
    root = el.attachShadow({ mode: "closed" });
    const style = doc().createElement("style");
    style.textContent = STYLE;
    const box = doc().createElement("div");
    box.className = "sign";
    box.setAttribute("role", "status");
    const text = doc().createElement("span");
    text.textContent = "After Class capture is paused";
    const resume = doc().createElement("button");
    resume.type = "button";
    resume.className = "resume";
    resume.textContent = "Resume";
    resume.setAttribute("aria-label", "Resume After Class capture");
    resume.addEventListener("click", (e) => {
      if (e.isTrusted) onResume();
    });
    const hide = doc().createElement("button");
    hide.type = "button";
    hide.className = "hide";
    hide.textContent = "Hide";
    hide.setAttribute("aria-label", "Hide this notice");
    hide.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      dismissed = true;
      remove();
    });
    // Stopping the bubble keeps Space, Enter and letters from reaching the player's shortcuts. Native button
    // activation is the default action and is not touched.
    for (const type of CONTAINED_KEYS) box.addEventListener(type, (e) => e.stopPropagation());
    box.append(text, resume, hide);
    root.append(style, box);
    return el;
  }

  function detach(): void {
    const parent = host?.parentElement;
    const hadFocus = root?.activeElement != null;
    host?.remove();
    host = null;
    root = null;
    // The focused button is gone; leave focus on the player so the learner's keys go where they were headed.
    if (hadFocus && parent != null && parent !== doc().documentElement) parent.focus({ preventScroll: true });
  }

  function attach(): void {
    const parent = locatePlayer() ?? doc().documentElement;
    if (host !== null && host.parentElement === parent && host.isConnected) return;
    detach();
    host = build();
    if (parent === doc().documentElement) host.style.position = "fixed";
    parent.append(host);
  }

  function remove(): void {
    if (watch !== null) clearInterval(watch);
    watch = null;
    detach();
  }

  return {
    show(next) {
      onResume = next;
      if (dismissed) return;
      attach();
      watch ??= setInterval(attach, recheckMs);
    },
    remove,
    reset() {
      dismissed = false;
      remove();
    },
  };
}
