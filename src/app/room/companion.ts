import type { CompanionActivity, CompanionId } from "../appearance";
import { COMPANION_ART } from "./companion-art";
import type { PaintedFrame } from "./companion-art";
import type { Rect } from "./layout";
import type { Gesture } from "./reactions";
import type { CompanionDraw } from "./scene";

/**
 * One whole painted picture of the companion: a pose of its approved sheet, or a gesture frame. Every frame shares the
 * sheet cell's canvas and ground line, so swapping one for another never shifts the companion.
 */
export type Frame = "idle" | "draw" | "read" | PaintedFrame;

/** The sheet's columns, left to right. */
const SHEET: readonly Frame[] = ["idle", "draw", "read"];
/** The painted cell's size in pixels in the large files. A step's rise is in these pixels. */
const CELL = 724;
/** The largest cell the small files hold. */
const SMALL_CELL = 362;

/**
 * How far below the ground line each companion's hop-air frame is drawn, in cell pixels, so the stage lifts it by this much
 * to stand it on the ground before the hop's own rise (#275). test/companion-animation.test.ts reads it from provenance.
 */
export const AIR_DROP: Readonly<Record<CompanionId, number>> = { pip: 54, mote: 38, "mote-moonlit": 46, "mote-pagewing": 61, lumi: 0, yun: 39 };

/** One step of a gesture: the frame, how long it shows, and how far above the ground the body is, in cell pixels. */
type Step = { readonly frame: Frame; readonly ms: number; readonly rise?: number };

/**
 * A gesture as data. `steps` play once in order on stepped timing. `still` is the one frame shown instead under reduced
 * motion, as an instant pose change. A companion that lacks a frame of `steps` plays `fallback`, or stays at rest.
 */
type GestureSpec = { readonly steps: readonly Step[]; readonly still: Frame; readonly fallback?: Gesture };

const hold = (frame: Frame): GestureSpec => ({ steps: [{ frame, ms: 1050 }], still: frame });

/** Every gesture's frames and timing. A reaction holds for 1050 ms (reaction-store.ts), and every gesture fits inside it. */
export const GESTURES: Readonly<Record<Gesture, GestureSpec>> = {
  blink: { steps: [{ frame: "blink", ms: 120 }], still: "idle" },
  "look-board": hold("look-board"),
  "look-mat": hold("look-mat"),
  nod: { steps: [{ frame: "nod", ms: 260 }, { frame: "idle", ms: 160 }, { frame: "nod", ms: 260 }], still: "nod" },
  hop: { steps: [{ frame: "hop-crouch", ms: 180 }, { frame: "hop-air", ms: 260, rise: 90 }, { frame: "hop-crouch", ms: 140 }], still: "idle" },
  think: hold("think"),
  cheer: { ...hold("cheer"), fallback: "hop" },
  talk: { steps: [{ frame: "talk", ms: 150 }, { frame: "idle", ms: 120 }, { frame: "talk", ms: 150 }, { frame: "idle", ms: 120 }, { frame: "talk", ms: 150 }], still: "talk" },
  draw: hold("draw"),
  read: hold("read"),
};

/** The frame the companion rests on between gestures: toward the mat while the learner answers, toward the board while it waits. */
const REST: Readonly<Record<CompanionActivity, Frame>> = { idle: "idle", listening: "look-mat", waiting: "look-board", paused: "idle", saving: "idle" };

/** What the room tells the companion: who it is, what the review is doing, and the reaction playing since `at`. */
export type CompanionCue = {
  readonly id: CompanionId;
  readonly activity: CompanionActivity;
  readonly gesture: { readonly name: Gesture; readonly at: number } | null;
};

/**
 * Where the companion's idle blinking counts from, and the seed its irregular intervals are drawn from. The same cue, idle
 * and time always give the same frame.
 */
export type Idle = { readonly since: number; readonly seed: number };

/** The frame to draw, how far to lift it in cell pixels, and the time the frame next changes, or null while nothing will. */
export type Shown = { readonly frame: Frame; readonly lift: number; readonly next: number | null };

const has = (id: CompanionId, frame: Frame) => SHEET.includes(frame) || COMPANION_ART[id].frames[frame as PaintedFrame] !== undefined;

/** The gesture `id` plays for `name`: the gesture itself, its fallback when a frame is missing, or nothing. */
function playable(id: CompanionId, name: Gesture): GestureSpec | null {
  for (let spec: GestureSpec | undefined = GESTURES[name]; spec !== undefined; spec = spec.fallback && GESTURES[spec.fallback]) {
    if (spec.steps.every((step) => has(id, step.frame))) return spec;
  }
  return null;
}

/** Idle blinks fall one per window, at a seeded offset in its first part, so two blinks are 2.4 to 7.6 seconds apart. */
const BLINK_WINDOW = 5000;
const BLINK_SPREAD = 2600;
/** One window in four blinks twice. */
const BLINK: readonly Step[] = [{ frame: "blink", ms: 120 }];
const DOUBLE_BLINK: readonly Step[] = [{ frame: "blink", ms: 120 }, { frame: "idle", ms: 140 }, { frame: "blink", ms: 120 }];

/** A value in [0, 1) from `seed` and `k`, the same every time. */
function unit(seed: number, k: number): number {
  let h = Math.imul(seed ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}

/** Plays `steps` from `start`: the step showing at `now` and when it ends, or null once they are over. */
function stepAt(steps: readonly Step[], start: number, now: number): { readonly step: Step; readonly end: number } | null {
  let end = start;
  for (const step of steps) {
    end += step.ms;
    if (now < end) return { step, end };
  }
  return null;
}

/**
 * When the companion is back at rest after the cue's gesture, or -Infinity with none. Its blinks count from then, so the
 * stage keeps it as its idle's `since` after the reaction has cleared, and the blinks do not jump when the cue drops it.
 */
export function restsFrom(cue: CompanionCue): number {
  const spec = cue.gesture === null ? null : playable(cue.id, cue.gesture.name);
  return spec === null || cue.gesture === null ? -Infinity : cue.gesture.at + spec.steps.reduce((sum, step) => sum + step.ms, 0);
}

/**
 * The companion at `now`, or at rest when `now` is null because the room is still: a reaction is then its gesture's still
 * frame, held until the reaction ends, and nothing blinks.
 */
export function companionAt(cue: CompanionCue, idle: Idle, now: number | null): Shown {
  const rest = has(cue.id, REST[cue.activity]) ? REST[cue.activity] : "idle";
  const spec = cue.gesture === null ? null : playable(cue.id, cue.gesture.name);
  if (now === null) return { frame: spec?.still ?? rest, lift: 0, next: null };
  const shown = (step: Step, next: number): Shown => ({ frame: step.frame, lift: (step.rise ?? 0) + (step.frame === "hop-air" ? AIR_DROP[cue.id] : 0), next });
  if (spec !== null && cue.gesture !== null) {
    const playing = stepAt(spec.steps, cue.gesture.at, now);
    if (playing !== null) return shown(playing.step, playing.end);
  }
  const from = Math.max(idle.since, restsFrom(cue));
  if (cue.activity === "paused" || !has(cue.id, "blink")) return { frame: rest, lift: 0, next: null };
  // The stage keeps a gesture's end as `since` while it plays. A cue cleared before then, by a room or companion switch, has
  // no gesture left to wake the stage at that end, so the wake is asked for here and blinking resumes.
  if (now < from) return { frame: rest, lift: 0, next: from };
  const window = Math.floor((now - from) / BLINK_WINDOW);
  const blinkAt = (k: number) => from + k * BLINK_WINDOW + unit(idle.seed, k) * BLINK_SPREAD;
  const steps = unit(idle.seed ^ 0x5bd1e995, window) < 0.25 ? DOUBLE_BLINK : BLINK;
  const start = blinkAt(window);
  if (now < start) return { frame: rest, lift: 0, next: start };
  const blinking = stepAt(steps, start, now);
  if (blinking !== null) return shown(blinking.step.frame === "idle" ? { ...blinking.step, frame: rest } : blinking.step, blinking.end);
  return { frame: rest, lift: 0, next: blinkAt(window + 1) };
}

/** Which file size draws a companion `height` CSS pixels tall at `ratio` device pixels per CSS pixel: the small file while it has a pixel for every device pixel. */
const sizeFor = (height: number, ratio: number) => (height * ratio > SMALL_CELL ? "large" : "small");

/**
 * The companion's draw in `box`, the square layout.ts gives it, at `ratio` device pixels per CSS pixel, and every file it may
 * draw at that size, so the stage can decode them before the first gesture needs one. `cell` is the box's height in plate
 * pixels, and a lift moves the whole frame up in whole plate pixels. Until a gesture frame has decoded, the stage draws the sheet's idle pose in its place.
 */
export function companionDraw(id: CompanionId, shown: Shown, box: Rect, ratio: number, cell: number): { readonly draw: CompanionDraw; readonly files: readonly string[] } {
  const size = sizeFor(box.height, ratio);
  const { sheet, frames } = COMPANION_ART[id];
  const files = [sheet[size], ...Object.values(frames).map((f) => f[size])];
  const rect = { ...box, top: box.top - (Math.round((shown.lift * cell) / CELL) * box.height) / cell };
  const idle = { kind: "companion", frame: "idle", src: sheet[size], rect: box, column: 0, columns: SHEET.length, standIn: null } as const;
  const column = SHEET.indexOf(shown.frame);
  if (column >= 0) return { draw: { ...idle, frame: shown.frame, rect, column }, files };
  return { draw: { kind: "companion", frame: shown.frame, src: frames[shown.frame as PaintedFrame]![size], rect, column: 0, columns: 1, standIn: idle }, files };
}
