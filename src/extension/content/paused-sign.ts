/**
 * The sign the learner sees on the YouTube page while capture is paused. Playing again never resumes capture
 * (control.ts), so without it the rest of the lecture is lost without a word.
 *
 * It sits inside the player, absolutely positioned, so it never moves the player or the page. It lives in a shadow
 * root so YouTube's styles cannot reach it and ours cannot reach YouTube. Hide removes it for this pause only.
 */
import { findPlayer } from "./capture";

export type PausedSign = {
  /** Shows the sign, or keeps it where it is. Safe to call again on every update. */
  show(onResume: () => void): void;
  /** Removes the sign and every trace of it from the page. */
  hide(): void;
};

export const PAUSED_SIGN_ID = "afterclass-paused-sign";

const STYLE = `
:host { all: initial; position: absolute; left: 12px; bottom: 64px; z-index: 2147483000; font: 14px/1.3 system-ui, sans-serif; }
.sign { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; color: #fff; background: rgba(23, 23, 23, 0.92); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 6px; }
button { font: inherit; cursor: pointer; border-radius: 4px; padding: 4px 10px; }
.resume { color: #111; background: #fff; border: 1px solid #fff; font-weight: 600; }
.hide { color: #fff; background: transparent; border: 1px solid transparent; padding: 4px 8px; }
button:hover { filter: brightness(0.9); }
button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
`;

export function createPausedSign(getDocument: () => Document, locatePlayer: () => HTMLElement | null = () => findPlayer()?.player ?? null): PausedSign {
  const doc = getDocument;
  let host: HTMLElement | null = null;
  let dismissed = false;

  function build(onResume: () => void): HTMLElement {
    const el = doc().createElement("div");
    el.id = PAUSED_SIGN_ID;
    const root = el.attachShadow({ mode: "open" });
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
    resume.addEventListener("click", onResume);
    const hide = doc().createElement("button");
    hide.type = "button";
    hide.className = "hide";
    hide.textContent = "Hide";
    hide.setAttribute("aria-label", "Hide this notice");
    hide.addEventListener("click", () => {
      dismissed = true;
      remove();
    });
    box.append(text, resume, hide);
    root.append(style, box);
    return el;
  }

  function remove(): void {
    host?.remove();
    host = null;
  }

  return {
    show(onResume) {
      if (dismissed) return;
      const parent = locatePlayer() ?? doc().documentElement;
      if (host !== null && host.parentElement === parent && host.isConnected) return;
      remove();
      host = build(onResume);
      if (parent === doc().documentElement) host.style.position = "fixed";
      parent.append(host);
    },
    hide() {
      dismissed = false;
      remove();
    },
  };
}
