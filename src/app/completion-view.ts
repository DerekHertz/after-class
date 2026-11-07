/**
 * The finished-review summary, built only from what the backend returns for a saved review: its topics, turns and
 * persisted observations. Nothing here calls a provider or guesses a status; a topic with no saved observation is
 * shown as not assessed.
 */
import type { RecordedStatus, ReviewView } from "../shared/domain";
import type { EvidenceId } from "../shared/ids";
import { moveEvidence, STATUS_LABEL } from "./core";

export type OutcomeGroup = "independent" | "with_help" | "looks_fine" | "unresolved" | "disputed" | "not_assessed";

/** Display order: what the learner did, then what is left to revisit. */
export const OUTCOME_GROUPS: readonly OutcomeGroup[] = ["independent", "with_help", "looks_fine", "unresolved", "disputed", "not_assessed"];

export const OUTCOME_HEADING: Readonly<Record<OutcomeGroup, string>> = {
  independent: "Explained on your own",
  with_help: "Explained in part or with help",
  looks_fine: "Quick check looked fine, not recorded as understood",
  unresolved: "Still unresolved",
  disputed: "Disputed, waiting for you to settle",
  not_assessed: "Not assessed",
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

export const NOT_REACHED = "Not reached in this review";

export type OutcomeItem = {
  readonly key: string;
  readonly label: string;
  /** The saved status, or NOT_REACHED for a topic with no saved observation. */
  readonly status: string;
  /** Lecture evidence the tutor cited in this question's thread, for the next revisit. Empty when none was cited. */
  readonly evidence: readonly EvidenceId[];
};

export type Completion = {
  readonly groups: readonly { readonly group: OutcomeGroup; readonly heading: string; readonly items: readonly OutcomeItem[] }[];
  /** Topics to start with next time: unresolved first, then those explained in part or with help. */
  readonly revisit: readonly string[];
  readonly disputed: number;
  readonly observations: number;
};

export function completionOf(view: Pick<ReviewView, "topics" | "turns" | "observations">): Completion {
  const labels = new Map(view.topics.map((t) => [t.id, t.label] as const));
  const items = new Map<OutcomeGroup, OutcomeItem[]>(OUTCOME_GROUPS.map((g) => [g, []]));
  const seen = new Set<string>();

  for (const o of view.observations) {
    const named = o.conceptIds.flatMap((id) => labels.get(id) ?? []);
    for (const id of o.conceptIds) seen.add(id);
    const evidence = [...new Set(view.turns.flatMap((t) => (t.actor === "tutor" && t.threadId === o.threadId ? moveEvidence(t.move) : [])))];
    items.get(GROUP_OF[o.status])!.push({ key: o.id, label: named.length > 0 ? named.join(" · ") : "A question in this review", status: STATUS_LABEL[o.status], evidence });
  }
  for (const t of view.topics) {
    if (!seen.has(t.id)) items.get("not_assessed")!.push({ key: t.id, label: t.label, status: NOT_REACHED, evidence: [] });
  }

  const labelsIn = (g: OutcomeGroup) => items.get(g)!.map((i) => i.label);
  return {
    groups: OUTCOME_GROUPS.filter((g) => items.get(g)!.length > 0).map((g) => ({ group: g, heading: OUTCOME_HEADING[g], items: items.get(g)! })),
    revisit: [...new Set([...labelsIn("unresolved"), ...labelsIn("with_help")])],
    disputed: items.get("disputed")!.length,
    observations: view.observations.length,
  };
}
