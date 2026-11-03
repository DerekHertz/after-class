/**
 * Invites + reviews, flows C (bottom half) and D (W7). Owns: invite_answers,
 * reviews (FrozenScope snapshot, written once), review_turns (append-only).
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
import type { CaptureId, ChunkRevisionId, ClaimId, EvidenceId, ReviewId, ThreadId, TurnId } from "../../shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkRevision, Claim, CodeNotice, Correction, EvidenceBundle, FrozenScope, InviteAnswer, InviteState,
  LearnerAct, ReviewOptions, ReviewView, Seq, StartChoice, StartResult, Turn, TurnEvent, TutorMove,
} from "../../shared/domain";
import { Material } from "../../shared/time";
import { asSeq } from "../db";
import type { Db } from "../db";
import type { Lookup } from "../providers/memo";
import { allowedMoves, parseMoveHeader, reviewState, validateMove } from "./tutor";
import type { TutorInput, TutorOutput, WrapUpInput, WrapUpOutput } from "./tutor";
import {
  corrections as deriveCorrections, decodeScope, encodeScope, foldInvites, freezeScope, takeSentences, unreviewed, usableInScope,
} from "./core";
import type { InviteEvent } from "./core";

export type Reviews = {
  invite(captureId: CaptureId): InviteState;
  /**
   * User fact.
   * R5: "Choosing Later never cancels preparation."
   * `later` and `wait` change only invite state. `review_now` / `stop_early` go through start().
   */
  answerInvite(captureId: CaptureId, answer: InviteAnswer): InviteState;
  /** "Review now always available": callable any time, regardless of invite state. */
  options(captureId: CaptureId): ReviewOptions;
  /**
   * Idempotent on the app-minted reviewId: a retried start returns the stored scope.
   *   stop_early → stopEarly(pending unreviewed chunks) first.
   *   scope = unreviewed ∧ finished chunk revisions; claims = assessableIn(material)
   * R10: "A review never starts with zero supported claims in scope."
   * Claims empty → nothing_to_review, and no review row is written.
   */
  start(captureId: CaptureId, choice: StartChoice, reviewId: ReviewId): StartResult;
  /**
   * Header-first (SYNTHESIS graft 1). The learner turn is committed before any
   * model call, so a failed call never loses what the learner said, and a
   * resend of the same turnId replays the stored reply instead of paying twice.
   * The tutor's header is validated before a word is spoken; an invalid header
   * aborts the call and gets one repair attempt, then a code-authored move.
   */
  turn(reviewId: ReviewId, turnId: TurnId, act: LearnerAct): AsyncIterable<TurnEvent>;
  view(reviewId: ReviewId): ReviewView;
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
  prep(id: ChunkRevisionId): ChunkPrep;
  stopEarly(captureId: CaptureId, ids: readonly ChunkRevisionId[]): Seq;
  assessableIn(captureId: CaptureId, material: Material): readonly AssessableClaim[];
  claimsIn(captureId: CaptureId, material: Material): readonly Claim[];
  bundle(material: Material): EvidenceBundle;
  watchedSeconds(captureId: CaptureId): number;
  runTutor(input: TutorInput, streamTo: (delta: string) => void, signal: AbortSignal): Promise<Lookup<TutorOutput>>;
  runWrapUp(input: WrapUpInput): Promise<Lookup<WrapUpOutput>>;
  nextSeq(): Seq;
};

type ReviewRow = { id: string; capture_id: string; choice: string; scope_json: string; frozen_at_seq: number; started_ms: number };
type TurnRow = { id: string; review_id: string; seq: number; actor: Turn["actor"]; thread_id: string | null; body_json: string; at_ms: number };
type Stored = { readonly captureId: CaptureId; readonly scope: FrozenScope; readonly claimTexts: ReadonlyMap<ClaimId, string> };

type Attempt =
  | { readonly kind: "spoken"; readonly move: TutorMove; readonly say: string }
  | { readonly kind: "invalid"; readonly why: string }
  | { readonly kind: "failed"; readonly error: string };

type Settled = { readonly ok: true; readonly lookup: Lookup<TutorOutput> } | { readonly ok: false; readonly error: string };

const CLOSE_THREAD_LINE = "Let's leave that question there and move on.";
const WRAP_UP_LINE = "Let's wrap up here.";
const NON_TERMINAL = new Set(["awaiting_check", "awaiting_revision", "awaiting_recheck"]);

export function createReviews(db: Db, deps: ReviewsDeps, config: ReviewsOptions = {}): Reviews {
  const softTargetS = config.softTargetS ?? 600;
  const timeInviteGapS = config.timeInviteGapS ?? 900;
  const now = config.now ?? Date.now;
  const kit: TutorKit = config.tutor ?? { reviewState, allowedMoves, parseMoveHeader, validateMove };

  const q = {
    answers: db.sql.query<{ seq: number; answer: InviteAnswer; watched_s: number }, [string]>(
      "SELECT seq, answer, watched_s FROM invite_answers WHERE capture_id = ?",
    ),
    insertAnswer: db.sql.query("INSERT INTO invite_answers (seq, capture_id, answer, watched_s, at_ms) VALUES (?, ?, ?, ?, ?)"),
    review: db.sql.query<ReviewRow, [string]>("SELECT * FROM reviews WHERE id = ?"),
    reviewsOf: db.sql.query<ReviewRow, [string]>("SELECT * FROM reviews WHERE capture_id = ?"),
    insertReview: db.sql.query("INSERT INTO reviews (id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, ?, ?, ?, ?)"),
    turns: db.sql.query<TurnRow, [string]>("SELECT * FROM review_turns WHERE review_id = ? ORDER BY seq"),
    turnExists: db.sql.query<{ n: number }, [string]>("SELECT 1 AS n FROM review_turns WHERE id = ?"),
    insertTurn: db.sql.query("INSERT INTO review_turns (id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  };

  function stored(reviewId: ReviewId): Stored | null {
    const row = q.review.get(reviewId);
    return row ? { captureId: row.capture_id as CaptureId, ...decodeScope(row.scope_json) } : null;
  }

  function loadTurns(reviewId: ReviewId): Turn[] {
    return q.turns.all(reviewId).map((r): Turn => {
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
    q.insertTurn.run(id, reviewId, deps.nextSeq(), actor, threadId, JSON.stringify(body), Math.round(now()));
  }

  const hasTurn = (id: TurnId) => q.turnExists.get(id) !== null;

  // ───────────────────────────── invites ─────────────────────────────

  /** Watched seconds at each close: chunks partition the watched material, so a running sum of their durations. */
  function closeEvents(captureId: CaptureId): InviteEvent[] {
    let watchedS = 0;
    return [...deps.currentChunks(captureId)]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c): InviteEvent => {
        watchedS += Material.duration(c.material);
        return { kind: "chunk_closed", seq: c.closedAtSeq, provenance: c.provenance, chunk: c.id, watchedS };
      });
  }

  function invite(captureId: CaptureId): InviteState {
    const events: InviteEvent[] = [
      ...closeEvents(captureId),
      ...q.answers.all(captureId).map((a): InviteEvent => ({ kind: "answer", seq: asSeq(a.seq), answer: a.answer, watchedS: a.watched_s })),
      ...q.reviewsOf.all(captureId).map((r): InviteEvent => ({ kind: "review_started", seq: asSeq(r.frozen_at_seq) })),
    ];
    return foldInvites(events, timeInviteGapS);
  }

  function answerInvite(captureId: CaptureId, answer: InviteAnswer): InviteState {
    q.insertAnswer.run(deps.nextSeq(), captureId, answer, deps.watchedSeconds(captureId), Math.round(now()));
    return invite(captureId);
  }

  // ───────────────────────────── options and start ─────────────────────────────

  function reviewedMaterial(captureId: CaptureId): Material {
    return q.reviewsOf.all(captureId).reduce((m, r) => Material.union(m, decodeScope(r.scope_json).scope.material), Material.empty);
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
      gaps,
      unverified: deps.claimsIn(captureId, material).filter((c) => c.status === "unverified"),
      rewatch: [
        ...gaps.map((g) => ({ sourceId: g.sourceId, interval: g.interval })),
        ...unsupported.flatMap((c) => [...c.rev.material].flatMap(([sourceId, set]) => set.intervals().map((interval) => ({ sourceId, interval })))),
      ],
    };
  }

  const preview = (s: FrozenScope) => ({ chunkRevisions: s.chunkRevisions, supportedClaims: s.claimsAtStart.length, partial: s.partial });

  /**
   * R6: "A pending resource search never blocks a review that is otherwise ready."
   * Resources are not an input here: ChunkPrep carries none.
   */
  function options(captureId: CaptureId): ReviewOptions {
    const cands = candidates(captureId);
    // A preview mints no Seq; the latest close stands in for "as of now".
    const asOf = cands.reduce((s, c) => Math.max(s, c.rev.closedAtSeq), 0);
    const scope = asOf > 0 ? freezeScope(cands, (m) => deps.assessableIn(captureId, m), gapsOf, asSeq(asOf)) : null;
    const pending = cands.filter((c) => !c.prep.finished).length;
    if (pending > 0) {
      return { kind: "processing", readyNow: scope && preview(scope), pendingChunks: pending, estimateS: config.estimateS?.(pending) ?? null };
    }
    return scope ? { kind: "ready", scope: preview(scope) } : nothingToReview(cands, captureId);
  }

  function start(captureId: CaptureId, choice: StartChoice, reviewId: ReviewId): StartResult {
    const existing = stored(reviewId);
    if (existing) return { kind: "started", reviewId, scope: existing.scope };

    return db.tx((): StartResult => {
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
      if (!frozen) return nothingToReview(cands, captureId);

      const scope: FrozenScope = dropped > 0 ? { ...frozen, partial: [...frozen.partial, { kind: "stopped_early", droppedClaims: dropped }] } : frozen;
      const texts = new Map(deps.assessableIn(captureId, scope.material).map((c) => [c.id, c.text] as const));
      q.insertReview.run(reviewId, captureId, choice, encodeScope(scope, texts), scope.frozenAtSeq, Math.round(now()));
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
    const disclosed = new Set(turns.flatMap((t) => (t.actor === "tutor" && t.move.kind === "disclose_correction" ? [t.move.correctionId] : [])));
    const inScope = evidenceIds(deps.bundle(review.scope.material));
    return deriveCorrections(reviewId, review.scope, deps.assessableIn(review.captureId, review.scope.material), disclosed, review.claimTexts, inScope);
  }

  function stateOf(reviewId: ReviewId, review: Stored, turns: readonly Turn[]) {
    const corrs = correctionsOf(reviewId, review, turns);
    return { corrs, state: kit.reviewState(reviewId, turns, corrs, softTargetS, now()) };
  }

  function view(reviewId: ReviewId): ReviewView {
    const review = stored(reviewId);
    if (!review) throw new Error(`unknown review ${reviewId}`);
    const turns = loadTurns(reviewId);
    return { reviewId, captureId: review.captureId, scope: review.scope, state: stateOf(reviewId, review, turns).state, turns, observations: [], saved: "unsaved" };
  }

  // ───────────────────────────── turns ─────────────────────────────

  const tutorTurnId = (reviewId: ReviewId, turnId: TurnId) => stableId("turn", reviewId, turnId, "tutor");
  const codeTurnId = (reviewId: ReviewId, cause: string) => stableId("turn", reviewId, cause, "code");
  const threadOf = (move: TutorMove): ThreadId | null => ("threadId" in move ? move.threadId : null);

  /** What the learner hears when the model cannot produce a valid move: code's own, never a stuck review. */
  function codeMove(input: TutorInput): { move: TutorMove; say: string } | null {
    const thread = input.state.openThread;
    if (input.allowed.includes("close_thread") && thread) return { move: { kind: "close_thread", threadId: thread }, say: CLOSE_THREAD_LINE };
    if (input.allowed.includes("wrap_up")) return { move: { kind: "wrap_up" }, say: WRAP_UP_LINE };
    return null;
  }

  function* spoken(say: string): Generator<TurnEvent> {
    yield { type: "say_delta", text: say };
    const { sentences, rest } = takeSentences(`${say} `);
    for (const s of [...sentences, rest.trim()]) if (s) yield { type: "sentence", text: s };
  }

  /**
   * One model call. Deltas are held back until the header is valid, so an
   * invalid header aborts the call before anything is yielded.
   */
  async function* attempt(reviewId: ReviewId, turnId: TurnId, input: TutorInput): AsyncGenerator<TurnEvent, Attempt> {
    const queue: TurnEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (e: TurnEvent) => {
      queue.push(e);
      wake?.();
    };
    const ctl = new AbortController();
    const outId = tutorTurnId(reviewId, turnId);
    let buf = "";
    let gated = false;
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
    const onDelta = (d: string) => {
      if (invalid !== null) return;
      if (gated) return speak(d);
      buf += d;
      const header = kit.parseMoveHeader(buf);
      if (header.kind === "pending") return;
      if (header.kind === "invalid") return rejectHeader(header.why);
      const verdict = kit.validateMove(header.move, input);
      if (!verdict.ok) return rejectHeader(verdict.why);
      gated = true;
      streamedMove = header.move;
      push({ type: "move", turnId: outId, move: header.move });
      speak(header.rest);
    };

    let settled: Settled | null = null;
    deps.runTutor(input, onDelta, ctl.signal).then(
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

    if (invalid !== null) return { kind: "invalid", why: invalid };
    const result = settled as Settled;
    if (!result.ok) return { kind: "failed", error: result.error };
    const lookup = result.lookup;
    if (lookup.kind === "failed") return { kind: "failed", error: lookup.lastError };
    if (lookup.kind !== "hit") return { kind: "failed", error: `tutor call ${lookup.kind}` };

    if (gated) {
      if (pending.trim()) yield { type: "sentence", text: pending.trim() };
      return { kind: "spoken", move: streamedMove ?? lookup.value.move, say: lookup.value.say };
    }
    const verdict = kit.validateMove(lookup.value.move, input);
    if (!verdict.ok) return { kind: "invalid", why: verdict.why };
    yield { type: "move", turnId: outId, move: lookup.value.move };
    yield* spoken(lookup.value.say);
    return { kind: "spoken", move: lookup.value.move, say: lookup.value.say };
  }

  async function* turn(reviewId: ReviewId, turnId: TurnId, act: LearnerAct): AsyncGenerator<TurnEvent> {
    const review = stored(reviewId);
    if (!review) {
      yield { type: "turn_failed", error: `unknown review ${reviewId}`, retryable: false };
      return;
    }

    if (!hasTurn(turnId)) {
      const { state } = stateOf(reviewId, review, loadTurns(reviewId));
      appendTurn(reviewId, turnId, "learner", state.openThread, { act });
    }
    yield { type: "learner_turn_stored", turnId };

    const outId = tutorTurnId(reviewId, turnId);
    const turns = loadTurns(reviewId);
    if (hasTurn(outId)) {
      const reply = turns.find((t) => t.id === outId);
      if (reply?.actor === "tutor") {
        yield { type: "move", turnId: outId, move: reply.move };
        yield* spoken(reply.say);
        yield { type: "turn_complete", turnId: outId };
      }
      return;
    }

    const { corrs, state } = stateOf(reviewId, review, turns);
    for (const c of corrs) {
      const noticeId = codeTurnId(reviewId, c.id);
      if (!c.disclosed && !hasTurn(noticeId)) {
        appendTurn(reviewId, noticeId, "code", null, { notice: { kind: "correction_pending", correctionId: c.id, affectedClaims: [c.claimId] } });
      }
    }

    const allowed = [...kit.allowedMoves(state)];
    if (allowed.length === 0) {
      yield { type: "turn_complete", turnId };
      return;
    }

    const usable = usableNow(review);
    const asked = turns.find((t) => t.actor === "tutor" && t.move.kind === "ask_main" && t.move.threadId === state.openThread);
    const threadClaims = new Set<ClaimId>(asked?.actor === "tutor" && asked.move.kind === "ask_main" ? asked.move.claimIds : []);
    const cited = new Set(usable.filter((c) => threadClaims.size === 0 || threadClaims.has(c.id)).flatMap((c) => c.evidence));
    const full = deps.bundle(review.scope.material);
    const input: TutorInput = {
      state,
      allowed,
      scope: review.scope,
      claims: usable,
      evidence: { ...full, passages: full.passages.filter((p) => cited.has(p.id)), frames: full.frames.filter((f) => cited.has(f.id)) },
      turns: loadTurns(reviewId),
      priorObservations: [],
      repairNote: null,
    };

    let outcome = yield* attempt(reviewId, turnId, input);
    if (outcome.kind === "invalid") outcome = yield* attempt(reviewId, turnId, { ...input, repairNote: outcome.why });
    if (outcome.kind === "invalid") {
      const fallback = codeMove(input);
      if (fallback) {
        yield { type: "move", turnId: outId, move: fallback.move };
        yield* spoken(fallback.say);
        outcome = { kind: "spoken", ...fallback };
      } else {
        outcome = { kind: "failed", error: `no valid move: ${outcome.why}` };
      }
    }
    if (outcome.kind !== "spoken") {
      yield { type: "turn_failed", error: outcome.kind === "failed" ? outcome.error : "invalid move", retryable: true };
      return;
    }

    const { move, say } = outcome;
    db.tx(() => {
      if (hasTurn(outId)) return;
      appendTurn(reviewId, outId, "tutor", threadOf(move), { move, say });
      if (move.kind !== "close_thread") return;
      const after = stateOf(reviewId, review, loadTurns(reviewId)).state;
      if (!after.softTargetOffered && after.activeSeconds >= softTargetS) {
        appendTurn(reviewId, codeTurnId(reviewId, `soft_target:${turnId}`), "code", null, { notice: { kind: "soft_target_reached", elapsedS: after.activeSeconds } });
      }
    });
    yield { type: "turn_complete", turnId: outId };
  }

  return { invite, answerInvite, options, start, turn, view };
}
