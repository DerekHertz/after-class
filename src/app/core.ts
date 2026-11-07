/**
 * Pure view logic for the review app: everything a screen decides, with no
 * React and no IO. Screens render what these return.
 */
import type {
  Author, CaptureView, Claim, Concept, EvidenceBundle, Gap, GapReason, LearnerAct, Note, Observation, PartialReason, RecordedStatus, ReviewOptions,
  ReviewState, ReviewView, StartChoice, Turn, TurnEvent, TutorMove, UsageSummary,
} from "../shared/domain";
import type { EvidenceId, SourceId } from "../shared/ids";
import { IntervalSet, Material } from "../shared/time";
import type { Interval } from "../shared/time";

// ───────────────────────────── Time ─────────────────────────────────────────

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatInterval(i: Interval): string {
  return `${formatClock(i.start)} to ${formatClock(i.end)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export type SourceTitles = ReadonlyMap<SourceId, string>;

export function sourceTitles(capture: CaptureView | null): SourceTitles {
  return new Map((capture?.sources ?? []).map((s) => [s.id, s.title]));
}

/** Source id to YouTube video id, for links that reopen the lecture. */
export type SourceVideos = ReadonlyMap<SourceId, string>;

export function sourceVideos(capture: CaptureView | null): SourceVideos {
  return new Map((capture?.sources ?? []).map((s) => [s.id, s.videoId]));
}

export const watchUrl = (videoId: string, seconds: number): string =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.max(0, Math.floor(seconds))}s`;

const titleOf = (titles: SourceTitles, id: SourceId): string => titles.get(id) ?? id;

// ───────────────────────────── Review options ───────────────────────────────

export const GAP_LABEL: Readonly<Record<GapReason, string>> = {
  no_transcript: "No captions for this stretch",
  transcript_declined: "You chose to continue without a transcript",
  hidden_tab: "Tab was hidden, so frames stalled",
  frame_stall: "Frame capture stalled",
  channel_failed: "A capture channel failed",
  capture_paused: "Capture was paused",
  partially_watched_segment: "Caption line only partly watched, so not used",
  implausible_span: "Watched time did not add up, so it was set aside",
};

export function partialText(reason: PartialReason, titles: SourceTitles = new Map()): string {
  switch (reason.kind) {
    case "capture_gap":
      return `${GAP_LABEL[reason.gap.reason]} in ${titleOf(titles, reason.gap.sourceId)}, ${formatInterval(reason.gap.interval)}.`;
    case "stopped_early":
      return `Preparation was stopped early; ${reason.droppedClaims} claim${reason.droppedClaims === 1 ? "" : "s"} left out.`;
    case "unverified_claims":
      return `${reason.count} claim${reason.count === 1 ? " was" : "s were"} not confirmed by the source and will not be used to assess you.`;
    case "chunks_still_preparing":
      return `${reason.count} section${reason.count === 1 ? " is" : "s are"} still preparing and not included.`;
  }
}

/**
 * Capture gaps grouped per video and reason, so a long capture shows one line per
 * kind of gap instead of one per stretch. A group of one keeps its exact interval.
 */
export function groupGaps(gaps: readonly Gap[], titles: SourceTitles = new Map()): readonly { readonly where: string; readonly reason: string; readonly count: number }[] {
  const groups = new Map<string, Gap[]>();
  for (const g of gaps) {
    const key = `${g.reason}\u0000${g.sourceId}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const title = titleOf(titles, first.sourceId);
    const total = group.reduce((sum, g) => sum + (g.interval.end - g.interval.start), 0);
    return {
      where: group.length === 1 ? `${title}, ${formatInterval(first.interval)}` : `${title}, ${group.length} places, ${formatClock(total)} in all`,
      reason: GAP_LABEL[first.reason],
      count: group.length,
    };
  });
}

/** Why a review is partial, one line per reason; capture gaps are grouped as in groupGaps, in the place their first gap held. */
export function partialLines(reasons: readonly PartialReason[], titles: SourceTitles = new Map()): readonly string[] {
  const gaps = reasons.flatMap((r) => (r.kind === "capture_gap" ? [r.gap] : []));
  const grouped = groupGaps(gaps, titles);
  const firstGap = reasons.findIndex((r) => r.kind === "capture_gap");
  const lines = reasons.filter((r) => r.kind !== "capture_gap").map((r) => partialText(r, titles));
  const gapLines = grouped.map((g) => `${g.reason} in ${g.where}.`);
  if (firstGap < 0) return lines;
  const before = reasons.slice(0, firstGap).filter((r) => r.kind !== "capture_gap").length;
  return [...lines.slice(0, before), ...gapLines, ...lines.slice(before)];
}

/**
 * A short heading for one or more lecture videos. Playlist titles usually share a
 * course suffix ("Intro - Georgia Tech - Advanced Operating Systems"); when they all
 * do, the heading is that shared part and the detail counts the videos. Otherwise the
 * first title and how many more.
 */
export function lectureHeading(titles: readonly string[]): { readonly title: string; readonly detail: string | null } {
  if (titles.length === 0) return { title: "Review", detail: null };
  if (titles.length === 1) return { title: titles[0]!, detail: null };
  const parts = titles.map((t) => t.split(" - "));
  let shared = 0;
  while (parts.every((p) => p.length > shared + 1 && p[p.length - 1 - shared] === parts[0]![parts[0]!.length - 1 - shared])) shared++;
  const count = `${titles.length} videos`;
  return shared > 0 ? { title: parts[0]!.slice(-shared).join(" - "), detail: count } : { title: `${titles[0]} and ${titles.length - 1} more`, detail: count };
}

export type StartOffer = { readonly choice: StartChoice; readonly label: string; readonly note: string };

export type OptionsScreen =
  | {
      readonly kind: "ready";
      readonly supportedClaims: number;
      readonly partial: readonly string[];
      readonly offers: readonly StartOffer[];
    }
  | {
      readonly kind: "processing";
      /** Null unless the backend gave a usable estimate: an unreliable estimate is never invented. */
      readonly estimate: string | null;
      readonly pendingChunks: number;
      readonly ready: { readonly supportedClaims: number; readonly partial: readonly string[] } | null;
      readonly offers: readonly StartOffer[];
    }
  | {
      readonly kind: "nothing";
      readonly gaps: readonly { readonly where: string; readonly reason: string }[];
      readonly unverified: readonly { readonly text: string; readonly status: string; readonly evidence: readonly EvidenceId[] }[];
      /** Null until the capture view says which video the source is. */
      readonly rewatch: readonly { readonly where: string; readonly href: string | null }[];
    };

export function estimateText(estimateS: number | null): string | null {
  if (estimateS === null || !Number.isFinite(estimateS) || estimateS <= 0) return null;
  return estimateS < 60 ? "under a minute" : `about ${Math.round(estimateS / 60)} min`;
}

export const CLAIM_STATUS_LABEL = {
  awaiting_check: "waiting for the evidence check",
  awaiting_revision: "waiting for a revision",
  awaiting_recheck: "waiting for a second check",
  supported_by_check: "supported",
  unverified: "not confirmed by the source",
  dropped: "dropped",
} as const satisfies Record<Claim["status"], string>;

/** The claim text the check last looked at: the revision if there is one. */
export const claimText = (c: Claim): string => (c.revision ?? c.original).text;
export const claimEvidence = (c: Claim): readonly EvidenceId[] => (c.revision ?? c.original).evidence;

export function optionsScreen(options: ReviewOptions, titles: SourceTitles = new Map(), videos: SourceVideos = new Map()): OptionsScreen {
  switch (options.kind) {
    case "ready":
      return {
        kind: "ready",
        supportedClaims: options.scope.supportedClaims,
        partial: partialLines(options.scope.partial, titles),
        offers: [{ choice: "prepared_only", label: "Review now", note: "Anything still preparing keeps preparing for later." }],
      };
    case "processing": {
      const ready = options.readyNow;
      return {
        kind: "processing",
        estimate: estimateText(options.estimateS),
        pendingChunks: options.pendingChunks,
        ready: ready && { supportedClaims: ready.supportedClaims, partial: partialLines(ready.partial, titles) },
        offers: ready
          ? [
              { choice: "prepared_only", label: "Review what is ready", note: "The rest keeps preparing for a later review." },
              { choice: "stop_early", label: "Stop preparing and review", note: "Cancels pending work in this review. Finished claims are kept." },
            ]
          : [],
      };
    }
    case "nothing_to_review":
      return {
        kind: "nothing",
        gaps: groupGaps(options.gaps, titles).map(({ where, reason }) => ({ where, reason })),
        unverified: options.unverified.map((c) => ({ text: claimText(c), status: CLAIM_STATUS_LABEL[c.status], evidence: claimEvidence(c) })),
        rewatch: options.rewatch.map((r) => {
          const videoId = videos.get(r.sourceId);
          return { where: `${titleOf(titles, r.sourceId)}, ${formatInterval(r.interval)}`, href: videoId === undefined ? null : watchUrl(videoId, r.interval.start) };
        }),
      };
  }
}

// ───────────────────────────── Conversation ─────────────────────────────────

export type Line = {
  readonly key: string;
  readonly speaker: "tutor" | "you" | "system";
  readonly label: string;
  readonly text: string;
  readonly evidenceIds: readonly EvidenceId[];
};

/**
 * The conversation is always on the page, under the scene, for every appearance; nothing hides it.
 * The source panel is a side panel that starts closed, opens when the learner asks or a reply cites evidence,
 * and closing it changes nothing else.
 */
export const INITIAL_SOURCE_OPEN = false;

/** What the page shows after the source panel is toggled. The conversation is never part of the choice. */
export function reviewLayout(sourceOpen: boolean): { readonly conversationVisible: true; readonly sourceVisible: boolean } {
  return { conversationVisible: true, sourceVisible: sourceOpen };
}

/** The system line for `begin`: what the learner marked as fuzzy, and their note. */
export function beginText(act: Extract<LearnerAct, { kind: "begin" }>, topics: readonly Concept[] = []): string {
  const marked = act.fuzzy ?? [];
  if (marked.length === 0 && act.note === undefined) return "Review started";
  const labels = marked.map((id) => topics.find((t) => t.id === id)?.label ?? "(topic)");
  const picks = marked.length === 0 ? "You marked no topics." : `You marked: ${labels.join(", ")}.`;
  return act.note === undefined ? picks : `${picks} Your note: ${act.note}`;
}

export function learnerActText(act: LearnerAct, topics: readonly Concept[] = []): string {
  switch (act.kind) {
    case "begin": return beginText(act, topics);
    case "answer": return act.text;
    case "skip": return "(skipped this question)";
    case "dont_know": return "I don't know.";
    case "hint_request": return "(asked for a hint)";
    case "explain_request": return "(asked the tutor to explain it)";
    case "dispute": return `I dispute that: ${act.text}`;
    case "detour_accept": return "Yes, take the detour.";
    case "detour_decline": return "No, stay on the lecture.";
    case "detour_wait": return "I'll wait for the resource.";
    case "detour_continue_without_resource": return "Continue on the lecture evidence.";
    case "continue_past_target": return "Keep going.";
    case "wrap_up": return "Wrap up.";
    case "pause": return "(paused)";
    case "resume": return "(resumed)";
    case "end": return "(ended the review)";
  }
}

export const MOVE_LABEL: Readonly<Record<TutorMove["kind"], string>> = {
  ask_main: "Question",
  quick_check: "Quick check",
  ask_followup: "Follow-up",
  diagnose: "Possible mismatch (tentative)",
  hint: "Hint",
  explain: "Explanation",
  propose_detour: "Detour offered",
  detour_step: "Detour",
  answer_dispute: "On your dispute",
  disclose_correction: "Correction",
  close_thread: "Closing this question",
  wrap_up: "Wrap up",
};

export function noticeText(turn: Extract<Turn, { actor: "code" }>): string {
  const n = turn.notice;
  switch (n.kind) {
    case "soft_target_reached": return `You have been reviewing for ${formatDuration(n.elapsedS)}.`;
    case "correction_pending": return "The source changed under a claim in this review. The tutor will explain what changed.";
    case "resource_ready": return "A supplemental resource is ready.";
  }
}

export function conversationLines(turns: readonly Turn[], topics: readonly Concept[] = []): Line[] {
  const lines: Line[] = [];
  for (const t of turns) {
    switch (t.actor) {
      case "learner":
        if (t.act.kind === "begin") lines.push({ key: t.id, speaker: "system", label: "Note", text: learnerActText(t.act, topics), evidenceIds: [] });
        else lines.push({ key: t.id, speaker: "you", label: "You", text: learnerActText(t.act), evidenceIds: [] });
        break;
      case "tutor":
        if (t.say.trim() !== "") lines.push({ key: t.id, speaker: "tutor", label: MOVE_LABEL[t.move.kind], text: t.say, evidenceIds: moveEvidence(t.move) });
        break;
      case "code":
        lines.push({ key: t.id, speaker: "system", label: "Note", text: noticeText(t), evidenceIds: [] });
        break;
    }
  }
  return lines;
}

/** Acts that expect a tutor reply. Pause, resume and end do not. */
const EXPECTS_REPLY = (act: LearnerAct): boolean => act.kind !== "pause" && act.kind !== "resume" && act.kind !== "end";

/** The learner turn the tutor never answered, if it is the last substantive turn. Resending it reuses its id, so it cannot duplicate. */
export function unansweredLearnerTurn(turns: readonly Turn[]): Extract<Turn, { actor: "learner" }> | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.actor === "code") continue;
    return t.actor === "learner" && EXPECTS_REPLY(t.act) ? t : null;
  }
  return null;
}

/**
 * The learner turn whose request stopped part-way (the backend says the tutor owes a move). Resending its id
 * replays the stored moves and goes on, so it cannot duplicate. Null unless the review is active and owes a move.
 */
export function owedLearnerTurn(view: Pick<ReviewView, "turns" | "owesMove" | "state">): Extract<Turn, { actor: "learner" }> | null {
  if (!view.owesMove || view.state.phase !== "active") return null;
  for (let i = view.turns.length - 1; i >= 0; i--) {
    const t = view.turns[i]!;
    if (t.actor === "learner") return t;
  }
  return null;
}

/**
 * Flow D: "Soft target (default 10 min, configurable) reached at a natural pause → offer continue / wrap up. Never a forced cutoff."
 * The prompt stands from the code notice until the learner answers it.
 */
export function softTargetPrompt(turns: readonly Turn[]): { readonly elapsedS: number } | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.actor === "code" && t.notice.kind === "soft_target_reached") return { elapsedS: t.notice.elapsedS };
    if (t.actor === "learner" && (t.act.kind === "continue_past_target" || t.act.kind === "wrap_up")) return null;
  }
  return null;
}

// ───────────────────────────── Live tutor turn ──────────────────────────────

export type Live = {
  readonly turnId: string;
  readonly stored: boolean;
  readonly move: TutorMove | null;
  readonly deltaText: string;
  readonly sentences: readonly string[];
  readonly status: "streaming" | "complete" | "failed";
  readonly error: string | null;
  readonly retryable: boolean;
};

export const startLive = (turnId: string): Live => ({
  turnId, stored: false, move: null, deltaText: "", sentences: [], status: "streaming", error: null, retryable: false,
});

export function reduceLive(live: Live, event: TurnEvent): Live {
  switch (event.type) {
    case "learner_turn_stored": return { ...live, stored: true };
    case "move": return { ...live, move: event.move };
    // A request can hold several tutor moves; a move event closes one, so words after it belong to the next.
    case "say_delta": return live.move !== null ? { ...live, move: null, deltaText: event.text, sentences: [] } : { ...live, deltaText: live.deltaText + event.text };
    case "sentence": return live.move !== null ? { ...live, move: null, deltaText: "", sentences: [event.text] } : { ...live, sentences: [...live.sentences, event.text] };
    case "turn_complete": return { ...live, status: "complete" };
    case "turn_failed": return { ...live, status: "failed", error: event.error, retryable: event.retryable };
  }
}

/** Deltas show the text as it arrives; a replayed turn may carry sentences only. */
export const liveText = (live: Live): string => (live.deltaText !== "" ? live.deltaText : live.sentences.join(" "));

// ───────────────────────────── Voice answers ────────────────────────────────

/** The last thing speech recognition heard, and whether the recogniser called it final. */
export type Heard = { readonly text: string; readonly final: boolean };

/**
 * A spoken answer sends itself when recognition ends with a final, non-empty transcript and an answer is allowed.
 * An interim-only or empty transcript is never sent: it stays in the box to edit.
 */
export function shouldAutoSendSpeech(heard: Heard | null, answerAllowed: boolean): boolean {
  return heard !== null && heard.final && heard.text.trim() !== "" && answerAllowed;
}

/** The microphone should be off: there is no answer to give, or voice was switched off while listening. */
export function shouldStopListening(listening: boolean, answerPossible: boolean, voiceOn: boolean): boolean {
  return listening && (!answerPossible || !voiceOn);
}

export type TurnStatus =
  | { readonly kind: "idle"; readonly text: null }
  | { readonly kind: "listening"; readonly text: string; readonly transcript: string }
  | { readonly kind: "sending"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "replying"; readonly text: string };

/**
 * What the composer area says while a turn is under way: listening (with what was heard so far), sending the
 * learner's turn, the tutor thinking until its first words, then the tutor replying (its words show in the conversation).
 */
export function turnStatus(input: { readonly listening: boolean; readonly transcript: string; readonly submitting: boolean; readonly live: Live | null }): TurnStatus {
  const { live } = input;
  if (input.listening) return { kind: "listening", text: "Listening… speak your answer", transcript: input.transcript };
  if (input.submitting || (live !== null && live.status === "streaming" && !live.stored)) return { kind: "sending", text: "Sending…" };
  if (live !== null && live.status === "streaming") {
    return liveText(live) === "" ? { kind: "thinking", text: "Tutor is thinking…" } : { kind: "replying", text: "Tutor is replying…" };
  }
  return { kind: "idle", text: null };
}

// ───────────────────────────── Actions ──────────────────────────────────────

export type ActionId =
  | "answer" | "skip" | "dont_know" | "hint" | "explain" | "dispute"
  | "detour_accept" | "detour_decline" | "detour_wait" | "detour_continue"
  | "continue" | "wrap_up" | "pause" | "resume" | "end";

/** What the learner may do now. The backend is still the authority; this only hides acts that cannot apply. */
export function availableActions(state: ReviewState, softTargetOffer: boolean): readonly ActionId[] {
  if (state.phase === "ended") return [];
  if (state.phase === "paused") return ["resume", "end"];
  const nudge: ActionId[] = softTargetOffer ? ["continue", "wrap_up"] : [];
  switch (state.detour.kind) {
    case "proposed": return ["detour_accept", "detour_decline", ...nudge, "pause", "end"];
    case "awaiting_resource": return ["detour_wait", "detour_continue", ...nudge, "pause", "end"];
    case "none":
    case "active": return [...nudge, "answer", "skip", "dont_know", "hint", "explain", "dispute", "pause", "end"];
  }
}

export const ACTION_LABEL: Readonly<Record<ActionId, string>> = {
  answer: "Send answer",
  skip: "Skip",
  dont_know: "I don't know",
  hint: "Hint",
  explain: "Explain it",
  dispute: "Dispute",
  detour_accept: "Yes, take the detour",
  detour_decline: "No thanks",
  detour_wait: "Wait for the resource",
  detour_continue: "Continue without it",
  continue: "Keep going",
  wrap_up: "Wrap up",
  pause: "Pause",
  resume: "Resume",
  end: "End review",
};

/**
 * Ending a review cannot be undone, so the End button only asks; the act is sent by the confirm step alone.
 * Pause and every other action stay one click.
 */
export type EndStep = "idle" | "confirming";
export type EndEvent = "press_end" | "confirm" | "cancel";

export function endFlow(step: EndStep, event: EndEvent): { readonly step: EndStep; readonly send: boolean } {
  if (event === "press_end") return { step: "confirming", send: false };
  if (event === "confirm") return { step, send: step === "confirming" };
  return { step: "idle", send: false };
}

export const END_CONFIRM_TEXT = "End this review? You can't reopen it.";

/** Acts that carry text. */
export const NEEDS_TEXT: ReadonlySet<ActionId> = new Set(["answer", "dispute"]);

export function toAct(id: ActionId, text: string, modality: "speech" | "text"): LearnerAct {
  switch (id) {
    case "answer": return { kind: "answer", text, modality };
    case "dispute": return { kind: "dispute", text };
    case "skip": return { kind: "skip" };
    case "dont_know": return { kind: "dont_know" };
    case "hint": return { kind: "hint_request" };
    case "explain": return { kind: "explain_request" };
    case "detour_accept": return { kind: "detour_accept" };
    case "detour_decline": return { kind: "detour_decline" };
    case "detour_wait": return { kind: "detour_wait" };
    case "detour_continue": return { kind: "detour_continue_without_resource" };
    case "continue": return { kind: "continue_past_target" };
    case "wrap_up": return { kind: "wrap_up" };
    case "pause": return { kind: "pause" };
    case "resume": return { kind: "resume" };
    case "end": return { kind: "end" };
  }
}

/** Evidence the latest tutor move points at. A main question points at none, so the source never gives the answer away. */
export function moveEvidence(move: TutorMove | null): readonly EvidenceId[] {
  if (move === null) return [];
  switch (move.kind) {
    case "diagnose":
    case "explain":
    case "answer_dispute":
    case "disclose_correction":
      return move.evidence;
    default:
      return [];
  }
}

/** Evidence for the pane beside the conversation: the live move if one is streaming, else the latest tutor turn that cites some. */
export function currentEvidenceIds(turns: readonly Turn[], live: Live | null): readonly EvidenceId[] {
  if (live?.move?.kind === "ask_main" || live?.move?.kind === "quick_check") return [];
  const fromLive = live === null ? [] : moveEvidence(live.move);
  if (fromLive.length > 0) return fromLive;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.actor !== "tutor") continue;
    const ids = moveEvidence(t.move);
    if (ids.length > 0) return ids;
    if (t.move.kind === "ask_main" || t.move.kind === "quick_check") return [];
  }
  return [];
}

// ───────────────────────────── Observations and the record ──────────────────

export const STATUS_LABEL: Readonly<Record<RecordedStatus, string>> = {
  independent: "Independent",
  partial: "Partial",
  after_help: "After help",
  unresolved: "Unresolved",
  not_assessed: "Not assessed",
  disputed: "Disputed",
  looks_fine: "Looks fine (quick check)",
};

export type ObservationRow = { readonly id: Observation["id"]; readonly status: string; readonly note: string | null; readonly disputeOpen: boolean };

/** Why the saved status differs from what the tutor proposed. Display only; the backend's clamp decides. */
export function observationRow(o: Observation): ObservationRow {
  const disputeOpen = o.dispute.kind === "open" || o.dispute.kind === "unsettled";
  let note: string | null = null;
  if (o.status === "disputed") note = "Disputed assessments are not counted as a learning gap unless you resolve them that way.";
  else if (o.status === "looks_fine") note = "A quick check only shows the topic looks fine; it is not recorded as understood.";
  else if (o.clampedFrom !== null) {
    const f = o.facts;
    const reason =
      o.dispute.kind === "resolved_by_learner" && o.dispute.outcome === "it_was_my_gap"
        ? "you chose to revisit this topic"
        : f.endedBySkip || f.saidDontKnowOnly
          ? "the question was skipped or left unanswered"
          : f.firstHelpSeq !== null && (f.firstSubstantiveAnswerSeq === null || f.firstHelpSeq < f.firstSubstantiveAnswerSeq)
            ? "the tutor helped before your answer"
            : "the record rules";
    note = `The tutor proposed "${STATUS_LABEL[o.clampedFrom]}"; recorded as "${STATUS_LABEL[o.status]}" because ${reason}.`;
  } else if (o.dispute.kind === "resolved_by_learner") {
    const outcome = o.dispute.outcome;
    note = DISPUTE_CHOICES.find((c) => c.outcome === outcome)?.resolvedNote ?? null;
  }
  return { id: o.id, status: STATUS_LABEL[o.status], note, disputeOpen };
}

/**
 * How the learner settles an open dispute, in neutral words. `outcome` is the existing record.resolveDispute value;
 * `null` keeps the dispute open, which is also what doing nothing does.
 */
export const DISPUTE_CHOICES = [
  {
    outcome: null,
    label: "Keep unresolved",
    meaning: "Stays disputed. It is not counted as a learning gap, and you can decide later.",
    resolvedNote: null,
  },
  {
    outcome: "learner_was_right",
    label: "My explanation was supported",
    meaning: "Closes the dispute. The tutor's assessment stays visible for reference but is not counted as a learning gap.",
    resolvedNote: "You marked your explanation as supported. The tutor's assessment is kept for reference and is not counted as a learning gap.",
  },
  {
    outcome: "it_was_my_gap",
    label: "I want to revisit this",
    meaning: "Closes the dispute and counts this topic as something to revisit (a learning gap).",
    resolvedNote: "You chose to revisit this topic, so it is counted as a learning gap.",
  },
] as const satisfies readonly { readonly outcome: "learner_was_right" | "it_was_my_gap" | null; readonly label: string; readonly meaning: string; readonly resolvedNote: string | null }[];

export type DisputeOutcome = NonNullable<(typeof DISPUTE_CHOICES)[number]["outcome"]>;

/** What a notebook row shows so the learner knows which assessment they are changing before they change it. */
export type ObservationContext = {
  /** The topic's name, or names when the thread covered more than one. */
  readonly topic: string | null;
  readonly kind: "Question" | "Quick check";
  readonly question: string | null;
  /** What the learner did on the thread: their answers, or that they skipped or did not know. */
  readonly answers: readonly string[];
  /** The learner's own words when they disputed the assessment. */
  readonly dispute: string | null;
  /** The tutor's assessment as it proposed it, before any record rule or dispute. */
  readonly assessed: string;
  /** The tutor's written reason, latest first: its reply to the dispute, else its reading of the answer. */
  readonly reasoning: { readonly label: string; readonly text: string } | null;
  /** Lecture evidence the tutor cited on this thread. */
  readonly evidence: readonly EvidenceId[];
};

const CONTEXT_ANSWER_ACTS: ReadonlySet<LearnerAct["kind"]> = new Set(["answer", "skip", "dont_know"]);

export function observationContext(o: Observation, review: Pick<ReviewView, "topics" | "turns"> | null): ObservationContext {
  const turns = review?.turns ?? [];
  const names = o.conceptIds.flatMap((id) => review?.topics.find((t) => t.id === id)?.label ?? []);
  const asked = turns.find((t) => t.actor === "tutor" && (t.move.kind === "ask_main" || t.move.kind === "quick_check") && t.move.threadId === o.threadId);
  const kind = asked?.actor === "tutor" && asked.move.kind === "quick_check" ? "Quick check" : "Question";
  const answers = o.facts.learnerTurns.flatMap((id) => {
    const t = turns.find((turn) => turn.id === id);
    return t?.actor === "learner" && CONTEXT_ANSWER_ACTS.has(t.act.kind) ? [learnerActText(t.act)] : [];
  });
  const onThread = turns.filter((t) => t.threadId === o.threadId || (t.actor === "tutor" && t.move.kind === "disclose_correction" && t.move.threadIds.includes(o.threadId)));
  const disputeTurn = onThread.findLast((t) => t.actor === "learner" && t.act.kind === "dispute");
  const dispute = disputeTurn?.actor === "learner" && disputeTurn.act.kind === "dispute" ? disputeTurn.act.text : null;
  let reasoning: ObservationContext["reasoning"] = null;
  for (const t of onThread.toReversed()) {
    if (t.actor !== "tutor") continue;
    if (t.move.kind === "answer_dispute" && t.say.trim() !== "") reasoning = { label: "The tutor's reply to your dispute", text: t.say };
    else if (t.move.kind === "diagnose" && t.move.hypothesis.trim() !== "") reasoning = { label: "The tutor's reading of your answer", text: t.move.hypothesis };
    if (reasoning !== null) break;
  }
  const evidence = [...new Set(onThread.flatMap((t) => (t.actor === "tutor" ? moveEvidence(t.move) : [])))];
  return {
    topic: names.length > 0 ? names.join(" · ") : null,
    kind,
    question: asked?.actor === "tutor" ? asked.say : null,
    answers,
    dispute,
    assessed: STATUS_LABEL[o.proposed],
    reasoning,
    evidence,
  };
}

export const AUTHOR_LABEL: Readonly<Record<Author, string>> = { learner: "You", tutor: "Tutor", source: "Lecture" };

export type NoteView = {
  readonly id: Note["id"];
  readonly segments: readonly { readonly author: Author; readonly label: string; readonly text: string; readonly evidence: readonly EvidenceId[] }[];
  readonly userEdit: string | null;
};

/** A note keeps who said what. Your edit sits beside the generated text and never replaces it. */
export function noteView(note: Note): NoteView {
  return {
    id: note.id,
    segments: note.generated.map((s) => ({ author: s.author, label: AUTHOR_LABEL[s.author], text: s.text, evidence: s.evidence })),
    userEdit: note.userEdit,
  };
}

// ───────────────────────────── Evidence inspector ───────────────────────────

export type BundleReport = {
  readonly watched: readonly { readonly source: string; readonly intervals: readonly string[]; readonly seconds: number }[];
  readonly passages: number;
  readonly frames: { readonly total: number; readonly kept: number; readonly uncertain: number };
  readonly gaps: readonly { readonly where: string; readonly channel: string; readonly reason: string }[];
  readonly ads: readonly { readonly where: string; readonly seconds: number }[];
  /** Watched time with neither a passage nor a logged gap: capture-probe bar 1 says this must be empty. */
  readonly uncovered: readonly { readonly source: string; readonly interval: string }[];
};

export function inspectBundle(bundle: EvidenceBundle, titles: SourceTitles = new Map()): BundleReport {
  const covered = new Map<SourceId, IntervalSet>();
  const cover = (source: SourceId, i: Interval) => covered.set(source, (covered.get(source) ?? IntervalSet.empty).union(IntervalSet.of([i])));
  for (const p of bundle.passages) cover(p.sourceId, p.interval);
  for (const g of bundle.gaps) cover(g.sourceId, g.interval);
  const coveredMaterial: Material = Material.of([...covered].map(([s, set]) => [s, set.intervals()] as const));
  const uncovered = Material.subtract(bundle.material, coveredMaterial);

  const rows = (m: Material) =>
    Material.sources(m).map((s) => ({ source: titleOf(titles, s), intervals: Material.get(m, s).intervals().map(formatInterval), seconds: Material.get(m, s).duration() }));

  return {
    watched: rows(bundle.material),
    passages: bundle.passages.length,
    frames: {
      total: bundle.frames.length,
      kept: bundle.frames.filter((f) => f.teaching === "kept").length,
      uncertain: bundle.frames.filter((f) => f.teaching === "uncertain" || f.teaching === "unjudged").length,
    },
    gaps: bundle.gaps.map((g: Gap) => ({ where: `${titleOf(titles, g.sourceId)}, ${formatInterval(g.interval)}`, channel: g.channel, reason: GAP_LABEL[g.reason] })),
    ads: bundle.ads.map((a) => ({ where: `${titleOf(titles, a.sourceId)}, at ${formatClock(a.atContentS)}`, seconds: a.wallDurationMs / 1000 })),
    uncovered: rows(uncovered).flatMap((r) => r.intervals.map((interval) => ({ source: r.source, interval }))),
  };
}

// ───────────────────────────── Usage ────────────────────────────────────────

export type UsageRow = { readonly kind: string; readonly calls: number; readonly amount: string };

const KIND_LABEL = {
  measured: "Measured",
  notional: "Notional (subscription)",
  estimated: "Estimated",
  unknown: "Unknown",
} as const satisfies Record<keyof UsageSummary["byKind"], string>;

/**
 * R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
 * Totals stay per kind. A kind with no amount reads "unknown", never "$0".
 */
export function usageRows(summary: UsageSummary): UsageRow[] {
  return (Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => {
    const { calls, usd } = summary.byKind[k];
    const amount = calls === 0 ? "none" : k === "unknown" || usd === null ? "unknown" : usd > 0 && usd < 0.0001 ? "<$0.0001" : `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
    return { kind: KIND_LABEL[k], calls, amount };
  });
}

// ───────────────────────────── Routing ──────────────────────────────────────

export type Route =
  | { readonly page: "home" }
  | { readonly page: "capture"; readonly id: string }
  | { readonly page: "review"; readonly id: string }
  | { readonly page: "record"; readonly reviewId: string | null }
  | { readonly page: "usage" }
  | { readonly page: "not_found" };

/** `/app/capture/<id>`, `/app/review/<id>`, `/app/record[/<reviewId>]`, `/app/usage`. */
export function parseRoute(pathname: string): Route {
  let parts: string[];
  try {
    parts = pathname.replace(/^\/app(?=\/|$)/, "").split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { page: "not_found" };
  }
  const [page, id] = parts;
  if (page === "capture" && id) return { page: "capture", id };
  if (page === "review" && id) return { page: "review", id };
  if (page === "record") return { page: "record", reviewId: id ?? null };
  if (page === "usage") return { page: "usage" };
  return { page: "home" };
}

export const routePath = (r: Route): string => {
  switch (r.page) {
    case "home":
    case "not_found": return "/app/";
    case "capture": return `/app/capture/${encodeURIComponent(r.id)}`;
    case "review": return `/app/review/${encodeURIComponent(r.id)}`;
    case "record": return r.reviewId === null ? "/app/record" : `/app/record/${encodeURIComponent(r.reviewId)}`;
    case "usage": return "/app/usage";
  }
};

export type SourceSelection =
  | { readonly kind: "automatic" }
  | { readonly kind: "pinned"; readonly ids: readonly EvidenceId[]; readonly label: string };

export function selectedEvidenceIds(selection: SourceSelection, automatic: readonly EvidenceId[]): readonly EvidenceId[] {
  return selection.kind === "pinned" ? selection.ids : automatic;
}

export function shouldSubmitAnswer(
  key: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly isComposing: boolean; readonly repeat: boolean },
  hasAnswer: boolean, disabled: boolean, draft: string,
): boolean {
  return key.key === "Enter" && (key.ctrlKey || key.metaKey) && !key.isComposing && !key.repeat && hasAnswer && !disabled && draft.trim() !== "";
}
