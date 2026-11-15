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
 * Cost is estimated from the response's input tokens at TypeSafe's published price (`jevCost`), and unknown only when the
 * response carried no input tokens or the model has no listed price.
 */
import { z } from "zod";
import { ProviderError } from "./memo";
import type { Admitted, UsageReport } from "./memo";
import type { Cost } from "../../shared/domain";

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
  ask<Q extends string>(req: JevRequest<Q>, signal: AbortSignal, admitted?: Admitted): Promise<{ readonly answers: Readonly<Record<Q, JevAnswer>>; readonly usage: UsageReport }>;
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
/**
 * TypeSafe's published price, by model id, in nano-dollars per input token, so every price is a whole number and a cost is
 * integer arithmetic. Output tokens are free. Read from https://docs.typesafe.ai/models on 2026-11-14: "Price (per Btok / per
 * Mtok) $42 / $0.042" for jev-1.14.0 and jev-1.13.0, and "You pay per input token. Output tokens are free." $0.042 per million
 * tokens is 42 nano-dollars per token. The page lists no separate image price, so image tokens are taken to be inside
 * `input_tokens`. That is an assumption, checked only against an invoice.
 */
export const JEV_INPUT_NANOUSD_PER_TOKEN: Readonly<Record<string, number>> = {
  "jev-1.13.0": 42,
  "jev-1.14.0": 42,
};

export const JEV_COST_BASIS = "typesafe_published_input_price";

/** A count above this is not a real call (10 billion tokens would be $420), so it is read as an invalid figure, not priced. */
const MAX_PRICED_TOKENS = 10_000_000_000;

/**
 * What a Jev response cost: estimated at the published input price, or unknown (R17) when the tokens or the model's price are
 * missing or invalid. The cost is the exact price rounded up to a whole micro-dollar, in integers, so `usd` is a whole number of
 * micros over a million, never below the exact price and under one micro above it. The budget then takes it back as exactly
 * those micros.
 */
export function jevCost(model: string, inputTokens: number | null): Cost {
  const rate = Object.hasOwn(JEV_INPUT_NANOUSD_PER_TOKEN, model) ? JEV_INPUT_NANOUSD_PER_TOKEN[model]! : null;
  if (rate === null) return { kind: "unknown", reason: `no published price for model ${model}` };
  if (inputTokens === null) return { kind: "unknown", reason: "the response reported no input tokens" };
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > MAX_PRICED_TOKENS) return { kind: "unknown", reason: "the response's input token count is not a plausible count" };
  const micros = Math.floor((inputTokens * rate + 999) / 1000);
  return { kind: "estimated", usd: micros / 1_000_000, basis: JEV_COST_BASIS };
}

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
  throw new ProviderError(message, null, false, "not_billed");
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

/** The whole reply envelope. A reply that does not match it is never accepted, whatever its answers say. */
const responseSchema = z.object({
  model: z.string().nullish(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().nonnegative().nullish(), output_tokens: z.number().nonnegative().nullish() }).nullish(),
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What a reply bills, read on its own from whatever the body holds, so one malformed or unrelated field (free output tokens, an
 * answer) never hides the input tokens Jev charged for. The reply is accepted or refused by `responseSchema`, never by this.
 * Null when the body is not an object. A figure that is missing or not a plausible count is null, so it prices as unknown.
 */
function billedUsage(body: unknown, requested: string): UsageReport | null {
  if (!isRecord(body)) return null;
  const usage = isRecord(body.usage) ? body.usage : {};
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const inputTokens = count(usage.input_tokens);
  const model = body.model === undefined || body.model === null ? requested : typeof body.model === "string" ? body.model : null;
  return {
    model: model ?? requested,
    inputTokens,
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: null,
    cost: model === null ? { kind: "unknown", reason: "the response named no readable model" } : jevCost(model, inputTokens),
  };
}

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
    async ask<Q extends string>(req: JevRequest<Q>, signal: AbortSignal, admitted?: Admitted) {
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
      const transportFailure = (err: unknown): unknown => {
        if (signal.aborted) return err;
        if (timeout.aborted) return new ProviderError(`jev request timed out after ${timeoutMs}ms`, null, true);
        if (isAbort(err)) return err;
        return new ProviderError(`jev network error: ${err instanceof Error ? err.message : String(err)}`, null, true);
      };
      let res: Response;
      let text: string;
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
        text = await res.text();
      } catch (err) {
        throw transportFailure(err);
      }

      let json: unknown = undefined;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON: no usage to read
      }
      // Jev bills the input tokens of a reply whether or not it is usable, so a reply that reports them is priced on every path.
      const reportOf = (): UsageReport | null => {
        const r = billedUsage(json, req.model);
        if (r === null || r.inputTokens === null) return null;
        admitted?.priced(r.cost);
        return r;
      };
      if (!res.ok) throw new ProviderError(describeError(res.status, text), reportOf(), res.status >= 500 || res.status === 429);
      if (json === undefined) throw new ProviderError(`jev ${res.status}: response is not JSON`, null, false);
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError(`jev response did not match the expected shape: ${parsed.error.message.slice(0, 300)}`, reportOf(), false);
      const { answers } = parsed.data;
      const report = billedUsage(json, req.model)!;
      admitted?.priced(report.cost);

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
