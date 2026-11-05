import { useSyncExternalStore } from "react";

export type CompanionGesture = "draw" | "read";
type Reaction = { readonly kind: CompanionGesture; readonly sequence: number };
const listeners = new Set<() => void>();
let reaction: Reaction | null = null;
let sequence = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;

function notify() { for (const listener of listeners) listener(); }
export function reactToCompanion(kind: CompanionGesture) {
  clearTimeout(expiry);
  reaction = { kind, sequence: ++sequence };
  notify();
  expiry = setTimeout(() => { reaction = null; notify(); }, 1050);
}
export function clearCompanionReaction() {
  clearTimeout(expiry);
  reaction = null;
  notify();
}
export function useCompanionReaction() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => reaction,
    () => null,
  );
}
