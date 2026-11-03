/**
 * Preparation, flow C (W6). Owns: claim_index, concept_index, prep_controls.
 *
 * Claims are keyed by EVIDENCE, not by chunk revision. A chunk revision's claims
 * are the claims of this capture whose cited evidence lies inside the revision's
 * material. When a boundary moves:
 *   - a claim whose evidence is unchanged keeps its ID and its check results
 *     (the check key is a function of claim + cited evidence);
 *   - a claim whose evidence now straddles chunks belongs to neither;
 *   - material the chunk gained goes through a DELTA interpretation that sees
 *     the existing claims as context.
 * That is flow D's "reprocess affected claims only", derived rather than tracked,
 * and it keeps R4 true across boundary moves (the TLC break).
 *
 * R5: "Choosing Later never cancels preparation."
 * This module and the scheduler never import review/, so invite answers are
 * not an input to demand() (test/boundaries.test.ts).
 *
 *   const prep = preparation.prep(chunkRevisionId);   // { finished, supportedCount, claims }
 *   preparation.stopEarly(captureId, ids);             // a fact; cancels by derivation
 *   const usable = preparation.assessableIn(captureId, scope.material);
 */
import type { CaptureId, ChunkRevisionId, ConceptId } from "../../shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkRevision, Claim, Concept, EvidenceBundle, PossibleConfusion, ResourceConnection,
  ResourceSearchState, Seq, SubjectLinkSuggestion,
} from "../../shared/domain";
import type { Material } from "../../shared/time";
import type { Lookup, Task } from "../providers/memo";
import type { Db } from "../db";
import type { WorkItem } from "../scheduler";
import type { PreparationTasks } from "./tasks";

export type Preparation = {
  prep(chunkRevisionId: ChunkRevisionId): ChunkPrep;
  /** Interpretation, claim checks, revisions, rechecks, resource searches still needed. Excludes cancelled scope. */
  demand(captureId: CaptureId): readonly WorkItem[];
  /** Flow C Stop early: one fact. Pending work in these chunks stops being demanded; late results are ignored. */
  stopEarly(captureId: CaptureId, chunkRevisionIds: readonly ChunkRevisionId[]): Seq;
  /** Flow C retry: one fact + memo.clearFailures for these chunks' keys. Re-demands dropped claims. */
  retry(captureId: CaptureId, chunkRevisionIds: readonly ChunkRevisionId[]): Seq;
  claimsIn(captureId: CaptureId, material: Material): readonly Claim[];
  /** The ONLY producer of AssessableClaim outside core.ts. */
  assessableIn(captureId: CaptureId, material: Material): readonly AssessableClaim[];
  concepts(ids: readonly ConceptId[]): readonly Concept[];
  confusions(conceptIds: readonly ConceptId[]): readonly PossibleConfusion[];
  linkSuggestions(conceptIds: readonly ConceptId[]): readonly SubjectLinkSuggestion[];
  /**
   * R6: "A pending resource search never blocks a review that is otherwise ready."
   * A separate query; nothing in prep() or readiness reads it.
   */
  resources(conceptId: ConceptId): { readonly state: ResourceSearchState; readonly connections: readonly ResourceConnection[] };
};

export function createPreparation(db: Db, deps: {
  chunk(id: ChunkRevisionId): ChunkRevision | null;
  currentChunks(captureId: CaptureId): readonly ChunkRevision[];
  bundle(material: Material): EvidenceBundle;
  lookup<I, O>(task: Task<I, O>, input: I): Lookup<O>;
  run<I, O>(task: Task<I, O>, input: I, signal: AbortSignal): Promise<Lookup<O>>;
  clearFailures: (keys: readonly Lookup<unknown>["key"][]) => void;
  tasks: PreparationTasks;
}): Preparation {
  throw new Error("not implemented");
}
