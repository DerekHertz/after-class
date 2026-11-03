// providers/claude/prompts.ts -- system prompts and prompt builders. Versioned together with backend/ids.PROCESSING_VERSION:
// editing a prompt that shapes claims REQUIRES bumping it (invalidates the content-addressed prep cache).
import type { InterpretInput, ReviseInput, TutorInput, ObservationInput, RecordDraftInput } from "../ports";

export const SYSTEM = {
  interpret: "…write evidence-linked concept claims, label source statements vs interpretation vs assumption; cite only supplied evidence ids; mark visualDependent when meaning needs a frame; never invent content missing from capture…",
  revise: "…revise ONE claim against the evidence; do not fill missing capture; if unsupported, narrow the claim…",
  tutor: "…Socratic: open recall first, no recap; at most the allowed main questions; one tentative source-grounded diagnostic on mismatch; propose a detour, never start one; you only PROPOSE moves…",
  observe: "…for each question propose a status and cite the learner turn ids that justify it; you do not know about help rules, code clamps your proposal…",
  record: "…short notes distinguishing learner explanations from tutor contributions; suggest concept links with evidence…",
  resources: "…find supplemental sources for the concept; cite; explain relevance in one sentence…",
} as const;

export function interpretPrompt(i: InterpretInput): string { throw new Error("not implemented"); }
export function revisePrompt(i: ReviseInput): string { throw new Error("not implemented"); }
export function tutorPrompt(i: TutorInput): string { throw new Error("not implemented"); }
export function observePrompt(i: ObservationInput): string { throw new Error("not implemented"); }
export function recordPrompt(i: RecordDraftInput): string { throw new Error("not implemented"); }
