// app/speech.ts -- voice I/O behind two tiny interfaces so the (parked) voice-provider decision touches one file.
//   input : Chrome Web Speech API (SpeechRecognition) -> text turns with viaSpeech=true; interim results shown, final sent
//   output: tutor `say_delta` text is split into sentences; each complete sentence is queued to TTS as it arrives; barge-in stops playback
//           AND aborts the in-flight `review.turn` request (which kills the tutor child, stopping the spend).
export interface SpeechIn { start(onFinal: (text: string) => void, onInterim: (text: string) => void): void; stop(): void; readonly supported: boolean }
export interface SpeechOut {
  /** feed raw deltas; internally sentence-splits and speaks complete sentences */
  push(delta: string): void;
  flush(): void;
  /** learner started talking */
  interrupt(): void;
}
export function createSpeechIn(): SpeechIn { throw new Error("not implemented"); }
/** fallback implementation: Chrome speechSynthesis. A provider (OpenAI / ElevenLabs / Cartesia) is another SpeechOut, chosen by the blind listening test. */
export function createSpeechOut(): SpeechOut { throw new Error("not implemented"); }
