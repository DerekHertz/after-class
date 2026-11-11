/**
 * The tutor turn (W8): code decides WHAT MAY HAPPEN, Claude decides WHAT TO SAY.
 *
 * Each turn, `reviewState` folds the log and `allowedMoves` computes the closed
 * set of move kinds the tutor may pick. Rules live here, not in the prompt:
 *   R3  ask_main.claimIds ⊆ usable AssessableClaim IDs; an open thread on a claim no longer usable may only be closed
 *   R11 detour_step allowed ⇔ detour.kind === "active" (only a learner detour_accept gets there)
 *   R7  cited evidence IDs ⊆ scope material
 *   ≤ 3 main questions; hint/explain requests force that move; a pending correction forces disclosure first
 *   fuzzy topics (marked at `begin`) get the main questions first; then at most 3 quick checks on unmarked topics (R18);
 *   a quick check that goes shaky becomes a main question only while fewer than 3 main questions were asked
 *
 * Reply protocol, header first (SYNTHESIS graft 1): the first line is one JSON
 * object, the TutorMove header. Code validates it before anything is spoken.
 * Everything after that line is the spoken prose (`say`). So a move that fails
 * validation is never heard.
 */
import { z } from "zod";
import { stableId } from "../../shared/ids";
import type { ClaimId, ConceptId, EvidenceId, Id, IdKind, ThreadId } from "../../shared/ids";
import type {
  AssessableClaim, Concept, Correction, EvidenceBundle, FrozenScope, LearnerActKind, Observation, ReviewPhase, ReviewState, Turn,
  TutorMove, TutorMoveKind,
} from "../../shared/domain";
import { Material, contains } from "../../shared/time";
import { ProviderError } from "../providers/memo";
import type { Task } from "../providers/memo";
import type { ClaudeCli, ClaudeRequest } from "../providers/claude";
import { attributeTurns, moveThreads, quickCheckThreads } from "./clamp";
import { detourTracker } from "./detour";

export const MAX_MAIN_QUESTIONS = 3;
/** Flow D: "a sample of at most 3 unmarked topics". */
export const MAX_QUICK_CHECKS = 3;

/** A learner request the next tutor move must answer, whatever else is going on. */
const FORCED_RESPONSE: Partial<Record<LearnerActKind, TutorMoveKind>> = {
  hint_request: "hint",
  explain_request: "explain",
  dispute: "answer_dispute",
};

function bySeq(turns: readonly Turn[]): readonly Turn[] {
  return [...turns].sort((a, b) => a.seq - b.seq);
}

/** The thread the tutor's next ask_main must open. Code mints it, so the model never invents an ID. */
export function nextThreadId(state: Pick<ReviewState, "reviewId" | "mainQuestions"> & { readonly quickChecks?: number }): ThreadId {
  return stableId("thr", state.reviewId, state.mainQuestions + (state.quickChecks ?? 0) + 1);
}

/**
 * DERIVED from the turn log + current corrections. Never stored.
 * `lastLearnerAct` is the learner turn the next tutor move answers: null once a
 * tutor turn has followed it, so a request forces exactly one response.
 * A correction counts as disclosed once a disclose_correction move named it.
 */
export function reviewState(reviewId: ReviewState["reviewId"], turns: readonly Turn[], corrections: readonly Correction[], softTargetS: number, nowMs: number): ReviewState {
  let phase: ReviewPhase = "active";
  let mainQuestions = 0;
  let quickChecks = 0;
  let fuzzy: readonly ConceptId[] = [];
  let openThread: ThreadId | null = null;
  let lastLearnerAct: Extract<Turn, { actor: "learner" }> | null = null;
  const detours = detourTracker();
  let openDispute: ThreadId | null = null;
  let softTargetOffered = false;
  let wrapUpRequested = false;
  const disclosed = new Set<string>();
  const sorted = attributeTurns(turns);
  let activeMs = 0;
  let activeSince: number | null = sorted[0]?.atMs ?? null;
  const stopClock = (atMs: number) => {
    if (activeSince !== null) activeMs += atMs - activeSince;
    activeSince = null;
  };

  for (const t of sorted) {
    if (t.actor === "learner") {
      lastLearnerAct = t;
      const act = t.act;
      switch (act.kind) {
        case "begin":
          fuzzy = act.fuzzy ?? [];
          break;
        case "pause":
          if (phase === "active") {
            stopClock(t.atMs);
            phase = "paused";
          }
          break;
        case "resume":
          if (phase === "paused") {
            phase = "active";
            activeSince = t.atMs;
          }
          break;
        case "end":
        case "wrap_up":
          wrapUpRequested = true;
          // Ending leaves a pause so the tutor can wrap up and the review can be saved (#136). The clock stays stopped.
          if (phase === "paused") phase = "active";
          break;
        case "continue_past_target":
          wrapUpRequested = false;
          break;
        case "dispute":
          openDispute = t.threadId;
          break;
        default:
          break;
      }
    } else if (t.actor === "tutor") {
      lastLearnerAct = null;
      const move = t.move;
      switch (move.kind) {
        case "ask_main":
          mainQuestions += 1;
          openThread = move.threadId;
          break;
        case "quick_check":
          quickChecks += 1;
          openThread = move.threadId;
          break;
        case "close_thread":
          if (openThread === move.threadId) openThread = null;
          break;
        case "answer_dispute":
          if (openDispute === move.threadId) openDispute = null;
          break;
        case "disclose_correction":
          disclosed.add(move.correctionId);
          break;
        case "wrap_up":
          stopClock(t.atMs);
          phase = "ended";
          break;
        default:
          break;
      }
    } else if (t.notice.kind === "soft_target_reached") {
      softTargetOffered = true;
    }
    detours.step(t);
  }
  if (activeSince !== null) activeMs += Math.max(0, nowMs - activeSince);

  return {
    reviewId,
    phase,
    mainQuestions,
    quickChecks,
    fuzzy,
    openThread,
    lastLearnerAct,
    detour: detours.state,
    openDispute,
    corrections: corrections.map((c) => (c.disclosed || !disclosed.has(c.id) ? c : { ...c, disclosed: true })),
    activeSeconds: activeMs / 1000,
    softTargetS,
    softTargetOffered,
    wrapUpRequested,
  };
}

/**
 * Whether the learner has anything to answer after this move. A correction disclosure and a
 * closed thread ("Let's leave that question there and move on.") ask nothing, so the turn
 * goes on to the next move in the same request; every other move waits for the learner
 * (a question, a tentative diagnosis, a detour offer) or ends the review (wrap_up).
 */
export function waitsForLearner(move: TutorMove): boolean {
  return move.kind !== "disclose_correction" && move.kind !== "close_thread";
}

/**
 * Whether the tutor still owes a move: the review is active and the last tutor move asked nothing
 * (a disclosure or a closed thread) with no learner turn since, so a request stopped part-way.
 * The soft-target prompt counts as the tutor's wait for the learner.
 */
export function tutorOwesMove(turns: readonly Turn[], phase: ReviewState["phase"]): boolean {
  if (phase !== "active") return false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.actor === "code") {
      if (t.notice.kind === "soft_target_reached") return false;
      continue;
    }
    return t.actor === "tutor" && !waitsForLearner(t.move);
  }
  return false;
}

/**
 * Flow D's TLC fix for R3, "A claim being rechecked is out of assessment until
 * it passes again; an open question on it pauses and the tutor says why."
 * The open thread's claims that are not usable now; any means the thread is paused.
 */
function recheckedClaims(openThread: ThreadId | null, ctx: Pick<TutorInput, "turns" | "claims">): readonly ClaimId[] {
  if (openThread === null) return [];
  const usable = new Set(ctx.claims.map((c) => c.id));
  for (const t of ctx.turns) {
    if (t.actor === "tutor" && (t.move.kind === "ask_main" || t.move.kind === "quick_check") && t.move.threadId === openThread) return t.move.claimIds.filter((id) => !usable.has(id));
  }
  return [];
}

/**
 * Where the review is in the fuzzy-first plan (flow D). Derived from the state, the turns and the claims usable now.
 *   active     the learner marked a topic that has a usable claim (or was already asked about): fuzzy-first applies.
 *              Otherwise "no topics marked" behaviour: today's open recall questions, and no quick checks.
 *   fuzzyLeft  marked topics with a usable claim that no main question has asked about yet
 *   quickLeft  unmarked topics with a usable claim that no question has touched yet (the quick-check sample pool)
 */
export type FocusPlan = { readonly active: boolean; readonly fuzzyLeft: readonly ConceptId[]; readonly quickLeft: readonly ConceptId[]; readonly conceptOf: ReadonlyMap<ClaimId, ConceptId> };

export function focusPlan(state: Pick<ReviewState, "fuzzy">, ctx: Pick<TutorInput, "turns" | "claims">): FocusPlan {
  const conceptOf = new Map<ClaimId, ConceptId>(ctx.claims.map((c) => [c.id, c.conceptId]));
  const usable = [...new Set(ctx.claims.map((c) => c.conceptId))];
  const touched = (kind: "ask_main" | "quick_check"): Set<ConceptId> => {
    const out = new Set<ConceptId>();
    for (const t of ctx.turns) {
      if (t.actor === "tutor" && t.move.kind === kind) for (const id of t.move.claimIds) { const c = conceptOf.get(id); if (c !== undefined) out.add(c); }
    }
    return out;
  };
  const asked = touched("ask_main");
  const checked = touched("quick_check");
  const marked = new Set(state.fuzzy);
  const active = state.fuzzy.some((id) => usable.includes(id) || asked.has(id));
  return {
    active,
    fuzzyLeft: state.fuzzy.filter((id, i) => state.fuzzy.indexOf(id) === i && usable.includes(id) && !asked.has(id)),
    quickLeft: usable.filter((id) => !marked.has(id) && !asked.has(id) && !checked.has(id)),
    conceptOf,
  };
}

/**
 * R11: "A detour only starts after I say yes."
 *   if phase != "active": return {}
 *   if any correction !disclosed: return {"disclose_correction"}
 *   open thread names a claim not usable now (R3): return {"wrap_up"} if wrapUpRequested else {"close_thread"}
 *   hint_request / explain_request / dispute pending: return the move that answers it
 *   if wrapUpRequested (learner wrap_up or end): return {"wrap_up"}
 *   just accepted a detour that can start: return {"detour_step"}
 *   s = {}
 *   if openThread is a quick check: s += {"close_thread", "ask_main" (if mainQuestions < 3)}
 *   else if openThread: s += {"ask_followup", "diagnose", "close_thread", "propose_detour" (if detour.kind == "none")}
 *   else if fuzzy-first applies (a marked topic has a usable claim):
 *     marked topics left and mainQuestions < 3: s += {"ask_main"}
 *     else no marked topic left and quickChecks < 3 and an unmarked topic is left: s += {"quick_check"}
 *     else: s += {"wrap_up"}
 *   else if mainQuestions < 3: s += {"ask_main"}
 *   else: s += {"wrap_up"}
 *   if detour.kind == "active": s += {"detour_step"}
 *   return s
 * Code (not the tutor) appends a soft_target_reached notice when the last tutor
 * move was close_thread and activeSeconds ≥ softTargetS ∧ !softTargetOffered.
 */
export function allowedMoves(state: ReviewState, ctx: Pick<TutorInput, "turns" | "claims"> & { readonly pendingClaims?: number }): ReadonlySet<TutorMoveKind> {
  if (state.phase !== "active") return new Set();
  if (state.corrections.some((c) => !c.disclosed)) return new Set(["disclose_correction"]);
  if (recheckedClaims(state.openThread, ctx).length > 0) return new Set([state.wrapUpRequested ? "wrap_up" : "close_thread"]);
  const last = state.lastLearnerAct?.act.kind;
  const forced = last === undefined ? undefined : FORCED_RESPONSE[last];
  if (forced !== undefined) return new Set([forced]);
  if (state.wrapUpRequested) return new Set(["wrap_up"]);
  if (last === "detour_accept" && state.detour.kind === "active") return new Set(["detour_step"]);
  const s = new Set<TutorMoveKind>();
  const plan = focusPlan(state, ctx);
  if (state.openThread !== null && quickCheckThreads(ctx.turns).has(state.openThread)) {
    // The learner has answered the quick check: a clear answer closes it, a shaky one may become a main question.
    s.add("close_thread");
    if (state.mainQuestions < MAX_MAIN_QUESTIONS && ctx.claims.length > 0) s.add("ask_main");
  } else if (state.openThread !== null) {
    s.add("ask_followup").add("diagnose").add("close_thread");
    if (state.detour.kind === "none") s.add("propose_detour");
  } else if (ctx.claims.length > 0 && plan.active) {
    if (plan.fuzzyLeft.length > 0 && state.mainQuestions < MAX_MAIN_QUESTIONS) s.add("ask_main");
    else if (plan.fuzzyLeft.length === 0 && state.quickChecks < MAX_QUICK_CHECKS && plan.quickLeft.length > 0) s.add("quick_check");
    else s.add("wrap_up");
  } else if (state.mainQuestions < MAX_MAIN_QUESTIONS) {
    // R3: nothing is asked on an unusable claim. If every one is only out for a check the tutor waits (no move); if they are gone for good the review ends.
    if (ctx.claims.length > 0) s.add("ask_main");
    else if ((ctx.pendingClaims ?? 0) === 0) s.add("wrap_up");
  } else s.add("wrap_up");
  if (state.detour.kind === "active") s.add("detour_step");
  return s;
}

export type TutorInput = {
  readonly state: ReviewState;
  /** Labels for the topics (concepts) the usable claims belong to, for the prompt. */
  readonly topics?: readonly Concept[];
  readonly allowed: readonly TutorMoveKind[];
  readonly scope: FrozenScope;
  readonly claims: readonly AssessableClaim[]; // usable now (R3/R7)
  readonly evidence: EvidenceBundle; // passages + frames the open thread's claims cite
  readonly turns: readonly Turn[];
  readonly priorObservations: readonly Observation[]; // rewatch reuse: earlier unresolved on the same claims
  readonly repairNote: string | null; // set on the single repair attempt after an invalid header
};

export type TutorOutput = { readonly move: TutorMove; readonly say: string };

/** Zod for a branded ID. A regex, not a transform, so the schema still converts to JSON Schema for `--json-schema`. */
function idSchema<K extends IdKind>(kind: K): z.ZodType<Id<K>> {
  return z.string().regex(new RegExp(`^${kind}_[a-z2-7]{26}$`)) as unknown as z.ZodType<Id<K>>;
}

const threadId = idSchema("thr");
const evidenceIds = z.array(idSchema("ev"));

const tutorMoveSchema: z.ZodType<TutorMove> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ask_main"), threadId, claimIds: z.tuple([idSchema("clm")], idSchema("clm")) }),
  z.object({ kind: z.literal("quick_check"), threadId, claimIds: z.tuple([idSchema("clm")], idSchema("clm")) }),
  z.object({ kind: z.literal("ask_followup"), threadId }),
  z.object({ kind: z.literal("diagnose"), threadId, hypothesis: z.string().min(1), evidence: evidenceIds }),
  z.object({ kind: z.literal("hint"), threadId }),
  z.object({ kind: z.literal("explain"), threadId, evidence: evidenceIds }),
  z.object({ kind: z.literal("propose_detour"), topic: z.string().min(1), reason: z.string().min(1), needsResource: idSchema("res").nullable() }),
  z.object({ kind: z.literal("detour_step") }),
  z.object({ kind: z.literal("answer_dispute"), threadId, evidence: evidenceIds, settled: z.boolean() }),
  z.object({ kind: z.literal("disclose_correction"), correctionId: z.string().min(1), threadIds: z.array(threadId), evidence: evidenceIds }),
  z.object({ kind: z.literal("close_thread"), threadId }),
  z.object({ kind: z.literal("wrap_up") }),
]);

const tutorOutputSchema: z.ZodType<TutorOutput> = z.object({ move: tutorMoveSchema, say: z.string() });

/**
 * Incremental header parse over the streamed text so far.
 *   no newline yet           → { kind: "pending" }
 *   first line parses (zod)  → { kind: "header", move, rest } where rest is the prose after the line
 *   first line is not a move → { kind: "invalid", why }
 * Leading whitespace is ignored. Anything but "{" first is invalid at once, so a
 * prose-first reply is cut before its first word could be spoken.
 */
export function parseMoveHeader(text: string): { readonly kind: "pending" } | { readonly kind: "header"; readonly move: TutorMove; readonly rest: string } | { readonly kind: "invalid"; readonly why: string } {
  const body = text.trimStart();
  if (body.length === 0) return { kind: "pending" };
  if (!body.startsWith("{")) return { kind: "invalid", why: "the first line must be the JSON move header" };
  const nl = body.indexOf("\n");
  if (nl === -1) return { kind: "pending" };
  let json: unknown;
  try {
    json = JSON.parse(body.slice(0, nl));
  } catch {
    return { kind: "invalid", why: "the first line is not one JSON object" };
  }
  const parsed = tutorMoveSchema.safeParse(json);
  if (!parsed.success) return { kind: "invalid", why: `the header is not a valid move: ${z.prettifyError(parsed.error)}` };
  return { kind: "header", move: parsed.data, rest: body.slice(nl + 1) };
}

type Verdict = { readonly ok: true } | { readonly ok: false; readonly why: string };
const OK: Verdict = { ok: true };
const no = (why: string): Verdict => ({ ok: false, why });

/**
 * R7: "Once a review starts, its scope never grows; corrections can change claims inside it but can't add material."
 * Cited evidence must be in the bundle the tutor was shown and inside the frozen scope.
 */
function evidenceInScope(ids: readonly EvidenceId[], input: TutorInput): Verdict {
  const scope = input.scope.material;
  const inScope = new Set<EvidenceId>();
  for (const p of input.evidence.passages) if (Material.covers(scope, p.sourceId, p.interval)) inScope.add(p.id);
  for (const f of input.evidence.frames) {
    if (Material.get(scope, f.sourceId).intervals().some((i) => contains(i, f.mediaS))) inScope.add(f.id);
  }
  const outside = ids.filter((id) => !inScope.has(id));
  return outside.length === 0 ? OK : no(`evidence outside the review scope: ${outside.join(", ")}`);
}

function threadsOpened(turns: readonly Turn[]): ReadonlySet<ThreadId> {
  const out = new Set<ThreadId>();
  for (const t of turns) if (t.actor === "tutor" && (t.move.kind === "ask_main" || t.move.kind === "quick_check")) out.add(t.move.threadId);
  return out;
}

/** hint / explain answer a request on the open thread, or on an earlier thread when none is open. */
function helpThread(id: ThreadId, input: TutorInput): Verdict {
  const open = input.state.openThread;
  if (open !== null) return id === open ? OK : no(`help must be on the open thread ${open}`);
  return threadsOpened(input.turns).has(id) ? OK : no(`unknown thread ${id}`);
}

function onOpenThread(id: ThreadId, input: TutorInput): Verdict {
  return id === input.state.openThread ? OK : no(`expected the open thread ${input.state.openThread ?? "(none)"}`);
}

function all(...checks: readonly (() => Verdict)[]): Verdict {
  for (const c of checks) {
    const v = c();
    if (!v.ok) return v;
  }
  return OK;
}

/**
 * R3: "A claim can be used to judge my answers only if it passed the evidence check."
 * R11: "A detour only starts after I say yes."
 * Validate a header against the allowed set, usable claims, scope evidence and thread IDs.
 */
export function validateMove(move: TutorMove, input: TutorInput): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const { state } = input;
  if (!input.allowed.includes(move.kind)) return no(`${move.kind} is not allowed now; allowed: ${input.allowed.join(", ") || "(none)"}`);
  const rechecked = recheckedClaims(state.openThread, input);
  if (rechecked.length > 0 && move.kind !== "close_thread" && move.kind !== "disclose_correction" && moveThreads(move).includes(state.openThread!)) {
    return no(`thread ${state.openThread} is paused while ${rechecked.join(", ")} is rechecked; only close it`);
  }
  switch (move.kind) {
    case "ask_main": {
      if (state.mainQuestions >= MAX_MAIN_QUESTIONS) return no(`at most ${MAX_MAIN_QUESTIONS} main questions`);
      const expected = nextThreadId(state);
      if (move.threadId !== expected) return no(`ask_main must open thread ${expected}`);
      const usable = new Set(input.claims.map((c) => c.id));
      const unusable = move.claimIds.filter((id) => !usable.has(id));
      if (unusable.length > 0) return no(`claims not usable for assessment: ${unusable.join(", ")}`);
      const plan = focusPlan(state, input);
      const concepts = move.claimIds.map((id) => plan.conceptOf.get(id));
      if (state.openThread !== null && quickCheckThreads(input.turns).has(state.openThread)) {
        // A shaky quick check becomes a main question on that topic.
        const quick = input.turns.find((t) => t.actor === "tutor" && t.move.kind === "quick_check" && t.move.threadId === state.openThread);
        const topic = quick?.actor === "tutor" && quick.move.kind === "quick_check" ? plan.conceptOf.get(quick.move.claimIds[0]) : undefined;
        return topic === undefined || concepts.every((c) => c === topic) ? OK : no("a main question after a quick check must stay on the quick-checked topic");
      }
      if (plan.active && plan.fuzzyLeft.length > 0 && !concepts.some((c) => c !== undefined && plan.fuzzyLeft.includes(c))) {
        return no("main questions go to the topics the learner marked as fuzzy first");
      }
      return OK;
    }
    case "quick_check": {
      if (state.quickChecks >= MAX_QUICK_CHECKS) return no(`at most ${MAX_QUICK_CHECKS} quick checks`);
      const expected = nextThreadId(state);
      if (move.threadId !== expected) return no(`quick_check must open thread ${expected}`);
      const usable = new Set(input.claims.map((c) => c.id));
      const unusable = move.claimIds.filter((id) => !usable.has(id));
      if (unusable.length > 0) return no(`claims not usable for assessment: ${unusable.join(", ")}`);
      const plan = focusPlan(state, input);
      if (!plan.active) return no("quick checks only follow topics the learner marked as fuzzy");
      if (plan.fuzzyLeft.length > 0) return no("quick checks start only after the fuzzy topics are covered");
      const concepts = new Set(move.claimIds.map((id) => plan.conceptOf.get(id)));
      if (concepts.size !== 1) return no("a quick check is on one topic");
      const [topic] = [...concepts];
      return topic !== undefined && plan.quickLeft.includes(topic) ? OK : no("a quick check goes on an unmarked topic not yet asked or checked");
    }
    case "ask_followup":
    case "close_thread":
      return onOpenThread(move.threadId, input);
    case "diagnose": {
      const already = input.turns.some((t) => t.actor === "tutor" && t.move.kind === "diagnose" && t.move.threadId === move.threadId);
      return all(
        () => onOpenThread(move.threadId, input),
        () => (already ? no("one diagnostic question per thread") : OK),
        () => (move.evidence.length > 0 ? OK : no("a diagnostic question must cite the source")),
        () => evidenceInScope(move.evidence, input),
      );
    }
    case "hint":
      return helpThread(move.threadId, input);
    case "explain":
      return all(() => helpThread(move.threadId, input), () => evidenceInScope(move.evidence, input));
    case "answer_dispute":
      return all(
        () => (move.threadId === state.openDispute ? OK : no(`expected the disputed thread ${state.openDispute ?? "(none)"}`)),
        () => (move.evidence.length > 0 ? OK : no("answering a dispute must cite the rechecked source")),
        () => evidenceInScope(move.evidence, input),
      );
    case "disclose_correction": {
      const known = threadsOpened(input.turns);
      return all(
        () => (state.corrections.some((c) => c.id === move.correctionId && !c.disclosed) ? OK : no(`no pending correction ${move.correctionId}`)),
        () => (move.threadIds.every((id) => known.has(id)) ? OK : no("unknown thread in correction")),
        () => evidenceInScope(move.evidence, input),
      );
    }
    case "detour_step":
      return state.detour.kind === "active" ? OK : no("a detour starts only after the learner accepts it");
    case "propose_detour":
    case "wrap_up":
      return OK;
  }
}

export const TUTOR_SYSTEM = `You are the tutor in After Class, a review of a lecture the learner just watched. You run a short Socratic review grounded in the lecture's own evidence. Code decides which moves are allowed each turn and checks every move you pick; you decide what to say.

How to tutor:
- Lead with open recall. Your first main question asks the learner to explain the idea in their own words. Never recap, summarize or preview the lecture first.
- Ask at most 3 main questions in a review, each about the usable claims you are given. Ask follow-ups inside a thread as needed, one question at a time.
- The learner may have marked topics they feel fuzzy on, and may have left a note. Main questions go to the marked topics first. If a marked topic has no usable claim, say so in one short sentence and carry on as you otherwise would.
- After the marked topics, a quick check is one short recall question on one unmarked topic, at most 3 per review. It is not a main question and not a follow-up thread. When the learner has answered it: if the answer is clear, close the thread and move on; if it is shaky, ask a main question on that same topic, but only if main questions remain. Never tell the learner a quick check shows they understood.
- When an answer does not match the lecture, ask one tentative diagnostic question grounded in a passage or frame you cite, for example "The lecture puts it as ... How does that fit with what you said?" It is a question, not a verdict. At most one per thread.
- If you suspect a missing prerequisite, you may propose a detour and say why. Never start it yourself. A detour step becomes available only after the learner says yes.
- If the learner disputes an interpretation, recheck the cited source, show what it says, and invite them to explain. If the evidence does not settle it, say so plainly and set "settled": false. You never decide a dispute; the learner does.
- When the learner asks for a hint or an explanation, give it. Anything you add beyond what the lecture's evidence shows is a supplemental explanation: say so out loud, for example "Beyond what the lecture showed, ...".
- When a correction is pending, disclose it first: what changed and the evidence for it.
- Never tell the learner they understood or failed. Their record is decided later from the actual turns.

Output format, exactly:
1. The first line is one JSON object on a single line: your move header. No code fence, no text before it.
2. Then a newline, then what you say aloud: plain spoken prose in short sentences, no markdown, no lists, no IDs.

Move headers (use only kinds listed as allowed, and only IDs you are given):
{"kind":"ask_main","threadId":"<the next thread id you are given>","claimIds":["clm_..."]}
{"kind":"quick_check","threadId":"<the next thread id you are given>","claimIds":["clm_..."]}
{"kind":"ask_followup","threadId":"thr_..."}
{"kind":"diagnose","threadId":"thr_...","hypothesis":"<what you suspect the learner thinks>","evidence":["ev_..."]}
{"kind":"hint","threadId":"thr_..."}
{"kind":"explain","threadId":"thr_...","evidence":["ev_..."]}
{"kind":"propose_detour","topic":"<prerequisite>","reason":"<why>","needsResource":null}
{"kind":"detour_step"}
{"kind":"answer_dispute","threadId":"thr_...","evidence":["ev_..."],"settled":false}
{"kind":"disclose_correction","correctionId":"<id>","threadIds":["thr_..."],"evidence":["ev_..."]}
{"kind":"close_thread","threadId":"thr_..."}
{"kind":"wrap_up"}`;

function renderTurn(t: Turn): string {
  const thread = t.threadId === null ? "" : ` [${t.threadId}]`;
  switch (t.actor) {
    case "learner": {
      const act = t.act;
      if (act.kind === "begin") return act.fuzzy && act.fuzzy.length > 0 ? `learner (learner opened the review, marking fuzzy: ${act.fuzzy.join(", ")})` : "learner (learner opened the review)";
      const text = act.kind === "answer" || act.kind === "dispute" ? `: ${JSON.stringify(act.text)}` : "";
      return `learner${thread} ${act.kind}${text}`;
    }
    case "tutor":
      return `tutor${thread} ${JSON.stringify(t.move)}\n  said: ${JSON.stringify(t.say)}`;
    case "code":
      return `code notice ${JSON.stringify(t.notice)}`;
  }
}

/**
 * Structured state in, prompt out. Nothing time-varying goes in (no clock, no
 * active seconds), so a resent turn produces the same prompt and the same memo key.
 */
export function tutorPrompt(input: TutorInput): string {
  const { state } = input;
  const sections: string[] = [
    `Allowed moves this turn: ${input.allowed.join(", ")}`,
    `Main questions asked: ${state.mainQuestions} of ${MAX_MAIN_QUESTIONS}. Next thread id for ask_main or quick_check: ${nextThreadId(state)}`,
    `Open thread: ${state.openThread ?? "none"}. Open dispute: ${state.openDispute ?? "none"}. Detour: ${JSON.stringify(state.detour)}`,
  ];
  if (state.fuzzy.length > 0) {
    const label = (id: ConceptId) => `${input.topics?.find((c) => c.id === id)?.label ?? "(topic)"} (concept ${id})`;
    const plan = focusPlan(state, input);
    const begin = bySeq(input.turns).find((t) => t.actor === "learner" && t.act.kind === "begin");
    const learnerNote = begin?.actor === "learner" && begin.act.kind === "begin" ? begin.act.note : undefined;
    sections.push([
      `Topics the learner marked as fuzzy: ${state.fuzzy.map(label).join("; ")}.${learnerNote ? ` Their note: ${JSON.stringify(learnerNote)}` : ""}`,
      plan.active
        ? `Marked topics still to ask a main question about: ${plan.fuzzyLeft.map(label).join("; ") || "none"}. Unmarked topics available for a quick check: ${plan.quickLeft.map(label).join("; ") || "none"}. Quick checks asked: ${state.quickChecks} of ${MAX_QUICK_CHECKS}.`
        : "None of the marked topics has a usable claim. Say that in one short sentence, then continue as if nothing was marked.",
    ].join("\n"));
  }
  const pending = state.corrections.filter((c) => !c.disclosed);
  if (pending.length > 0) sections.push(`Pending corrections to disclose:\n${pending.map((c) => `- ${c.id}: claim ${c.claimId} ${c.change}`).join("\n")}`);
  const rechecked = recheckedClaims(state.openThread, input);
  if (rechecked.length > 0) {
    sections.push(`Open thread ${state.openThread} is paused: claim ${rechecked.join(", ")} is being rechecked and is out of assessment until it passes again. Ask or judge nothing on it; tell the learner why it is paused.`);
  }
  sections.push(`Usable claims (the only ones you may ask about or judge against):\n${input.claims.map((c) => `- ${c.id} (concept ${c.conceptId}): ${c.text} [evidence: ${c.evidence.join(", ")}]${c.assumptions.length ? ` assumptions: ${c.assumptions.join("; ")}` : ""}`).join("\n")}`);
  sections.push(`Lecture evidence (cite only these IDs):\n${[
    ...input.evidence.passages.map((p) => `- ${p.id} passage ${p.interval.start}s-${p.interval.end}s: ${JSON.stringify(p.text)}`),
    ...input.evidence.frames.map((f) => `- ${f.id} frame at ${f.mediaS}s (image not shown)`),
  ].join("\n") || "- none"}`);
  if (input.evidence.gaps.length > 0) sections.push(`Capture gaps in scope (nothing was recorded there, do not assume what it said): ${input.evidence.gaps.map((g) => `${g.interval.start}s-${g.interval.end}s ${g.reason}`).join("; ")}`);
  if (input.priorObservations.length > 0) {
    sections.push(`From earlier reviews of these claims:\n${input.priorObservations.map((o) => `- claims ${o.claimIds.join(", ")}: ${o.status}`).join("\n")}`);
  }
  sections.push(`Review so far:\n${bySeq(input.turns).map(renderTurn).join("\n") || "(no turns yet; open with a recall question)"}`);
  if (input.repairNote !== null) sections.push(`Your previous reply was rejected: ${input.repairNote}. Reply again with a valid header first.`);
  return sections.join("\n\n");
}

const TUTOR_REQUEST = { model: "opus", effort: "medium", images: [], webTools: false, timeoutMs: 120_000 } as const;

function tutorRequest(input: TutorInput): ClaudeRequest {
  return { ...TUTOR_REQUEST, system: TUTOR_SYSTEM, prompt: tutorPrompt(input) };
}

/**
 * Claude streaming task. The key includes the whole turn log, so a resent turn hits the memo instead of paying twice.
 * A reply whose header is invalid or not allowed fails without a stored hit, so
 * the memo never replays a move that validation would reject.
 */
export function tutorTask(claude: ClaudeCli): Task<TutorInput, TutorOutput> {
  return {
    provider: "claude",
    purpose: "tutor_turn",
    model: TUTOR_REQUEST.model,
    version: "tutor-2",
    maxAttempts: 2,
    canonicalInput: (input) => ({ system: TUTOR_SYSTEM, prompt: tutorPrompt(input), effort: TUTOR_REQUEST.effort }),
    async attempt(input, ctx) {
      const { text, usage } = await claude.streamText(tutorRequest(input), ctx.streamTo ?? (() => {}), ctx.signal);
      const header = parseMoveHeader(text.includes("\n") ? text : `${text}\n`);
      if (header.kind !== "header") throw new ProviderError(`invalid move header: ${header.kind === "invalid" ? header.why : "empty reply"}`, usage, false);
      const verdict = validateMove(header.move, input);
      if (!verdict.ok) throw new ProviderError(`move rejected: ${verdict.why}`, usage, false);
      return { output: { move: header.move, say: header.rest.trim() }, usage };
    },
    decode: (stored) => tutorOutputSchema.parse(stored),
  };
}

export type WrapUpInput = { readonly turns: readonly Turn[]; readonly claims: readonly AssessableClaim[]; readonly threads: readonly ThreadId[] };
export type WrapUpOutput = {
  readonly observations: readonly { readonly threadId: ThreadId; readonly proposed: Observation["proposed"]; readonly rationale: string }[];
  readonly notes: readonly { readonly conceptId: AssessableClaim["conceptId"]; readonly tutorSummary: string; readonly evidence: readonly string[] }[];
};

const wrapUpSchema: z.ZodType<WrapUpOutput> = z.object({
  observations: z.array(z.object({
    threadId,
    proposed: z.enum(["independent", "partial", "after_help", "unresolved", "not_assessed"]),
    rationale: z.string(),
  })),
  notes: z.array(z.object({ conceptId: idSchema("cpt") as z.ZodType<ConceptId>, tutorSummary: z.string(), evidence: z.array(z.string()) })),
});

export const WRAP_UP_SYSTEM = `You close a lecture review in After Class. From the actual turns only, propose one observation per thread and one short note per concept discussed.

Observation status, per thread:
- independent: the learner gave a correct, substantive answer without help.
- partial: a substantive answer that was partly right.
- after_help: the learner got there only after a hint, explanation or correction.
- unresolved: the learner tried or said they did not know, and it stayed unclear.
- not_assessed: the learner skipped, or the turns hold no evidence about understanding.
Give a one-sentence rationale that points at the turns. Code may cap your proposal; never inflate it.
A thread opened by a quick_check move is a short check on a topic the learner did not mark. Propose its status the same way; code never records it as understood.

Notes, per concept: a tutorSummary of what the review established and what stayed open, written as the tutor's summary (the learner's own words are kept separately). Cite only evidence IDs that appear in the claims or turns.`;

export function wrapUpPrompt(input: WrapUpInput): string {
  return [
    `Threads: ${input.threads.join(", ") || "none"}`,
    `Claims:\n${input.claims.map((c) => `- ${c.id} (concept ${c.conceptId}): ${c.text} [evidence: ${c.evidence.join(", ")}]`).join("\n")}`,
    `Turns:\n${bySeq(input.turns).map(renderTurn).join("\n")}`,
  ].join("\n\n");
}

const WRAP_UP_REQUEST = { model: "opus", effort: "medium", images: [], webTools: false, timeoutMs: 180_000 } as const;

/** Claude structured task. Proposes statuses from the actual turns; code clamps them. */
export function wrapUpTask(claude: ClaudeCli): Task<WrapUpInput, WrapUpOutput> {
  return {
    provider: "claude",
    purpose: "wrap_up",
    model: WRAP_UP_REQUEST.model,
    version: "wrap-up-1",
    maxAttempts: 3,
    canonicalInput: (input) => ({ system: WRAP_UP_SYSTEM, prompt: wrapUpPrompt(input), effort: WRAP_UP_REQUEST.effort }),
    async attempt(input, ctx) {
      return claude.structured({ ...WRAP_UP_REQUEST, system: WRAP_UP_SYSTEM, prompt: wrapUpPrompt(input) }, wrapUpSchema, ctx.signal);
    },
    decode: (stored) => wrapUpSchema.parse(stored),
  };
}

