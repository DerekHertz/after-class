import { useSyncExternalStore } from "react";
import { reactionFor } from "./reactions";
import type { Reaction, ReactionInput } from "./reactions";

/** A reaction playing, numbered, with the `performance.now()` time it started, which the stage times its gesture from. */
export type ActiveReaction = Reaction & { readonly sequence: number; readonly at: number };

/** How long a reaction holds before the companion is back at rest. */
export const REACTION_MS = 1050;

const listeners = new Set<() => void>();
let active: ActiveReaction | null = null;
let sequence = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;

function notify() { for (const listener of listeners) listener(); }

export function react(input: ReactionInput) {
  play(reactionFor(input));
}

/** Plays `reaction` as is. The app reacts only through `react`; the UI preview plays any gesture to show it. */
export function play(reaction: Reaction) {
  clearTimeout(expiry);
  active = { ...reaction, sequence: ++sequence, at: performance.now() };
  notify();
  expiry = setTimeout(() => { active = null; notify(); }, REACTION_MS);
}

export function clearReaction() {
  clearTimeout(expiry);
  active = null;
  notify();
}

export function useReaction(): ActiveReaction | null {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => active,
    () => null,
  );
}
