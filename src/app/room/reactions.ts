import type { TurnEvent, TutorMoveKind } from "../../shared/domain";
import type { Pose } from "../companion";

/**
 * What the room reacts to. It carries what happened and nothing else: a move's kind, never its claims, evidence or
 * hypothesis, and no observation, status or correctness field exists on it. Nothing is assessed during a review, so a
 * reaction has nothing to read that could say an answer was right.
 */
export type ReactionInput =
  | { readonly type: "move"; readonly kind: TutorMoveKind }
  | { readonly type: "learner_sent" }
  | { readonly type: "source_opened" }
  | { readonly type: "review_saved" };

/** Every gesture the companion will have once #222's rig lands. Today each maps onto one of the three painted poses. */
export const GESTURES = ["blink", "look-board", "look-mat", "nod", "hop", "think", "cheer", "talk", "draw", "read"] as const;
export type Gesture = (typeof GESTURES)[number];

export const GESTURE_POSE: Readonly<Record<Gesture, Pose>> = {
  blink: "idle",
  "look-board": "draw",
  "look-mat": "idle",
  nod: "idle",
  hop: "idle",
  think: "read",
  cheer: "draw",
  talk: "idle",
  draw: "draw",
  read: "read",
};

export type EmoteGlyph = "?" | "…" | "!";

/** A room effect as data. The stage draws it; nothing here draws. */
export type RoomEffect =
  | { readonly kind: "chalk-dust" }
  | { readonly kind: "emote"; readonly glyph: EmoteGlyph }
  | { readonly kind: "notebook-page" }
  | { readonly kind: "celebrate" };

export type Reaction = {
  readonly gesture: Gesture;
  readonly effects: readonly RoomEffect[];
  /** Reduced motion: the gesture is an instant pose change, with no easing or movement. */
  readonly instant: boolean;
};

type Entry = { readonly gesture: Gesture; readonly effects: readonly RoomEffect[] };
const chalk: RoomEffect = { kind: "chalk-dust" };
const emote = (glyph: EmoteGlyph): RoomEffect => ({ kind: "emote", glyph });

/** One row per move. A new tutor move fails to compile until it has a row. */
const MOVES: Readonly<Record<TutorMoveKind, Entry>> = {
  ask_main: { gesture: "look-board", effects: [chalk, emote("?")] },
  quick_check: { gesture: "look-board", effects: [chalk] },
  ask_followup: { gesture: "look-board", effects: [chalk, emote("?")] },
  diagnose: { gesture: "think", effects: [emote("…")] },
  hint: { gesture: "talk", effects: [emote("!")] },
  explain: { gesture: "talk", effects: [chalk] },
  propose_detour: { gesture: "think", effects: [emote("?")] },
  detour_step: { gesture: "talk", effects: [] },
  answer_dispute: { gesture: "think", effects: [emote("…")] },
  disclose_correction: { gesture: "talk", effects: [] },
  close_thread: { gesture: "nod", effects: [{ kind: "notebook-page" }] },
  wrap_up: { gesture: "read", effects: [] },
};

const EVENTS: Readonly<Record<Exclude<ReactionInput["type"], "move">, Entry>> = {
  learner_sent: { gesture: "look-mat", effects: [] },
  source_opened: { gesture: "draw", effects: [] },
  review_saved: { gesture: "cheer", effects: [{ kind: "celebrate" }, { kind: "notebook-page" }] },
};

export function reactionFor(input: ReactionInput): Reaction {
  const entry = input.type === "move" ? MOVES[input.kind] : EVENTS[input.type];
  return { gesture: entry.gesture, effects: entry.effects, instant: false };
}

/** Reduced motion keeps the gesture as an instant pose change and drops every effect. */
export function withMotion(reaction: Reaction, reduced: boolean): Reaction {
  return reduced ? { gesture: reaction.gesture, effects: [], instant: true } : reaction;
}

/** The streamed events the room reacts to. Reads only the event's type and a move's kind. */
export function inputFromTurnEvent(event: TurnEvent): ReactionInput | null {
  if (event.type === "move") return { type: "move", kind: event.move.kind };
  if (event.type === "learner_turn_stored") return { type: "learner_sent" };
  return null;
}
