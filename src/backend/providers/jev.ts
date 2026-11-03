/**
 * Jev HTTP adapter (W5; docs/research/jev-api.md). Transport only: no question
 * wording, no thresholds. Importable only inside providers/.
 *
 * POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer $TYPESAFE_API_KEY
 *   TypeSafe-Danger-Zone-Images: true      (only when assets are present)
 *   { model, state, questions, assets? }
 * → { model, answers: { [q]: { type: "noul", noul } | { type: "choice", … } | { type: "score", … } }, usage: { input_tokens, output_tokens } }
 *
 * Cost is always { kind: "unknown", reason: "typesafe pricing not published" } until pricing is known.
 */
import { z } from "zod";
import { ProviderError } from "./memo";
import type { UsageReport } from "./memo";

export type JevQuestion =
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] };

export type JevImage = { readonly ref: string; readonly format: "jpeg" | "png"; readonly bytes: Uint8Array; readonly width: number; readonly height: number };

export type JevRequest<Q extends string> = {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<Q, JevQuestion>>;
  readonly images: readonly JevImage[];
};

export type JevAnswer =
  | { readonly type: "noul"; readonly p: number }
  | { readonly type: "choice"; readonly choice: string; readonly probabilities: Readonly<Record<string, number>> }
  | { readonly type: "score"; readonly score: number; readonly probabilities: Readonly<Record<string, number>> };

export type JevClient = {
  /**
   * One request, independent questions over one state.
   * Checks image bounds (280–1568 px per side, 78,400–2,458,624 px, 16 MiB) and
   * that every asset is referenced BEFORE sending: one bad image fails the
   * whole request on Jev's side, so we fail fast and the task maps it to uncertain.
   * Throws ProviderError (retryable: status >= 500 || 429), with usage when the response carried it.
   */
  ask<Q extends string>(req: JevRequest<Q>, signal: AbortSignal): Promise<{ readonly answers: Readonly<Record<Q, JevAnswer>>; readonly usage: UsageReport }>;
};

export const JEV_IMAGE_LIMITS = {
  minSide: 280,
  maxSide: 1568,
  minPixels: 78_400,
  maxPixels: 2_458_624,
  maxImageBytes: 16 * 1024 * 1024,
  maxRequestBytes: 32 * 1024 * 1024,
} as const;

const MAX_CHOICE_OPTIONS = 255;
const MAX_SCORE_LEVELS = 10;
const UNKNOWN_COST = { kind: "unknown", reason: "typesafe pricing not published" } as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Format by magic bytes, never by file name. */
export function imageFormat(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/** The size the image really has, so bounds are checked on pixels and not on caller metadata. */
export function imageSize(bytes: Uint8Array, format: "jpeg" | "png"): { readonly width: number; readonly height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (i: number) => view.getUint16(i);
  if (format === "png") return bytes.length < 24 ? null : { width: view.getUint32(16), height: view.getUint32(20) };
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) return i + 9 <= bytes.length ? { height: u16(i + 5), width: u16(i + 7) } : null;
    i += 2 + u16(i + 2);
  }
  return null;
}

function refersTo(text: string, ref: string): boolean {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

function reject(message: string): never {
  throw new ProviderError(message, null, false);
}

function validateQuestions(questions: Readonly<Record<string, JevQuestion>>): void {
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice" && Object.keys(q.criteria).length > MAX_CHOICE_OPTIONS) reject(`jev question ${id}: choice supports at most ${MAX_CHOICE_OPTIONS} options`);
    if (q.type === "score" && q.criteria.length > MAX_SCORE_LEVELS) reject(`jev question ${id}: score supports at most ${MAX_SCORE_LEVELS} levels`);
  }
}

function validateImages(req: JevRequest<string>): void {
  const seen = new Set<string>();
  const questionText = Object.values(req.questions).flatMap((q) => [q.instructions, ...(q.type === "noul" ? [] : Object.values(q.criteria))]).join("\n");
  const text = `${JSON.stringify(req.state)}\n${questionText}`;
  const L = JEV_IMAGE_LIMITS;
  for (const img of req.images) {
    if (img.ref === "" || seen.has(img.ref)) reject(`jev image ref "${img.ref}" is empty or repeated`);
    seen.add(img.ref);
    if (imageFormat(img.bytes) !== img.format) reject(`jev image ${img.ref}: bytes are not ${img.format}`);
    if (img.bytes.length > L.maxImageBytes) reject(`jev image ${img.ref}: ${img.bytes.length} bytes exceeds ${L.maxImageBytes}`);
    const size = imageSize(img.bytes, img.format);
    if (size === null) reject(`jev image ${img.ref}: cannot read its dimensions`);
    const { width, height } = size;
    const sides = [width, height];
    if (sides.some((s) => s < L.minSide || s > L.maxSide)) reject(`jev image ${img.ref}: ${width}x${height} is outside ${L.minSide}-${L.maxSide} px per side`);
    if (width * height < L.minPixels || width * height > L.maxPixels) reject(`jev image ${img.ref}: ${width * height} pixels is outside ${L.minPixels}-${L.maxPixels}`);
    if (!refersTo(text, img.ref)) reject(`jev image ${img.ref} is never referenced by state or a question`);
  }
}

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number()) }),
  z.object({ type: z.literal("score"), score: z.number(), probabilities: z.record(z.string(), z.number()) }),
]);

const responseSchema = z.object({
  model: z.string().nullish(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().nullish(), output_tokens: z.number().nullish() }).nullish(),
});

const errorSchema = z.object({
  message: z.string().nullish(),
  detail: z.unknown().optional(),
  error: z.union([z.string(), z.object({ message: z.string().nullish() })]).nullish(),
  error_type: z.string().nullish(),
});

function describeError(status: number, bodyText: string): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // not JSON: fall through to the raw text
  }
  const e = errorSchema.safeParse(parsed);
  if (!e.success) return `jev ${status}: ${bodyText.slice(0, 300)}`;
  const { message, detail, error, error_type } = e.data;
  const text =
    message ??
    (typeof error === "string" ? error : error?.message) ??
    (typeof detail === "string" ? detail : detail === undefined ? null : JSON.stringify(detail)) ??
    bodyText.slice(0, 300);
  return `jev ${status}${error_type ? ` ${error_type}` : ""}: ${text}`;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export function createJevClient(opts: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): JevClient {
  const baseUrl = (opts.baseUrl ?? "https://api.typesafe.ai/v1").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    async ask<Q extends string>(req: JevRequest<Q>, signal: AbortSignal) {
      validateQuestions(req.questions);
      validateImages(req);

      const body = JSON.stringify({
        model: req.model,
        state: req.state,
        questions: req.questions,
        ...(req.images.length > 0
          ? {
              assets: Object.fromEntries(
                req.images.map((img) => [img.ref, { type: "image", format: img.format, data_base64: Buffer.from(img.bytes).toString("base64") }]),
              ),
            }
          : {}),
      });
      if (Buffer.byteLength(body) > JEV_IMAGE_LIMITS.maxRequestBytes) reject(`jev request is ${Buffer.byteLength(body)} bytes, over ${JEV_IMAGE_LIMITS.maxRequestBytes}`);

      const timeout = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/systemone`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            ...(req.images.length > 0 ? { "TypeSafe-Danger-Zone-Images": "true" } : {}),
          },
          body,
          signal: AbortSignal.any([signal, timeout]),
        });
      } catch (err) {
        if (signal.aborted) throw err;
        if (timeout.aborted) throw new ProviderError(`jev request timed out after ${timeoutMs}ms`, null, true);
        if (isAbort(err)) throw err;
        throw new ProviderError(`jev network error: ${err instanceof Error ? err.message : String(err)}`, null, true);
      }

      const text = await res.text();
      if (!res.ok) throw new ProviderError(describeError(res.status, text), null, res.status >= 500 || res.status === 429);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError(`jev ${res.status}: response is not JSON`, null, false);
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError(`jev response did not match the expected shape: ${parsed.error.message.slice(0, 300)}`, null, false);

      const { model, answers, usage } = parsed.data;
      const report: UsageReport = {
        model: model ?? req.model,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        cacheReadTokens: null,
        cost: UNKNOWN_COST,
      };

      const out: Partial<Record<Q, JevAnswer>> = {};
      for (const id of Object.keys(req.questions) as Q[]) {
        const a = answers[id];
        const asked = req.questions[id].type;
        if (a === undefined) throw new ProviderError(`jev answered without question ${id}`, report, false);
        if (a.type !== asked) throw new ProviderError(`jev answered question ${id} as ${a.type}, asked ${asked}`, report, false);
        out[id] =
          a.type === "noul"
            ? { type: "noul", p: a.noul }
            : a.type === "choice"
              ? { type: "choice", choice: a.choice, probabilities: a.probabilities }
              : { type: "score", score: a.score, probabilities: a.probabilities };
      }
      return { answers: out as Record<Q, JevAnswer>, usage: report };
    },
  };
}
