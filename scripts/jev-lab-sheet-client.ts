/**
 * The labeling sheet's logic, with no DOM: sheet state, the label file it exports and what blocks a sign-off.
 * The page bundles this module (scripts/jev-lab-sheet-page.ts); tests import it directly and check the export
 * against the lab's own `validateLabels`. Types only come from jev-lab-score, so nothing of the backend is bundled.
 *
 * The rules mirror `validateLabels` (docs/experiments/02-jev-lab.md, "Labels"): times in media seconds inside the
 * half-open span, a duplicate group of at least 2 frames, and `signed_off` only with a name, an ISO date and every
 * item confirmed. A draft carries nulls. Nothing is ever signed for the labeler: the name and date are typed by them.
 */
import type { DuplicateGroup, DuplicateMember, LabelFile, LabelItem, SpanS } from "./jev-lab-score";

export type Status = "unconfirmed" | "confirmed" | "rejected";
export type MarkKey = "boundaries" | "visualSteps";
export type ItemKey = MarkKey | "groups";

type Item = { readonly id: string; readonly note: string; readonly status: Status; readonly cue?: string; readonly fromDraft: boolean };
export type Mark = Item & { readonly mediaS: number };
export type Group = Item & { readonly frames: readonly DuplicateMember[] };

export type SheetState = {
  readonly boundaries: readonly Mark[];
  readonly visualSteps: readonly Mark[];
  readonly groups: readonly Group[];
  readonly signedOffBy: string;
  readonly signedOffAt: string;
  readonly nextId: number;
};

export type SheetData = {
  readonly draft: LabelFile;
  readonly draftHash: string;
  readonly videoId: string;
  readonly durationS: number | null;
  readonly watched: readonly (readonly [number, number])[];
  readonly passages: readonly { readonly id: string; readonly start: number; readonly end: number; readonly text: string }[];
  readonly frames: readonly { readonly id: string; readonly mediaS: number; readonly width: number; readonly height: number; readonly src: string }[];
};

export type Blocker = { readonly code: "unconfirmed" | "name" | "date" | "outside_span" | "group_size"; readonly message: string };
export type Evaluation = { readonly labels: LabelFile; readonly blockers: readonly Blocker[]; readonly warnings: readonly string[] };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const EPS = 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

export const isVideoId = (id: string): boolean => VIDEO_ID.test(id);

/** The only external link the page makes. A bad id throws, so no link is ever built from it. */
export function watchUrl(videoId: string, mediaS: number): string {
  if (!VIDEO_ID.test(videoId)) throw new Error(`refusing to build a YouTube link from the video id ${JSON.stringify(videoId)}`);
  if (!Number.isFinite(mediaS) || mediaS < 0) throw new Error(`refusing to build a YouTube link at ${String(mediaS)} s`);
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(mediaS)}s`;
}

export function fmtTime(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** Same arithmetic as `splitPoint` in jev-lab-score: a label at exactly this time is in the held-out half. */
export const midpointOf = (span: SpanS): number => span.start + (span.end - span.start) / 2;

export const storageKey = (draft: LabelFile, draftHash: string): string => `afterclass-jev-sheet:v1:${draft.lecture.captureId}:${draft.lecture.videoId}:${draftHash}`;

// ───────────────────────────── state ─────────────────────────────

const status = (confirmed: boolean): Status => (confirmed ? "confirmed" : "unconfirmed");
const withCue = (cue: string | undefined) => (cue === undefined ? {} : { cue });

/** Every draft item starts as the draft has it. The name and date start empty whatever the draft says. */
export function initialState(draft: LabelFile): SheetState {
  const mark = (prefix: string) => (it: LabelItem, i: number): Mark => ({ id: `${prefix}${i}`, mediaS: it.mediaS, note: it.note, status: status(it.confirmed), fromDraft: true, ...withCue(it.cue) });
  return {
    boundaries: draft.boundaries.map(mark("db")),
    visualSteps: draft.visualSteps.map(mark("dv")),
    groups: draft.duplicateGroups.map((g: DuplicateGroup, i): Group => ({ id: `dg${i}`, note: g.note, status: status(g.confirmed), fromDraft: true, frames: g.frames.map((f) => ({ ...f })), ...withCue(g.cue) })),
    signedOffBy: "",
    signedOffAt: "",
    nextId: 0,
  };
}

const sortMarks = (list: readonly Mark[]) => [...list].sort((a, b) => a.mediaS - b.mediaS);

/** The "boundary here" / "visual step" button. Pressed means a confirmed item sits at that time. */
export function toggleMark(state: SheetState, key: MarkKey, mediaS: number): SheetState {
  const list = state[key];
  const found = list.find((m) => same(m.mediaS, mediaS) && m.status !== "rejected") ?? list.find((m) => same(m.mediaS, mediaS));
  if (found === undefined) {
    const added: Mark = { id: `u${state.nextId}`, mediaS, note: "", status: "confirmed", fromDraft: false };
    return { ...state, [key]: sortMarks([...list, added]), nextId: state.nextId + 1 };
  }
  if (found.status !== "confirmed") return setStatus(state, key, found.id, "confirmed");
  return found.fromDraft ? setStatus(state, key, found.id, "unconfirmed") : removeItem(state, key, found.id);
}

export const isMarked = (state: SheetState, key: MarkKey, mediaS: number): boolean => state[key].some((m) => same(m.mediaS, mediaS) && m.status === "confirmed");

const patch = <T extends Item>(list: readonly T[], id: string, change: Partial<Item>): readonly T[] => list.map((x) => (x.id === id ? { ...x, ...change } : x));

export function setStatus(state: SheetState, key: ItemKey, id: string, next: Status): SheetState {
  return { ...state, [key]: patch(state[key] as readonly Item[], id, { status: next }) };
}

export function setNote(state: SheetState, key: ItemKey, id: string, note: string): SheetState {
  return { ...state, [key]: patch(state[key] as readonly Item[], id, { note }) };
}

/** Removes an item the labeler added. A draft item is rejected instead, so its cue stays visible. */
export function removeItem(state: SheetState, key: ItemKey, id: string): SheetState {
  const list = state[key] as readonly Item[];
  const item = list.find((x) => x.id === id);
  if (item === undefined) return state;
  if (item.fromDraft) return setStatus(state, key, id, "rejected");
  return { ...state, [key]: list.filter((x) => x.id !== id) };
}

export function makeGroup(state: SheetState, members: readonly DuplicateMember[]): SheetState {
  const byFrame = new Map<string, DuplicateMember>();
  for (const m of members) byFrame.set(m.frameId ?? `t${m.mediaS}`, m);
  const frames = [...byFrame.values()].sort((a, b) => a.mediaS - b.mediaS);
  if (frames.length < 2) return state;
  const group: Group = { id: `u${state.nextId}`, note: "", status: "confirmed", fromDraft: false, frames };
  return { ...state, groups: [...state.groups, group], nextId: state.nextId + 1 };
}

export function removeMember(state: SheetState, groupId: string, index: number): SheetState {
  return { ...state, groups: state.groups.map((g) => (g.id === groupId ? { ...g, frames: g.frames.filter((_, i) => i !== index) } : g)) };
}

export const setSignature = (state: SheetState, signedOffBy: string, signedOffAt: string): SheetState => ({ ...state, signedOffBy, signedOffAt });

// ───────────────────────────── the label file and what blocks sign-off ─────────────────────────────

const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s));
const inSpan = (t: number, span: SpanS) => Number.isFinite(t) && t >= span.start && t < span.end;
const kept = <T extends Item>(list: readonly T[]) => list.filter((x) => x.status !== "rejected");

const asItem = (m: Mark): LabelItem => ({ mediaS: m.mediaS, note: m.note, confirmed: m.status === "confirmed", ...withCue(m.cue) });
const asGroup = (g: Group): DuplicateGroup => ({ note: g.note, confirmed: g.status === "confirmed", ...withCue(g.cue), frames: g.frames.map((f) => ({ ...f })) });

/**
 * The label file for the state, and why it is not signed off. A rejected item is left out. An item that would make
 * the file invalid (a time outside the span, a group under 2 frames) is a blocker and is also left out of the file,
 * so the JSON shown always validates. The status is "signed_off" only when nothing blocks.
 */
export function evaluate(state: SheetState, draft: LabelFile): Evaluation {
  const { spanS } = draft.lecture;
  const blockers: Blocker[] = [];
  const at = (t: number) => `${fmtTime(t)} (${t} s)`;
  const span = `[${spanS.start}, ${spanS.end})`;

  const marks = (key: MarkKey, label: string): LabelItem[] =>
    kept(state[key]).flatMap((m) => {
      if (m.status === "unconfirmed") blockers.push({ code: "unconfirmed", message: `${label} at ${at(m.mediaS)} is not confirmed: confirm it or reject it` });
      if (!inSpan(m.mediaS, spanS)) {
        blockers.push({ code: "outside_span", message: `${label} at ${String(m.mediaS)} s is outside the labeled span ${span}; it is left out of the file until you remove it` });
        return [];
      }
      return [asItem(m)];
    });
  const boundaries = marks("boundaries", "Boundary");
  const visualSteps = marks("visualSteps", "Visual step");

  const duplicateGroups = kept(state.groups).flatMap((g) => {
    const first = g.frames.length > 0 ? at(Math.min(...g.frames.map((f) => f.mediaS))) : "no frames";
    if (g.status === "unconfirmed") blockers.push({ code: "unconfirmed", message: `Duplicate group at ${first} is not confirmed: confirm it or reject it` });
    if (g.frames.length < 2) {
      blockers.push({ code: "group_size", message: `Duplicate group at ${first} has ${g.frames.length} frame(s); a group needs at least 2 (it is left out of the file until it does)` });
      return [];
    }
    if (g.frames.some((f) => !inSpan(f.mediaS, spanS))) {
      blockers.push({ code: "outside_span", message: `Duplicate group at ${first} has a frame outside the labeled span ${span}; it is left out of the file until you fix it` });
      return [];
    }
    return [asGroup(g)];
  });

  const name = state.signedOffBy.trim();
  const date = state.signedOffAt.trim();
  if (name === "") blockers.push({ code: "name", message: "Type your name in the sign-off block" });
  if (date === "") blockers.push({ code: "date", message: "Type the date in the sign-off block (YYYY-MM-DD)" });
  else if (!isoDate(date)) blockers.push({ code: "date", message: `"${date}" is not an ISO date such as 2026-11-05` });

  const signed = blockers.length === 0;
  const warnings: string[] = [];
  if (!boundaries.some((b) => b.confirmed)) warnings.push("No boundary is confirmed. If this lecture has none, that is allowed; the lab then lists it as having no labeled boundary.");
  if (!visualSteps.some((s) => s.confirmed)) warnings.push("No visual step is confirmed.");

  const lecture = { captureId: draft.lecture.captureId, videoId: draft.lecture.videoId, ...(draft.lecture.title !== undefined ? { title: draft.lecture.title } : {}), spanS: { ...spanS } };
  const byTime = <T extends { readonly mediaS: number }>(list: readonly T[]) => [...list].sort((a, b) => a.mediaS - b.mediaS);
  const labels: LabelFile = {
    schemaVersion: 1,
    status: signed ? "signed_off" : "draft",
    signedOffBy: signed ? name : null,
    signedOffAt: signed ? date : null,
    description: signed ? `Labels made with the labeling sheet and signed off by ${name} on ${date}.` : (draft.description ?? "DRAFT labels from the labeling sheet. Not signed off."),
    lecture,
    boundaries: byTime(boundaries),
    visualSteps: byTime(visualSteps),
    duplicateGroups: [...duplicateGroups].sort((a, b) => a.frames[0]!.mediaS - b.frames[0]!.mediaS),
  };
  return { labels, blockers, warnings };
}

export const labelJson = (labels: LabelFile): string => JSON.stringify(labels, null, 2) + "\n";

// ───────────────────────────── saved state ─────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStatus = (x: unknown): x is Status => x === "unconfirmed" || x === "confirmed" || x === "rejected";
const isTime = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function readItem(x: unknown): Item | null {
  if (!isObj(x) || typeof x.id !== "string" || typeof x.note !== "string" || !isStatus(x.status) || typeof x.fromDraft !== "boolean") return null;
  if (x.cue !== undefined && typeof x.cue !== "string") return null;
  return { id: x.id, note: x.note, status: x.status, fromDraft: x.fromDraft, ...(typeof x.cue === "string" ? { cue: x.cue } : {}) };
}

/** Saved state from localStorage, or null for anything that is not exactly the shape `JSON.stringify(state)` makes. */
export function restoreState(raw: unknown): SheetState | null {
  if (!isObj(raw) || !Array.isArray(raw.boundaries) || !Array.isArray(raw.visualSteps) || !Array.isArray(raw.groups)) return null;
  if (typeof raw.signedOffBy !== "string" || typeof raw.signedOffAt !== "string" || !isTime(raw.nextId)) return null;
  const marks = (list: readonly unknown[]): Mark[] | null => {
    const out: Mark[] = [];
    for (const x of list) {
      const item = readItem(x);
      if (item === null || !isObj(x) || !isTime(x.mediaS)) return null;
      out.push({ ...item, mediaS: x.mediaS });
    }
    return out;
  };
  const groups: Group[] = [];
  for (const x of raw.groups) {
    const item = readItem(x);
    if (item === null || !isObj(x) || !Array.isArray(x.frames)) return null;
    const frames: DuplicateMember[] = [];
    for (const f of x.frames as unknown[]) {
      if (!isObj(f) || !isTime(f.mediaS) || (f.frameId !== undefined && typeof f.frameId !== "string")) return null;
      frames.push({ mediaS: f.mediaS, ...(typeof f.frameId === "string" ? { frameId: f.frameId } : {}) });
    }
    groups.push({ ...item, frames });
  }
  const boundaries = marks(raw.boundaries);
  const visualSteps = marks(raw.visualSteps);
  if (boundaries === null || visualSteps === null) return null;
  return { boundaries, visualSteps, groups, signedOffBy: raw.signedOffBy, signedOffAt: raw.signedOffAt, nextId: raw.nextId };
}
