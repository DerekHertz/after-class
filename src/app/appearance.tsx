import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

export const SCENES = {
  "last-desk": { name: "The Last Desk", detail: "Honey wood, warm paper, mint chalkboard" },
  "projection-booth": { name: "The Projection Booth", detail: "Evening indigo, amber lamplight, cream paper" },
  "study-bench": { name: "The Study Bench", detail: "Mint enamel, paper feed, cobalt controls" },
} as const;
export const COMPANIONS = {
  pip: { name: "Pip", detail: "The eraser friend" },
  mote: { name: "Mote", detail: "The book moth" },
  lumi: { name: "Lumi", detail: "The desk-lamp companion" },
  "mote-moonlit": { name: "Moonlit Library Mote", detail: "A navy bookmark scarf" },
  yun: { name: "Inkcloud Yun", detail: "The cloud dragonlet" },
  "mote-pagewing": { name: "Pagewing Spirit Mote", detail: "Parchment wings and a moss satchel" },
} as const;
export type SceneId = keyof typeof SCENES;
export type CompanionId = keyof typeof COMPANIONS;
export type CompanionActivity = "idle" | "listening" | "waiting" | "paused" | "saving";
export type Appearance = { readonly detail: "painted" | "hd-pixel"; readonly scene: SceneId; readonly companion: CompanionId; readonly visible: boolean; readonly motion: "system" | "reduced" };
export const APPEARANCE_KEY = "afterclass.appearance.v1";
export const DEFAULT_APPEARANCE: Appearance = { detail: "hd-pixel", scene: "last-desk", companion: "mote", visible: true, motion: "system" };

export function parseAppearance(raw: string | null): Appearance {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_APPEARANCE;
    const v = value as Record<string, unknown>;
    return {
      detail: "hd-pixel",
      scene: typeof v.scene === "string" && Object.hasOwn(SCENES, v.scene) ? v.scene as SceneId : DEFAULT_APPEARANCE.scene,
      companion: typeof v.companion === "string" && Object.hasOwn(COMPANIONS, v.companion) ? v.companion as CompanionId : DEFAULT_APPEARANCE.companion,
      visible: typeof v.visible === "boolean" ? v.visible : DEFAULT_APPEARANCE.visible,
      motion: v.motion === "reduced" ? "reduced" : "system",
    };
  } catch { return DEFAULT_APPEARANCE; }
}
export function readAppearance(storage: Pick<Storage, "getItem"> | null): Appearance {
  try { return parseAppearance(storage?.getItem(APPEARANCE_KEY) ?? null); } catch { return DEFAULT_APPEARANCE; }
}
export function persistAppearance(storage: Pick<Storage, "setItem"> | null, value: Appearance): boolean {
  try {
    if (storage === null) return false;
    storage.setItem(APPEARANCE_KEY, JSON.stringify(value));
    return true;
  } catch { return false; }
}
function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
const ignoreActivity: Dispatch<SetStateAction<CompanionActivity>> = () => {};
const AppearanceContext = createContext({ appearance: DEFAULT_APPEARANCE, update: (_patch: Partial<Appearance>) => {}, activity: "idle" as CompanionActivity, setActivity: ignoreActivity, persistent: true });
export function AppearanceProvider({ children }: { readonly children: ReactNode }) {
  const [appearance, setAppearance] = useState(() => readAppearance(browserStorage()));
  const [activity, setActivity] = useState<CompanionActivity>("idle");
  const [persistent, setPersistent] = useState(true);
  const update = useCallback((patch: Partial<Appearance>) => setAppearance(p => ({ ...p, ...patch })), []);
  useEffect(() => { setPersistent(persistAppearance(browserStorage(), appearance)); }, [appearance]);
  const value = useMemo(() => ({ appearance, update, activity, setActivity, persistent }), [appearance, update, activity, persistent]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
export function useAppearance() { return useContext(AppearanceContext); }
export function useSceneActivity(activity: CompanionActivity) {
  const { setActivity } = useAppearance();
  useEffect(() => { setActivity(activity); return () => setActivity("idle"); }, [activity, setActivity]);
}
