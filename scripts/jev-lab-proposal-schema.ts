import type { Effort } from "../src/backend/providers/claude";
import type { Origin } from "./jev-lab-score";


// ───────────────────────────── constants (PROPOSED unless the brief fixes them) ─────────────────────────────

/** The hard ceiling of Claude calls across the whole experiment, retries included (PROPOSED in the protocol, decision 6). */
export const BUDGET_CLAUDE_CALLS = 250;

/** The brief: a call carries at most 24 frames. */
export const MAX_FRAMES_PER_CALL = 24;

/** Frames repeated between two calls of one clip, so a change at the seam is seen by both (PROPOSED). */
export const CHUNK_OVERLAP_FRAMES = 3;

export const PILOT_CALLS = 3;

/** Two items of different calls of one clip within this many seconds are one item when chunk proposals are merged (PROPOSED). */
export const MERGE_TOLERANCE_S = 10;

/** `compare`: two models proposed the same step within 10 s, the same boundary within 60 s (PROPOSED). */
export const COMPARE_TOLERANCE_STEP_S = 10;

export const COMPARE_TOLERANCE_BOUNDARY_S = 60;

/** `compare`: two duplicate-group frames without frame ids are the same frame within this many seconds (PROPOSED). */
export const COMPARE_FRAME_MATCH_S = 2;

/** The two models of the experiment (decision 1, ADOPTED). Anything else is a typo and costs a paid call. */
export const PROPOSED_MODELS = ["claude-opus-5-5", "claude-fable-5-1"] as const;

export const PROPOSE_EFFORT: Effort = "high";

/** One call may think and read up to 24 images; 15 minutes (PROPOSED). */
export const CALL_TIMEOUT_MS = 15 * 60_000;

/** A model's time for a frame may differ from the frame's by rounding only. */
export const FRAME_TIME_EPS_S = 0.011;

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const SECRET_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "TYPESAFE_API_KEY"] as const;


/** A guard that stopped the tool before a call. The message never contains a secret. */
export class ProposeRefusal extends Error {
  override readonly name = "ProposeRefusal";
}


export function refuse(message: string): never {
  throw new ProposeRefusal(message);
}


// ───────────────────────────── the proposals file (schemaVersion 1) ─────────────────────────────

/**
 * proposals.json, version 1. Written by `propose`, read by `compare` and by the labeling sheet.
 *
 *   { schemaVersion: 1, kind: "label-proposals",
 *     proposedBy: { model, effort }, captureId, provenance: string | null, createdAt: ISO string,
 *     origin?: "fixture" | "live",                 // optional: "fixture" means a scripted client, not a model
 *     items: {
 *       boundaries:      [{ videoId, mediaS, reason, source: "model" | "join" }],   // "join" = added by code at a later clip's start
 *       visualSteps:     [{ videoId, mediaS, reason }],
 *       duplicateGroups: [{ frames: [{ videoId, mediaS, frameId? }], reason }]      // at least 2 frames; within one clip
 *     } }
 *
 * Times are media seconds of the video. `provenance` is `provenanceLine(readProvenance(dataDir))` or null. No unknown field
 * is allowed. These are proposals of a model for Derek to verify: not his labels, not truth.
 */
export type ProposedFrame = { readonly videoId: string; readonly mediaS: number; readonly frameId?: string };

export type ProposedBoundary = { readonly videoId: string; readonly mediaS: number; readonly reason: string; readonly source: "model" | "join" };

export type ProposedStep = { readonly videoId: string; readonly mediaS: number; readonly reason: string };

export type ProposedGroup = { readonly frames: readonly ProposedFrame[]; readonly reason: string };

export type LabelProposals = {
  readonly schemaVersion: 1;
  readonly kind: "label-proposals";
  readonly proposedBy: { readonly model: string; readonly effort: string };
  readonly captureId: string;
  readonly provenance: string | null;
  readonly createdAt: string;
  readonly origin?: Origin;
  readonly items: {
    readonly boundaries: readonly ProposedBoundary[];
    readonly visualSteps: readonly ProposedStep[];
    readonly duplicateGroups: readonly ProposedGroup[];
  };
};

export type ProposalsResult = { readonly ok: true; readonly proposals: LabelProposals } | { readonly ok: false; readonly errors: readonly string[] };


export type Rec = Record<string, unknown>;

export const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);

export const isTime = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

export const isText = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";


/** Every problem at once, each with its path; an unknown field is an error, not ignored. */
export function validateProposals(input: unknown): ProposalsResult {
  const errors: string[] = [];
  const bad = (path: string, why: string) => void errors.push(`${path}: ${why}`);
  const keys = (o: Rec, path: string, required: readonly string[], optional: readonly string[] = []) => {
    for (const k of required) if (!(k in o)) bad(`${path}${path === "" ? "" : "."}${k}`, "is missing");
    for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) bad(`${path}${path === "" ? "" : "."}${k}`, "unknown field");
  };
  if (!isRec(input)) return { ok: false, errors: ["proposals: must be an object"] };
  keys(input, "", ["schemaVersion", "kind", "proposedBy", "captureId", "provenance", "createdAt", "items"], ["origin"]);
  if (input.schemaVersion !== 1) bad("schemaVersion", "must be 1");
  if (input.kind !== "label-proposals") bad("kind", 'must be "label-proposals"');
  if (isRec(input.proposedBy)) {
    keys(input.proposedBy, "proposedBy", ["model", "effort"]);
    if (!isText(input.proposedBy.model)) bad("proposedBy.model", "must be a non-empty string");
    if (!isText(input.proposedBy.effort)) bad("proposedBy.effort", "must be a non-empty string");
  } else if ("proposedBy" in input) bad("proposedBy", "must be an object { model, effort }");
  if ("captureId" in input && !isText(input.captureId)) bad("captureId", "must be a non-empty string");
  if ("provenance" in input && input.provenance !== null && typeof input.provenance !== "string") bad("provenance", "must be a string or null");
  if ("createdAt" in input && !(isText(input.createdAt) && !Number.isNaN(Date.parse(input.createdAt)))) bad("createdAt", "must be an ISO date-time string");
  if ("origin" in input && input.origin !== "fixture" && input.origin !== "live") bad("origin", 'must be "fixture" or "live"');

  const items = input.items;
  if (isRec(items)) {
    keys(items, "items", ["boundaries", "visualSteps", "duplicateGroups"]);
    const list = (name: string, each: (x: unknown, path: string) => void) => {
      const v = items[name];
      if (v === undefined) return;
      if (!Array.isArray(v)) return bad(`items.${name}`, "must be an array");
      v.forEach((x, i) => each(x, `items.${name}[${i}]`));
    };
    const place = (o: Rec, path: string) => {
      if (!isText(o.videoId)) bad(`${path}.videoId`, "must be a non-empty string");
      if (!isTime(o.mediaS)) bad(`${path}.mediaS`, "must be a number of seconds, 0 or more");
      if (!isText(o.reason)) bad(`${path}.reason`, "must be a non-empty string");
    };
    list("boundaries", (x, path) => {
      if (!isRec(x)) return bad(path, "must be an object");
      keys(x, path, ["videoId", "mediaS", "reason", "source"]);
      place(x, path);
      if (x.source !== "model" && x.source !== "join") bad(`${path}.source`, 'must be "model" or "join"');
    });
    list("visualSteps", (x, path) => {
      if (!isRec(x)) return bad(path, "must be an object");
      keys(x, path, ["videoId", "mediaS", "reason"]);
      place(x, path);
    });
    list("duplicateGroups", (x, path) => {
      if (!isRec(x)) return bad(path, "must be an object");
      keys(x, path, ["frames", "reason"]);
      if (!isText(x.reason)) bad(`${path}.reason`, "must be a non-empty string");
      if (!Array.isArray(x.frames) || x.frames.length < 2) return bad(`${path}.frames`, "needs at least 2 frames");
      x.frames.forEach((f: unknown, j: number) => {
        const fp = `${path}.frames[${j}]`;
        if (!isRec(f)) return bad(fp, "must be an object");
        keys(f, fp, ["videoId", "mediaS"], ["frameId"]);
        if (!isText(f.videoId)) bad(`${fp}.videoId`, "must be a non-empty string");
        if (!isTime(f.mediaS)) bad(`${fp}.mediaS`, "must be a number of seconds, 0 or more");
        if ("frameId" in f && !isText(f.frameId)) bad(`${fp}.frameId`, "must be a non-empty string");
      });
    });
  } else if ("items" in input) bad("items", "must be an object");
  return errors.length === 0 ? { ok: true, proposals: input as unknown as LabelProposals } : { ok: false, errors };
}
