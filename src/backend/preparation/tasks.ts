/**
 * Claude tasks for preparation (W6): prompts and output schemas live here,
 * transport lives in providers/claude.ts. Each is a memo Task.
 */
import { z } from "zod";
import { stableId } from "../../shared/ids";
import type { ChunkRevisionId, ClaimId, EvidenceId, IdPart } from "../../shared/ids";
import type {
  AssessableClaim, ClaimDraft, Concept, EvidenceBundle, LinkType, NonEmpty, ResourceConnection, SubjectLinkSuggestion, Verdict,
} from "../../shared/domain";
import { ProviderError } from "../providers/memo";
import type { Task, UsageReport } from "../providers/memo";
import type { ClaimSupportInput } from "../providers/jev-tasks";
import type { ClaudeCli, ClaudeImage, ClaudeRequest } from "../providers/claude";

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

/** Frame JPEG bytes by evidence ID, or null when the file is gone. Wired by main.ts to evidence.frameBytes. */
export type FrameBytes = (id: EvidenceId) => Uint8Array | null;

// ───────────────────────────── canonical inputs (what each call sees) ───────

function draftPart(d: ClaimDraft): IdPart {
  return { text: d.text, evidence: [...d.evidence], visualDependent: d.visualDependent, assumptions: [...d.assumptions] };
}

function bundlePart(b: EvidenceBundle): IdPart {
  return {
    passages: b.passages.map((p) => p.id),
    frames: b.frames.map((f) => f.id),
    gaps: b.gaps.map((g) => [g.sourceId, g.channel, g.reason, g.interval.start, g.interval.end]),
  };
}

/** Evidence IDs are content hashes, so hashing IDs is hashing what the model reads. */
export function canonicalInterpretation(i: InterpretationInput): IdPart {
  return { chunkRevisionId: i.chunkRevisionId, material: bundlePart(i.newMaterial), existing: i.existingClaims.map((c) => [c.id, c.text]) };
}

export function canonicalRevision(i: RevisionInput): IdPart {
  return { original: draftPart(i.original), check: { verdict: i.check.verdict, p: i.check.p }, evidence: bundlePart(i.evidence) };
}

export function canonicalResourceSearch(i: ResourceSearchInput): IdPart {
  return {
    concept: { id: i.concept.id, label: i.concept.label, summary: i.concept.summary },
    claims: i.supportedClaims.map((c) => [c.id, c.text, [...c.evidence]]),
  };
}

// ───────────────────────────── output schemas ───────────────────────────────

const LINK_TYPES = ["prerequisite_of", "part_of", "example_of", "contrasts_with", "related_to"] as const satisfies readonly LinkType[];

const draftSchema = z.object({
  text: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  visualDependent: z.boolean(),
  assumptions: z.array(z.string()),
});

const interpretationSchema = z.object({
  concepts: z.array(z.object({
    label: z.string().min(1),
    summary: z.string(),
    claims: z.array(draftSchema),
    confusions: z.array(z.object({ text: z.string().min(1), evidence: z.array(z.string()) })),
  })),
  links: z.array(z.object({
    fromLabel: z.string().min(1),
    toLabel: z.string().min(1),
    type: z.enum(LINK_TYPES),
    evidence: z.array(z.string()),
    rationale: z.string(),
  })),
  supersedes: z.array(z.object({ claimId: z.string(), reason: z.string() })),
});

const resourceSchema = z.object({
  resources: z.array(z.object({
    url: z.string(),
    title: z.string().min(1),
    relevance: z.string().min(1),
    supportingPassages: z.array(z.string()),
  })),
});

type RawDraft = z.infer<typeof draftSchema>;

/** Every ID the model returns must be one it was shown; anything else is a retryable bad output. */
function knownIds(allowed: ReadonlySet<string>, ids: readonly string[], what: string, usage: UsageReport): EvidenceId[] {
  const unknown = ids.filter((id) => !allowed.has(id));
  if (unknown.length > 0) throw new ProviderError(`${what} cites unknown evidence: ${unknown.join(", ")}`, usage, true);
  return ids as EvidenceId[];
}

function toDraft(raw: RawDraft, allowed: ReadonlySet<string>, usage: UsageReport): ClaimDraft {
  const evidence = knownIds(allowed, raw.evidence, `claim "${raw.text}"`, usage);
  return { text: raw.text, evidence: evidence as unknown as NonEmpty<EvidenceId>, visualDependent: raw.visualDependent, assumptions: raw.assumptions };
}

function bundleIds(b: EvidenceBundle): ReadonlySet<string> {
  return new Set<string>([...b.passages.map((p) => p.id), ...b.frames.map((f) => f.id)]);
}

// ───────────────────────────── prompts ──────────────────────────────────────

const EVIDENCE_RULES = `Evidence rules:
- Cite evidence only by the IDs listed (passage IDs and frame IDs). Never invent an ID.
- Gaps are intervals where capture is missing. They are not evidence. Never fill them or guess what was said or shown there.
- A claim must be supported by the evidence it cites, in its stated scope. Narrow the claim rather than overreach.
- Anything the claim relies on that the evidence does not state goes in its assumptions list, labelled as an assumption.
- If a claim depends on what was shown on screen (board work, a diagram, an equation, code), set visualDependent to true and cite at least one frame ID.`;

function describeEvidence(b: EvidenceBundle, gaps: EvidenceBundle["gaps"], bytes: FrameBytes): { readonly text: string; readonly images: ClaudeImage[] } {
  const images: ClaudeImage[] = [];
  const frames = b.frames.map((f) => {
    const jpeg = bytes(f.id);
    if (jpeg) images.push({ label: f.id, mediaType: "image/jpeg", bytes: jpeg });
    return `- ${f.id} at ${f.mediaS.toFixed(1)}s${jpeg ? " (image attached, labelled with this ID)" : " (image unavailable; do not cite for visual content)"}`;
  });
  const text = [
    "Passages:",
    ...b.passages.map((p) => `- ${p.id} [${p.interval.start.toFixed(1)}s–${p.interval.end.toFixed(1)}s] ${p.text}`),
    "Frames:",
    ...(frames.length > 0 ? frames : ["- none"]),
    "Gaps (missing capture, never to be filled):",
    ...(gaps.length > 0 ? gaps.map((g) => `- ${g.channel} ${g.reason} [${g.interval.start.toFixed(1)}s–${g.interval.end.toFixed(1)}s]`) : ["- none"]),
  ].join("\n");
  return { text, images };
}

function request(system: string, prompt: string, images: readonly ClaudeImage[], opts: { effort: ClaudeRequest["effort"]; webTools: boolean }): ClaudeRequest {
  return { model: "opus", effort: opts.effort, system, prompt, images, webTools: opts.webTools, timeoutMs: 600_000 };
}

const INTERPRET_SYSTEM = `You prepare one chunk of a lecture the learner watched for a later Socratic review. You write the concepts the chunk teaches, as claims tied to evidence.

${EVIDENCE_RULES}

Write for each concept: a short label, a one-sentence summary, its claims, and possible confusions (misunderstandings a learner could plausibly form from this material, each citing the evidence it arises from).
Links relate two concepts by label (prerequisite_of, part_of, example_of, contrasts_with, related_to), citing evidence and a one-sentence rationale.
Existing claims come from earlier material of the same lecture. Do not restate them. If the new material qualifies or corrects one, list its ID under supersedes with the reason. Otherwise leave supersedes empty.`;

const INTERPRET_VERSION = "interpret-v1";

/** System prompt states gaps are missing capture, never to be filled; claims cite evidence IDs only. */
export function interpretTask(claude: ClaudeCli, frameBytes: FrameBytes): Task<InterpretationInput, InterpretationOutput> {
  return {
    provider: "claude",
    purpose: "interpretation",
    model: "opus",
    version: INTERPRET_VERSION,
    maxAttempts: 2,
    canonicalInput: canonicalInterpretation,
    async attempt(input, ctx) {
      const evidence = describeEvidence(input.newMaterial, input.gaps, frameBytes);
      const existing = input.existingClaims.length > 0 ? input.existingClaims.map((c) => `- ${c.id}: ${c.text}`).join("\n") : "- none";
      const prompt = `${evidence.text}\n\nExisting claims:\n${existing}`;
      const { output, usage } = await claude.structured(request(INTERPRET_SYSTEM, prompt, evidence.images, { effort: "high", webTools: false }), interpretationSchema, ctx.signal);
      return { output: toInterpretation(output, bundleIds(input.newMaterial), new Set(input.existingClaims.map((c) => c.id)), usage), usage };
    },
    decode: (stored) => {
      const raw = interpretationSchema.parse(stored);
      return raw as unknown as InterpretationOutput;
    },
  };
}

function toInterpretation(raw: z.infer<typeof interpretationSchema>, allowed: ReadonlySet<string>, existing: ReadonlySet<string>, usage: UsageReport): InterpretationOutput {
  const unknownClaims = raw.supersedes.filter((s) => !existing.has(s.claimId));
  if (unknownClaims.length > 0) throw new ProviderError(`supersedes unknown claims: ${unknownClaims.map((s) => s.claimId).join(", ")}`, usage, true);
  return {
    concepts: raw.concepts.map((c) => ({
      label: c.label,
      summary: c.summary,
      claims: c.claims.map((d) => toDraft(d, allowed, usage)),
      confusions: c.confusions.map((x) => ({ text: x.text, evidence: knownIds(allowed, x.evidence, "confusion", usage) })),
    })),
    links: raw.links.map((l) => ({ ...l, evidence: knownIds(allowed, l.evidence, "link", usage) })),
    supersedes: raw.supersedes.map((s) => ({ claimId: s.claimId as ClaimId, reason: s.reason })),
  };
}

const REVISE_SYSTEM = `An evidence check found that a claim about a lecture is not supported, in its stated scope, by the evidence it cites. Revise once against the evidence; never fill missing capture.

${EVIDENCE_RULES}

Return one revised claim. Keep what the evidence supports and drop or narrow the rest, fix its citations, and move anything the evidence does not state into assumptions. Do not add content from outside the evidence.`;

/** "Revise once against the evidence; never fill missing capture." */
export function reviseTask(claude: ClaudeCli, frameBytes: FrameBytes): Task<RevisionInput, ClaimDraft> {
  return {
    provider: "claude",
    purpose: "claim_revision",
    model: "opus",
    version: "revise-v1",
    maxAttempts: 2,
    canonicalInput: canonicalRevision,
    async attempt(input, ctx) {
      const evidence = describeEvidence(input.evidence, input.evidence.gaps, frameBytes);
      const o = input.original;
      const prompt = [
        evidence.text,
        "",
        `Original claim: ${o.text}`,
        `Cited: ${o.evidence.join(", ")}`,
        `Visual-dependent: ${o.visualDependent}`,
        `Assumptions: ${o.assumptions.length > 0 ? o.assumptions.join("; ") : "none"}`,
        `Check verdict: ${input.check.verdict}${input.check.p === null ? "" : ` (p = ${input.check.p.toFixed(2)})`}`,
      ].join("\n");
      const { output, usage } = await claude.structured(request(REVISE_SYSTEM, prompt, evidence.images, { effort: "high", webTools: false }), draftSchema, ctx.signal);
      return { output: toDraft(output, bundleIds(input.evidence), usage), usage };
    },
    decode: (stored) => draftSchema.parse(stored) as unknown as ClaimDraft,
  };
}

const RESOURCE_SYSTEM = `Find a few supplemental resources (at most 4) that help a learner who just watched a lecture on this concept. Use web search; return only URLs you actually found. Prefer primary, authoritative and freely readable sources: textbooks, course notes, papers, official documentation.
For each: the URL, its title, one sentence on how it relates to the lecture's claims, and the passage IDs (from the claims' evidence) it supplements.`;

/** `claude -p` with WebSearch/WebFetch tools only for this task; lowest scheduler priority. */
export function resourceSearchTask(claude: ClaudeCli): Task<ResourceSearchInput, readonly ResourceConnection[]> {
  return {
    provider: "claude",
    purpose: "resource_search",
    model: "opus",
    version: "resources-v1",
    maxAttempts: 2,
    canonicalInput: canonicalResourceSearch,
    async attempt(input, ctx) {
      const prompt = [
        `Concept: ${input.concept.label}`,
        `Summary: ${input.concept.summary}`,
        "Claims the lecture supports:",
        ...input.supportedClaims.map((c) => `- ${c.text} (evidence: ${c.evidence.join(", ")})`),
      ].join("\n");
      const { output, usage } = await claude.structured(request(RESOURCE_SYSTEM, prompt, [], { effort: "medium", webTools: true }), resourceSchema, ctx.signal);
      return { output: toConnections(output, input), usage };
    },
    decode: (stored) => z.array(connectionSchema).parse(stored) as unknown as readonly ResourceConnection[],
  };
}

const connectionSchema = z.object({
  id: z.string(),
  conceptId: z.string(),
  url: z.string(),
  title: z.string(),
  provenance: z.enum(["user_provided", "lecturer_linked", "web_search"]),
  relevance: z.string(),
  supportingPassages: z.array(z.string()),
});

/** Keeps http(s) links only and the passage citations the claims actually carry. */
function toConnections(raw: z.infer<typeof resourceSchema>, input: ResourceSearchInput): ResourceConnection[] {
  const cited = new Set<string>(input.supportedClaims.flatMap((c) => c.evidence));
  return raw.resources.flatMap((r) => {
    if (!URL.canParse(r.url) || !["http:", "https:"].includes(new URL(r.url).protocol)) return [];
    return [{
      id: stableId("res", input.concept.id, r.url),
      conceptId: input.concept.id,
      url: r.url,
      title: r.title,
      provenance: "web_search" as const,
      relevance: r.relevance,
      supportingPassages: r.supportingPassages.filter((id) => cited.has(id)) as EvidenceId[],
    }];
  });
}
