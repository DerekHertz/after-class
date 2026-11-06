/**
 * ElevenLabs tutor voice (app side). Same `Speaker` contract as the synth speaker: `speak` queues a sentence,
 * sentences play in order, the next one's audio is fetched while the current one plays, `stop` cuts the current
 * audio and drops the queue (the tutor stops when the learner starts), and `beginTurn` lifts an earlier stop.
 *
 * The review never goes silent: a sentence whose audio fails is spoken by `fallback` (Chrome's speechSynthesis), and
 * once ElevenLabs is clearly unavailable (the backend says so, rejects the token, or fails three times in a row) every
 * later sentence of the session goes straight to the fallback.
 */
import { ApiError } from "./api";
import type { Speaker } from "./speech";

/** One thing being said. `done` settles when it has finished or been stopped; it rejects only if it could not play. */
export type Playback = { readonly done: Promise<void>; stop(): void };

export type VoiceDeps = {
  fetchAudio(text: string, signal: AbortSignal): Promise<Blob>;
  play(audio: Blob): Playback;
  /** Chrome's voice, one sentence at a time, resolving when it has finished. */
  fallback(text: string): Playback;
  /** Sentences whose audio is fetched ahead, counting the one playing. Default 2. */
  readonly prefetch?: number;
};

const PERMANENT = new Set([401, 403, 404, 503]);
const MAX_CONSECUTIVE_FAILURES = 3;

type Item = { readonly text: string; blob: Promise<Blob | null> | null; ctrl: AbortController | null };

export function createElevenLabsSpeaker(deps: VoiceDeps): Speaker {
  const ahead = deps.prefetch ?? 2;
  let stopped = false;
  let epoch = 0;
  let queue: Item[] = [];
  let running = false;
  let current: Playback | null = null;
  let degraded = false;
  let failures = 0;

  function noteFailure(error: unknown): void {
    failures += 1;
    // A network error (status 0) is transient for one sentence; three in a row end the session's ElevenLabs use.
    if ((error instanceof ApiError && PERMANENT.has(error.status)) || failures >= MAX_CONSECUTIVE_FAILURES) degraded = true;
  }

  function start(item: Item): void {
    if (item.blob !== null || degraded) return;
    const ctrl = new AbortController();
    item.ctrl = ctrl;
    item.blob = deps.fetchAudio(item.text, ctrl.signal).then(
      (blob) => {
        failures = 0;
        return blob;
      },
      (error: unknown) => {
        if (!ctrl.signal.aborted) noteFailure(error);
        return null;
      },
    );
  }

  const prefetchAhead = () => queue.slice(0, ahead).forEach(start);

  async function play(mine: number, item: Item): Promise<void> {
    const blob = degraded || item.blob === null ? null : await item.blob;
    if (mine !== epoch) return;
    let playback: Playback | null = null;
    if (blob !== null) {
      try {
        playback = deps.play(blob);
      } catch {
        playback = null;
      }
    }
    if (playback !== null) {
      current = playback;
      try {
        await playback.done;
        return;
      } catch {
        if (mine !== epoch) return;
        noteFailure(new Error("playback failed"));
      } finally {
        if (current === playback) current = null;
      }
    }
    if (mine !== epoch) return;
    const spoken = deps.fallback(item.text);
    current = spoken;
    try {
      await spoken.done;
    } catch {
      // Nothing left to fall back to; the sentence stays on screen.
    } finally {
      if (current === spoken) current = null;
    }
  }

  async function run(mine: number): Promise<void> {
    while (mine === epoch && queue.length > 0) {
      prefetchAhead();
      const item = queue[0]!;
      await play(mine, item);
      if (mine !== epoch) return;
      queue.shift();
    }
    if (mine === epoch) running = false;
  }

  return {
    beginTurn() {
      stopped = false;
    },
    speak(sentence) {
      if (stopped || sentence.trim() === "") return;
      queue.push({ text: sentence, blob: null, ctrl: null });
      prefetchAhead();
      if (!running) {
        running = true;
        void run(epoch);
      }
    },
    stop() {
      stopped = true;
      epoch += 1;
      running = false;
      for (const item of queue) item.ctrl?.abort();
      queue = [];
      current?.stop();
      current = null;
    },
  };
}

/**
 * Chrome's voice, one sentence per utterance. Chrome sometimes never fires `end`, so a sentence also settles after a
 * length-based allowance rather than holding the queue forever.
 */
export function synthPlayback(
  synth: { speak(u: SpeechSynthesisUtterance): void; cancel(): void },
  makeUtterance: (text: string) => SpeechSynthesisUtterance = (text) => new SpeechSynthesisUtterance(text),
): (text: string) => Playback {
  return (text) => {
    const utterance = makeUtterance(text);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(settle, 3000 + text.length * 120);
    void done.then(() => clearTimeout(timer));
    utterance.onend = settle;
    utterance.onerror = settle;
    synth.speak(utterance);
    return { done, stop: () => (synth.cancel(), settle()) };
  };
}

/** Plays one mp3 blob through an audio element. Rejects `done` when the browser refuses to play it. */
export function audioElementPlayer(): (audio: Blob) => Playback {
  return (audio) => {
    const url = URL.createObjectURL(audio);
    const element = new Audio(url);
    let settle!: () => void;
    let fail!: (e: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const cleanup = () => URL.revokeObjectURL(url);
    element.onended = settle;
    element.onerror = () => fail(new Error("audio element error"));
    void done.then(cleanup, cleanup);
    element.play().catch(fail);
    return { done, stop: () => (element.pause(), settle()) };
  };
}

/**
 * Chrome's voice until the backend says ElevenLabs is available, then ElevenLabs. The switch happens at the start of a
 * turn, never in the middle of one. `stop` reaches both, so nothing keeps talking.
 */
export function chooseSpeaker(available: Promise<boolean>, voice: Speaker, fallback: Speaker): Speaker {
  let ready = false;
  let active = fallback;
  available.then((yes) => void (ready = yes), () => {});
  return {
    beginTurn() {
      if (ready) active = voice;
      active.beginTurn();
    },
    speak: (sentence) => active.speak(sentence),
    stop() {
      voice.stop();
      fallback.stop();
    },
  };
}

/**
 * Voice is off unless the learner turned it on. While off, the tutor is never spoken: `beginTurn` and `speak` do
 * nothing (no ElevenLabs request, no speechSynthesis call, nothing to wait for), and `make` is not even called, so the
 * availability check never goes out. `stop` still reaches a speaker that was made, so turning voice off mid-sentence
 * silences it.
 */
export function gateSpeaker(enabled: () => boolean, make: () => Speaker): Speaker {
  let inner: Speaker | null = null;
  const live = (): Speaker | null => {
    if (!enabled()) return null;
    inner ??= make();
    return inner;
  };
  return {
    beginTurn: () => live()?.beginTurn(),
    speak: (sentence) => live()?.speak(sentence),
    stop: () => inner?.stop(),
  };
}
