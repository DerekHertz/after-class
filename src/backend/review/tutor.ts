/**
 * The tutor turn (W8): code decides WHAT MAY HAPPEN, Claude decides WHAT TO SAY.
 *
 * Each turn, `reviewState` folds the log and `allowedMoves` computes the closed
 * set of move kinds the tutor may pick. Rules live here, not in the prompt:
 *   R3  ask_main.claimIds ⊆ usable AssessableClaim IDs
 *   R11 detour_step allowed ⇔ detour.kind === "active" (only a learner detour_accept gets there)
 *   R7  cited evidence IDs ⊆ scope material
 *   ≤ 3 main questions; hint/explain requests force that move; a pending correction forces disclosure first
 *
 * Reply protocol, header first (SYNTHESIS graft 1): the first line is one JSON
 * object, the TutorMove header. Code validates it before anything is spoken.
 * Everything after that line is the spoken prose (`say`). So a move that fails
 * validation is never heard.
 */
import type { ThreadId } from "../../shared/ids";
import type {
  AssessableClaim, Correction, EvidenceBundle, FrozenScope, Observation, ReviewState, Turn, TutorMove, TutorMoveKind,
} from "../../shared/domain";
import type { Task } from "../providers/memo";
import type { ClaudeCli } from "../providers/claude";

/** DERIVED from the turn log + current corrections. Never stored. */
export function reviewState(reviewId: ReviewState["reviewId"], turns: readonly Turn[], corrections: readonly Correction[], softTargetS: number, nowMs: number): ReviewState {
  throw new Error("not implemented");
}

/**
 * R11: "A detour only starts after I say yes."
 * TODO pseudocode:
 *   if phase != "active": return {}
 *   if any correction !disclosed: return {"disclose_correction"}
 *   last = lastLearnerAct?.act.kind
 *   if last == "hint_request": return {"hint"}
 *   if last == "explain_request": return {"explain"}
 *   if last == "dispute": return {"answer_dispute"}
 *   if wrapUpRequested || last == "end": return {"wrap_up"}
 *   s = {}
 *   if openThread: s += {"ask_followup", "diagnose", "close_thread", "propose_detour" (if detour.kind == "none")}
 *   else if mainQuestions < 3: s += {"ask_main"}
 *   else: s += {"wrap_up"}
 *   if detour.kind == "active": s += {"detour_step"}
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
  readonly repairNote: string | null; // set on the single repair attempt after an invalid header
};

export type TutorOutput = { readonly move: TutorMove; readonly say: string };

/**
 * Incremental header parse over the streamed text so far.
 *   no newline yet           → { kind: "pending" }
 *   first line parses (zod)  → { kind: "header", move, rest } where rest is the prose after the line
 *   first line is not a move → { kind: "invalid", why }
 */
export function parseMoveHeader(text: string): { readonly kind: "pending" } | { readonly kind: "header"; readonly move: TutorMove; readonly rest: string } | { readonly kind: "invalid"; readonly why: string } {
  throw new Error("not implemented");
}

/**
 * R3: "A claim can be used to judge my answers only if it passed the evidence check."
 * R11: "A detour only starts after I say yes."
 * Validate a header against the allowed set, usable claims, scope evidence and thread IDs.
 */
export function validateMove(move: TutorMove, input: TutorInput): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  throw new Error("not implemented");
}

/** Claude streaming task. The key includes the whole turn log, so a resent turn hits the memo instead of paying twice. */
export function tutorTask(claude: ClaudeCli): Task<TutorInput, TutorOutput> {
  throw new Error("not implemented");
}

export type WrapUpInput = { readonly turns: readonly Turn[]; readonly claims: readonly AssessableClaim[]; readonly threads: readonly ThreadId[] };
export type WrapUpOutput = {
  readonly observations: readonly { readonly threadId: ThreadId; readonly proposed: Observation["proposed"]; readonly rationale: string }[];
  readonly notes: readonly { readonly conceptId: AssessableClaim["conceptId"]; readonly tutorSummary: string; readonly evidence: readonly string[] }[];
};

/** Claude structured task. Proposes statuses from the actual turns; code clamps them. */
export function wrapUpTask(claude: ClaudeCli): Task<WrapUpInput, WrapUpOutput> {
  throw new Error("not implemented");
}
