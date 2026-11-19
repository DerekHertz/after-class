/**
 * Invites + reviews, flows C (bottom half) and D (W7). Owns: invite_answers,
 * reviews (FrozenScope snapshot, written once), review_turns (append-only).
 *
 * One store serves one user (the `UserDb` it is built on): every query reads or writes with that user_id. A review id is
 * minted by the app and belongs to the first user that starts it, for good (reviews are never deleted), so the turn ids and
 * notes derived from it stay one user's. A turn id is minted by the app too and keys by (user_id, id), so another user's
 * turn id never finds, replays or blocks this user's turn.
 *
 * R9: "Starting a review doesn't stop capture, and stopping capture doesn't end a review."
 * A dependency fact: this module never imports evidence/, and evidence/ never
 * imports this module (test/boundaries.test.ts). Readers get capture data
 * through the deps below.
 *
 *   const opts = reviews.options(captureId);                       // ready | processing | nothing_to_review
 *   const r = reviews.start(captureId, "prepared_only", reviewId); // reviewId minted by the app
 *   for await (const ev of reviews.turn(reviewId, turnId, act)) send(ev);
 */
import { stableId } from "../../shared/ids";
import type { CaptureId, ChunkId, ChunkRevisionId, ClaimId, ConceptId, EvidenceId, ReviewId, ThreadId, TurnId } from "../../shared/ids";
import type {
  AssessableClaim, BudgetHold, ChunkPrep, ChunkRevision, Claim, CodeNotice, Concept, Correction, EvidenceBundle, FrozenScope, HeldBack, InviteAnswer, InviteAnswered, InviteState,
  LearnerAct, LectureAsk, ReviewOptions, ReviewView, ScopePreview, Seq, StartChoice, StartResult, Turn, TurnEvent, TutorMove,
} from "../../shared/domain";
import { Material } from "../../shared/time";
import { asSeq } from "../db";
import type { UserDb } from "../db";
import { PAID_TUTOR_HOLD } from "../providers/budget";
import type { Memo, RunResult } from "../providers/memo";
import { MAX_MAIN_QUESTIONS, allowedMoves, askedClaims, parseMoveHeader, reviewState, settledCorrections, validateMove, validateSay, tutorOwesMove, waitsForLearner } from "./tutor";
import type { TutorInput, TutorOutput } from "./tutor";
import { NOTHING_TO_ASK_LINE, WRAP_UP_LINE } from "./clamp";
import {
  corrections as deriveCorrections, decodeScope, encodeScope, foldInvites, freezeScope, takeSentences, unreviewed, usableInScope,
} from "./core";
import type { InviteEvent } from "./core";

export type Reviews = {
  invite(captureId: CaptureId): InviteState;
  /**
   * User fact.
   * R5: "Choosing Later never cancels preparation."
   * `later` changes only invite state. `review_now` and `wait` also ask for the lecture's review, so its preparation starts
   * (flow C, 2026-11-18). Starting a review goes through start(). The result names the ask the answer opened or joined, if any.
   */
  answerInvite(captureId: CaptureId, answer: InviteAnswer): InviteAnswered;
  /** "Review now always available": callable any time, regardless of invite state. */
  options(captureId: CaptureId): ReviewOptions;
  /**
   * Idempotent on the app-minted reviewId: a retried start returns the stored scope.
   *   stop_early → stopEarly(pending unreviewed chunks) first.
   *   scope = unreviewed ∧ finished chunk revisions; claims = assessableIn(material)
   * R10: "A review never starts with zero supported claims in scope."
   * Claims empty → nothing_to_review, and no review row is written. So is a scope whose every claim an open or answered review of the
   * lecture already took, or a grown chunk offered whole would start the same review again.
   */
  start(captureId: CaptureId, choice: StartChoice, reviewId: ReviewId): StartResult;
  /**
   * Flow C, 2026-11-18: "start the review once a prepared chunk has a supported claim. Its scope is the chunks prepared at that moment."
   * The backend calls this whenever the lecture's preparation may have changed. With an open ask and a supported claim it starts the
   * review the ask names, which closes the ask in the same transaction, so a retry or a restart never starts a second one. When nothing
   * can answer the open ask any more, it ends the ask exhausted. Returns the review started, or null.
   */
  startAsked(captureId: CaptureId): ReviewId | null;
  /**
   * Header-first (SYNTHESIS graft 1). The learner turn is committed before any
   * model call, so a failed call never loses what the learner said, and a
   * resend of the same turnId replays the stored reply instead of paying twice.
   * The tutor's header is validated before a word is spoken; an invalid header
   * aborts the call and gets one repair attempt, then a code-authored move.
   * The `move` event follows the prose and is sent only once the turn is stored,
   * after the move passed validateMove again against the claims usable then.
   */
  turn(reviewId: ReviewId, turnId: TurnId, act: LearnerAct): AsyncIterable<TurnEvent>;
  view(reviewId: ReviewId): ReviewView;
  /** Read-only: the reviews started on a capture, newest first, for the home page's list. */
  list(captureId: CaptureId): readonly { readonly reviewId: ReviewId; readonly startedMs: number }[];
  /**
   * Whether another user's review has this id. A review id is unique across users, so `start` throws `RangeError` for one and
   * `http.ts` answers 404 for it. An id nobody holds is false, and its routes keep their old answer (404 for a review that does not exist).
   */
  heldByAnotherUser(reviewId: ReviewId): boolean;
};

/** The W8 functions this module calls. Injectable so tests can run before the tutor lands. */
export type TutorKit = {
  readonly reviewState: typeof reviewState;
  readonly allowedMoves: typeof allowedMoves;
  readonly parseMoveHeader: typeof parseMoveHeader;
  readonly validateMove: typeof validateMove;
};

export type ReviewsOptions = {
  /** Flow D soft target, default 10 minutes of active review time. */
  readonly softTargetS?: number;
  /** Flow C: a time-cap close invites only after this many watched seconds since the last invite or Later. */
  readonly timeInviteGapS?: number;
  readonly now?: () => number;
  /** Seconds to finish `pendingChunks` chunks, or null when the scheduler has no reliable estimate. */
  readonly estimateS?: (pendingChunks: number) => number | null;
  readonly tutor?: TutorKit;
};

export type ReviewsDeps = {
  currentChunks(captureId: CaptureId): readonly ChunkRevision[];
  /** Segmentation's `history`: every revision of a chunk, oldest first. */
  chunkHistory(chunkId: ChunkId): readonly ChunkRevision[];
  prep(id: ChunkRevisionId): ChunkPrep;
  stopEarly(captureId: CaptureId, ids: readonly ChunkRevisionId[]): Seq;
  assessableIn(captureId: CaptureId, material: Material): readonly AssessableClaim[];
  claimsIn(captureId: CaptureId, material: Material): readonly Claim[];
  /** Preparation's `concepts`: label and summary for each known concept ID, in the order asked. */
  concepts?(ids: readonly ConceptId[]): readonly Concept[];
  bundle(material: Material): EvidenceBundle;
  watchedSeconds(captureId: CaptureId): number;
  runTutor(input: TutorInput, streamTo: (delta: string) => void, signal: AbortSignal, onRetry: () => void): Promise<RunResult<TutorOutput>>;
  /** The memo's: a resend clears the stored terminal failure of its tutor call so the model is asked again. */
  clearFailures: Memo["clearFailures"];
  /**
   * Starts the summary the save will read, without waiting for it. It does not read the tutor's closing line, so it runs while that
   * line streams (#234). Called when the review is bound to end, and again when the closing line is stored; the second call is dropped.
   */
  startWrapUp(reviewId: ReviewId): void;
  nextSeq(): Seq;
  /**
   * Preparation's ask record (flow C, 2026-11-18). Absent: every lecture counts as asked and no review starts on its own, which is how a
   * test of a prepared lecture runs.
   */
  asks?: {
    ask(captureId: CaptureId): Seq;
    asked(captureId: CaptureId): boolean;
    latestAsk(captureId: CaptureId): LectureAsk | null;
    closeAsk(captureId: CaptureId, reviewId: ReviewId): void;
    exhaust(captureId: CaptureId): void;
  };
  /** Whether the capture has stopped and every watched passage is in a closed chunk, so no chunk will close. Absent: more may close. */
  allChunksClosed?(captureId: CaptureId): boolean;
  /** The record's markEndedInTx, run in the transaction that stores the wrap_up turn, so an ended review always has a save row (#138). */
  endedInTx?(reviewId: ReviewId): void;
};

type ReviewRow = { id: string; capture_id: string; choice: string; scope_json: string; frozen_at_seq: number; started_ms: number };
type TurnRow = { id: string; review_id: string; seq: number; actor: Turn["actor"]; thread_id: string | null; body_json: string; at_ms: number };
type Stored = { readonly captureId: CaptureId; readonly scope: FrozenScope; readonly claimTexts: ReadonlyMap<ClaimId, string> };

type Attempt =
  | { readonly kind: "spoken"; readonly move: TutorMove; readonly say: string }
  /** `stored`: the memo holds this invalid output, so a resend replays it instead of asking the model again. */
  | { readonly kind: "invalid"; readonly why: string; readonly stored: boolean }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "held"; readonly hold: BudgetHold };

type Settled = { readonly ok: true; readonly lookup: RunResult<TutorOutput> } | { readonly ok: false; readonly error: string };

const CLOSE_THREAD_LINE = "Let's leave that question there and move on.";
/** One request may hold several tutor moves (a correction, then the next question); never more than this, so it cannot loop. */
export const MAX_MOVES_PER_TURN = 4;
const NON_TERMINAL = new Set(["awaiting_check", "awaiting_revision", "awaiting_recheck"]);

/**
 * Reviews one learner may start in a day that hold no paid tutoring (`PAID_TUTOR_HOLD`: a tutor turn the caps admitted and
 * charged, whatever its move). Far above a mis-click, so a learner never meets it (#244).
 */
export const UNTUTORED_REVIEWS_PER_DAY = 20;
const DAY_MS = 86_400_000;

/** Thrown by `start` when the learner has started too many reviews that got no tutoring. The message is for the learner. */
export class ReviewLimitError extends Error {
  constructor() {
    super("You have started a lot of reviews today that never reached a question from the tutor. Work through the reviews you have started, or try again tomorrow.");
    this.name = "ReviewLimitError";
  }
}

export function createReviews(db: UserDb, deps: ReviewsDeps, config: ReviewsOptions = {}): Reviews {
  const softTargetS = config.softTargetS ?? 600;
  const timeInviteGapS = config.timeInviteGapS ?? 900;
  const now = config.now ?? Date.now;
  const kit: TutorKit = config.tutor ?? { reviewState, allowedMoves, parseMoveHeader, validateMove };

  const userId = db.userId;
  const wrapUpStarted = new Set<ReviewId>();
  const startWrapUp = (reviewId: ReviewId) => {
    if (wrapUpStarted.has(reviewId)) return;
    wrapUpStarted.add(reviewId);
    deps.startWrapUp(reviewId);
  };
  const REVIEW_COLUMNS = "id, capture_id, choice, scope_json, frozen_at_seq, started_ms";
  const q = {
    answers: db.sql.query<{ seq: number; answer: InviteAnswer; watched_s: number }, [string, string]>(
      "SELECT seq, answer, watched_s FROM invite_answers WHERE user_id = ? AND capture_id = ?",
    ),
    insertAnswer: db.sql.query("INSERT INTO invite_answers (seq, user_id, capture_id, answer, watched_s, at_ms) VALUES (?, ?, ?, ?, ?, ?)"),
    review: db.sql.query<ReviewRow, [string, string]>(`SELECT ${REVIEW_COLUMNS} FROM reviews WHERE user_id = ? AND id = ?`),
    reviewHeldByOther: db.sql.query<{ n: number }, [string, string]>("SELECT 1 AS n FROM reviews WHERE id = ? AND user_id <> ?"),
    untutoredSince: db.sql.query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM reviews r WHERE r.user_id = ? AND r.started_ms >= ?
         AND NOT EXISTS (SELECT 1 FROM budget_holds h WHERE h.user_id = r.user_id AND h.review_id = r.id AND ${PAID_TUTOR_HOLD})`,
    ),
    reviewsOf: db.sql.query<ReviewRow, [string, string]>(`SELECT ${REVIEW_COLUMNS} FROM reviews WHERE user_id = ? AND capture_id = ?`),
    insertReview: db.sql.query("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    turns: db.sql.query<TurnRow, [string, string]>(
      "SELECT id, review_id, seq, actor, thread_id, body_json, at_ms FROM review_turns WHERE user_id = ? AND review_id = ? ORDER BY seq",
    ),
    turnExists: db.sql.query<{ n: number }, [string, string]>("SELECT 1 AS n FROM review_turns WHERE user_id = ? AND id = ?"),
    insertTurn: db.sql.query("INSERT INTO review_turns (user_id, id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  };

  function stored(reviewId: ReviewId): Stored | null {
    const row = q.review.get(userId, reviewId);
    return row ? { captureId: row.capture_id as CaptureId, ...decodeScope(row.scope_json) } : null;
  }

  function loadTurns(reviewId: ReviewId): Turn[] {
    return q.turns.all(userId, reviewId).map((r): Turn => {
      const base = { id: r.id as TurnId, reviewId, seq: asSeq(r.seq), atMs: r.at_ms };
      const body = JSON.parse(r.body_json) as Record<string, unknown>;
      switch (r.actor) {
        case "learner":
          return { ...base, actor: "learner", threadId: r.thread_id as ThreadId | null, act: body.act as LearnerAct };
        case "tutor":
          return { ...base, actor: "tutor", threadId: r.thread_id as ThreadId | null, move: body.move as TutorMove, say: body.say as string };
        case "code":
          return { ...base, actor: "code", threadId: null, notice: body.notice as CodeNotice };
      }
    });
  }

  function appendTurn(reviewId: ReviewId, id: TurnId, actor: Turn["actor"], threadId: ThreadId | null, body: object): void {
    q.insertTurn.run(userId, id, reviewId, deps.nextSeq(), actor, threadId, JSON.stringify(body), Math.round(now()));
  }

  const heldByAnotherUser = (reviewId: ReviewId): boolean => q.reviewHeldByOther.get(reviewId, userId) !== null;

  const hasTurn = (id: TurnId) => q.turnExists.get(userId, id) !== null;

  // ───────────────────────────── invites ─────────────────────────────

  /**
   * One close per chunk, at its first revision's seq and provenance, so revising a
   * chunk's boundary neither drops its invite nor sends a second one.
   * Watched seconds at each close: chunks partition the watched material, so a running sum of their durations.
   */
  function closeEvents(captureId: CaptureId): InviteEvent[] {
    let watchedS = 0;
    return [...deps.currentChunks(captureId)]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c): InviteEvent => {
        watchedS += Material.duration(c.material);
        const first = deps.chunkHistory(c.chunkId)[0] ?? c;
        return { kind: "chunk_closed", seq: first.closedAtSeq, provenance: first.provenance, chunk: c.id, watchedS };
      });
  }

  function inviteFold(captureId: CaptureId) {
    const events: InviteEvent[] = [
      ...closeEvents(captureId),
      ...q.answers.all(userId, captureId).map((a): InviteEvent => ({ kind: "answer", seq: asSeq(a.seq), answer: a.answer, watchedS: a.watched_s })),
      ...q.reviewsOf.all(userId, captureId).map((r): InviteEvent => ({ kind: "review_started", seq: asSeq(r.frozen_at_seq) })),
    ];
    return foldInvites(events, timeInviteGapS);
  }

  function invite(captureId: CaptureId): InviteState {
    const state = inviteFold(captureId).state;
    // Waiting ends in nothing to review once nothing can answer an ask, so the popup never shows Processing for an exhausted ask.
    const over = state.state === "waiting" && deps.asks !== undefined && deps.asks.latestAsk(captureId)?.state !== "open" && !answerable(captureId);
    return over ? { state: "nothing_to_review" } : state;
  }

  /** Idempotent per invite: an answer already given to the latest invite is a retry and stores nothing. */
  function answerInvite(captureId: CaptureId, answer: InviteAnswer): InviteAnswered {
    return db.tx(() => {
      // Only Review now and Wait ask. Later and Stop early never do, and opening the lecture asks nothing. Review now with a review of
      // the lecture still open returns that review. Nobody asks for what nothing can still answer, and an open ask it finds ends exhausted.
      const review = answer === "review_now" ? activeReview(captureId) : null;
      let ask: Seq | null = null;
      if (answer === "wait" || (answer === "review_now" && review === null)) {
        if (answerable(captureId)) ask = deps.asks?.ask(captureId) ?? null;
        else deps.asks?.exhaust(captureId);
      }
      if (!inviteFold(captureId).answered.has(answer)) {
        q.insertAnswer.run(deps.nextSeq(), userId, captureId, answer, deps.watchedSeconds(captureId), Math.round(now()));
      }
      return { ...invite(captureId), ask, review };
    });
  }

  // ───────────────────────────── options and start ─────────────────────────────

  /**
   * Material that a new review must not take again: the frozen scope of every review that is still open (active or
   * paused, so two reviews of the same material cannot run at once) or that the learner responded to (an answer, a
   * skip or an "I don't know"). An ended review with no response, such as one ended by a mis-click, used up nothing,
   * so its material is offered again. R7 is about a started review's own frozen scope, which this never touches.
   */
  function holding(captureId: CaptureId): readonly { readonly reviewId: ReviewId; readonly material: Material; readonly claims: readonly ClaimId[] }[] {
    const counts = (r: ReviewRow): boolean => {
      const turns = loadTurns(r.id as ReviewId);
      const responded = turns.some((t) => t.actor === "learner" && (t.act.kind === "answer" || t.act.kind === "skip" || t.act.kind === "dont_know"));
      return responded || kit.reviewState(r.id as ReviewId, turns, [], softTargetS, now()).phase !== "ended";
    };
    return q.reviewsOf.all(userId, captureId).filter(counts).map((r) => {
      const { scope } = decodeScope(r.scope_json);
      return { reviewId: r.id as ReviewId, material: scope.material, claims: scope.claimsAtStart };
    });
  }

  /** The lecture's latest review that has not ended, or null. */
  function activeReview(captureId: CaptureId): ReviewId | null {
    const open = q.reviewsOf.all(userId, captureId).filter((r) => kit.reviewState(r.id as ReviewId, loadTurns(r.id as ReviewId), [], softTargetS, now()).phase !== "ended");
    return (open.sort((a, b) => a.started_ms - b.started_ms).at(-1)?.id as ReviewId | undefined) ?? null;
  }

  /** Whether the scope holds a supported claim that no review still holding this lecture's material took. Every start needs one. */
  function takesANewClaim(captureId: CaptureId, scope: FrozenScope): boolean {
    const taken = new Set(holding(captureId).flatMap((r) => r.claims));
    return scope.claimsAtStart.some((id) => !taken.has(id));
  }

  /** Whether a review started now would take a supported claim that no review still holding this lecture's material took. */
  function hasNewClaim(captureId: CaptureId, cands: Candidates): boolean {
    const asOf = cands.reduce((s, c) => Math.max(s, c.rev.closedAtSeq), 0);
    const scope = asOf > 0 ? freezeScope(cands, (m) => deps.assessableIn(captureId, m), gapsOf, asSeq(asOf)) : null;
    return scope !== null && takesANewClaim(captureId, scope);
  }

  /** Whether an ask could still start a review: a new claim is prepared, a chunk is held or preparing, or more may close. */
  function answerable(captureId: CaptureId, cands: Candidates = candidates(captureId)): boolean {
    return !(deps.allChunksClosed?.(captureId) ?? false) || cands.some((c) => !c.prep.finished) || hasNewClaim(captureId, cands);
  }

  const reviewedMaterial = (captureId: CaptureId): Material => holding(captureId).reduce((m, r) => Material.union(m, r.material), Material.empty);

  /**
   * What the learner is told an earlier review keeps: each holding review's material that this answer's candidates do not
   * offer. A revised section that grew back over a held scope is offered whole, so the overlap is not kept from it.
   */
  function heldBack(cands: Candidates, captureId: CaptureId): HeldBack {
    const offered = cands.reduce((m, c) => Material.union(m, c.rev.material), Material.empty);
    return holding(captureId).map((r) => ({ reviewId: r.reviewId, material: Material.subtract(r.material, offered) })).filter((r) => Material.duration(r.material) > 0);
  }

  function candidates(captureId: CaptureId) {
    return unreviewed(deps.currentChunks(captureId), reviewedMaterial(captureId)).map((rev) => ({ rev, prep: deps.prep(rev.id) }));
  }
  type Candidates = ReturnType<typeof candidates>;

  const gapsOf = (m: Material) => deps.bundle(m).gaps;

  function nothingToReview(cands: Candidates, captureId: CaptureId): Extract<ReviewOptions, { kind: "nothing_to_review" }> {
    const material = cands.reduce((m, c) => Material.union(m, c.rev.material), Material.empty);
    const gaps = gapsOf(material);
    const unsupported = cands.filter((c) => c.prep.finished && c.prep.supportedCount === 0);
    return {
      kind: "nothing_to_review",
      heldBack: heldBack(cands, captureId),
      gaps,
      unverified: deps.claimsIn(captureId, material).filter((c) => c.status === "unverified"),
      rewatch: [
        ...gaps.map((g) => ({ sourceId: g.sourceId, interval: g.interval })),
        ...unsupported.flatMap((c) => [...c.rev.material].flatMap(([sourceId, set]) => set.intervals().map((interval) => ({ sourceId, interval })))),
      ],
    };
  }

  /**
   * The topics of a scope: the concepts of its claims, in scope order, each once.
   * Claims that have since lost their check still name the topic they were frozen with, so the list never changes under the learner.
   */
  function scopeTopics(captureId: CaptureId, scope: FrozenScope): readonly Concept[] {
    const byClaim = new Map(deps.assessableIn(captureId, scope.material).map((c) => [c.id, c.conceptId] as const));
    const ids = [...new Set(scope.claimsAtStart.flatMap((id) => byClaim.get(id) ?? []))];
    return deps.concepts?.(ids) ?? [];
  }

  const preview = (captureId: CaptureId, s: FrozenScope): ScopePreview => ({
    chunkRevisions: s.chunkRevisions, supportedClaims: s.claimsAtStart.length, topics: scopeTopics(captureId, s), material: s.material, partial: s.partial,
  });

  /**
   * R6: "A pending resource search never blocks a review that is otherwise ready."
   * Resources are not an input here: ChunkPrep carries none.
   */
  function options(captureId: CaptureId): ReviewOptions {
    const cands = candidates(captureId);
    // A preview mints no Seq; the latest close stands in for "as of now".
    const asOf = cands.reduce((s, c) => Math.max(s, c.rev.closedAtSeq), 0);
    const frozen = asOf > 0 ? freezeScope(cands, (m) => deps.assessableIn(captureId, m), gapsOf, asSeq(asOf)) : null;
    // A scope with no claim new to it would not start, so it is not offered.
    const scope = frozen && takesANewClaim(captureId, frozen) ? frozen : null;
    const pending = cands.filter((c) => !c.prep.finished).length;
    const ask = askView(captureId);
    if (pending > 0) {
      const asked = deps.asks?.asked(captureId) ?? true;
      return { kind: "processing", asked, readyNow: scope && preview(captureId, scope), pendingChunks: pending, estimateS: asked ? config.estimateS?.(pending) ?? null : null, heldBack: heldBack(cands, captureId), ...ask };
    }
    return scope ? { kind: "ready", scope: preview(captureId, scope), heldBack: heldBack(cands, captureId), ...ask } : { ...nothingToReview(cands, captureId), ...ask };
  }

  /** The latest ask as a page reads it. A page follows only the review of the ask it waits on. */
  function askView(captureId: CaptureId): { ask: LectureAsk } | null {
    const ask = deps.asks?.latestAsk(captureId) ?? null;
    return ask === null ? null : { ask };
  }

  function startAsked(captureId: CaptureId): ReviewId | null {
    const ask = deps.asks?.latestAsk(captureId) ?? null;
    if (ask?.state !== "open") return null;
    // A review needs a claim no open or answered review took, or a resent ask would start the same review again. Until then the ask
    // waits, unless nothing can answer it any more: then it ends exhausted, so no page shows Processing for it.
    const cands = candidates(captureId);
    if (!hasNewClaim(captureId, cands)) {
      if (!answerable(captureId, cands)) deps.asks?.exhaust(captureId);
      return null;
    }
    // The ask names its review, so a start retried after a crash finds the review it already stored.
    const result = start(captureId, "prepared_only", stableId("rvw", captureId, ask.seq));
    return result.kind === "started" ? result.reviewId : null;
  }

  function start(captureId: CaptureId, choice: StartChoice, reviewId: ReviewId): StartResult {
    const existing = stored(reviewId);
    if (existing) return { kind: "started", reviewId, scope: existing.scope };

    return db.tx((): StartResult => {
      // The id is the row's key across users, so another user's review would collide on insert; refuse it before anything else runs.
      if (heldByAnotherUser(reviewId)) throw new RangeError(`review ${reviewId} belongs to another user`);
      // A review id is minted by the client, so without this one learner could start, end and restart reviews without limit (#244).
      if (q.untutoredSince.get(userId, Math.round(now()) - DAY_MS)!.n >= UNTUTORED_REVIEWS_PER_DAY) throw new ReviewLimitError();
      let cands = candidates(captureId);
      let dropped = 0;
      if (choice === "stop_early") {
        const pending = cands.filter((c) => !c.prep.finished);
        if (pending.length > 0) {
          dropped = pending.reduce((n, c) => n + c.prep.claims.filter((cl) => NON_TERMINAL.has(cl.status)).length, 0);
          deps.stopEarly(captureId, pending.map((c) => c.rev.id));
          cands = candidates(captureId);
        }
      }
      const frozen = freezeScope(cands, (m) => deps.assessableIn(captureId, m), gapsOf, deps.nextSeq());
      if (!frozen || !takesANewClaim(captureId, frozen)) return nothingToReview(cands, captureId);

      const scope: FrozenScope = dropped > 0 ? { ...frozen, partial: [...frozen.partial, { kind: "stopped_early", droppedClaims: dropped }] } : frozen;
      const texts = new Map(deps.assessableIn(captureId, scope.material).map((c) => [c.id, c.text] as const));
      q.insertReview.run(reviewId, userId, captureId, choice, encodeScope(scope, texts), scope.frozenAtSeq, Math.round(now()));
      // Whichever way it started, this review answers the lecture's open ask.
      deps.asks?.closeAsk(captureId, reviewId);
      return { kind: "started", reviewId, scope };
    });
  }

  // ───────────────────────────── review state ─────────────────────────────

  const evidenceIds = (b: EvidenceBundle): Set<EvidenceId> => new Set([...b.passages.map((p) => p.id), ...b.frames.map((f) => f.id)]);

  /** Usable claims inside the frozen material only (R3, R7). */
  function usableNow(review: Stored): AssessableClaim[] {
    const inScope = evidenceIds(deps.bundle(review.scope.material));
    return [...usableInScope(deps.assessableIn(review.captureId, review.scope.material), inScope).values()];
  }

  function correctionsOf(reviewId: ReviewId, review: Stored, turns: readonly Turn[]): Correction[] {
    const disclosed = settledCorrections(turns);
    const inScope = evidenceIds(deps.bundle(review.scope.material));
    const states = new Map(
      deps.claimsIn(review.captureId, review.scope.material).map((c) => {
        const checkedAt = Math.max(c.originalCheck?.atSeq ?? 0, c.revisionCheck?.atSeq ?? 0);
        return [c.id, { status: c.status, checkedAt }] as const;
      }),
    );
    const claimState = (id: ClaimId) => states.get(id) ?? "absent";
    return deriveCorrections(reviewId, review.scope, deps.assessableIn(review.captureId, review.scope.material), disclosed, review.claimTexts, inScope, claimState);
  }

  function stateOf(reviewId: ReviewId, review: Stored, turns: readonly Turn[]) {
    const corrs = correctionsOf(reviewId, review, turns);
    return { corrs, state: kit.reviewState(reviewId, turns, corrs, softTargetS, now()) };
  }

  /** The topics of the frozen scope. */
  function topicsOf(review: Stored): readonly Concept[] {
    return scopeTopics(review.captureId, review.scope);
  }

  function view(reviewId: ReviewId): ReviewView {
    const review = stored(reviewId);
    if (!review) throw new Error(`unknown review ${reviewId}`);
    const turns = loadTurns(reviewId);
    const { state } = stateOf(reviewId, review, turns);
    return { reviewId, captureId: review.captureId, topics: topicsOf(review), scope: review.scope, state, turns, owesMove: tutorOwesMove(turns, state.phase), turnInFlight: false, observations: [], saved: "unsaved" };
  }

  function list(captureId: CaptureId) {
    return q.reviewsOf.all(userId, captureId).map((r) => ({ reviewId: r.id as ReviewId, startedMs: r.started_ms })).sort((a, b) => b.startedMs - a.startedMs);
  }

  // ───────────────────────────── turns ─────────────────────────────

  const tutorTurnId = (reviewId: ReviewId, turnId: TurnId) => stableId("turn", reviewId, turnId, "tutor");
  /** The nth tutor move of one request; the first keeps the id a single-move turn always had. */
  const moveTurnId = (reviewId: ReviewId, turnId: TurnId, n: number) => (n === 0 ? tutorTurnId(reviewId, turnId) : stableId("turn", reviewId, turnId, "tutor", n));
  const codeTurnId = (reviewId: ReviewId, cause: string) => stableId("turn", reviewId, cause, "code");
  const threadOf = (move: TutorMove): ThreadId | null => ("threadId" in move ? move.threadId : null);

  /**
   * A pending correction written from its own data: the claim it names, what
   * changed, and only the evidence that claim carries now (none once withdrawn).
   * R3: "A claim can be used to judge my answers only if it passed the evidence check."
   * A withdrawn claim is named from the text frozen at start and is never used to judge; a
   * reworded or newly usable claim is in `input.claims`, so it has passed the check.
   */
  function disclosure(input: TutorInput, review: Stored): { move: TutorMove; say: string } | null {
    const pending = input.state.corrections.find((c) => !c.disclosed);
    if (!pending) return null;
    const now = input.claims.find((c) => c.id === pending.claimId);
    const before = review.claimTexts.get(pending.claimId);
    const shown = new Set<EvidenceId>([...input.evidence.passages.map((p) => p.id), ...input.evidence.frames.map((f) => f.id)]);
    const threadIds = [...new Set(input.turns.flatMap((t) => (t.actor === "tutor" && t.move.kind === "ask_main" && t.move.claimIds.includes(pending.claimId) ? [t.move.threadId] : [])))];
    const evidence = pending.change === "withdrawn" || !now ? [] : now.evidence.filter((e) => shown.has(e));
    const say =
      pending.change === "withdrawn"
        ? `I need to correct something. I can no longer confirm this point against the lecture${before ? `: "${before}"` : ""}. I won't use it to judge your answers.`
        : pending.change === "text_changed" && now
          ? `I need to correct something. A point I was using has been reworded${before ? `: it said "${before}"` : ""}. It now says "${now.text}", and I'll use that version from here on.`
          : now
            ? `I need to correct something. A new point has passed the check for this part of the lecture: "${now.text}". I may use it from here on.`
            : "I need to correct something about a point I was using.";
    return { move: { kind: "disclose_correction", correctionId: pending.id, threadIds, evidence }, say };
  }

  /** What the learner hears when the model cannot produce a valid move: code's own, never a stuck review. A pending correction is disclosed before anything else. */
  function codeMove(input: TutorInput, review: Stored): { move: TutorMove; say: string } | null {
    if (input.allowed.includes("disclose_correction")) {
      const disclosed = disclosure(input, review);
      if (disclosed) return disclosed;
    }
    const thread = input.state.openThread;
    if (input.allowed.includes("close_thread") && thread) return { move: { kind: "close_thread", threadId: thread }, say: CLOSE_THREAD_LINE };
    if (input.allowed.includes("wrap_up")) {
      const noneLeft = input.claims.length === 0 && input.state.openThread === null && input.state.mainQuestions < MAX_MAIN_QUESTIONS && !input.state.wrapUpRequested;
      return { move: { kind: "wrap_up" }, say: noneLeft ? NOTHING_TO_ASK_LINE : WRAP_UP_LINE };
    }
    return null;
  }

  function* spoken(say: string): Generator<TurnEvent> {
    yield { type: "say_delta", text: say };
    const { sentences, rest } = takeSentences(`${say} `);
    for (const s of [...sentences, rest.trim()]) if (s) yield { type: "sentence", text: s };
  }

  /**
   * A terminal failure stored before this request began answered an earlier send,
   * not this one, so a resend clears it and asks the model once more.
   */
  async function runTutor(input: TutorInput, onDelta: (d: string) => void, onRetry: () => void, signal: AbortSignal, asOf: Seq): Promise<RunResult<TutorOutput>> {
    const lookup = await deps.runTutor(input, onDelta, signal, onRetry);
    if (lookup.kind !== "failed" || lookup.atSeq > asOf) return lookup;
    deps.clearFailures([lookup.key]);
    return deps.runTutor(input, onDelta, signal, onRetry);
  }

  /**
   * One model call. Prose is held back until the header passes validateMove, so an
   * invalid header aborts the call before a word is spoken. The move itself is
   * not yielded here: turn() sends it once the turn is committed.
   */
  async function* attempt(input: TutorInput, asOf: Seq): AsyncGenerator<TurnEvent, Attempt> {
    const queue: TurnEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (e: TurnEvent) => {
      queue.push(e);
      wake?.();
    };
    const ctl = new AbortController();
    let buf = "";
    let gated = false;
    let held = false;
    let invalid: string | null = null;
    let streamedMove: TutorMove | null = null;
    let pending = "";

    const speak = (text: string) => {
      if (!text) return;
      push({ type: "say_delta", text });
      const taken = takeSentences(pending + text);
      pending = taken.rest;
      for (const s of taken.sentences) push({ type: "sentence", text: s });
    };
    const rejectHeader = (why: string) => {
      invalid = why;
      ctl.abort();
    };
    /** The retried call streams its whole reply again, header included, so the header gate and the shown prose start over. */
    const onRetry = () => {
      buf = "";
      gated = false;
      held = false;
      streamedMove = null;
      pending = "";
      push({ type: "say_reset" });
    };
    const onDelta = (d: string) => {
      if (invalid !== null) return;
      if (gated) return speak(d);
      if (held) return;
      buf += d;
      const header = kit.parseMoveHeader(buf);
      if (header.kind === "pending") return;
      if (header.kind === "invalid") return rejectHeader(header.why);
      const verdict = kit.validateMove(header.move, input);
      if (!verdict.ok) return rejectHeader(verdict.why);
      // A diagnostic question is checked as a whole before it is heard, so a reply that recites the lecture is never spoken.
      if (header.move.kind === "diagnose") {
        held = true;
        return;
      }
      gated = true;
      streamedMove = header.move;
      speak(header.rest);
    };

    let settled: Settled | null = null;
    runTutor(input, onDelta, onRetry, ctl.signal, asOf).then(
      (lookup): Settled => ({ ok: true, lookup }),
      (err: unknown): Settled => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    ).then((s) => {
      settled = s;
      wake?.();
    });

    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (settled) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }

    const result = settled as Settled;
    if (invalid !== null) return { kind: "invalid", why: invalid, stored: result.ok && result.lookup.kind === "hit" };
    if (!result.ok) return { kind: "failed", error: result.error };
    const lookup = result.lookup;
    if (lookup.kind === "held") return { kind: "held", hold: lookup.hold };
    if (lookup.kind === "failed") return { kind: "failed", error: lookup.lastError };
    if (lookup.kind !== "hit") return { kind: "failed", error: `tutor call ${lookup.kind}` };

    if (gated) {
      if (pending.trim()) yield { type: "sentence", text: pending.trim() };
      return { kind: "spoken", move: streamedMove ?? lookup.value.move, say: lookup.value.say };
    }
    const verdict = kit.validateMove(lookup.value.move, input);
    if (!verdict.ok) return { kind: "invalid", why: verdict.why, stored: true };
    const said = validateSay(lookup.value.move, lookup.value.say);
    if (!said.ok) return { kind: "invalid", why: said.why, stored: true };
    yield* spoken(lookup.value.say);
    return { kind: "spoken", move: lookup.value.move, say: lookup.value.say };
  }

  /**
   * The claims and evidence the tutor may use now (R3, R7): re-read on every call, so a claim that lost its check drops out.
   * The evidence is every passage and frame a usable claim cites, whatever thread is open, so it stays the same
   * across turns and the tutor's system prompt is read from cache (#135).
   */
  function grounding(review: Stored): Pick<TutorInput, "claims" | "evidence"> {
    const usable = usableNow(review);
    const cited = new Set(usable.flatMap((c) => c.evidence));
    const full = deps.bundle(review.scope.material);
    return { claims: usable, evidence: { ...full, passages: full.passages.filter((p) => cited.has(p.id)), frames: full.frames.filter((f) => cited.has(f.id)) } };
  }

  /**
   * Notes every undisclosed correction in the log, then builds the tutor's input; null when no move is allowed.
   * A correction to a claim no question in this review has named is logged as applied and never announced;
   * one to a claim already asked about is logged as pending, for the tutor to disclose with evidence (#137).
   */
  function tutorInput(reviewId: ReviewId, review: Stored, repairNote: string | null): TutorInput | null {
    const before = loadTurns(reviewId);
    const asked = askedClaims(before);
    for (const c of correctionsOf(reviewId, review, before)) {
      const noticeId = codeTurnId(reviewId, c.id);
      if (!c.disclosed && !hasTurn(noticeId)) {
        const kind = asked.has(c.claimId) ? "correction_pending" : "correction_applied";
        appendTurn(reviewId, noticeId, "code", null, { notice: { kind, correctionId: c.id, affectedClaims: [c.claimId] } });
      }
    }
    const turns = loadTurns(reviewId);
    const { state } = stateOf(reviewId, review, turns);
    const { claims, evidence } = grounding(review);
    const pendingClaims = deps.claimsIn(review.captureId, review.scope.material).filter((c) => NON_TERMINAL.has(c.status)).length;
    const allowed = [...kit.allowedMoves(state, { turns, claims, pendingClaims })];
    if (allowed.length === 0) return null;
    return { state, allowed, topics: topicsOf(review), scope: review.scope, claims, evidence, turns, priorObservations: [], repairNote };
  }

  /**
   * Stores the tutor turn if the move still passes validateMove against the claims
   * usable now, since one can lose its check while the model is talking.
   * R3: "A claim can be used to judge my answers only if it passed the evidence check."
   * Returns the stored turn, or why the move went stale.
   */
  function commit(reviewId: ReviewId, turnId: TurnId, outId: TurnId, review: Stored, input: TutorInput, move: TutorMove, say: string) {
    return db.tx((): { readonly ok: true; readonly move: TutorMove; readonly say: string } | { readonly ok: false; readonly why: string } => {
      const already = loadTurns(reviewId).find((t) => t.id === outId);
      if (already?.actor === "tutor") return { ok: true, move: already.move, say: already.say };
      const verdict = kit.validateMove(move, { ...input, ...grounding(review) });
      if (!verdict.ok) return { ok: false, why: verdict.why };
      appendTurn(reviewId, outId, "tutor", threadOf(move), { move, say });
      if (move.kind === "wrap_up") deps.endedInTx?.(reviewId);
      if (move.kind === "close_thread") {
        const after = stateOf(reviewId, review, loadTurns(reviewId)).state;
        if (!after.softTargetOffered && after.activeSeconds >= softTargetS) {
          appendTurn(reviewId, codeTurnId(reviewId, `soft_target:${turnId}`), "code", null, { notice: { kind: "soft_target_reached", elapsedS: after.activeSeconds } });
        }
      }
      return { ok: true, move, say };
    });
  }

  async function* turn(reviewId: ReviewId, turnId: TurnId, act: LearnerAct): AsyncGenerator<TurnEvent> {
    const review = stored(reviewId);
    if (!review) {
      yield { type: "turn_failed", error: `unknown review ${reviewId}`, retryable: false };
      return;
    }

    if (!hasTurn(turnId)) {
      const { state } = stateOf(reviewId, review, loadTurns(reviewId));
      // A saved review is final (record.save answers a retry from its first save), so an ended review takes no new turn.
      if (state.phase === "ended") {
        yield { type: "turn_failed", error: "this review has ended", retryable: false };
        return;
      }
      // `begin` only opens a review: it is the first turn, so any earlier turn makes it invalid.
      if (act.kind === "begin" && loadTurns(reviewId).length > 0) {
        yield { type: "turn_failed", error: "this review has already begun", retryable: false };
        return;
      }
      appendTurn(reviewId, turnId, "learner", state.openThread, { act });
    }
    yield { type: "learner_turn_stored", turnId };

    // Replay what an earlier attempt of this request already stored, in order.
    let n = 0;
    let last: TutorMove | null = null;
    for (;; n++) {
      const reply = loadTurns(reviewId).find((t) => t.id === moveTurnId(reviewId, turnId, n));
      if (reply?.actor !== "tutor") break;
      yield* spoken(reply.say);
      yield { type: "move", turnId: reply.id, move: reply.move };
      last = reply.move;
    }
    const completeId = () => (n === 0 ? turnId : moveTurnId(reviewId, turnId, n - 1));
    const softTargetUp = () => {
      const lastTurn = loadTurns(reviewId).at(-1);
      return lastTurn?.actor === "code" && lastTurn.notice.kind === "soft_target_reached";
    };
    /** The request stops once a move waits for the learner (or the soft-target prompt is up). */
    const stops = (move: TutorMove) => waitsForLearner(move) || softTargetUp();
    if (last && stops(last)) {
      yield { type: "turn_complete", turnId: completeId() };
      return;
    }

    let replayed = n === 0;
    // The cap counts the moves this attempt makes, not the ones it replayed, so a resend after the cap still goes on.
    let made = 0;
    while (made < MAX_MOVES_PER_TURN) {
      made++;
      let input = tutorInput(reviewId, review, null);
      if (!input) {
        // No move is allowed while the review is active: every claim in scope is out for a check (R3), so nothing can be asked yet.
        if (stateOf(reviewId, review, loadTurns(reviewId)).state.phase === "active") {
          yield { type: "turn_failed", error: "Some statements are being rechecked against the lecture. Try again in a moment.", retryable: true };
          return;
        }
        break;
      }
      if (input.allowed.length === 1 && input.allowed[0] === "wrap_up") startWrapUp(reviewId);
      const outId = moveTurnId(reviewId, turnId, n);
      const asOf = deps.nextSeq();
      let stored: { readonly move: TutorMove; readonly say: string } | null = null;
      // Two model attempts (the second carries the repair note), then code's own move.
      for (let k = 0; input && k < 2; k++) {
        const outcome = yield* attempt(input, asOf);
        if (outcome.kind === "failed") {
          yield { type: "turn_failed", error: outcome.error, retryable: true };
          return;
        }
        if (outcome.kind === "held") {
          // Derek, 2026-11-13: "i think it should be allowed to finish". A cap never holds a turn that can only wrap up,
          // so code says the wrap-up line without a call. The stop switch still holds it.
          const onlyWrapUp = input.allowed.length === 1 && input.allowed[0] === "wrap_up";
          if (onlyWrapUp && outcome.hold.reason !== "stopped") break;
          yield { type: "turn_held", hold: outcome.hold };
          return;
        }
        let why: string;
        if (outcome.kind === "spoken") {
          const done = commit(reviewId, turnId, outId, review, input, outcome.move, outcome.say);
          if (done.ok) {
            if (done.move.kind === "wrap_up") startWrapUp(reviewId);
            yield { type: "move", turnId: outId, move: done.move };
            stored = done;
            break;
          }
          why = done.why;
          replayed = false;
        } else {
          why = outcome.why;
          replayed &&= outcome.stored;
        }
        input = tutorInput(reviewId, review, why);
      }
      if (!stored) {
        if (!input) break;
        const fallback = codeMove(input, review);
        if (!fallback) {
          yield { type: "turn_failed", error: `no valid move: ${input.repairNote}`, retryable: !replayed };
          return;
        }
        const done = commit(reviewId, turnId, outId, review, input, fallback.move, fallback.say);
        if (!done.ok) {
          yield { type: "turn_failed", error: `no valid move: ${done.why}`, retryable: true };
          return;
        }
        if (done.move.kind === "wrap_up") startWrapUp(reviewId);
        yield* spoken(done.say);
        yield { type: "move", turnId: outId, move: done.move };
        stored = done;
      }
      n++;
      if (stops(stored.move)) break;
    }
    yield { type: "turn_complete", turnId: completeId() };
  }

  return { invite, answerInvite, options, start, startAsked, turn, view, list, heldByAnotherUser };
}
