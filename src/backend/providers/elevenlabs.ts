/**
 * ElevenLabs streaming text-to-speech (tutor voice). The key lives here and in main.ts only: it is sent as the
 * `xi-api-key` header to api.elevenlabs.io and goes nowhere else (not a response, not a log line, not the browser).
 *
 * API values, from elevenlabs.io/docs/api-reference/text-to-speech/stream and /docs/overview/models:
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128
 *   header xi-api-key; body { text, model_id }; the response is streamed audio.
 *
 * R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
 * One `voice_usage_events` row per upstream call, written when the call ends (ok, error or aborted): the characters
 * sent, and a cost that is always unknown because the per-character rate depends on the plan.
 */
import type { Db } from "../db";

export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const DEFAULT_VOICE_MODEL = "eleven_flash_v2_5";
export const OUTPUT_FORMAT = "mp3_44100_128";
const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
export const DEFAULT_TIMEOUT_MS = 30_000;

export type VoiceOutcome = "ok" | "error" | "aborted";

export type SpeakResult =
  | { readonly kind: "audio"; readonly body: ReadableStream<Uint8Array> }
  | { readonly kind: "failed"; readonly status: 502 | 504 };

export type Voice = {
  readonly available: boolean;
  readonly model: string;
  readonly voiceId: string;
  /** `signal` is the client's: aborting it aborts the upstream call. The returned stream ends the call's usage event. */
  speak(text: string, signal: AbortSignal): Promise<SpeakResult>;
};

export type VoiceOptions = {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly model: string;
  readonly db: Db;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
};

const VOICE_ID = /^[A-Za-z0-9]{8,40}$/;
const MODEL_ID = /^[a-z0-9_]{3,64}$/;

/** Fails at boot, so a typo in an env var is not found by the first sentence of a review. */
export function checkVoiceSettings(voiceId: string, model: string): void {
  if (!VOICE_ID.test(voiceId)) throw new Error("AFTERCLASS_ELEVENLABS_VOICE_ID must be 8 to 40 letters and digits (a voice id from your ElevenLabs voice list)");
  if (!MODEL_ID.test(model)) throw new Error("AFTERCLASS_ELEVENLABS_MODEL must be a model id such as eleven_flash_v2_5");
}

export const unavailableVoice: Voice = {
  available: false,
  model: DEFAULT_VOICE_MODEL,
  voiceId: DEFAULT_VOICE_ID,
  speak: () => Promise.resolve({ kind: "failed", status: 502 }),
};

export function createVoice(options: VoiceOptions): Voice {
  const { apiKey, voiceId, model, db } = options;
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  checkVoiceSettings(voiceId, model);
  const insert = db.sql.query(
    `INSERT INTO voice_usage_events (id, provider, model, voice_id, characters, outcome, cost_kind, cost_reason, started_ms, duration_ms)
     VALUES (?, 'elevenlabs', ?, ?, ?, ?, 'unknown', ?, ?, ?)`,
  );

  async function speak(text: string, clientSignal: AbortSignal): Promise<SpeakResult> {
    const startedMs = Date.now();
    const upstream = new AbortController();
    let timedOut = false;
    let recorded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      upstream.abort();
    }, timeoutMs);
    const onClientAbort = () => upstream.abort();
    if (clientSignal.aborted) upstream.abort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });

    const record = (outcome: VoiceOutcome) => {
      if (recorded) return;
      recorded = true;
      clearTimeout(timer);
      clientSignal.removeEventListener("abort", onClientAbort);
      insert.run(
        crypto.randomUUID(), model, voiceId, [...text].length, outcome,
        "ElevenLabs bills per character at a plan-dependent rate; the backend does not know it", startedMs, Date.now() - startedMs,
      );
    };
    const failed = (): SpeakResult => {
      const aborted = upstream.signal.aborted && !timedOut;
      record(aborted ? "aborted" : "error");
      return { kind: "failed", status: timedOut ? 504 : 502 };
    };

    let res: Response;
    try {
      res = await doFetch(`${ENDPOINT}/${encodeURIComponent(voiceId)}/stream?output_format=${OUTPUT_FORMAT}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model }),
        signal: upstream.signal,
      });
    } catch {
      return failed();
    }
    if (!res.ok || res.body === null) {
      void res.body?.cancel().catch(() => {});
      return failed();
    }

    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            record("ok");
            controller.close();
          } else controller.enqueue(next.value);
        } catch {
          const aborted = upstream.signal.aborted && !timedOut;
          record(aborted ? "aborted" : "error");
          controller.error(new Error(timedOut ? "voice timed out" : "voice stream failed"));
        }
      },
      cancel() {
        // The listener went away mid-sentence: stop paying for audio nobody will hear.
        upstream.abort();
        void reader.cancel().catch(() => {});
        record("aborted");
      },
    });
    return { kind: "audio", body };
  }

  return { available: true, model, voiceId, speak };
}
