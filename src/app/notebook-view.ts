/**
 * Pure view logic for the notebook (#117): one structure, lecture → topic, shared by the full page and the room's
 * notebook. A lecture is a capture; its saved reviews' notes and observations are grouped under the topic they are
 * about, so a topic's explanation, help, status and source read in one place.
 */
import type { ConceptId, NoteId, ReviewId } from "../shared/ids";
import type { Note, Observation, RecordView } from "../shared/domain";
import type { LecturesResponse } from "../shared/wire";
import { lectureHeading } from "./core";
import type { ReviewContext } from "./observation-view";

export type NotebookTopic = {
  /** The topic's concept, or null for observations that name no concept. */
  readonly conceptId: ConceptId | null;
  /** The topic's name from a loaded review, else null until one loads. */
  readonly label: string | null;
  readonly notes: readonly Note[];
  readonly observations: readonly Observation[];
  readonly revisit: boolean;
  readonly disputed: boolean;
};

export type NotebookLecture = {
  /** The capture's id, or the review's when the lecture list does not name its capture. Stable while the page is open. */
  readonly key: string;
  /** The lecture's title, or null when the lecture list does not have it. */
  readonly title: string | null;
  readonly detail: string | null;
  readonly reviews: readonly { readonly reviewId: ReviewId; readonly startedMs: number | null }[];
  readonly topics: readonly NotebookTopic[];
};

/**
 * R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
 * Mirrors the backend's `isLearningGap`: a partial or unresolved status counts only with no dispute, or a dispute the
 * learner settled as their gap. "My explanation was supported" keeps the tutor's partial status but is never a gap.
 */
export function countsAsGap(o: Pick<Observation, "status" | "dispute">): boolean {
  if (o.status !== "partial" && o.status !== "unresolved") return false;
  return o.dispute.kind === "none" || (o.dispute.kind === "resolved_by_learner" && o.dispute.outcome === "it_was_my_gap");
}

/** An open or unsettled dispute, saved as "disputed" until the learner settles it. */
export const isDisputed = (o: Pick<Observation, "status">): boolean => o.status === "disputed";

/** The focused views, in the order both entry points show them. A view with nothing in it is not offered. */
export const NOTEBOOK_VIEWS = [
  { value: "all", label: "All topics", matches: (_: NotebookTopic) => true },
  { value: "revisit", label: "To revisit", matches: (t: NotebookTopic) => t.revisit },
  { value: "disputed", label: "Disputed", matches: (t: NotebookTopic) => t.disputed },
] as const;
export type NotebookViewName = (typeof NOTEBOOK_VIEWS)[number]["value"];

/** The headings inside a topic, in order. Both entry points use these words. */
export const TOPIC_SECTIONS = { explanation: "My explanation", help: "Help used", status: "Status", source: "Source" } as const;

type Lectures = LecturesResponse["lectures"];

/**
 * Lectures in the lecture list's order (newest first), then any the list does not know. Topics keep the reviews' scope
 * order, then any the reviews do not name, in the record's order. A topic with no note and no observation is left out.
 */
export function notebookLectures(record: RecordView, lectures: Lectures | null, contexts: ReadonlyMap<ReviewId, ReviewContext>): NotebookLecture[] {
  const captureOf = new Map<ReviewId, { readonly index: number; readonly lecture: Lectures[number]; readonly startedMs: number }>();
  lectures?.forEach((lecture, index) => { for (const r of lecture.reviews) captureOf.set(r.reviewId, { index, lecture, startedMs: r.startedMs }); });
  const reviewIds = [...new Set([...record.notes.map((n) => n.reviewId), ...record.observations.map((o) => o.reviewId)])];
  const keyOf = (id: ReviewId): string => captureOf.get(id)?.lecture.captureId ?? `review:${id}`;
  const rank = (id: ReviewId): number => captureOf.get(id)?.index ?? (lectures?.length ?? 0) + reviewIds.indexOf(id);
  const first = new Map<string, ReviewId>();
  for (const id of reviewIds) if (!first.has(keyOf(id))) first.set(keyOf(id), id);
  const keys = [...first].sort(([, a], [, b]) => rank(a) - rank(b)).map(([key]) => key);
  return keys.map((key) => {
    const mine = reviewIds.filter((id) => keyOf(id) === key);
    const known = captureOf.get(mine[0]!);
    const heading = known === undefined ? null : lectureHeading(known.lecture.sourceTitles);
    const named = new Map<ConceptId, string>();
    for (const id of mine) {
      const c = contexts.get(id);
      if (c?.state === "ready") for (const t of c.view.topics) if (!named.has(t.id)) named.set(t.id, t.label);
    }
    const notes = record.notes.filter((n) => mine.includes(n.reviewId));
    const observations = record.observations.filter((o) => mine.includes(o.reviewId));
    const conceptOf = (o: Observation): ConceptId | null => o.conceptIds.find((c) => named.has(c)) ?? o.conceptIds[0] ?? null;
    const order = [...new Set<ConceptId | null>([...named.keys(), ...notes.map((n) => n.conceptId), ...observations.map(conceptOf)])];
    const topics = order.flatMap((conceptId): NotebookTopic[] => {
      const topicNotes = notes.filter((n) => n.conceptId === conceptId);
      const topicObservations = observations.filter((o) => conceptOf(o) === conceptId);
      if (topicNotes.length === 0 && topicObservations.length === 0) return [];
      return [{
        conceptId,
        label: conceptId === null ? null : (named.get(conceptId) ?? null),
        notes: topicNotes,
        observations: topicObservations,
        revisit: topicObservations.some(countsAsGap),
        disputed: topicObservations.some(isDisputed),
      }];
    });
    return {
      key,
      title: heading?.title ?? null,
      detail: heading?.detail ?? null,
      reviews: mine.map((reviewId) => ({ reviewId, startedMs: captureOf.get(reviewId)?.startedMs ?? null })),
      topics,
    };
  });
}

/** The lectures a focused view shows, each with only its matching topics. */
export function focusLectures(lectures: readonly NotebookLecture[], view: NotebookViewName): NotebookLecture[] {
  const matches = NOTEBOOK_VIEWS.find((v) => v.value === view)!.matches;
  return lectures.flatMap((l) => {
    const topics = l.topics.filter(matches);
    return topics.length === 0 ? [] : [{ ...l, topics }];
  });
}

/** How many topics each view holds. */
export const viewCounts = (lectures: readonly NotebookLecture[]): Readonly<Record<NotebookViewName, number>> => {
  const topics = lectures.flatMap((l) => l.topics);
  return { all: topics.length, revisit: topics.filter((t) => t.revisit).length, disputed: topics.filter((t) => t.disputed).length };
};

/**
 * The notes the learner is editing, each with its unsaved text. A note with no entry is not being edited. Held above the
 * views and the lecture grouping, so a topic that leaves a view or moves to another lecture keeps its edit.
 */
export type NoteDrafts = ReadonlyMap<NoteId, string>;

/** Opens or updates one note's draft with `text`, or closes it with null. Every other note's draft is unchanged. */
export function withDraft(drafts: NoteDrafts, id: NoteId, text: string | null): NoteDrafts {
  const next = new Map(drafts);
  if (text === null) next.delete(id);
  else next.set(id, text);
  return next;
}

/** The name a topic is shown by. Until a review names it, its place in the lecture says which one it is. */
export function topicName(topic: NotebookTopic, index: number, loading: boolean): string {
  if (topic.label !== null) return topic.label;
  if (topic.conceptId === null) return "Not tied to one topic";
  return loading ? `Topic ${index + 1} (name loading)` : `Topic ${index + 1}`;
}
