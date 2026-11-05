/**
 * Model proposals for the labeling sheet (experiment 6, stage 3 output, stage 4 input): `proposals.json`, schema version 1.
 * A model PROPOSES boundaries, visual steps and duplicate groups with a one-sentence reason each. Nothing here confirms
 * anything: only Derek's click on the sheet does. The sheet imports the types and the validator from this module. The
 * worker that builds the proposing tool (`scripts/jev-lab-propose.ts`) may re-export them from here.
 *
 *   { schemaVersion: 1, kind: "label-proposals", proposedBy: { model, effort }, captureId, provenance: string | null, createdAt,
 *     items: { boundaries: [{ videoId, mediaS, reason, source: "model" | "join" }],
 *              visualSteps: [{ videoId, mediaS, reason }],
 *              duplicateGroups: [{ frames: [{ videoId, mediaS, frameId? }], reason }] } }
 *
 * No DOM, no backend import: the page bundles the types only.
 */
import type { LabelFileV2 } from "./jev-lab-score";

export type ProposedBoundary = { readonly videoId: string; readonly mediaS: number; readonly reason: string; readonly source: "model" | "join" };
export type ProposedStep = { readonly videoId: string; readonly mediaS: number; readonly reason: string };
export type ProposedFrame = { readonly videoId: string; readonly mediaS: number; readonly frameId?: string };
export type ProposedGroup = { readonly frames: readonly ProposedFrame[]; readonly reason: string };

export type Proposals = {
  readonly schemaVersion: 1;
  readonly kind: "label-proposals";
  readonly proposedBy: { readonly model: string; readonly effort: string };
  readonly captureId: string;
  readonly provenance: string | null;
  readonly createdAt: string;
  /** "fixture" = produced by a scripted test client, not a model. Absent or "live" = a real model. */
  readonly origin?: "fixture" | "live";
  readonly items: {
    readonly boundaries: readonly ProposedBoundary[];
    readonly visualSteps: readonly ProposedStep[];
    readonly duplicateGroups: readonly ProposedGroup[];
  };
};

export type ProposalsResult = { readonly ok: true; readonly proposals: Proposals } | { readonly ok: false; readonly errors: readonly string[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isText = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

/** Every problem at once with its field path. A misspelled key is an error, never ignored. */
export function validateProposals(input: unknown): ProposalsResult {
  const errors: string[] = [];
  const err = (path: string, msg: string) => void errors.push(`${path}: ${msg}`);
  const unknownKeys = (path: string, o: Record<string, unknown>, allowed: readonly string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  };
  if (!isObj(input)) return { ok: false, errors: ["proposals: expected a JSON object"] };
  unknownKeys("proposals", input, ["schemaVersion", "kind", "proposedBy", "captureId", "provenance", "createdAt", "origin", "items"]);
  if (input.schemaVersion !== 1) err("schemaVersion", `expected 1, got ${JSON.stringify(input.schemaVersion)}`);
  if (input.kind !== "label-proposals") err("kind", `expected "label-proposals", got ${JSON.stringify(input.kind)}`);
  const by = input.proposedBy;
  if (!isObj(by)) err("proposedBy", "expected {model, effort}");
  else {
    unknownKeys("proposedBy", by, ["model", "effort"]);
    if (!isText(by.model)) err("proposedBy.model", "expected a non-empty string");
    if (!isText(by.effort)) err("proposedBy.effort", "expected a non-empty string");
  }
  if (!isText(input.captureId)) err("captureId", "expected a non-empty string");
  if (input.provenance !== null && typeof input.provenance !== "string") err("provenance", "expected a string or null");
  if (!isText(input.createdAt) || Number.isNaN(Date.parse(input.createdAt))) err("createdAt", "expected an ISO date-time string");

  if (input.origin !== undefined && input.origin !== "fixture" && input.origin !== "live") err("origin", `expected "fixture" or "live" when present, got ${JSON.stringify(input.origin)}`);

  const items = input.items;
  const reason = (path: string, o: Record<string, unknown>) => {
    if (!isText(o.reason)) err(`${path}.reason`, "expected a non-empty one-sentence reason");
  };
  const place = (path: string, o: Record<string, unknown>) => {
    if (!isText(o.videoId)) err(`${path}.videoId`, "expected a non-empty string");
    if (!isNum(o.mediaS) || o.mediaS < 0) err(`${path}.mediaS`, `expected media seconds >= 0, got ${JSON.stringify(o.mediaS)}`);
  };
  if (!isObj(items)) err("items", "expected {boundaries, visualSteps, duplicateGroups}");
  else {
    unknownKeys("items", items, ["boundaries", "visualSteps", "duplicateGroups"]);
    for (const name of ["boundaries", "visualSteps"] as const) {
      const list = items[name];
      if (!Array.isArray(list)) {
        err(`items.${name}`, "expected an array (it may be empty)");
        continue;
      }
      list.forEach((it: unknown, i) => {
        const path = `items.${name}[${i}]`;
        if (!isObj(it)) return err(path, "expected an object");
        unknownKeys(path, it, name === "boundaries" ? ["videoId", "mediaS", "reason", "source"] : ["videoId", "mediaS", "reason"]);
        place(path, it);
        reason(path, it);
        if (name === "boundaries" && it.source !== "model" && it.source !== "join") err(`${path}.source`, `expected "model" or "join", got ${JSON.stringify(it.source)}`);
      });
    }
    const groups = items.duplicateGroups;
    if (!Array.isArray(groups)) err("items.duplicateGroups", "expected an array (it may be empty)");
    else {
      groups.forEach((g: unknown, i) => {
        const path = `items.duplicateGroups[${i}]`;
        if (!isObj(g)) return err(path, "expected an object");
        unknownKeys(path, g, ["frames", "reason"]);
        reason(path, g);
        if (!Array.isArray(g.frames) || g.frames.length < 2) return err(`${path}.frames`, "expected at least 2 frames: a group of one has no duplicate");
        g.frames.forEach((f: unknown, k) => {
          const fp = `${path}.frames[${k}]`;
          if (!isObj(f)) return err(fp, "expected an object");
          unknownKeys(fp, f, ["videoId", "mediaS", "frameId"]);
          place(fp, f);
          if (f.frameId !== undefined && !isText(f.frameId)) err(`${fp}.frameId`, "expected a non-empty string when present");
        });
      });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, proposals: input as unknown as Proposals };
}

/**
 * What the label file's set cannot hold, as readable errors: a proposal for another capture, a video that is not in
 * the set, a time outside that video's labeled span (half-open, as in the lab) or a frame id the capture does not have
 * for that video. The caller refuses on any of them; nothing is dropped silently. `frameIdsOf` returns the frame ids
 * of a video in the capture, or null when it does not know (then the frame id is not checked).
 */
export function proposalsAgainstLabels(
  proposals: Proposals,
  labels: LabelFileV2,
  frameIdsOf: (videoId: string) => ReadonlySet<string> | null = () => null,
): string[] {
  const errors: string[] = [];
  const who = `${proposals.proposedBy.model} proposals`;
  if (proposals.captureId !== labels.lecture.captureId) errors.push(`${who} are for capture ${proposals.captureId}, but the label file is for capture ${labels.lecture.captureId}`);
  const spans = new Map(labels.lecture.videos.map((v) => [v.videoId, v.spanS] as const));
  const place = (path: string, videoId: string, mediaS: number) => {
    const span = spans.get(videoId);
    if (span === undefined) return errors.push(`${who} ${path}: video ${videoId} is not one of the label file's clips (${[...spans.keys()].join(", ")})`);
    if (mediaS < span.start || mediaS >= span.end) {
      const hint = path.includes("boundaries") && mediaS < span.start ? "; a clip join proposal belongs at the clip's first labeled second" : "";
      errors.push(`${who} ${path}: ${mediaS} s lies outside the labeled span [${span.start}, ${span.end}) of video ${videoId}${hint}`);
    }
  };
  proposals.items.boundaries.forEach((b, i) => place(`boundaries[${i}]`, b.videoId, b.mediaS));
  proposals.items.visualSteps.forEach((s, i) => place(`visualSteps[${i}]`, s.videoId, s.mediaS));
  proposals.items.duplicateGroups.forEach((g, i) =>
    g.frames.forEach((f, k) => {
      place(`duplicateGroups[${i}].frames[${k}]`, f.videoId, f.mediaS);
      const known = f.frameId === undefined ? null : frameIdsOf(f.videoId);
      if (f.frameId !== undefined && known !== null && !known.has(f.frameId)) errors.push(`${who} duplicateGroups[${i}].frames[${k}]: frame ${f.frameId} is not a frame of video ${f.videoId} in this capture`);
    }),
  );
  return errors;
}
