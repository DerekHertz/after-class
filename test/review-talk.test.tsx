import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { INITIAL_SOURCE_OPEN, reduceLive, reviewLayout, shouldAutoSendSpeech, startLive, turnStatus } from "../src/app/core";
import type { Live } from "../src/app/core";
import { Composer, TurnStatusNote } from "../src/app/review";
import type { SpeechInput } from "../src/app/speech";
import type { TutorMove } from "../src/shared/domain";

const ask: TutorMove = { kind: "wrap_up" };
const quiet: SpeechInput = { supported: true, start() {}, stop() {} };

describe("the conversation is never hidden", () => {
  test("the source panel starts closed, and toggling it never touches the conversation", () => {
    expect(INITIAL_SOURCE_OPEN).toBe(false);
    for (const open of [true, false]) expect(reviewLayout(open)).toEqual({ conversationVisible: true, sourceVisible: open });
  });

  test("the review page never hides the conversation or offers the room-only landing", () => {
    const tsx = readFileSync(new URL("../src/app/review.tsx", import.meta.url), "utf8");
    expect(tsx).not.toContain("roomLanding");
    expect(tsx).not.toContain("studyOpen");
    expect(tsx).not.toContain("Back to room");
    expect(tsx).not.toMatch(/conversation-notebook"[^>]*hidden=/);
    const closeSource = /function closeSource\(\) \{[\s\S]*?\n  \}/.exec(tsx)![0];
    expect(closeSource).not.toMatch(/set(Study|Conversation|Room)/);
  });

  test("no stylesheet hides the conversation or turns it into an overlay", () => {
    for (const file of ["hd-room.css", "reference.css", "review.css", "styles.css", "scene.css"]) {
      const css = readFileSync(new URL(`../src/app/${file}`, import.meta.url), "utf8");
      expect(css).not.toMatch(/conversation-notebook[^{]*\{[^}]*(visibility:\s*hidden|display:\s*none)/);
      expect(css).not.toContain('data-view="room"');
      expect(css).not.toContain('data-view="study"');
    }
    const hd = readFileSync(new URL("../src/app/hd-room.css", import.meta.url), "utf8");
    expect(hd).not.toMatch(/conversation-notebook[^{]*\{[^}]*position:\s*absolute/);
  });
});

describe("a spoken answer sends itself", () => {
  test("only a final, non-empty transcript with an answer allowed is sent", () => {
    expect(shouldAutoSendSpeech({ text: "the cache is write-back", final: true }, true)).toBe(true);
    expect(shouldAutoSendSpeech({ text: "the cache is", final: false }, true)).toBe(false);
    expect(shouldAutoSendSpeech({ text: "   ", final: true }, true)).toBe(false);
    expect(shouldAutoSendSpeech({ text: "", final: true }, true)).toBe(false);
    expect(shouldAutoSendSpeech(null, true)).toBe(false);
    expect(shouldAutoSendSpeech({ text: "the cache is write-back", final: true }, false)).toBe(false);
  });
});

describe("what the composer says while a turn is under way", () => {
  const live = (patch: Partial<Live>): Live => ({ ...startLive("t"), ...patch });
  const base = { listening: false, transcript: "", submitting: false, live: null };

  test("idle says nothing", () => {
    expect(turnStatus(base)).toEqual({ kind: "idle", text: null });
    expect(renderToStaticMarkup(createElement(TurnStatusNote, { status: turnStatus(base) }))).toBe("");
  });

  test("listening shows the prompt and the live transcript", () => {
    const status = turnStatus({ ...base, listening: true, transcript: "the cache" });
    expect(status).toMatchObject({ kind: "listening", text: "Listening… speak your answer", transcript: "the cache" });
    const html = renderToStaticMarkup(createElement(TurnStatusNote, { status }));
    expect(html).toContain("Listening… speak your answer");
    expect(html).toContain("the cache");
  });

  test("sending while the learner turn is in flight, then thinking until words stream, then replying", () => {
    expect(turnStatus({ ...base, submitting: true }).text).toBe("Sending…");
    expect(turnStatus({ ...base, live: live({ stored: false }) }).text).toBe("Sending…");
    expect(turnStatus({ ...base, live: live({ stored: true }) }).text).toBe("Tutor is thinking…");
    expect(turnStatus({ ...base, live: live({ stored: true, deltaText: "What is" }) })).toMatchObject({ kind: "replying" });
    expect(turnStatus({ ...base, live: live({ stored: true, status: "complete" }) }).kind).toBe("idle");
    expect(turnStatus({ ...base, live: live({ stored: true, status: "failed", error: "x" }) }).kind).toBe("idle");
  });

  test("the composer renders the status and the speech error", () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      actions: ["answer"], disabled: true, sendError: null, speech: quiet, onSpeaking() {},
      live: live({ stored: true }), send: async () => true,
    }));
    expect(html).toContain("Tutor is thinking…");
    expect(html).toContain("Your response");
  });
});

describe("a request with several tutor moves streams each as its own segment", () => {
  test("words after a move event start the next move's text", () => {
    let l = startLive("t");
    l = reduceLive(l, { type: "learner_turn_stored", turnId: "t" as never });
    l = reduceLive(l, { type: "say_delta", text: "A correction." });
    l = reduceLive(l, { type: "sentence", text: "A correction." });
    l = reduceLive(l, { type: "move", turnId: "a" as never, move: ask });
    l = reduceLive(l, { type: "say_delta", text: "Now a " });
    l = reduceLive(l, { type: "say_delta", text: "question." });
    expect(l.deltaText).toBe("Now a question.");
    expect(l.sentences).toEqual([]);
    expect(l.move).toBeNull();
    l = reduceLive(l, { type: "move", turnId: "b" as never, move: ask });
    expect(l.move).toEqual(ask);
    expect(l.status).toBe("streaming");
  });
});
