import { useSyncExternalStore } from "react";
import { reactionFor } from "./reactions";
import type { Reaction, ReactionInput } from "./reactions";

export type ActiveReaction = Reaction & { readonly sequence: number };

/** How long a reaction holds before the companion is back at rest. */
export const REACTION_MS = 1050;

const listeners = new Set<() => void>();
let active: ActiveReaction | null = null;
let sequence = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;

function notify() { for (const listener of listeners) listener(); }

export function react(input: ReactionInput) {
  clearTimeout(expiry);
  active = { ...reactionFor(input), sequence: ++sequence };
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
