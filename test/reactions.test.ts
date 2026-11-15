import { describe, expect, test } from "bun:test";
import { GESTURES, GESTURE_POSE, inputFromTurnEvent, reactionFor, withMotion } from "../src/app/room/reactions";
import type { ReactionInput } from "../src/app/room/reactions";
import type { TurnEvent, TutorMove, TutorMoveKind } from "../src/shared/domain";
import { POSES } from "../src/app/companion";

const MOVE_KINDS: readonly TutorMoveKind[] = ["ask_main", "quick_check", "ask_followup", "diagnose", "hint", "explain", "propose_detour", "detour_step", "answer_dispute", "disclose_correction", "close_thread", "wrap_up"];
const EVENTS: readonly ReactionInput[] = [...MOVE_KINDS.map((kind) => ({ type: "move", kind }) as const), { type: "learner_sent" }, { type: "source_opened" }, { type: "review_saved" }];
const ASSESSMENT = ["status", "observation", "observations", "correct", "correctness", "independent", "assessment", "outcome", "score"];

describe("reactions", () => {
  test("every input maps to a gesture that lands on a real pose", () => {
    for (const input of EVENTS) {
      const reaction = reactionFor(input);
      expect(GESTURES).toContain(reaction.gesture);
      expect(POSES).toContain(GESTURE_POSE[reaction.gesture]);
    }
  });

  test("the question is chalked and the close of a thread catches a notebook page", () => {
    expect(reactionFor({ type: "move", kind: "ask_main" }).effects).toContainEqual({ kind: "chalk-dust" });
    expect(reactionFor({ type: "move", kind: "close_thread" }).effects).toEqual([{ kind: "notebook-page" }]);
    expect(reactionFor({ type: "review_saved" }).effects).toContainEqual({ kind: "celebrate" });
  });

  test("a turn event is read only for its type and a move's kind, never an assessment", () => {
    const reads: (string | symbol)[] = [];
    const spy = <T extends object>(target: T): T => new Proxy(target, { get(t, key, receiver) { reads.push(key); return Reflect.get(t, key, receiver); } });
    const move = { kind: "diagnose", threadId: "t", hypothesis: "status: independent, correct", evidence: [] } as unknown as TutorMove;
    for (const kind of MOVE_KINDS) {
      reads.length = 0;
      const event = spy({ type: "move", turnId: "x", move: spy({ ...move, kind }) }) as unknown as TurnEvent;
      const input = inputFromTurnEvent(event);
      expect(input).toEqual({ type: "move", kind });
      for (const key of reads) expect(["type", "move", "kind"]).toContain(String(key));
    }
    expect(inputFromTurnEvent({ type: "say_delta", text: "Correct!" })).toBeNull();
  });

  test("no reaction value mentions an assessment", () => {
    for (const input of EVENTS) expect(JSON.stringify(reactionFor(input)).toLowerCase()).not.toMatch(new RegExp(ASSESSMENT.join("|")));
  });

  test("reduced motion keeps the gesture as an instant pose change and drops every effect", () => {
    for (const input of EVENTS) {
      const full = reactionFor(input);
      const reduced = withMotion(full, true);
      expect(reduced).toEqual({ gesture: full.gesture, effects: [], instant: true });
      expect(withMotion(full, false)).toBe(full);
    }
  });
});
