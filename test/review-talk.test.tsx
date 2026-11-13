import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { currentExchange, reduceLive, shouldAutoSendSpeech, startLive, turnStatus } from "../src/app/core";
import type { Line, Live } from "../src/app/core";
import { Composer, TurnStatusNote } from "../src/app/review";
import type { SpeechInput } from "../src/app/speech";
import type { TutorMove } from "../src/shared/domain";

const ask: TutorMove = { kind: "wrap_up" };
const quiet: SpeechInput = { supported: true, start() {}, stop() {} };

describe("the current question stays with the composer", () => {
  const line = (key: string, speaker: Line["speaker"]): Line => ({ key, speaker, label: speaker, text: key, evidenceIds: [] });
  const keys = (ls: readonly Line[]) => ls.map((l) => l.key);

  test("the tutor's latest run of lines is current; everything before it is earlier history", () => {
    const { earlier, current } = currentExchange([line("begin", "system"), line("q1", "tutor"), line("a1", "you"), line("fix", "tutor"), line("q2", "tutor")]);
    expect(keys(earlier)).toEqual(["begin", "q1", "a1"]);
    expect(keys(current)).toEqual(["fix", "q2"]);
  });

  test("an answer awaiting a reply stays beside the question it answers", () => {
    const { earlier, current } = currentExchange([line("q1", "tutor"), line("a1", "you"), line("q2", "tutor"), line("a2", "you"), line("note", "system")]);
    expect(keys(earlier)).toEqual(["q1", "a1"]);
    expect(keys(current)).toEqual(["q2", "a2", "note"]);
  });

  test("before the tutor speaks there is no current question, and nothing is dropped", () => {
    expect(currentExchange([])).toEqual({ earlier: [], current: [] });
    const begin = [line("begin", "system")];
    expect(currentExchange(begin)).toEqual({ earlier: begin, current: [] });
  });

  test("the current question comes before the composer, and the composer keeps one place", () => {
    const tsx = readFileSync(new URL("../src/app/review.tsx", import.meta.url), "utf8");
    const at = (needle: string) => { const i = tsx.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };
    expect(at('className="current-exchange"')).toBeLessThan(at("<Composer"));
    expect(tsx.match(/<Composer\b/g)).toHaveLength(1);
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
    expect(html).toContain("Your thinking");
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
