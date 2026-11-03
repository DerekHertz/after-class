/**
 * Observation status clamping (flow D) and the learning-gap predicate (W8).
 * Pure. Imported by review (live view) and record (save); nothing else decides status.
 *
 * Rank for capping: independent > partial > after_help > unresolved.
 * not_assessed is outside the rank: it means "no evidence about understanding".
 * Downgrades the tutor proposed are kept; code only ever caps.
 */
import type { DisputeState, Observation, ObservationStatus, RecordedStatus, Seq, ThreadFacts, TutorMove, Turn } from "../../shared/domain";
import type { ThreadId, TurnId } from "../../shared/ids";
import { HELP_MOVES } from "../../shared/domain";

const HELP: ReadonlySet<TutorMove["kind"]> = new Set(HELP_MOVES);

function bySeq(turns: readonly Turn[]): readonly Turn[] {
  return [...turns].sort((a, b) => a.seq - b.seq);
}

/** The threads a tutor move is about. A correction disclosure can touch several. */
export function moveThreads(move: TutorMove): readonly ThreadId[] {
  switch (move.kind) {
    case "disclose_correction":
      return move.threadIds;
    case "propose_detour":
    case "detour_step":
    case "wrap_up":
      return [];
    default:
      return [move.threadId];
  }
}

/**
 * Facts about one thread, derived from turns in seq order.
 *   substantive answer = learner `answer` act in the thread (skip / dont_know are not answers)
 *   help               = tutor turn in the thread whose move.kind ∈ HELP_MOVES (single list in domain.ts)
 *   endedBySkip        = the learner's last answer, skip or dont_know in the thread was a skip
 *   saidDontKnowOnly   = no substantive answer, at least one dont_know, and not ended by a skip
 */
export function threadFacts(threadId: ThreadId, turns: readonly Turn[]): ThreadFacts {
  let firstSubstantiveAnswerSeq: Seq | null = null;
  let firstHelpSeq: Seq | null = null;
  let lastResponse: "answer" | "skip" | "dont_know" | null = null;
  let saidDontKnow = false;
  const learnerTurns: TurnId[] = [];
  const helpTurns: TurnId[] = [];
  for (const t of bySeq(turns)) {
    if (t.actor === "learner" && t.threadId === threadId) {
      learnerTurns.push(t.id);
      const k = t.act.kind;
      if (k === "answer" || k === "skip" || k === "dont_know") lastResponse = k;
      if (k === "answer" && firstSubstantiveAnswerSeq === null) firstSubstantiveAnswerSeq = t.seq;
      if (k === "dont_know") saidDontKnow = true;
    } else if (t.actor === "tutor" && HELP.has(t.move.kind) && moveThreads(t.move).includes(threadId)) {
      helpTurns.push(t.id);
      if (firstHelpSeq === null) firstHelpSeq = t.seq;
    }
  }
  const endedBySkip = lastResponse === "skip";
  return {
    threadId,
    firstSubstantiveAnswerSeq,
    firstHelpSeq,
    endedBySkip,
    saidDontKnowOnly: firstSubstantiveAnswerSeq === null && saidDontKnow && !endedBySkip,
    learnerTurns,
    helpTurns,
  };
}

/**
 * A thread's dispute as the turn log shows it. The tutor's `settled` claim
 * never resolves anything: only the learner does, through record.resolveDispute.
 *   learner dispute in the thread            → open
 *   tutor answer_dispute, settled: false     → unsettled
 *   tutor answer_dispute, settled: true      → stays open until the learner resolves it
 */
export function threadDispute(threadId: ThreadId, turns: readonly Turn[]): Exclude<DisputeState, { kind: "resolved_by_learner" }> {
  let d: Exclude<DisputeState, { kind: "resolved_by_learner" }> = { kind: "none" };
  for (const t of bySeq(turns)) {
    if (t.actor === "learner" && t.threadId === threadId && t.act.kind === "dispute") d = { kind: "open", turnId: t.id };
    else if (t.actor === "tutor" && t.move.kind === "answer_dispute" && t.move.threadId === threadId && !t.move.settled && d.kind !== "none") d = { kind: "unsettled" };
  }
  return d;
}

/**
 * R12: "If the tutor helped before my answer, it can't count as independent."
 * R13: "A skipped or unanswered question is never counted as understood."
 * R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
 *
 *   dispute open or unsettled                    → "disputed"      (R14, explicit clamp; the TLC fix)
 *   no substantive answer:
 *     only dont_know                             → "unresolved"    (SYNTHESIS open question 2)
 *     skipped / unanswered                       → "not_assessed"  (R13)
 *   help before the first substantive answer:
 *     proposed ∈ {independent, partial}          → "after_help"    (R12)
 *   otherwise                                    → proposed
 * The learner's override is clamped the same way. Returns what it was clamped from, for the audit line.
 */
export function clampStatus(proposed: ObservationStatus, facts: ThreadFacts, dispute: DisputeState): { readonly status: RecordedStatus; readonly clampedFrom: ObservationStatus | null } {
  const status = clamped(proposed, facts, dispute);
  return { status, clampedFrom: status === proposed ? null : proposed };
}

function clamped(proposed: ObservationStatus, facts: ThreadFacts, dispute: DisputeState): RecordedStatus {
  if (dispute.kind === "open" || dispute.kind === "unsettled") return "disputed";
  const answeredAt = facts.firstSubstantiveAnswerSeq;
  if (answeredAt === null) return facts.saidDontKnowOnly ? "unresolved" : "not_assessed";
  const helpedFirst = facts.firstHelpSeq !== null && facts.firstHelpSeq < answeredAt;
  if (helpedFirst && (proposed === "independent" || proposed === "partial")) return "after_help";
  return proposed;
}

/**
 * R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
 * Only record.resolveDispute (a user command) produces `resolved_by_learner`;
 * the tutor's move set has no way to resolve a dispute. after_help is not a
 * gap (SYNTHESIS open question 3).
 */
export function isLearningGap(o: Pick<Observation, "status" | "dispute">): boolean {
  const gapStatus = o.status === "unresolved" || o.status === "partial";
  return gapStatus && disputeAllowsGap(o.dispute);
}

function disputeAllowsGap(d: DisputeState): boolean {
  switch (d.kind) {
    case "none":
      return true;
    case "resolved_by_learner":
      return d.outcome === "it_was_my_gap";
    case "open":
    case "unsettled":
      return false;
  }
}
