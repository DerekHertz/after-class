/**
 * The finished-review summary, built only from what the backend returns for a saved review: its topics, turns and
 * persisted observations. Nothing here calls a provider or guesses a status. A topic with no saved observation was never
 * asked about, so it is listed as not reached; "Not assessed" is kept for a question that was skipped or left unanswered (R13).
 */
import type { Observation, RecordedStatus, ReviewView } from "../shared/domain";
import type { EvidenceId } from "../shared/ids";
import { moveEvidence, STATUS_LABEL } from "./core";

export type OutcomeGroup = "independent" | "with_help" | "looks_fine" | "supported" | "unresolved" | "disputed" | "not_assessed" | "not_reached";

/** Display order: what the learner did, then what is left to revisit, then topics nobody asked about. */
export const OUTCOME_GROUPS: readonly OutcomeGroup[] = ["independent", "with_help", "looks_fine", "supported", "unresolved", "disputed", "not_assessed", "not_reached"];

export const NOT_REACHED = "Not reached in this review";

export const OUTCOME_HEADING: Readonly<Record<OutcomeGroup, string>> = {
  independent: "Explained on your own",
  with_help: "Explained in part or with help",
  looks_fine: "Quick check looked fine, not recorded as understood",
  supported: "You marked your explanation as supported",
  unresolved: "Still unresolved",
  disputed: "Disputed, waiting for you to settle",
  not_assessed: "Not assessed",
  not_reached: NOT_REACHED,
};

const GROUP_OF: Readonly<Record<RecordedStatus, OutcomeGroup>> = {
  independent: "independent",
  partial: "with_help",
  after_help: "with_help",
  looks_fine: "looks_fine",
  unresolved: "unresolved",
  disputed: "disputed",
  not_assessed: "not_assessed",
};

export type OutcomeItem = {
  readonly key: string;
  readonly label: string;
  /** The saved status. Empty for a topic with no saved observation: its group heading already says it was not reached. */
  readonly status: string;
  /** Lecture evidence the tutor cited in this question's thread, for the next revisit. Empty when none was cited. */
  readonly evidence: readonly EvidenceId[];
  /** How the learner settled a dispute on this item, or null when they did not. */
  readonly resolution: string | null;
};

const RESOLUTION: Readonly<Record<"learner_was_right" | "it_was_my_gap", string>> = {
  learner_was_right: "You marked your explanation as supported",
  it_was_my_gap: "You chose to revisit this",
};

/**
 * R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
 * The backend keeps the tutor's gap status on an observation the learner settled as supported, so the summary
 * moves it out of the revisit groups and shows that status only as the tutor's assessment.
 */
function groupOf(o: Observation): OutcomeGroup {
  const supported = o.dispute.kind === "resolved_by_learner" && o.dispute.outcome === "learner_was_right";
  return supported && (o.status === "partial" || o.status === "unresolved") ? "supported" : GROUP_OF[o.status];
}

export type Completion = {
  readonly groups: readonly { readonly group: OutcomeGroup; readonly heading: string; readonly items: readonly OutcomeItem[] }[];
  /** Topics to start with next time: unresolved first, then those explained in part or with help. */
  readonly revisit: readonly string[];
  readonly disputed: number;
  readonly observations: number;
  /** Topics the review's questions named (any status, a skipped one included), out of every topic in its scope. */
  readonly topicsAsked: number;
  readonly topicsInScope: number;
};

export function completionOf(view: Pick<ReviewView, "topics" | "turns" | "observations">): Completion {
  const labels = new Map(view.topics.map((t) => [t.id, t.label] as const));
  const items = new Map<OutcomeGroup, OutcomeItem[]>(OUTCOME_GROUPS.map((g) => [g, []]));
  const seen = new Set<string>();

  for (const o of view.observations) {
    const named = o.conceptIds.flatMap((id) => labels.get(id) ?? []);
    for (const id of o.conceptIds) seen.add(id);
    const evidence = [...new Set(view.turns.flatMap((t) => (t.actor === "tutor" && t.threadId === o.threadId ? moveEvidence(t.move) : [])))];
    const group = groupOf(o);
    items.get(group)!.push({
      key: o.id,
      label: named.length > 0 ? named.join(" · ") : "A question in this review",
      status: group === "supported" ? `The tutor assessed it as ${STATUS_LABEL[o.status]}` : STATUS_LABEL[o.status],
      evidence,
      resolution: o.dispute.kind === "resolved_by_learner" ? RESOLUTION[o.dispute.outcome] : null,
    });
  }
  for (const t of view.topics) {
    if (!seen.has(t.id)) items.get("not_reached")!.push({ key: t.id, label: t.label, status: "", evidence: [], resolution: null });
  }

  const labelsIn = (g: OutcomeGroup) => items.get(g)!.map((i) => i.label);
  return {
    groups: OUTCOME_GROUPS.filter((g) => items.get(g)!.length > 0).map((g) => ({ group: g, heading: OUTCOME_HEADING[g], items: items.get(g)! })),
    revisit: [...new Set([...labelsIn("unresolved"), ...labelsIn("with_help")])],
    disputed: items.get("disputed")!.length,
    observations: view.observations.length,
    topicsAsked: view.topics.filter((t) => seen.has(t.id)).length,
    topicsInScope: view.topics.length,
  };
}
