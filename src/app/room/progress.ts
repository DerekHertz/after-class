/**
 * What the room shows of a learner's progress, derived from the saved record and nothing else (GET /record).
 *
 * Rules (docs/flows/after-class.md; docs/design/live-room/README.md "Rules"):
 * - R12: "If the tutor helped before my answer, it can't count as independent."
 * - R13: "A skipped or unanswered question is never counted as understood."
 * - R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
 * - R18: "A quick check I pass only shows the topic looks fine; it's never recorded as understood the way a main question is."
 *
 * The record already applies those rules when it derives `Observation.status`. This module adds one more: only
 * `independent` grows understanding. `partial` and `after_help` are shown as effort, apart and smaller, never as
 * understood. Every other status awards nothing. An independent observation that names no topic awards nothing either:
 * understanding is counted per topic, and there is no topic to count. There is no clock and no streak: the output depends only on the
 * observations given, so a later review can add to it and never takes anything away.
 */
import type { Observation, RecordedStatus } from "../../shared/domain";
import type { ConceptId, ReviewId } from "../../shared/ids";
import type { SceneId } from "../appearance";

/** Topics explained independently per unlock. Typical review (Fable run, 2026-11-14): 5 questions, 1 independent, so about 3 good reviews per object, not 1 per review. Derek's call. */
export const TOPICS_PER_UNLOCK = 3;
/** Objects a room can grow. #226 draws one painted object per slot. */
export const UNLOCKS_PER_ROOM = 6;

export const ROOM_IDS = ["last-desk", "study-bench", "projection-booth"] as const;
export type RoomId = (typeof ROOM_IDS)[number];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _roomsMatchScenes: Same<RoomId, SceneId> = true;
void _roomsMatchScenes;

/** `${room}/${n}`, n from 1. A slot's id is fixed, so #226 can bind art and a position to it. */
export type UnlockId = `${RoomId}/${number}`;

/** A real count with what it counts, so the UI never shows a bare number. */
export type Count = { readonly value: number; readonly label: string };

/** One saved review that held effort (a `partial` or `after_help` thread): one notebook in the stack. */
export type EffortMark = { readonly reviewId: ReviewId; readonly threads: number };

export type Progress = {
  /** Distinct topics with at least one saved `independent` observation. The only count that grows the room. */
  readonly understood: Count;
  /** Reviews with at least one saved question thread. GET /record carries no list of saved reviews, so a save with zero threads is not visible here and is not counted. */
  readonly reviews: Count;
  /** Saved threads that ended `partial` or `after_help`. Effort, never understanding. */
  readonly effort: Count;
  /** One mark per saved review with effort, in record order. */
  readonly effortMarks: readonly EffortMark[];
  /** Per room, the unlocked slots in slot order. A prefix of the room's slots. */
  readonly unlocks: Readonly<Record<RoomId, readonly UnlockId[]>>;
  /** Topics still to explain independently for the next object, or null once every slot is open. */
  readonly toNextUnlock: Count | null;
};

type Kind = "understood" | "effort" | "nothing";

/** Exhaustive: a new status fails typecheck here until someone decides what it is worth. */
function kindOf(status: RecordedStatus): Kind {
  switch (status) {
    case "independent": return "understood";
    case "partial":
    case "after_help": return "effort";
    case "unresolved":
    case "not_assessed":
    case "looks_fine":
    case "disputed": return "nothing";
  }
}

export function slotIds(room: RoomId): readonly UnlockId[] {
  return Array.from({ length: UNLOCKS_PER_ROOM }, (_, i) => `${room}/${i + 1}` as UnlockId);
}

export function deriveProgress(observations: readonly Observation[]): Progress {
  const topics = new Set<ConceptId>();
  const reviews = new Set<ReviewId>();
  const effortByReview = new Map<ReviewId, number>();
  let effort = 0;
  for (const o of observations) {
    reviews.add(o.reviewId);
    const kind = kindOf(o.status);
    if (kind === "understood") for (const k of o.conceptIds) topics.add(k);
    else if (kind === "effort") {
      effort += 1;
      effortByReview.set(o.reviewId, (effortByReview.get(o.reviewId) ?? 0) + 1);
    }
  }
  const understood = topics.size;
  const open = Math.min(UNLOCKS_PER_ROOM, Math.floor(understood / TOPICS_PER_UNLOCK));
  const unlocks = { "last-desk": slotIds("last-desk").slice(0, open), "study-bench": slotIds("study-bench").slice(0, open), "projection-booth": slotIds("projection-booth").slice(0, open) } satisfies Record<RoomId, readonly UnlockId[]>;
  return {
    understood: { value: understood, label: "topics explained on your own" },
    reviews: { value: reviews.size, label: "reviews with a saved question" },
    effort: { value: effort, label: "questions answered with some help or only in part" },
    effortMarks: [...effortByReview].map(([reviewId, threads]) => ({ reviewId, threads })),
    unlocks,
    toNextUnlock: open >= UNLOCKS_PER_ROOM
      ? null
      : { value: (open + 1) * TOPICS_PER_UNLOCK - understood, label: "more topics explained on your own for the next object" },
  };
}

