/**
 * Claude tasks for preparation (W6): prompts and output schemas live here,
 * transport lives in providers/claude.ts. Each is a memo Task.
 */
import type { ChunkRevisionId, ClaimId, EvidenceId } from "../../shared/ids";
import type { AssessableClaim, ClaimDraft, Concept, EvidenceBundle, ResourceConnection, SubjectLinkSuggestion, Verdict } from "../../shared/domain";
import type { Task } from "../providers/memo";
import type { ClaimSupportInput } from "../providers/jev-tasks";
import type { ClaudeCli } from "../providers/claude";

export type InterpretationInput = {
  readonly chunkRevisionId: ChunkRevisionId;
  readonly newMaterial: EvidenceBundle; // only the uninterpreted part
  readonly existingClaims: readonly { readonly id: ClaimId; readonly text: string }[]; // context for delta calls
  readonly gaps: EvidenceBundle["gaps"]; // stated to the model so it doesn't fill them
};

/** zod-validated structured output; code then checks every evidence ID is in newMaterial. */
export type InterpretationOutput = {
  readonly concepts: readonly {
    readonly label: string;
    readonly summary: string;
    readonly claims: readonly ClaimDraft[];
    readonly confusions: readonly { readonly text: string; readonly evidence: readonly EvidenceId[] }[];
  }[];
  readonly links: readonly { readonly fromLabel: string; readonly toLabel: string; readonly type: SubjectLinkSuggestion["type"]; readonly evidence: readonly EvidenceId[]; readonly rationale: string }[];
  /** Existing claims that later context qualifies: the source of correction disclosures. */
  readonly supersedes: readonly { readonly claimId: ClaimId; readonly reason: string }[];
};

/**
 * R4: "A claim gets at most one revision; after that it's unverified."
 * The input is always the ORIGINAL draft and its check, never a revision, so
 * a second revision has no key to be stored under.
 */
export type RevisionInput = {
  readonly original: ClaimDraft;
  readonly check: { readonly verdict: Verdict; readonly p: number | null };
  readonly evidence: EvidenceBundle; // the chunk's evidence; the revision may cite only these IDs
};

export type ResourceSearchInput = { readonly concept: Concept; readonly supportedClaims: readonly AssessableClaim[] };

export type PreparationTasks = {
  readonly interpret: Task<InterpretationInput, InterpretationOutput>;
  readonly revise: Task<RevisionInput, ClaimDraft>;
  readonly checkClaim: Task<ClaimSupportInput, { readonly verdict: Verdict; readonly p: number | null }>;
  readonly searchResources: Task<ResourceSearchInput, readonly ResourceConnection[]>;
};

/** TODO: system prompt states gaps are missing capture, never to be filled; claims cite evidence IDs only. */
export function interpretTask(claude: ClaudeCli): Task<InterpretationInput, InterpretationOutput> {
  throw new Error("not implemented");
}

/** TODO: "Revise once against the evidence; never fill missing capture." */
export function reviseTask(claude: ClaudeCli): Task<RevisionInput, ClaimDraft> {
  throw new Error("not implemented");
}

/** TODO: `claude -p` with WebSearch/WebFetch tools only for this task; lowest scheduler priority. */
export function resourceSearchTask(claude: ClaudeCli): Task<ResourceSearchInput, readonly ResourceConnection[]> {
  throw new Error("not implemented");
}
