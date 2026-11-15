import { useSyncExternalStore } from "react";
import type { Appearance } from "../appearance";
import type { Composition } from "./layout";

/** What decides whether the room moves: the learner's Reduce motion setting, the system's, and how the room is composed. */
export type MotionInputs = {
  readonly setting: Appearance["motion"];
  readonly systemReduced: boolean;
  readonly composition: Composition;
};

/**
 * The one switch for motion drawn on the stage, read by ambient life and by the companion's animation. The room moves only
 * when neither the app's Reduce motion setting nor the system's `prefers-reduced-motion` asks for stillness, and only in the
 * full composition: a phone or a short window composes the room as a flat backdrop and keeps it still by default.
 */
export function motionOn({ setting, systemReduced, composition }: MotionInputs): boolean {
  return setting !== "reduced" && !systemReduced && composition === "full";
}

const QUERY = "(prefers-reduced-motion: reduce)";
const media = (): MediaQueryList | null => (typeof matchMedia === "function" ? matchMedia(QUERY) : null);
const subscribe = (notify: () => void) => {
  const list = media();
  list?.addEventListener("change", notify);
  return () => list?.removeEventListener("change", notify);
};

/** `motionOn` for the current system setting, updating when the learner changes it. */
export function useMotion(setting: Appearance["motion"], composition: Composition): boolean {
  const systemReduced = useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
  return motionOn({ setting, systemReduced, composition });
}
