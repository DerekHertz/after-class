/**
 * The diagram summary task: one Claude call per (topic, evidence set), on demand. Prompt and output schema live
 * here, transport lives in providers/claude.ts, and the memo makes it single-flight, cached and ledgered (R17).
 */
import { z } from "zod";
import type { ClaimId, ConceptId, EvidenceId, IdPart } from "../../shared/ids";
import type { DiagramLine, Frame, Passage } from "../../shared/domain";
import { ProviderError } from "../providers/memo";
import type { Task } from "../providers/memo";
import type { ClaudeCli, ClaudeImage } from "../providers/claude";
import { enforceCitations, evidenceIdsOf } from "./core";

export type DiagramSummaryInput = {
  readonly topic: { readonly id: ConceptId; readonly label: string };
  /** Context only: what the lecture's claims say about the topic. Never evidence and never citable. */
  readonly claims: readonly { readonly id: ClaimId; readonly text: string }[];
  readonly passages: readonly Passage[];
  /** The frame shown for the topic comes first. */
  readonly frames: readonly Frame[];
};

export type DiagramSummaryOutput = { readonly title: string; readonly lines: readonly DiagramLine[] };

/** Frame JPEG bytes by evidence ID, or null when the file is gone. */
export type FrameBytes = (id: EvidenceId) => Uint8Array | null;

export function canonicalDiagramSummary(i: DiagramSummaryInput): IdPart {
  return {
    topic: { id: i.topic.id, label: i.topic.label },
    claims: i.claims.map((c) => [c.id, c.text]),
    passages: i.passages.map((p) => p.id),
    frames: i.frames.map((f) => f.id),
  };
}

const MAX_LINES = 8;

const outputSchema = z.object({
  title: z.string().min(1),
  lines: z.array(z.object({ text: z.string().min(1), evidence: z.array(z.string()) })).min(1).max(MAX_LINES),
});

const storedSchema = z.object({
  title: z.string().min(1),
  lines: z.array(z.object({ text: z.string().min(1), evidence: z.tuple([z.string()], z.string()) })),
});

export const DIAGRAM_SYSTEM = `You write a short state-change summary for one topic of a lecture the learner watched, in the style of illustrated lecture notes.

Write:
- title: the topic as a question the lecture answers, in a few words.
- lines: 2 to ${MAX_LINES} short lines saying what changes, in order. Each line is a short delta. Give the concrete values and specifics first, then the general rule. Examples of the form: "Node P: local memory +1, global memory -1", "Boundary moves DOWN", "t = 3: clock A reads 5, clock B reads 2", then "Rule: a receive is always later than its send".

Rules:
- Say only what the cited evidence states or shows. Never fill a gap, never add a value, step or rule the evidence does not give. If the evidence supports fewer lines, write fewer lines.
- Every line cites the passage or frame IDs it comes from, listed in its evidence field. A line you cannot cite is not written.
- Cite only the IDs listed below (passage IDs and frame IDs). Never invent an ID. Claims are context for the topic, not evidence, and cannot be cited.
- Frames are attached as images labelled with their ID. Read the board or slide itself: what is written, drawn or changed on it.
- Plain words, no filler, no praise, no questions.`;

function describe(input: DiagramSummaryInput, bytes: FrameBytes): { readonly text: string; readonly images: ClaudeImage[] } {
  const images: ClaudeImage[] = [];
  const frames = input.frames.map((f) => {
    const jpeg = bytes(f.id);
    if (jpeg) images.push({ label: f.id, mediaType: "image/jpeg", bytes: jpeg });
    return `- ${f.id} at ${f.mediaS.toFixed(1)}s${jpeg ? " (image attached, labelled with this ID)" : " (image unavailable; do not cite for visual content)"}`;
  });
  const text = [
    `Topic: ${input.topic.label}`,
    "Claims the lecture supports about this topic (context, not evidence):",
    ...(input.claims.length > 0 ? input.claims.map((c) => `- ${c.text}`) : ["- none"]),
    "Passages:",
    ...(input.passages.length > 0 ? input.passages.map((p) => `- ${p.id} [${p.interval.start.toFixed(1)}s-${p.interval.end.toFixed(1)}s] ${p.text}`) : ["- none"]),
    "Frames:",
    ...(frames.length > 0 ? frames : ["- none"]),
  ].join("\n");
  return { text, images };
}

/**
 * R19: "Every line of a diagram summary cites something I watched; a line without a citation is never shown."
 * Lines are filtered here before anything is stored; the reader filters again, so a stored output can never show an
 * uncited or out-of-scope line. Nothing left is a retryable failure.
 */
export function diagramSummaryTask(claude: ClaudeCli, frameBytes: FrameBytes): Task<DiagramSummaryInput, DiagramSummaryOutput> {
  return {
    provider: "claude",
    purpose: "diagram_summary",
    model: "opus",
    version: "diagram-summary-v1",
    maxAttempts: 2,
    canonicalInput: canonicalDiagramSummary,
    async attempt(input, ctx) {
      const evidence = describe(input, frameBytes);
      const { output, usage } = await claude.structured(
        { model: "opus", effort: "high", system: DIAGRAM_SYSTEM, prompt: evidence.text, images: evidence.images, webTools: false, timeoutMs: 600_000 },
        outputSchema,
        ctx.signal,
      );
      const lines = enforceCitations(output.lines, evidenceIdsOf({ passages: input.passages, frames: input.frames }));
      if (lines.length === 0) throw new ProviderError("no summary line cites the topic's evidence", usage, true);
      return { output: { title: output.title.trim(), lines }, usage };
    },
    decode: (stored) => storedSchema.parse(stored) as unknown as DiagramSummaryOutput,
  };
}
