/**
 * Pure record bundle (W8). Importable only by record/ and test/.
 */
import type { EvidenceId, ReviewId } from "../../shared/ids";
import type { AssessableClaim, Note, Observation, SubjectLinkSuggestion, Turn } from "../../shared/domain";
import type { WrapUpOutput } from "../review/tutor";

export type RecordBundle = {
  readonly hash: string;
  readonly notes: readonly Omit<Note, "userEdit">[];
  readonly observations: readonly Omit<Observation, "status" | "clampedFrom" | "dispute" | "corrections">[];
  readonly links: readonly SubjectLinkSuggestion[];
  readonly evidence: readonly EvidenceId[];
};

/**
 * R15: "Retrying a save never creates a duplicate record."
 * Same inputs, same bundle, same IDs, same hash.
 * Learner segments are VERBATIM learner turn text (author "learner", turnId
 * set); tutor segments come from the wrap-up summary (author "tutor"); cited
 * source passages are author "source". Attribution is structural, not something
 * the model labels.
 */
export function buildBundle(reviewId: ReviewId, turns: readonly Turn[], claims: readonly AssessableClaim[], wrapUp: WrapUpOutput): RecordBundle {
  throw new Error("not implemented");
}
