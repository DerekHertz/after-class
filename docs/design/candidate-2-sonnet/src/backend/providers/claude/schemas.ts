// providers/claude/schemas.ts -- zod schemas for every structured Claude output. The adapter parses with these, then maps to
// DOMAIN types (core/claimMachine etc. never see these). Field order matters for tutor: `say` first for streaming.
import { z } from "zod";
import { LabeledText } from "../../../shared/domain/claim";
import { EvidenceId, QuestionId, TurnId } from "../../../shared/domain/ids";
import { ObservationStatus, TutorMove } from "../../../shared/domain/review";

export const InterpretOut = z.object({
  claims: z.array(z.object({
    text: z.string().min(1),
    evidence: z.array(EvidenceId).min(1),
    visualDependent: z.boolean(),
    details: z.array(LabeledText),
  })).max(12),
});

export const ReviseOut = InterpretOut.shape.claims.element;

/** Key order is load-bearing: header fields first, `say` last (see TutorEvent). */
export const TutorOut = z.object({
  move: TutorMove,
  claimId: z.string().nullable(),
  cites: z.array(EvidenceId),
  detourTopic: z.string().nullable(),
  say: z.string().min(1),
});

export const ObservationOut = z.object({
  proposals: z.array(z.object({
    questionId: QuestionId,
    status: ObservationStatus,
    citedLearnerTurns: z.array(TurnId),
    rationale: z.string(),
  })),
});

export const RecordOut = z.object({
  notes: z.array(z.object({ subject: z.string(), text: z.string(), cites: z.array(EvidenceId) })),
  links: z.array(z.object({ fromConcept: z.string(), toConcept: z.string(), relation: z.string(), evidence: z.array(EvidenceId) })),
});

export const ResourcesOut = z.object({
  resources: z.array(z.object({ url: z.string().url(), title: z.string(), relevance: z.string().min(1) })),
});
