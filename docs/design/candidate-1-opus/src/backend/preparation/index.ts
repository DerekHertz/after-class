/**
 * Preparation (flow C). Owns: claim_index, prep_controls (stop-early / retry facts).
 *
 * Claims are keyed by EVIDENCE, not by chunk revision. A chunk revision's claims
 * are the claims (from any interpretation in this capture) whose cited evidence
 * lies inside the revision's material. So when a boundary moves:
 *   - a claim whose evidence is unchanged keeps its ID and its check results
 *     (the check's memo key is a function of claim + cited evidence; same
 *     inputs, same answer, no re-check);
 *   - a claim whose evidence now straddles chunks belongs to neither ("affected");
 *   - material the chunk gained is interpreted by a DELTA interpretation call
 *     that sees the existing claims as context.
 * That is flow D's "reprocess affected claims only", derived rather than tracked.
 *
 * Claim status is DERIVED (see deriveClaimStatus). Nothing stores it.
 *
 * Usage:
 *   const prep = preparation.prep(chunkRevisionId);   // { finished, supportedCount, claims }
 *   preparation.stopEarly(ids);                        // a fact; cancels by derivation
 *   const usable = preparation.assessableIn(scope.material, captureId);   // AssessableClaim[] (R3)
 */
import type { CaptureId, ChunkRevisionId, ClaimId, ConceptId, EvidenceId } from "../../shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkRevision, Claim, ClaimDraft, ClaimLineage, ClaimStatus, Concept,
  EvidenceBundle, PossibleConfusion, ResourceConnection, ResourceSearchState, Seq, SubjectLinkSuggestion, Verdict,
} from "../../shared/domain";
import type { Material } from "../../shared/time";
import type { Lookup, Task } from "../providers/memo";
import type { Db, ModuleSchema } from "../db";
import type { WorkItem } from "../scheduler";

export const preparationSchema: ModuleSchema = { module: "preparation", version: 1, ddl: [/* claim_index, prep_controls */] };

export type Preparation = {
  prep(chunkRevisionId: ChunkRevisionId): ChunkPrep;
  /** Interpretation, claim checks, revisions, rechecks, resource searches still needed. Excludes cancelled scope. */
  demand(captureId: CaptureId): readonly WorkItem[];
  /** Flow C Stop early: one fact. Pending work in these chunks stops being demanded; late results are ignored. */
  stopEarly(chunkRevisionIds: readonly ChunkRevisionId[]): Seq;
  /** Flow C retry: one fact + memo.clearFailures for these chunks' keys. Re-demands dropped claims. */
  retry(chunkRevisionIds: readonly ChunkRevisionId[]): Seq;
  claimsIn(captureId: CaptureId, material: Material): readonly Claim[];
  /** R3: the ONLY producer of AssessableClaim. */
  assessableIn(captureId: CaptureId, material: Material): readonly AssessableClaim[];
  concepts(ids: readonly ConceptId[]): readonly Concept[];
  confusions(conceptIds: readonly ConceptId[]): readonly PossibleConfusion[];
  linkSuggestions(conceptIds: readonly ConceptId[]): readonly SubjectLinkSuggestion[];
  /** R6: separate query; nothing in prep()/readiness reads it. */
  resources(conceptId: ConceptId): { state: ResourceSearchState; connections: readonly ResourceConnection[] };
};

export function createPreparation(db: Db, deps: {
  chunk(id: ChunkRevisionId): ChunkRevision | null;
  currentChunks(captureId: CaptureId): readonly ChunkRevision[];
  bundle(material: Material): EvidenceBundle;
  lookup<I, O>(task: Task<I, O>, input: I): Lookup<O>;
  tasks: PreparationTasks;
}): Preparation {
  throw new Error("not implemented");
}

// ───────────────────────── Claude tasks (preparation/tasks.ts) ──────────────

export type InterpretationInput = {
  readonly chunkRevisionId: ChunkRevisionId;
  readonly newMaterial: EvidenceBundle; // only the uninterpreted part
  readonly existingClaims: readonly { id: ClaimId; text: string }[]; // context for delta calls
  readonly gaps: EvidenceBundle["gaps"]; // stated to the model so it doesn't fill them
};

/** zod-validated structured output; code then checks every evidence ID is in newMaterial. */
export type InterpretationOutput = {
  readonly concepts: readonly { label: string; summary: string; claims: readonly ClaimDraft[]; confusions: readonly { text: string; evidence: readonly EvidenceId[] }[] }[];
  readonly links: readonly { fromLabel: string; toLabel: string; type: SubjectLinkSuggestion["type"]; evidence: readonly EvidenceId[]; rationale: string }[];
  readonly supersedes: readonly { claimId: ClaimId; reason: string }[]; // existing claims later context qualifies (correction source)
};

export type RevisionInput = {
  readonly original: ClaimDraft;
  readonly check: { verdict: Verdict; p: number | null };
  readonly evidence: EvidenceBundle; // the chunk's evidence; the revision may cite only these IDs
};

export type ResourceSearchInput = { readonly concept: Concept; readonly supportedClaims: readonly AssessableClaim[] };

export type PreparationTasks = {
  readonly interpret: Task<InterpretationInput, InterpretationOutput>;
  readonly revise: Task<RevisionInput, ClaimDraft>;
  readonly checkClaim: Task<import("../providers/jev-tasks").ClaimSupportInput, { verdict: Verdict; p: number | null }>;
  readonly searchResources: Task<ResourceSearchInput, readonly ResourceConnection[]>;
};

// ───────────────────────── pure core (preparation/core.ts) ──────────────────

/** Code-side validity before any Jev call: refs exist, lie in the chunk, visual ⇒ cites a frame. */
export function validateDraft(draft: ClaimDraft, chunk: EvidenceBundle): { ok: true } | { ok: false; why: string } {
  throw new Error("not implemented");
}

export type CheckLookups = {
  readonly originalCheck: Lookup<{ verdict: Verdict; p: number | null }> | { kind: "invalid_refs" };
  readonly revision: Lookup<ClaimDraft> | null; // null until originalCheck is terminal-and-not-yes
  readonly revisionCheck: Lookup<{ verdict: Verdict; p: number | null }> | { kind: "invalid_refs" } | null;
};

/**
 * R3/R4/R8 in one pure function.
 *
 * `cutoff` = Seq of the latest stop-early covering this claim's chunk that is not
 * followed by a retry covering it (null if none). A result counts only if
 * its atSeq < cutoff — so a late result from a cancelled job is stored but never applied.
 *
 *   counts(r)     = r is hit|failed ∧ (cutoff = null ∨ r.atSeq < cutoff)
 *   pending(next) = cutoff ? "dropped" : next
 *
 *   c1 = originalCheck            (invalid_refs counts as verdict "no", no Jev call made)
 *   !counts(c1)                    → pending("awaiting_check")
 *   c1 yes                         → "supported_by_check"
 *   rv = revision                  (input is ALWAYS the original draft + c1 ⇒ exactly one revision exists, R4)
 *   !counts(rv)                    → pending("awaiting_revision")
 *   rv failed                      → "unverified"   (no second revision attempt)
 *   c2 = revisionCheck(rv.value)
 *   !counts(c2)                    → pending("awaiting_recheck")
 *   c2 yes ? "supported_by_check" : "unverified"   (no / uncertain / failed ⇒ unverified)
 */
export function deriveClaimStatus(lookups: CheckLookups, cutoff: Seq | null): ClaimStatus {
  throw new Error("not implemented");
}

/** R3 constructor. Returns null unless status is supported_by_check. */
export function assessable(claim: Claim): AssessableClaim | null {
  throw new Error("not implemented");
}

/** Interpretation terminal ∧ every member claim terminal (supported | unverified | dropped). */
export function isFinished(prep: Omit<ChunkPrep, "finished">): boolean {
  throw new Error("not implemented");
}

export type { ClaimLineage };
