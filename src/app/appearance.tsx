import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

/** Scene IDs are what browsers have saved, so they stay; each now names one of the three front-row skins. */
export const SCENES = {
  "last-desk": { name: "Rail-side Classroom", detail: "A chalkboard by the window, trains passing over the bridge" },
  "study-bench": { name: "Harbor Study Terrace", detail: "An open-air board above the sea, cream paper on the desk" },
  "projection-booth": { name: "Lantern Canal Film Club", detail: "A cream screen, rain on the canal, a navy desk mat" },
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
/** Tutor speech and the Speak controls. Off unless the learner turns it on; stored per browser, apart from the look of the room. */
export const VOICE_KEY = "afterclass.voice.v1";
export function readVoice(storage: Pick<Storage, "getItem"> | null): boolean {
  try { return storage?.getItem(VOICE_KEY) === "on"; } catch { return false; }
}
export function persistVoice(storage: Pick<Storage, "setItem"> | null, on: boolean): boolean {
  try {
    if (storage === null) return false;
    storage.setItem(VOICE_KEY, on ? "on" : "off");
    return true;
  } catch { return false; }
}
let voiceOn: boolean | null = null;
/** The current voice setting, readable outside React (the speaker asks it at the start of each turn). */
export function voiceEnabled(): boolean {
  voiceOn ??= readVoice(browserStorage());
  return voiceOn;
}
function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
const ignoreActivity: Dispatch<SetStateAction<CompanionActivity>> = () => {};
const AppearanceContext = createContext({ appearance: DEFAULT_APPEARANCE, update: (_patch: Partial<Appearance>) => {}, activity: "idle" as CompanionActivity, setActivity: ignoreActivity, persistent: true, voice: false, setVoice: (_on: boolean) => {} });
export function AppearanceProvider({ children }: { readonly children: ReactNode }) {
  const [appearance, setAppearance] = useState(() => readAppearance(browserStorage()));
  const [activity, setActivity] = useState<CompanionActivity>("idle");
  const [persistent, setPersistent] = useState(true);
  const [voice, setVoiceState] = useState(voiceEnabled);
  const setVoice = useCallback((on: boolean) => { voiceOn = on; persistVoice(browserStorage(), on); setVoiceState(on); }, []);
  const update = useCallback((patch: Partial<Appearance>) => setAppearance(p => ({ ...p, ...patch })), []);
  // Report a synchronous browser-storage write failure to the user.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { setPersistent(persistAppearance(browserStorage(), appearance)); }, [appearance]);
  const value = useMemo(() => ({ appearance, update, activity, setActivity, persistent, voice, setVoice }), [appearance, update, activity, persistent, voice, setVoice]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
export function useAppearance() { return useContext(AppearanceContext); }
export function useSceneActivity(activity: CompanionActivity) {
  const { setActivity } = useAppearance();
  useEffect(() => { setActivity(activity); return () => setActivity("idle"); }, [activity, setActivity]);
}
