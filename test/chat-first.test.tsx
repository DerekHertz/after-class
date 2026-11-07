/** Chat-first review: voice is off unless the learner turns it on. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VOICE_KEY, persistVoice, readVoice } from "../src/app/appearance";
import { shouldAutoSendSpeech, shouldStopListening } from "../src/app/core";
import { Composer } from "../src/app/review";
import { FrontRowScene } from "../src/app/front-row";
import { SceneShell } from "../src/app/scene";
import type { Speaker, SpeechInput } from "../src/app/speech";
import { gateSpeaker } from "../src/app/voice";

const quiet: SpeechInput = { supported: true, start() {}, stop() {} };
const composer = (extra: object) => renderToStaticMarkup(createElement(Composer, {
  actions: ["answer"], disabled: false, sendError: null, speech: quiet, onSpeaking() {}, send: async () => true, ...extra,
}));

describe("voice setting storage", () => {
  test("defaults off, including when storage is missing or throws", () => {
    expect(readVoice(null)).toBe(false);
    expect(readVoice({ getItem: () => null })).toBe(false);
    expect(readVoice({ getItem() { throw new Error("denied"); } })).toBe(false);
    expect(persistVoice({ setItem() { throw new Error("denied"); } }, true)).toBe(false);
    expect(persistVoice(null, true)).toBe(false);
  });
  test("on round-trips and off clears it", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(persistVoice(storage, true)).toBe(true);
    expect(m.get(VOICE_KEY)).toBe("on");
    expect(readVoice(storage)).toBe(true);
    persistVoice(storage, false);
    expect(readVoice(storage)).toBe(false);
  });
});

describe("gateSpeaker", () => {
  const rig = () => {
    const log: string[] = [];
    const inner: Speaker = { beginTurn: () => void log.push("begin"), speak: (s) => void log.push(`speak ${s}`), stop: () => void log.push("stop") };
    return { log, make: () => (log.push("made"), inner) };
  };
  test("off: nothing is made, spoken or awaited", () => {
    const r = rig();
    const s = gateSpeaker(() => false, r.make);
    s.beginTurn();
    s.speak("Hello.");
    s.stop();
    expect(r.log).toEqual([]);
  });
  test("on: the real speaker is used, made once", () => {
    const r = rig();
    const s = gateSpeaker(() => true, r.make);
    s.beginTurn();
    s.speak("Hello.");
    s.beginTurn();
    s.stop();
    expect(r.log).toEqual(["made", "begin", "speak Hello.", "begin", "stop"]);
  });
  test("turning it off mid-turn silences the rest and stop still reaches the speaker", () => {
    const r = rig();
    let on = true;
    const s = gateSpeaker(() => on, r.make);
    s.beginTurn();
    s.speak("One.");
    on = false;
    s.speak("Two.");
    s.stop();
    expect(r.log).toEqual(["made", "begin", "speak One.", "stop"]);
  });
});

describe("voice switched off while listening", () => {
  test("the microphone stops, and a late final transcript is not sent", () => {
    expect(shouldStopListening(true, true, false)).toBe(true);
    expect(shouldStopListening(true, true, true)).toBe(false);
    expect(shouldStopListening(true, false, true)).toBe(true);
    expect(shouldStopListening(false, true, false)).toBe(false);
    // The composer folds the voice setting into `allowed`, so onEnd cannot send once voice is off.
    expect(shouldAutoSendSpeech({ text: "the cache", final: true }, false)).toBe(false);
  });
});

describe("Speak controls", () => {
  test("the composer shows Speak only when asked, and by default for direct use", () => {
    expect(composer({ showSpeak: false })).not.toContain("Speak");
    expect(composer({ showSpeak: false })).not.toContain("Speech input is not available");
    expect(composer({ showSpeak: true })).toContain("Speak");
  });
  test("the room adds no Speak control of its own, so voice off leaves no Speak anywhere in the scene", () => {
    const html = (showSpeak: boolean) => renderToStaticMarkup(createElement(FrontRowScene, {
      scene: "last-desk", appearance: { companion: "mote", visible: true, motion: "system" }, activity: "idle", onNotebook() {},
      layout: { kind: "review", board: "Why?", desk: createElement(Composer, { actions: ["answer"], disabled: false, sendError: null, speech: quiet, onSpeaking() {}, send: async () => true, showSpeak }) },
    }));
    expect(html(false)).not.toContain("Speak");
    expect(html(true).match(/>Speak</g)).toHaveLength(1);
  });
  test("the voice setting lives with Room & companion, off by default", () => {
    const html = renderToStaticMarkup(createElement(SceneShell, null));
    expect(html).toContain("Room &amp; companion");
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*\/> Voice/);
  });
});
