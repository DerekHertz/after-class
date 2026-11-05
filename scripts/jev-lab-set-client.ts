/**
 * The set labeling sheet's logic, with no DOM: sheet state for a SET of clips (label schema 2), model proposals merged
 * into it, the disagreements between two models, the label file it exports and what blocks a sign-off. The page bundles
 * this module (scripts/jev-lab-set-page.ts); tests import it and check every export against the lab's own
 * `validateLabels` and `loadLabels`. Types only come from jev-lab-score and jev-lab-proposals, so no backend is bundled.
 *
 * The rules mirror `validateLabels` for schema 2 (docs/experiments/02-jev-lab.md, Amendment 1): every item carries the
 * `videoId` of one of the clips, its time lies inside that clip's half-open span, a duplicate group needs two distinct
 * frames (and may span clips), the clips stay in the draft's watch order, and `signed_off` needs a typed name, an ISO
 * date and every item confirmed. A draft carries nulls. Nothing is ever signed for the labeler, and a model's proposal
 * is never confirmed by the sheet: only a click by the labeler sets `confirmed`.
 */
import type { DuplicateMember, LabelFileV2, LabelItem, SpanS } from "./jev-lab-score";
import type { Proposals } from "./jev-lab-proposals";
import { fmtTime } from "./jev-lab-sheet-client";

/** PROPOSED (not adopted): two models' visual steps within this many seconds in one clip are the same step. Inclusive. */
export const STEP_TOLERANCE_S = 10;
/** PROPOSED: two models' boundaries within this many seconds in one clip are the same boundary. Inclusive. */
export const BOUNDARY_TOLERANCE_S = 60;
/** PROPOSED: two frames of one clip without frame ids are the same frame when this close (the lab's own duplicate match is 2 s). */
export const GROUP_FRAME_MATCH_S = 2;

export type Status = "unconfirmed" | "confirmed" | "rejected";
export type MarkKey = "boundaries" | "visualSteps";
export type ItemKey = MarkKey | "groups";
export type Origin = "draft" | "proposal" | "user";

/** A proposing model, as the sheet names it. `key` is `proposedBy.model` verbatim; `label` is what the page shows. */
export type Proposer = { readonly key: string; readonly label: string; readonly effort: string; readonly reason: string; readonly source?: "model" | "join"; readonly fixture?: true };
export type Member = DuplicateMember & { readonly videoId: string };

type Item = { readonly id: string; readonly note: string; readonly status: Status; readonly cue?: string; readonly origin: Origin; readonly proposers: readonly Proposer[] };
export type Mark = Item & { readonly videoId: string; readonly mediaS: number };
export type Group = Item & { readonly frames: readonly Member[] };

export type SetState = {
  readonly boundaries: readonly Mark[];
  readonly visualSteps: readonly Mark[];
  readonly groups: readonly Group[];
  readonly signedOffBy: string;
  readonly signedOffAt: string;
  readonly nextId: number;
};

export type SetClip = {
  readonly videoId: string;
  readonly title: string;
  readonly durationS: number | null;
  readonly spanS: SpanS;
  readonly watched: readonly (readonly [number, number])[];
  readonly watchedS: number;
  readonly half: "first" | "second";
  readonly passages: readonly { readonly id: string; readonly start: number; readonly end: number; readonly text: string }[];
  readonly frames: readonly { readonly id: string; readonly mediaS: number; readonly width: number; readonly height: number; readonly file: string }[];
};

/** The lab's split of this set (`makeSplitter`): a join split counts watched seconds; one clip splits at its span's midpoint. */
export type SetSplit = { readonly kind: "join" | "midpoint"; readonly joinIndex: number; readonly totalS: number; readonly midpointS: number; readonly beforeS: number; readonly afterS: number };

export type SetData = {
  readonly draft: LabelFileV2;
  readonly inputHash: string;
  readonly clips: readonly SetClip[];
  readonly split: SetSplit;
  readonly proposals: readonly Proposals[];
};

export type Blocker = { readonly code: "unconfirmed" | "name" | "date" | "outside_span" | "unknown_video" | "group_size"; readonly message: string };
export type Evaluation = { readonly labels: LabelFileV2; readonly blockers: readonly Blocker[]; readonly warnings: readonly string[] };

const EPS = 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

/** The only image files the page may show: written next to it by the generator, never anything else. */
export const FRAME_FILE = /^frames\/c\d{2}-f\d{4}\.jpg$/;

export const storageKey = (captureId: string, inputHash: string): string => `afterclass-jev-sheet:v2set:${captureId}:${inputHash}`;

/** The name a model goes by on the page: Opus, Fable, or the raw id when it is neither. */
export function modelLabel(model: string): string {
  if (/opus/i.test(model)) return "Opus";
  if (/fable/i.test(model)) return "Fable";
  return model;
}

/** What the page calls a proposals file. A fixture file came from a scripted test client, so it is never called Opus or Fable. */
export const proposalsLabel = (p: Proposals): string => (p.origin === "fixture" ? `FIXTURE, not a model: ${p.proposedBy.model}` : modelLabel(p.proposedBy.model));

const proposerOf = (p: Proposals, reason: string, source?: "model" | "join"): Proposer => ({
  key: p.proposedBy.model, label: proposalsLabel(p), effort: p.proposedBy.effort, reason, ...(source === undefined ? {} : { source }), ...(p.origin === "fixture" ? { fixture: true as const } : {}),
});

// ───────────────────────────── merging two models' proposals ─────────────────────────────

export type MergedMark = { readonly videoId: string; readonly mediaS: number; readonly proposers: readonly Proposer[] };
export type MergedGroup = { readonly frames: readonly Member[]; readonly proposers: readonly Proposer[] };
export type Merged = { readonly boundaries: readonly MergedMark[]; readonly visualSteps: readonly MergedMark[]; readonly groups: readonly MergedGroup[] };

/** "Both" when two models proposed it, "only" when one did. */
export const agreementOf = (proposers: readonly Proposer[]): "both" | "only" => (new Set(proposers.map((p) => p.key)).size >= 2 ? "both" : "only");

type Located = { readonly videoId: string; readonly mediaS: number; readonly proposer: Proposer };

/**
 * One-to-one pairing of the first two proposers' items inside one clip: the closest pairs first (ties go to the earlier
 * time, then to list order), each item used once, a pair only when the gap is at most `tol` (inclusive). A pair is one
 * item at the earlier time that carries both reasons. Anything else stays an item of its own model alone.
 */
function mergeMarks(lists: readonly (readonly Located[])[], tol: number): MergedMark[] {
  const [a = [], b = []] = lists;
  const pairs: { i: number; j: number; gap: number; at: number }[] = [];
  a.forEach((x, i) =>
    b.forEach((y, j) => {
      const gap = Math.abs(x.mediaS - y.mediaS);
      if (x.videoId === y.videoId && gap <= tol + 1e-9) pairs.push({ i, j, gap, at: Math.min(x.mediaS, y.mediaS) });
    }),
  );
  pairs.sort((p, q) => p.gap - q.gap || p.at - q.at || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: MergedMark[] = [];
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    out.push({ videoId: a[p.i]!.videoId, mediaS: p.at, proposers: [a[p.i]!.proposer, b[p.j]!.proposer] });
  }
  a.forEach((x, i) => void (usedA.has(i) || out.push({ videoId: x.videoId, mediaS: x.mediaS, proposers: [x.proposer] })));
  b.forEach((y, j) => void (usedB.has(j) || out.push({ videoId: y.videoId, mediaS: y.mediaS, proposers: [y.proposer] })));
  return out;
}

const sameFrame = (x: Member, y: Member): boolean => x.videoId === y.videoId && (x.frameId !== undefined && y.frameId !== undefined ? x.frameId === y.frameId : Math.abs(x.mediaS - y.mediaS) <= GROUP_FRAME_MATCH_S + 1e-9);

/** Watch order: the clip's place in the set, then media time. */
function byWatchOrder(order: readonly string[]) {
  const at = (v: string) => {
    const i = order.indexOf(v);
    return i < 0 ? order.length : i;
  };
  return (x: { readonly videoId: string; readonly mediaS: number }, y: { readonly videoId: string; readonly mediaS: number }) => at(x.videoId) - at(y.videoId) || x.mediaS - y.mediaS;
}

/** Two groups are the same duplicate group when they share at least 2 frames. The merged group is the union of their frames. */
function mergeGroups(lists: readonly (readonly { readonly frames: readonly Member[]; readonly proposer: Proposer }[])[], order: readonly string[]): MergedGroup[] {
  const [a = [], b = []] = lists;
  const cmp = byWatchOrder(order);
  const overlap = (x: readonly Member[], y: readonly Member[]) => x.filter((m) => y.some((n) => sameFrame(m, n))).length;
  const pairs: { i: number; j: number; n: number; first: Member }[] = [];
  a.forEach((x, i) =>
    b.forEach((y, j) => {
      const n = overlap(x.frames, y.frames);
      if (n >= 2) pairs.push({ i, j, n, first: [...x.frames, ...y.frames].sort(cmp)[0]! });
    }),
  );
  pairs.sort((p, q) => q.n - p.n || cmp(p.first, q.first) || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const sorted = (frames: readonly Member[]) => [...frames].sort(cmp);
  const out: MergedGroup[] = [];
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    const x = a[p.i]!;
    const y = b[p.j]!;
    out.push({ frames: sorted([...x.frames, ...y.frames.filter((m) => !x.frames.some((n) => sameFrame(m, n)))]), proposers: [x.proposer, y.proposer] });
  }
  a.forEach((x, i) => void (usedA.has(i) || out.push({ frames: sorted(x.frames), proposers: [x.proposer] })));
  b.forEach((y, j) => void (usedB.has(j) || out.push({ frames: sorted(y.frames), proposers: [y.proposer] })));
  return out;
}

/**
 * The proposals of up to two models as items, each marked with who proposed it. Boundaries pair within
 * BOUNDARY_TOLERANCE_S and visual steps within STEP_TOLERANCE_S, in the same clip only. Deterministic and order of the
 * list is the order of the files given. Everything is sorted by watch order.
 */
export function mergeProposals(proposals: readonly Proposals[], order: readonly string[]): Merged {
  if (proposals.length > 2) throw new RangeError("the sheet compares at most two proposal files");
  const cmp = byWatchOrder(order);
  const marks = (pick: (p: Proposals) => readonly { readonly videoId: string; readonly mediaS: number; readonly reason: string; readonly source?: "model" | "join" }[], tol: number): MergedMark[] =>
    mergeMarks(proposals.map((p) => pick(p).map((x): Located => ({ videoId: x.videoId, mediaS: x.mediaS, proposer: proposerOf(p, x.reason, x.source) }))), tol).sort(cmp);
  const groups = mergeGroups(proposals.map((p) => p.items.duplicateGroups.map((g) => ({ frames: g.frames.map((f): Member => ({ videoId: f.videoId, mediaS: f.mediaS, ...(f.frameId === undefined ? {} : { frameId: f.frameId }) })), proposer: proposerOf(p, g.reason) }))), order);
  return {
    boundaries: marks((p) => p.items.boundaries, BOUNDARY_TOLERANCE_S),
    visualSteps: marks((p) => p.items.visualSteps, STEP_TOLERANCE_S),
    groups: groups.sort((x, y) => cmp(x.frames[0]!, y.frames[0]!)),
  };
}

// ───────────────────────────── disagreements ─────────────────────────────

export type Disagreement = {
  readonly key: ItemKey;
  readonly id: string;
  readonly videoId: string;
  readonly mediaS: number;
  readonly agreement: "both" | "only";
  /** The labels of the models that proposed it. */
  readonly by: readonly string[];
  readonly status: Status;
};

/**
 * Items a model proposed, as "both" or "only one". When fewer than two models were given nothing can disagree, and
 * `comparable` is false. An item with no proposer (a draft candidate or the labeler's own) is not listed.
 */
export function disagreements(state: SetState, modelCount: number): { readonly comparable: boolean; readonly entries: readonly Disagreement[] } {
  const entries: Disagreement[] = [];
  const add = (key: ItemKey, item: Mark | Group) => {
    if (item.proposers.length === 0) return;
    const first = "frames" in item ? item.frames[0] : item;
    entries.push({
      key, id: item.id, videoId: first?.videoId ?? "", mediaS: first?.mediaS ?? 0, agreement: agreementOf(item.proposers),
      by: [...new Set(item.proposers.map((p) => p.label))], status: item.status,
    });
  };
  state.boundaries.forEach((m) => add("boundaries", m));
  state.visualSteps.forEach((m) => add("visualSteps", m));
  state.groups.forEach((g) => add("groups", g));
  return { comparable: modelCount >= 2, entries };
}

// ───────────────────────────── state ─────────────────────────────

const status = (confirmed: boolean): Status => (confirmed ? "confirmed" : "unconfirmed");
const withCue = (cue: string | undefined) => (cue === undefined ? {} : { cue });
const orderOf = (draft: LabelFileV2): readonly string[] => draft.lecture.videos.map((v) => v.videoId);

/**
 * Every draft item starts as the draft has it; every proposed item starts UNCONFIRMED whatever the model said, and a
 * proposal at the same place as a draft item (same clip, same second) is attached to that item. The name and date start
 * empty whatever the draft says.
 */
export function initialState(draft: LabelFileV2, proposals: readonly Proposals[] = []): SetState {
  const order = orderOf(draft);
  const mark = (prefix: string) => (it: LabelItem & { readonly videoId: string }, i: number): Mark => ({ id: `${prefix}${i}`, videoId: it.videoId, mediaS: it.mediaS, note: it.note, status: status(it.confirmed), origin: "draft", proposers: [], ...withCue(it.cue) });
  const boundaries: Mark[] = draft.boundaries.map(mark("db"));
  const visualSteps: Mark[] = draft.visualSteps.map(mark("dv"));
  const merged = mergeProposals(proposals, order);
  const attach = (list: Mark[], found: readonly MergedMark[], prefix: string) => {
    found.forEach((m, i) => {
      const at = list.findIndex((x) => x.origin === "draft" && x.videoId === m.videoId && same(x.mediaS, m.mediaS) && x.proposers.length === 0);
      if (at >= 0) list[at] = { ...list[at]!, proposers: m.proposers };
      else list.push({ id: `${prefix}${i}`, videoId: m.videoId, mediaS: m.mediaS, note: "", status: "unconfirmed", origin: "proposal", proposers: m.proposers });
    });
  };
  attach(boundaries, merged.boundaries, "pb");
  attach(visualSteps, merged.visualSteps, "pv");
  const groups: Group[] = draft.duplicateGroups.map((g, i): Group => ({ id: `dg${i}`, note: g.note, status: status(g.confirmed), origin: "draft", proposers: [], frames: g.frames.map((f) => ({ ...f })), ...withCue(g.cue) }));
  merged.groups.forEach((g, i) => groups.push({ id: `pg${i}`, note: "", status: "unconfirmed", origin: "proposal", proposers: g.proposers, frames: g.frames.map((f) => ({ ...f })) }));
  const cmp = byWatchOrder(order);
  const bySpot = (x: Mark, y: Mark) => cmp(x, y);
  return { boundaries: boundaries.sort(bySpot), visualSteps: visualSteps.sort(bySpot), groups: groups.sort((x, y) => cmp(x.frames[0]!, y.frames[0]!)), signedOffBy: "", signedOffAt: "", nextId: 0 };
}

/** The "boundary here" / "visual step" button. Pressed means a confirmed item sits at that place. */
export function toggleMark(state: SetState, key: MarkKey, videoId: string, mediaS: number, order: readonly string[] = [videoId]): SetState {
  const list = state[key];
  const here = (m: Mark) => m.videoId === videoId && same(m.mediaS, mediaS);
  const found = list.find((m) => here(m) && m.status !== "rejected") ?? list.find(here);
  if (found === undefined) {
    const added: Mark = { id: `u${state.nextId}`, videoId, mediaS, note: "", status: "confirmed", origin: "user", proposers: [] };
    return { ...state, [key]: [...list, added].sort(byWatchOrder(order)), nextId: state.nextId + 1 };
  }
  if (found.status !== "confirmed") return setStatus(state, key, found.id, "confirmed");
  return found.origin !== "user" ? setStatus(state, key, found.id, "unconfirmed") : removeItem(state, key, found.id);
}

export const isMarked = (state: SetState, key: MarkKey, videoId: string, mediaS: number): boolean => state[key].some((m) => m.videoId === videoId && same(m.mediaS, mediaS) && m.status === "confirmed");

const patch = <T extends Item>(list: readonly T[], id: string, change: Partial<Item>): readonly T[] => list.map((x) => (x.id === id ? { ...x, ...change } : x));

export function setStatus(state: SetState, key: ItemKey, id: string, next: Status): SetState {
  return { ...state, [key]: patch(state[key] as readonly Item[], id, { status: next }) };
}

export function setNote(state: SetState, key: ItemKey, id: string, note: string): SetState {
  return { ...state, [key]: patch(state[key] as readonly Item[], id, { note }) };
}

/** Removes an item the labeler added. A draft or proposed item is rejected instead, so its reason stays visible. */
export function removeItem(state: SetState, key: ItemKey, id: string): SetState {
  const list = state[key] as readonly Item[];
  const item = list.find((x) => x.id === id);
  if (item === undefined) return state;
  if (item.origin !== "user") return setStatus(state, key, id, "rejected");
  return { ...state, [key]: list.filter((x) => x.id !== id) };
}

const memberKey = (m: Member) => `${m.videoId}:${m.frameId ?? `t${m.mediaS}`}`;

/** A group of frames, possibly across clips. Fewer than two distinct frames makes no group. Members are in watch order. */
export function makeGroup(state: SetState, members: readonly Member[], order: readonly string[]): SetState {
  const byFrame = new Map<string, Member>();
  for (const m of members) byFrame.set(memberKey(m), m);
  const frames = [...byFrame.values()].sort(byWatchOrder(order));
  if (frames.length < 2) return state;
  const group: Group = { id: `u${state.nextId}`, note: "", status: "confirmed", origin: "user", proposers: [], frames };
  return { ...state, groups: [...state.groups, group], nextId: state.nextId + 1 };
}

export function removeMember(state: SetState, groupId: string, index: number): SetState {
  return { ...state, groups: state.groups.map((g) => (g.id === groupId ? { ...g, frames: g.frames.filter((_, i) => i !== index) } : g)) };
}

export const setSignature = (state: SetState, signedOffBy: string, signedOffAt: string): SetState => ({ ...state, signedOffBy, signedOffAt });

// ───────────────────────────── the label file and what blocks sign-off ─────────────────────────────

const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s));
const kept = <T extends Item>(list: readonly T[]) => list.filter((x) => x.status !== "rejected");

/** Where an item lives for display: its video and time, a group at its earliest member in watch order. */
export function placeOf(item: Mark | Group, order: readonly string[]): { readonly videoId: string; readonly mediaS: number } {
  if (!("frames" in item)) return { videoId: item.videoId, mediaS: item.mediaS };
  const first = [...item.frames].sort(byWatchOrder(order))[0];
  return first === undefined ? { videoId: order[0] ?? "", mediaS: 0 } : { videoId: first.videoId, mediaS: first.mediaS };
}

/** Provenance kept in the file: the draft's own cue, then one "proposed by <model>: <reason>" per model. The labeler's own items carry none. */
export function cueOf(item: Mark | Group): string | undefined {
  if (item.origin === "user") return undefined;
  const parts = [...(item.cue === undefined ? [] : [item.cue]), ...item.proposers.map((p) => `proposed by ${p.key}${p.fixture === true ? " (FIXTURE, not a model)" : ""}: ${p.reason}`)];
  return parts.length === 0 ? undefined : parts.join("; ");
}

/**
 * The label file for the state, and why it is not signed off. A rejected item is left out. An item that would make the
 * file invalid (a time outside its clip's span, a video that is not in the set, a group under 2 distinct frames) is a
 * blocker and is also left out of the file, so the JSON shown always validates. The status is "signed_off" only when
 * nothing blocks.
 */
export function evaluate(state: SetState, draft: LabelFileV2): Evaluation {
  const order = orderOf(draft);
  const spans = new Map(draft.lecture.videos.map((v) => [v.videoId, v.spanS] as const));
  const clipNo = (videoId: string) => `clip ${order.indexOf(videoId) + 1}`;
  const blockers: Blocker[] = [];
  const at = (videoId: string, t: number) => `${clipNo(videoId)} at ${fmtTime(t)} (${t} s)`;
  const inSpan = (videoId: string, t: number): "ok" | "unknown" | "outside" => {
    const span = spans.get(videoId);
    if (span === undefined) return "unknown";
    return Number.isFinite(t) && t >= span.start && t < span.end ? "ok" : "outside";
  };

  const marks = (key: MarkKey, label: string): (LabelItem & { readonly videoId: string })[] =>
    kept(state[key]).flatMap((m) => {
      const where = at(m.videoId, m.mediaS);
      if (m.status === "unconfirmed") blockers.push({ code: "unconfirmed", message: `${label} at ${where} is not confirmed: confirm it or reject it` });
      const ok = inSpan(m.videoId, m.mediaS);
      if (ok === "unknown") {
        blockers.push({ code: "unknown_video", message: `${label} at ${String(m.mediaS)} s names the video ${m.videoId}, which is not one of the clips; it is left out of the file until you remove it` });
        return [];
      }
      if (ok === "outside") {
        const span = spans.get(m.videoId)!;
        blockers.push({ code: "outside_span", message: `${label} at ${String(m.mediaS)} s is outside the labeled span [${span.start}, ${span.end}) of ${clipNo(m.videoId)}; it is left out of the file until you remove it` });
        return [];
      }
      const cue = cueOf(m);
      return [{ videoId: m.videoId, mediaS: m.mediaS, note: m.note, confirmed: m.status === "confirmed", ...withCue(cue) }];
    });
  const boundaries = marks("boundaries", "Boundary");
  const visualSteps = marks("visualSteps", "Visual step");

  const duplicateGroups = kept(state.groups).flatMap((g) => {
    const firstAt = g.frames.length > 0 ? placeOf(g, order) : null;
    const first = firstAt === null ? "no frames" : at(firstAt.videoId, firstAt.mediaS);
    if (g.status === "unconfirmed") blockers.push({ code: "unconfirmed", message: `Duplicate group at ${first} is not confirmed: confirm it or reject it` });
    const distinct = new Set(g.frames.map(memberKey)).size;
    if (distinct < 2) {
      blockers.push({ code: "group_size", message: `Duplicate group at ${first} has ${distinct} distinct frame(s); a group needs at least 2 (it is left out of the file until it does)` });
      return [];
    }
    const states = g.frames.map((f) => inSpan(f.videoId, f.mediaS));
    if (states.includes("unknown")) {
      blockers.push({ code: "unknown_video", message: `Duplicate group at ${first} has a frame of a video that is not one of the clips; it is left out of the file until you fix it` });
      return [];
    }
    if (states.includes("outside")) {
      blockers.push({ code: "outside_span", message: `Duplicate group at ${first} has a frame outside its clip's labeled span; it is left out of the file until you fix it` });
      return [];
    }
    const cue = cueOf(g);
    const frames = [...g.frames].sort(byWatchOrder(order)).map((f) => ({ videoId: f.videoId, mediaS: f.mediaS, ...(f.frameId === undefined ? {} : { frameId: f.frameId }) }));
    return [{ note: g.note, confirmed: g.status === "confirmed", ...withCue(cue), frames }];
  });

  const name = state.signedOffBy.trim();
  const date = state.signedOffAt.trim();
  if (name === "") blockers.push({ code: "name", message: "Type your name in the sign-off block" });
  if (date === "") blockers.push({ code: "date", message: "Type the date in the sign-off block (YYYY-MM-DD)" });
  else if (!isoDate(date)) blockers.push({ code: "date", message: `"${date}" is not an ISO date such as 2026-11-05` });

  const signed = blockers.length === 0;
  const warnings: string[] = [];
  if (!boundaries.some((b) => b.confirmed)) warnings.push("No boundary is confirmed. If this set has none, that is allowed; the lab then lists it as having no labeled boundary.");
  if (!visualSteps.some((s) => s.confirmed)) warnings.push("No visual step is confirmed.");
  const firstClip = spans.get(order[0] ?? "");
  if (firstClip !== undefined && boundaries.some((b) => b.confirmed && b.videoId === order[0] && b.mediaS <= firstClip.start + 1)) {
    warnings.push("A boundary is confirmed at the very start of the first clip. The first clip's start is not a boundary; the lab cannot detect it and excludes it from recall.");
  }

  const byPlace = <T extends { readonly videoId: string; readonly mediaS: number }>(list: readonly T[]) => [...list].sort(byWatchOrder(order));
  const labels: LabelFileV2 = {
    schemaVersion: 2,
    status: signed ? "signed_off" : "draft",
    signedOffBy: signed ? name : null,
    signedOffAt: signed ? date : null,
    description: signed ? `Labels made with the labeling sheet and signed off by ${name} on ${date}.` : (draft.description ?? "DRAFT labels from the labeling sheet. Not signed off."),
    lecture: { captureId: draft.lecture.captureId, videos: draft.lecture.videos.map((v) => ({ videoId: v.videoId, ...(v.title !== undefined ? { title: v.title } : {}), spanS: { ...v.spanS } })) },
    boundaries: byPlace(boundaries),
    visualSteps: byPlace(visualSteps),
    duplicateGroups: [...duplicateGroups].sort((x, y) => byWatchOrder(order)(x.frames[0]!, y.frames[0]!)),
  };
  return { labels, blockers, warnings };
}

export const labelJson = (labels: LabelFileV2): string => JSON.stringify(labels, null, 2) + "\n";

// ───────────────────────────── saved state ─────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStatus = (x: unknown): x is Status => x === "unconfirmed" || x === "confirmed" || x === "rejected";
const isOrigin = (x: unknown): x is Origin => x === "draft" || x === "proposal" || x === "user";
const isTime = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function readProposer(x: unknown): Proposer | null {
  if (!isObj(x) || typeof x.key !== "string" || typeof x.label !== "string" || typeof x.effort !== "string" || typeof x.reason !== "string") return null;
  if (x.source !== undefined && x.source !== "model" && x.source !== "join") return null;
  if (x.fixture !== undefined && x.fixture !== true) return null;
  return { key: x.key, label: x.label, effort: x.effort, reason: x.reason, ...(x.source === undefined ? {} : { source: x.source }), ...(x.fixture === true ? { fixture: true as const } : {}) };
}

function readItem(x: unknown): Item | null {
  if (!isObj(x) || typeof x.id !== "string" || typeof x.note !== "string" || !isStatus(x.status) || !isOrigin(x.origin) || !Array.isArray(x.proposers)) return null;
  if (x.cue !== undefined && typeof x.cue !== "string") return null;
  const proposers: Proposer[] = [];
  for (const p of x.proposers as unknown[]) {
    const read = readProposer(p);
    if (read === null) return null;
    proposers.push(read);
  }
  return { id: x.id, note: x.note, status: x.status, origin: x.origin, proposers, ...(typeof x.cue === "string" ? { cue: x.cue } : {}) };
}

/** Saved state from localStorage, or null for anything that is not exactly the shape `JSON.stringify(state)` makes. */
export function restoreState(raw: unknown): SetState | null {
  if (!isObj(raw) || !Array.isArray(raw.boundaries) || !Array.isArray(raw.visualSteps) || !Array.isArray(raw.groups)) return null;
  if (typeof raw.signedOffBy !== "string" || typeof raw.signedOffAt !== "string" || !isTime(raw.nextId)) return null;
  const marks = (list: readonly unknown[]): Mark[] | null => {
    const out: Mark[] = [];
    for (const x of list) {
      const item = readItem(x);
      if (item === null || !isObj(x) || !isTime(x.mediaS) || typeof x.videoId !== "string") return null;
      out.push({ ...item, videoId: x.videoId, mediaS: x.mediaS });
    }
    return out;
  };
  const groups: Group[] = [];
  for (const x of raw.groups) {
    const item = readItem(x);
    if (item === null || !isObj(x) || !Array.isArray(x.frames)) return null;
    const frames: Member[] = [];
    for (const f of x.frames as unknown[]) {
      if (!isObj(f) || !isTime(f.mediaS) || typeof f.videoId !== "string" || (f.frameId !== undefined && typeof f.frameId !== "string")) return null;
      frames.push({ videoId: f.videoId, mediaS: f.mediaS, ...(typeof f.frameId === "string" ? { frameId: f.frameId } : {}) });
    }
    groups.push({ ...item, frames });
  }
  const boundaries = marks(raw.boundaries);
  const visualSteps = marks(raw.visualSteps);
  if (boundaries === null || visualSteps === null) return null;
  return { boundaries, visualSteps, groups, signedOffBy: raw.signedOffBy, signedOffAt: raw.signedOffAt, nextId: raw.nextId };
}
