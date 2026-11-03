// domain/record.ts -- the learning record. Every ID here is natural (backend/ids.ts), so
// committing the same draft twice writes the same rows: R15 by construction.
import { z } from "zod";
import { ConceptId, EvidenceId, LinkId, NoteId, ReviewId } from "./ids";
import type { Observation } from "./review";

/**
 * Separate-before-serializing: `generated` is written by the save path (and overwritten on
 * retry); `userText` is written only by the learner's edit endpoint. Display = userText ?? generated.
 * A retry therefore can never clobber a learner edit.
 */
export interface Note {
  readonly id: NoteId;
  readonly reviewId: ReviewId;
  readonly author: "learner" | "tutor";
  readonly generated: string;
  readonly userText: string | null;
  readonly cites: readonly EvidenceId[];
}

export interface GraphLink {
  readonly id: LinkId;
  readonly from: ConceptId;
  readonly to: ConceptId;
  readonly relation: string;
  /** suggestions carry evidence; the learner accepts or corrects. Subject links are separate from observations. */
  readonly status: "suggested" | "accepted" | "corrected";
  readonly evidence: readonly EvidenceId[];
}

export interface LearningRecordDraft {
  readonly reviewId: ReviewId;
  readonly notes: readonly Note[];
  readonly observations: readonly Observation[];
  readonly links: readonly GraphLink[];
  /** covered sources + watched intervals + partial reasons, for honest display */
  readonly coverageNote: string;
}

export type SaveState =
  | { readonly tag: "unsaved" }
  | { readonly tag: "saved"; readonly atWall: number }
  | { readonly tag: "pending"; readonly sinceWall: number; readonly lastError: string };

export const SaveResult = z.enum(["saved", "pending"]);
export type SaveResult = z.infer<typeof SaveResult>;
