import { describe, expect, test } from "bun:test";
import type { TurnEvent, TutorMove } from "../src/shared/domain";
import { reactToTurnEvent } from "../src/app/review";
import { clearReaction } from "../src/app/room/reaction-store";
import { answer, complete, events, sentence, stored, setup, tid } from "./app-fixtures";

const moveEvent = { type: "move", turnId: tid("a"), move: { kind: "diagnose", threadId: "t", hypothesis: "status: independent, correct", evidence: [] } as unknown as TutorMove } as unknown as TurnEvent;

describe("the room's turn-event hook", () => {
  test("a throwing hook does not stop the stream: the sentence is spoken and the turn completes", async () => {
    const h = setup({ sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, moveEvent, sentence("One."), { type: "turn_complete", turnId }), onTurnEvent: () => { throw new Error("observer broke"); } });
    await h.controller.send(answer);
    expect(h.spoken).toEqual(["One."]);
    expect(h.controller.getState().live?.status).not.toBe("failed");
    expect(h.controller.getState().sendError).toBeNull();
  });

  test("after dispose, a stream still running delivers nothing to the hook", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const h = setup({
      sendTurn: async function* ({ turnId }) {
        yield { type: "learner_turn_stored", turnId };
        await gate;
        yield moveEvent;
        yield sentence("Late.");
        yield { type: "turn_complete", turnId };
      },
      onTurnEvent: (e) => void seen.push(e.type),
    });
    const sending = h.controller.send(answer);
    while (!seen.includes("learner_turn_stored")) await Promise.resolve();
    h.controller.dispose();
    release();
    await sending;
    expect(seen).toEqual(["learner_turn_stored"]);
  });

  test("a dispose while the unsent store is still writing silences the old review: no hook event, no speech, no send", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const h = setup({
      sendTurn: ({ turnId }) => events({ type: "learner_turn_stored", turnId }, moveEvent, sentence("Old review."), { type: "turn_complete", turnId }),
      onTurnEvent: (e) => void seen.push(e.type),
    });
    const put = h.unsent.put.bind(h.unsent);
    h.unsent.put = async (row) => {
      await gate;
      return put(row);
    };
    const sending = h.controller.send(answer);
    await Promise.resolve();
    h.controller.dispose();
    release();
    await sending;
    expect(seen).toEqual([]);
    expect(h.spoken).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(h.saves()).toBe(0);
  });

  test("the review's wiring reads only an event's type and a move's kind, never an assessment", async () => {
    const reads: (string | symbol)[] = [];
    const spy = <T extends object>(target: T): T => new Proxy(target, { get(t, key, receiver) { reads.push(key); return Reflect.get(t, key, receiver); } });
    // The controller and reducer read events for their own work, so the spy wraps the event only as the hook receives it.
    const raw = { ...moveEvent, move: { ...(moveEvent as { move: object }).move, status: "independent", correct: true } } as unknown as TurnEvent;
    const h = setup({ sendTurn: () => events(stored("a"), raw, sentence("Hi."), complete("a")), onTurnEvent: (event) => reactToTurnEvent(event.type === "move" ? (spy({ ...event, move: spy({ ...event.move }) }) as TurnEvent) : event) });
    await h.controller.send(answer);
    clearReaction();
    expect(reads.length).toBeGreaterThan(0);
    for (const key of reads) expect(["type", "move", "kind"]).toContain(String(key));
  });
});
