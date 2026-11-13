/**
 * Pure view logic for the review app: everything a screen decides, with no
 * React and no IO. Screens render what these return.
 */
import { heldMessage, resetDay } from "../shared/allowance";
import type {
  Allowance, Author, CaptureView, Claim, Concept, EvidenceBundle, Gap, GapReason, LearnerAct, Note, Observation, PartialReason, RecordedStatus, ReviewOptions,
  ReviewState, ReviewView, ScopePreview, StartChoice, Turn, TurnEvent, TutorMove, UsageSummary,
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

/** What a capture gap means for a review. Each line names only the channel that is missing; the other channels from that stretch stay in the evidence. */
export const GAP_CONSEQUENCE: Readonly<Record<Gap["channel"], string>> = {
  transcript: "No transcript text from this stretch is in the evidence. Any frames saved from it still are.",
  frames: "No frames from this stretch are in the evidence. Its transcript text, if captured, still is.",
  playback: "Playback was not fully recorded near here, so some watched time may be missing from the evidence.",
};

export function partialText(reason: PartialReason, titles: SourceTitles = new Map()): string {
  switch (reason.kind) {
    case "capture_gap":
      return `${GAP_LABEL[reason.gap.reason]} in ${titleOf(titles, reason.gap.sourceId)}, ${formatInterval(reason.gap.interval)}. ${GAP_CONSEQUENCE[reason.gap.channel]}`;
    case "stopped_early":
      return `Preparation was stopped early; ${reason.droppedClaims} claim${reason.droppedClaims === 1 ? "" : "s"} left out.`;
    case "unverified_claims":
      return `${reason.count} claim${reason.count === 1 ? " was" : "s were"} not confirmed by the source and will not be used to assess you.`;
    case "chunks_still_preparing":
      return `${reason.count} section${reason.count === 1 ? " is" : "s are"} still preparing and not included.`;
  }
}

/**
 * Capture gaps grouped per video, reason and channel, so a long capture shows one line per
 * kind of gap instead of one per stretch. A group of one keeps its exact interval.
 * The channel is in the key because `channel_failed` happens on any channel, and each line says which one is missing.
 */
export function groupGaps(gaps: readonly Gap[], titles: SourceTitles = new Map()): readonly { readonly where: string; readonly reason: string; readonly count: number; readonly channel: Gap["channel"] }[] {
  const groups = new Map<string, Gap[]>();
  for (const g of gaps) {
    const key = `${g.reason}\u0000${g.channel}\u0000${g.sourceId}`;
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
      channel: first.channel,
    };
  });
}

/** Why a review is partial, one line per reason; capture gaps are grouped as in groupGaps, in the place their first gap held. */
export function partialLines(reasons: readonly PartialReason[], titles: SourceTitles = new Map()): readonly string[] {
  const gaps = reasons.flatMap((r) => (r.kind === "capture_gap" ? [r.gap] : []));
  const grouped = groupGaps(gaps, titles);
  const firstGap = reasons.findIndex((r) => r.kind === "capture_gap");
  const lines = reasons.filter((r) => r.kind !== "capture_gap").map((r) => partialText(r, titles));
  const gapLines = grouped.map((g) => `${g.reason} in ${g.where}. ${GAP_CONSEQUENCE[g.channel]}`);
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

/**
 * What a review started now would cover, in the learner's terms: the named topics, the watched stretches, and its
 * limits. `supportedClaims` is only for the case with no topic names; a claim count is never shown as a topic count.
 */
export type ScopeSummary = {
  readonly topics: readonly string[];
  readonly supportedClaims: number;
  readonly covered: readonly string[];
  readonly limits: readonly string[];
};

export type OptionsScreen =
  | {
      readonly kind: "ready";
      readonly scope: ScopeSummary;
      readonly offers: readonly StartOffer[];
    }
  | {
      readonly kind: "processing";
      /** Null unless the backend gave a usable estimate: an unreliable estimate is never invented. */
      readonly estimate: string | null;
      readonly pendingChunks: number;
      readonly ready: ScopeSummary | null;
      /** The first offer is the usual start; the rest are secondary and say what they give up. */
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

const sections = (n: number): string => `${n} section${n === 1 ? "" : "s"}`;

/** One line per video: its watched stretch, or how many stretches and their total when there are several. */
export function coveredLines(material: Material, titles: SourceTitles = new Map()): readonly string[] {
  return Material.sources(material).flatMap((id) => {
    const spans = Material.get(material, id).intervals();
    const only = spans[0];
    if (only === undefined) return [];
    const total = spans.reduce((sum, i) => sum + (i.end - i.start), 0);
    return [spans.length === 1 ? `${titleOf(titles, id)}, ${formatInterval(only)}` : `${titleOf(titles, id)}, ${spans.length} stretches, ${formatClock(total)} in all`];
  });
}

export function scopeSummary(scope: ScopePreview, titles: SourceTitles = new Map()): ScopeSummary {
  return {
    topics: scope.topics.map((t) => t.label),
    supportedClaims: scope.supportedClaims,
    covered: coveredLines(scope.material, titles),
    limits: partialLines(scope.partial, titles),
  };
}

export function optionsScreen(options: ReviewOptions, titles: SourceTitles = new Map(), videos: SourceVideos = new Map()): OptionsScreen {
  switch (options.kind) {
    case "ready":
      return {
        kind: "ready",
        scope: scopeSummary(options.scope, titles),
        offers: [{ choice: "prepared_only", label: "Start review", note: "" }],
      };
    case "processing": {
      const ready = options.readyNow;
      const one = options.pendingChunks === 1;
      const rest = sections(options.pendingChunks);
      return {
        kind: "processing",
        estimate: estimateText(options.estimateS),
        pendingChunks: options.pendingChunks,
        // The pending sections get their own sentence on this screen, so they are not repeated as a limit.
        ready: ready && scopeSummary({ ...ready, partial: ready.partial.filter((r) => r.kind !== "chunks_still_preparing") }, titles),
        offers: ready
          ? [
              { choice: "prepared_only", label: "Start with ready topics", note: `${one ? "The other section keeps" : `The other ${rest} keep`} preparing for a later review.` },
              {
                choice: "stop_early",
                label: "Stop preparing and start",
                note: `Cancels the preparation still running for ${rest}. Anything ${one ? "it has" : "they have"} already checked joins this review. Anything not yet checked is left out.`,
              },
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
    case "correction_applied": return "The source changed under a claim this review has not asked about yet.";
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
        // A silently applied correction is logged for the record, not shown in the conversation (#137).
        if (t.notice.kind === "correction_applied") break;
        lines.push({ key: t.id, speaker: "system", label: "Note", text: noticeText(t), evidenceIds: [] });
        break;
    }
  }
  return lines;
}

/**
 * Splits the conversation into earlier lines and the current exchange: the tutor's latest run of lines (the question
 * being worked on) and anything after it, such as the learner's answer awaiting a reply. The review keeps the current
 * exchange beside the composer and the earlier lines in their own scrollable history.
 */
export function currentExchange(lines: readonly Line[]): { readonly earlier: readonly Line[]; readonly current: readonly Line[] } {
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.speaker === "tutor") { start = i; break; }
  while (start > 0 && start < lines.length && lines[start - 1]!.speaker === "tutor") start--;
  return { earlier: lines.slice(0, start), current: lines.slice(start) };
}

/** What the board needs to place a line: its scroll box and the line's edges measured from the top of the scrolled content. */
export type RevealBox = { readonly scrollTop: number; readonly clientHeight: number; readonly scrollHeight: number };

/**
 * Where to scroll a board so the tutor's question is in view, or null when nothing should move. A question is the end of
 * the tutor's reply, so a line that fits the board must be wholly in view and a line taller than the board must show its
 * last lines. The bottom edge is the anchor in both cases, and `gap` leaves a little room under it.
 */
export function questionScrollTop(box: RevealBox, line: { readonly top: number; readonly bottom: number }, gap = 12): number | null {
  const viewTop = box.scrollTop;
  const viewBottom = box.scrollTop + box.clientHeight;
  const fits = line.bottom - line.top <= box.clientHeight;
  const inView = fits ? line.top >= viewTop && line.bottom <= viewBottom : line.bottom > viewTop && line.bottom <= viewBottom;
  if (inView) return null;
  // Anchor on the line's end, but never past a line's start when the whole line fits: the gap gives way first.
  const anchored = line.bottom + gap - box.clientHeight;
  const wanted = fits ? Math.min(anchored, line.top) : anchored;
  const target = Math.min(Math.max(wanted, 0), Math.max(box.scrollHeight - box.clientHeight, 0));
  return target === box.scrollTop ? null : target;
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
 * The learner `end` the tutor never wrapped up: the last non-code turn is a learner end and the review is still active,
 * so the wrap-up call failed after the end was stored. Resending its id replays the stored turn and goes on, so it cannot duplicate.
 * Kept apart from unansweredLearnerTurn, which pause and end are deliberately not part of.
 */
export function strandedEndTurn(view: Pick<ReviewView, "turns" | "state">): Extract<Turn, { actor: "learner" }> | null {
  if (view.state.phase !== "active") return null;
  for (let i = view.turns.length - 1; i >= 0; i--) {
    const t = view.turns[i]!;
    if (t.actor === "code") continue;
    return t.actor === "learner" && t.act.kind === "end" ? t : null;
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
  /** `held`: a budget refused the tutor's call before it began, and `error` holds the words to show. */
  readonly status: "streaming" | "complete" | "failed" | "held";
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
    case "say_reset": return { ...live, deltaText: "", sentences: [] };
    case "turn_complete": return { ...live, status: "complete" };
    case "turn_failed": return { ...live, status: "failed", error: event.error, retryable: event.retryable };
    case "turn_held": return { ...live, status: "held", error: heldMessage(event.hold), retryable: false };
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

/**
 * Where keyboard focus goes when the starting-point form gives way to the conversation. Only the learner's own start moves
 * focus, once: to the start status while the first reply is pending, then to the first question if focus is still on that
 * status or nowhere. A reloaded review and every later reply leave focus where the learner put it.
 */
export type StartHandoff = "none" | "submitted" | "waiting";
export function stepStartHandoff(step: StartHandoff, now: { readonly checklist: boolean; readonly question: boolean; readonly focusFree: boolean }): { readonly step: StartHandoff; readonly focus: "status" | "question" | null } {
  if (step === "none" || (step === "submitted" && now.checklist)) return { step, focus: null };
  if (now.checklist) return { step: "none", focus: null };
  if (!now.question) return step === "submitted" ? { step: "waiting", focus: "status" } : { step, focus: null };
  return { step: "none", focus: step === "submitted" || now.focusFree ? "question" : null };
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
  end: "Finish & save",
};

/**
 * Finishing a review cannot be undone, so the Finish & save button only asks; the act is sent by the confirm step alone.
 * Pause and every other action stay one click.
 */
export type EndStep = "idle" | "confirming";
export type EndEvent = "press_end" | "confirm" | "cancel";

export function endFlow(step: EndStep, event: EndEvent): { readonly step: EndStep; readonly send: boolean } {
  if (event === "press_end") return { step: "confirming", send: false };
  if (event === "confirm") return { step, send: step === "confirming" };
  return { step: "idle", send: false };
}

/** Says what finishing stops for good and what stays: the saved record, and this review to reread. */
export const END_CONFIRM_TEXT = "Finish and save this review? The conversation ends and can't be continued. Your notes and results stay in your notebook, and you can reread this review.";

/**
 * Where the composer offers each act. Help a stuck learner needs sits beside Share my thinking; the less frequent acts
 * stay in the menu. Pause, resume and end live in the header and are never passed to the composer.
 */
const COMPOSER_PLACEMENT: Partial<Readonly<Record<ActionId, "assist" | "more">>> = {
  hint: "assist", dont_know: "assist", skip: "more", explain: "more", dispute: "more",
};

export function composerActions(actions: readonly ActionId[]): { readonly primary: readonly ActionId[]; readonly assist: readonly ActionId[]; readonly more: readonly ActionId[] } {
  const at = (place: "assist" | "more" | undefined) => actions.filter((id) => COMPOSER_PLACEMENT[id] === place);
  return { primary: at(undefined), assist: at("assist"), more: at("more") };
}

type ShownFrame = { readonly id: EvidenceId; readonly sourceId: SourceId; readonly mediaS: number };
const frameKey = (f: ShownFrame) => `${f.sourceId}@${formatClock(f.mediaS)}`;

/**
 * The frames worth drawing, in order. Two frames of one source at the same displayed time look the same, so only the
 * first is kept, and a frame already drawn elsewhere on the panel (the topic diagram's) is not drawn again.
 */
export function distinctFrames<F extends ShownFrame>(frames: readonly F[], shownElsewhere: ShownFrame | null): { readonly frames: readonly F[]; readonly alreadyShown: boolean } {
  const seen = new Set<string>(shownElsewhere === null ? [] : [shownElsewhere.id, frameKey(shownElsewhere)]);
  let alreadyShown = false;
  const kept = frames.filter((f) => {
    const duplicate = seen.has(f.id) || seen.has(frameKey(f));
    if (duplicate && shownElsewhere !== null && (f.id === shownElsewhere.id || frameKey(f) === frameKey(shownElsewhere))) alreadyShown = true;
    seen.add(f.id);
    seen.add(frameKey(f));
    return !duplicate;
  });
  return { frames: kept, alreadyShown };
}

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
      f.endedBySkip || f.saidDontKnowOnly
        ? "the question was skipped or left unanswered"
        : f.firstHelpSeq !== null && (f.firstSubstantiveAnswerSeq === null || f.firstHelpSeq < f.firstSubstantiveAnswerSeq)
          ? "the tutor helped before your answer"
          : "the record rules";
    note = `The tutor proposed "${STATUS_LABEL[o.clampedFrom]}"; recorded as "${STATUS_LABEL[o.status]}" because ${reason}.`;
  } else if (o.dispute.kind === "resolved_by_learner") {
    note = o.dispute.outcome === "it_was_my_gap" ? "You chose to revisit this topic, so it counts as a learning gap." : "You marked your explanation as supported, so this is not counted as a learning gap.";
  }
  return { id: o.id, status: STATUS_LABEL[o.status], note, disputeOpen };
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

const dollars = (usd: number): string => (usd > 0 && usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** The month's allowance as the usage page states it. Null when no budget runs (replay mode). */
export function allowanceView(a: Allowance | null): { readonly line: string; readonly held: string | null } | null {
  if (a === null) return null;
  const line =
    a.limitUsd === null
      ? `${dollars(a.usedUsd)} counted this month, with no monthly cap. The month resets on ${resetDay(a.resetsAtMs)}.`
      : `${dollars(a.usedUsd)} of your ${dollars(a.limitUsd)} AI allowance used this month. It resets on ${resetDay(a.resetsAtMs)}.`;
  return { line, held: a.held === null ? null : heldMessage(a.held) };
}

// ───────────────────────────── Routing ──────────────────────────────────────

export type Route =
  | { readonly page: "home" }
  | { readonly page: "capture"; readonly id: string }
  | { readonly page: "review"; readonly id: string }
  | { readonly page: "record"; readonly reviewId: string | null }
  | { readonly page: "usage" }
  | { readonly page: "connect_extension" }
  | { readonly page: "not_found" };

/** `/app/capture/<id>`, `/app/review/<id>`, `/app/record[/<reviewId>]`, `/app/usage`, `/app/connect-extension`. */
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
  if (page === "connect-extension") return { page: "connect_extension" };
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
    case "connect_extension": return "/app/connect-extension";
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
