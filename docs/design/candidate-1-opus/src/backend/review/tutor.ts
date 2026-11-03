/**
 * The tutor turn: code decides WHAT MAY HAPPEN, Claude decides WHAT TO SAY.
 *
 * Each turn, `reviewState(turns, …)` folds the log into a ReviewState and
 * `allowedMoves(state)` computes the closed set of move kinds the tutor may
 * pick. The Claude task is shown only those kinds and their schemas; the reply
 * is validated against them. Rules live in this fold, not in the prompt:
 *   R3  ask_main.claimIds ⊆ usable AssessableClaim IDs
 *   R11 detour_step ∈ allowed  ⇔  detour.kind === "active" (only a learner detour_accept gets there)
 *   R7  evidence IDs cited ⊆ scope material
 *   ≤ 3 main questions; hint/explain requests force that move; pending correction forces disclosure first
 *
 * Reply protocol (stream-json text): the spoken utterance first, then a line
 * `<<<MOVE>>>` and one JSON object validated by the move schema. Text before the
 * marker streams to speech sentence by sentence; nothing after it is spoken.
 */
import type { ClaimId, ReviewId, ThreadId } from "../../shared/ids";
import type {
  AssessableClaim, DetourState, EvidenceBundle, FrozenScope, Observation, ReviewPhase, Turn, TutorMove, TutorMoveKind,
} from "../../shared/domain";
import type { Task } from "../providers/memo";

export type Correction = {
  readonly id: string; // stableId-ish: hash(reviewId, claimId, change)
  readonly claimId: ClaimId;
  readonly change: "withdrawn" | "text_changed" | "new_in_scope";
  readonly disclosed: boolean;
};

/** DERIVED from the turn log + current preparation. Never stored. */
export type ReviewState = {
  readonly reviewId: ReviewId;
  readonly phase: ReviewPhase;
  readonly mainQuestions: number;
  readonly openThread: ThreadId | null;
  readonly lastLearnerAct: Turn | null;
  readonly detour: DetourState;
  readonly openDispute: ThreadId | null;
  readonly corrections: readonly Correction[];
  readonly activeSeconds: number; // excludes paused time
  readonly softTargetS: number; // default 600, configurable
  readonly softTargetOffered: boolean;
  readonly wrapUpRequested: boolean;
};

export function reviewState(reviewId: ReviewId, turns: readonly Turn[], corrections: readonly Correction[], softTargetS: number, nowMs: number): ReviewState {
  throw new Error("not implemented");
}

/**
 * TODO pseudocode:
 *   if phase != "active": return {}
 *   if any correction !disclosed: return {"disclose_correction"}
 *   last = lastLearnerAct?.act.kind
 *   if last == "hint_request": return {"hint"}
 *   if last == "explain_request": return {"explain"}
 *   if last == "dispute": return {"answer_dispute"}
 *   if wrapUpRequested || last == "end": return {"wrap_up"}
 *   s = {}
 *   if openThread: s += {"ask_followup", "diagnose", "close_thread", "propose_detour"(if detour.kind == "none")}
 *   else if mainQuestions < 3: s += {"ask_main"}
 *   else: s += {"wrap_up"}
 *   if detour.kind == "active": s += {"detour_step"}          // R11
 *   return s
 * Code (not the tutor) appends a soft_target_reached notice when the last tutor
 * move was close_thread and activeSeconds ≥ softTargetS ∧ !softTargetOffered.
 */
export function allowedMoves(state: ReviewState): ReadonlySet<TutorMoveKind> {
  throw new Error("not implemented");
}

export type TutorInput = {
  readonly state: ReviewState;
  readonly allowed: readonly TutorMoveKind[];
  readonly scope: FrozenScope;
  readonly claims: readonly AssessableClaim[]; // usable now (R3/R7)
  readonly evidence: EvidenceBundle; // passages + frames the open thread's claims cite
  readonly turns: readonly Turn[];
  readonly priorObservations: readonly Observation[]; // rewatch reuse: earlier unresolved on the same claims
  readonly repairNote: string | null; // set on the single repair attempt after an invalid move
};

export type TutorOutput = { readonly say: string; readonly move: TutorMove };

/** Claude task (streaming). Key includes the whole turn log, so a resent turn hits the memo instead of paying twice. */
export function tutorTask(): Task<TutorInput, TutorOutput> {
  throw new Error("not implemented");
}

/** Validate a parsed move against the allowed set, usable claims, scope evidence, thread IDs. */
export function validateMove(move: TutorMove, input: TutorInput): { ok: true } | { ok: false; why: string } {
  throw new Error("not implemented");
}

export type WrapUpInput = { readonly turns: readonly Turn[]; readonly claims: readonly AssessableClaim[]; readonly threads: readonly ThreadId[] };
export type WrapUpOutput = {
  readonly observations: readonly { threadId: ThreadId; proposed: Observation["proposed"]; rationale: string }[];
  readonly notes: readonly { conceptId: AssessableClaim["conceptId"]; tutorSummary: string; evidence: readonly string[] }[];
};

/** Claude task (structured). Proposes statuses from the actual turns; code clamps them. */
export function wrapUpTask(): Task<WrapUpInput, WrapUpOutput> {
  throw new Error("not implemented");
}
