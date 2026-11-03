/**
 * Speech in and out.
 *
 * Output goes through `Speaker`. Chrome's speechSynthesis is the fallback only:
 * the voice provider is parked, so a better one replaces `createSynthSpeaker`
 * without touching callers. The tutor speaks by sentence and stops the moment
 * the learner starts speaking.
 */

export interface Speaker {
  /** Start of a new tutor turn: lifts any earlier `stop`. */
  beginTurn(): void;
  speak(sentence: string): void;
  /** Cuts the current sentence and drops the rest of this turn's sentences. */
  stop(): void;
}

export type SynthLike = {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
};

export function createSynthSpeaker(
  synth: SynthLike,
  makeUtterance: (text: string) => SpeechSynthesisUtterance = (text) => new SpeechSynthesisUtterance(text),
): Speaker {
  let stopped = false;
  return {
    beginTurn() {
      stopped = false;
    },
    speak(sentence) {
      if (stopped || sentence.trim() === "") return;
      synth.speak(makeUtterance(sentence));
    },
    stop() {
      stopped = true;
      synth.cancel();
    },
  };
}

export const silentSpeaker: Speaker = { beginTurn() {}, speak() {}, stop() {} };

export function browserSpeaker(): Speaker {
  return typeof speechSynthesis === "undefined" ? silentSpeaker : createSynthSpeaker(speechSynthesis);
}

// ───────────────────────────── Input ────────────────────────────────────────

export type RecognitionEventLike = {
  readonly resultIndex: number;
  readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }>;
};

export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onspeechstart: (() => void) | null;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export type RecognitionCtor = new () => RecognitionLike;

export type SpeechHandlers = {
  /** Fires when the learner starts speaking; the caller stops the tutor here. */
  readonly onSpeechStart: () => void;
  readonly onTranscript: (text: string, final: boolean) => void;
  readonly onEnd: () => void;
  readonly onError: (message: string) => void;
};

export type SpeechInput = {
  readonly supported: boolean;
  start(handlers: SpeechHandlers): void;
  stop(): void;
};

export function createSpeechInput(Ctor: RecognitionCtor | undefined, lang = "en-US"): SpeechInput {
  if (Ctor === undefined) return { supported: false, start() {}, stop() {} };
  let active: RecognitionLike | null = null;
  return {
    supported: true,
    start(h) {
      active?.stop();
      const rec = new Ctor();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.onspeechstart = () => h.onSpeechStart();
      rec.onresult = (e) => {
        let text = "";
        for (let i = 0; i < e.results.length; i++) text += e.results[i]![0]?.transcript ?? "";
        h.onTranscript(text.trim(), e.results[e.results.length - 1]?.isFinal ?? false);
      };
      rec.onerror = (e) => h.onError(e.error);
      rec.onend = () => {
        if (active === rec) active = null;
        h.onEnd();
      };
      active = rec;
      rec.start();
    },
    stop() {
      active?.stop();
    },
  };
}

export function browserSpeechInput(): SpeechInput {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return createSpeechInput(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}
