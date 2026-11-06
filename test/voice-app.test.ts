/** Tutor voice, app side: the ElevenLabs speaker's queue, prefetch, stop, fallback, and createApi's two voice calls. */
import { describe, expect, test } from "bun:test";
import { ApiError, createApi } from "../src/app/api";
import { chooseSpeaker, createElevenLabsSpeaker, synthPlayback } from "../src/app/voice";
import type { Playback } from "../src/app/voice";
import type { Speaker } from "../src/app/speech";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** Fake audio backend: each fetch is held until the test releases it; each play is held until it "ends". */
function rig(opts: { prefetch?: number } = {}) {
  const fetches: { text: string; signal: AbortSignal; release: () => void; fail: (e: unknown) => void }[] = [];
  const events: string[] = [];
  const plays: { text: string; end: () => void; failPlay: (e: unknown) => void; stopped: boolean }[] = [];
  const spoken: { text: string; end: () => void; stopped: boolean }[] = [];
  const texts = new WeakMap<Blob, string>();
  const speaker = createElevenLabsSpeaker({
    ...opts,
    fetchAudio: (text, signal) => {
      const d = deferred<Blob>();
      fetches.push({
        text, signal, fail: d.reject,
        release: () => {
          const blob = new Blob([text]);
          texts.set(blob, text);
          d.resolve(blob);
        },
      });
      events.push(`fetch ${text}`);
      signal.addEventListener("abort", () => d.reject(new DOMException("aborted", "AbortError")));
      return d.promise;
    },
    play: (blob) => {
      const d = deferred();
      const entry = { text: texts.get(blob)!, end: () => d.resolve(), failPlay: d.reject, stopped: false };
      plays.push(entry);
      events.push(`play ${entry.text}`);
      return { done: d.promise, stop: () => ((entry.stopped = true), d.resolve()) } satisfies Playback;
    },
    fallback: (text) => {
      const d = deferred();
      const entry = { text, end: () => d.resolve(), stopped: false };
      spoken.push(entry);
      events.push(`synth ${text}`);
      return { done: d.promise, stop: () => ((entry.stopped = true), d.resolve()) };
    },
  });
  return { speaker, fetches, events, plays, spoken };
}

describe("createElevenLabsSpeaker", () => {
  test("plays sentences in order, whatever order their audio arrives in", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("One.");
    r.speaker.speak("Two.");
    await settle();
    r.fetches[1]!.release();
    await settle();
    expect(r.plays).toHaveLength(0);
    r.fetches[0]!.release();
    await settle();
    expect(r.plays.map((p) => p.text)).toEqual(["One."]);
    r.plays[0]!.end();
    await settle();
    expect(r.plays.map((p) => p.text)).toEqual(["One.", "Two."]);
  });

  test("fetches the next sentence while the current one plays, but only as far ahead as it should", async () => {
    const r = rig({ prefetch: 2 });
    r.speaker.beginTurn();
    for (const s of ["A.", "B.", "C."]) r.speaker.speak(s);
    await settle();
    expect(r.fetches.map((f) => f.text)).toEqual(["A.", "B."]);
    r.fetches[0]!.release();
    await settle();
    expect(r.events.indexOf("play A.")).toBeGreaterThan(-1);
    expect(r.fetches.map((f) => f.text)).toEqual(["A.", "B."]);
    r.plays[0]!.end();
    await settle();
    expect(r.fetches.map((f) => f.text)).toEqual(["A.", "B.", "C."]);
  });

  test("stop() cuts the current audio, aborts in-flight fetches and drops the queue", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("A.");
    r.speaker.speak("B.");
    await settle();
    r.fetches[0]!.release();
    await settle();
    expect(r.plays).toHaveLength(1);
    r.speaker.stop();
    expect(r.plays[0]!.stopped).toBe(true);
    expect(r.fetches[1]!.signal.aborted).toBe(true);
    r.speaker.speak("Same turn, after stop.");
    r.fetches[1]!.release();
    await settle();
    expect(r.plays.map((p) => p.text)).toEqual(["A."]);
    expect(r.fetches).toHaveLength(2);
    expect(r.spoken).toHaveLength(0);
  });

  test("stop() while a sentence is still being fetched leaves nothing to play when the audio arrives", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("A.");
    await settle();
    r.speaker.stop();
    r.fetches[0]!.release();
    await settle();
    expect(r.plays).toHaveLength(0);
    expect(r.spoken).toHaveLength(0);
  });

  test("beginTurn() after stop() speaks again, and the stopped turn's leftovers do not leak into it", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("Old one.");
    r.speaker.speak("Old two.");
    await settle();
    r.speaker.stop();
    r.fetches[0]!.release();
    await settle();
    r.speaker.beginTurn();
    r.speaker.speak("New.");
    await settle();
    const fresh = r.fetches.find((f) => f.text === "New.")!;
    fresh.release();
    await settle();
    expect(r.plays.map((p) => p.text)).toEqual(["New."]);
    r.plays[0]!.end();
    await settle();
    expect(r.events.filter((e) => e.startsWith("play"))).toEqual(["play New."]);
  });

  test("blank sentences are ignored", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("   ");
    await settle();
    expect(r.fetches).toHaveLength(0);
  });

  test("a failed sentence is spoken by the fallback, in its place in the order, and the next one is back on ElevenLabs", async () => {
    const r = rig({ prefetch: 3 });
    r.speaker.beginTurn();
    r.speaker.speak("A.");
    r.speaker.speak("B.");
    r.speaker.speak("C.");
    await settle();
    r.fetches[1]!.release();
    r.fetches[2]!.release();
    r.fetches[0]!.fail(new ApiError("boom", 502));
    await settle();
    expect(r.events.filter((e) => /^(play|synth)/.test(e))).toEqual(["synth A."]);
    r.spoken[0]!.end();
    await settle();
    r.plays[0]!.end();
    await settle();
    r.plays[1]!.end();
    await settle();
    expect(r.events.filter((e) => /^(play|synth)/.test(e))).toEqual(["synth A.", "play B.", "play C."]);
  });

  test("a sentence whose audio will not play falls back too", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("A.");
    await settle();
    r.fetches[0]!.release();
    await settle();
    r.plays[0]!.failPlay(new Error("NotAllowedError"));
    await settle();
    expect(r.spoken.map((s) => s.text)).toEqual(["A."]);
  });

  test("when the backend says voice is unavailable (503), the rest of the session goes straight to the fallback with no more fetches", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("A.");
    await settle();
    r.fetches[0]!.fail(new ApiError("voice unavailable", 503));
    await settle();
    r.spoken[0]!.end();
    await settle();
    r.speaker.beginTurn();
    r.speaker.speak("B.");
    await settle();
    expect(r.fetches).toHaveLength(1);
    expect(r.spoken.map((s) => s.text)).toEqual(["A.", "B."]);
  });

  test("three network failures in a row end ElevenLabs for the session; one failure does not", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("A.");
    await settle();
    r.fetches[0]!.fail(new ApiError("offline", 0));
    await settle();
    r.spoken[0]!.end();
    r.speaker.speak("B.");
    await settle();
    expect(r.fetches.map((f) => f.text)).toEqual(["A.", "B."]);
    r.fetches[1]!.fail(new ApiError("offline", 0));
    await settle();
    r.spoken[1]!.end();
    r.speaker.speak("C.");
    await settle();
    r.fetches[2]!.fail(new ApiError("offline", 0));
    await settle();
    r.spoken[2]!.end();
    r.speaker.speak("D.");
    await settle();
    expect(r.fetches).toHaveLength(3);
    expect(r.spoken.map((s) => s.text)).toEqual(["A.", "B.", "C.", "D."]);
  });

  test("stop() cuts the fallback voice too", async () => {
    const r = rig();
    r.speaker.beginTurn();
    r.speaker.speak("A.");
    await settle();
    r.fetches[0]!.fail(new ApiError("x", 502));
    await settle();
    r.speaker.stop();
    expect(r.spoken[0]!.stopped).toBe(true);
  });
});

describe("chooseSpeaker", () => {
  const mark = (name: string, log: string[]): Speaker => ({ beginTurn: () => void log.push(`${name}.begin`), speak: (s) => void log.push(`${name}.speak ${s}`), stop: () => void log.push(`${name}.stop`) });

  test("uses Chrome's voice until availability is known, switches at the next turn, and stop reaches both", async () => {
    const log: string[] = [];
    const yes = deferred<boolean>();
    const s = chooseSpeaker(yes.promise, mark("el", log), mark("chrome", log));
    s.beginTurn();
    s.speak("a");
    yes.resolve(true);
    await settle();
    s.speak("b");
    s.beginTurn();
    s.speak("c");
    s.stop();
    expect(log).toEqual(["chrome.begin", "chrome.speak a", "chrome.speak b", "el.begin", "el.speak c", "el.stop", "chrome.stop"]);
  });

  test("stays on Chrome's voice when ElevenLabs is unavailable or the check fails", async () => {
    for (const available of [() => Promise.resolve(false), () => Promise.reject(new Error("down"))]) {
      const log: string[] = [];
      const s = chooseSpeaker(available(), mark("el", log), mark("chrome", log));
      await settle();
      s.beginTurn();
      s.speak("a");
      expect(log).toEqual(["chrome.begin", "chrome.speak a"]);
    }
  });
});

describe("synthPlayback", () => {
  test("resolves on the utterance's end, and stop() cancels and resolves", async () => {
    const cancelled: number[] = [];
    const utterances: { text: string; onend?: () => void; onerror?: () => void }[] = [];
    const play = synthPlayback(
      { speak: (u) => void utterances.push(u as never), cancel: () => void cancelled.push(1) },
      (text) => ({ text }) as SpeechSynthesisUtterance,
    );
    const a = play("One.");
    let ended = false;
    void a.done.then(() => (ended = true));
    await settle();
    expect(ended).toBe(false);
    utterances[0]!.onend!();
    await settle();
    expect(ended).toBe(true);
    const b = play("Two.");
    b.stop();
    await b.done;
    expect(cancelled).toEqual([1]);
  });
});

describe("createApi voice calls", () => {
  test("voiceAvailable reads GET /voice, and speech posts the sentence with the token and returns the audio", async () => {
    const seen: { url: string; method: string; auth: string | null; body: unknown; signal: unknown }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, signal: init?.signal });
      return url.endsWith("/voice") ? new Response(JSON.stringify({ available: true })) : new Response(new Blob(["mp3"], { type: "audio/mpeg" }));
    }) as typeof fetch;
    const api = createApi("tok", { fetch: fetchFn });
    expect(await api.voiceAvailable()).toBe(true);
    const ctrl = new AbortController();
    const blob = await api.speech("Hello there.", ctrl.signal);
    expect(await blob.text()).toBe("mp3");
    expect(seen.map((s) => [s.method, s.url, s.auth])).toEqual([["GET", "/voice", "Bearer tok"], ["POST", "/voice/speech", "Bearer tok"]]);
    expect(seen[1]!.body).toEqual({ text: "Hello there." });
    expect(seen[1]!.signal).toBe(ctrl.signal);
  });

  test("a non-200 is an ApiError carrying the status; an empty sentence never leaves the app", async () => {
    const api = createApi("tok", { fetch: (async () => new Response(JSON.stringify({ error: "voice unavailable" }), { status: 503 })) as unknown as typeof fetch });
    const error = await api.speech("Hello.").then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    await expect(api.speech("   ")).rejects.toThrow();
  });
});
