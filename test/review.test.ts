/**
 * Review lifecycle (W7). Preparation and the tutor are fakes: a World that
 * answers the dependency questions from plain data, and a scripted tutor task
 * that runs through the real memo so streaming and abort take the real path.
 * The W8 functions (reviewState, allowedMoves, header parse, validateMove) are
 * replaced by a small TutorKit, so these tests do not depend on W8's bodies.
 */
import { describe, expect, test } from "bun:test";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, ChunkId, ChunkRevisionId, ClaimId, EvidenceId, ReviewId, ThreadId, TurnId } from "../src/shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkProvenance, ChunkRevision, Claim, ClaimStatus, EvidenceBundle, Gap, LearnerAct, Passage, ReviewState, Seq,
  StartResult, Turn, TurnEvent, TutorMove, TutorMoveKind,
} from "../src/shared/domain";
import { Material, interval } from "../src/shared/time";
import type { Interval } from "../src/shared/time";
import { MAX_MOVES_PER_TURN, createReviews } from "../src/backend/review";
import type { Reviews, TutorKit } from "../src/backend/review";
import { corrections, foldInvites, freezeScope, takeSentences } from "../src/backend/review/core";
import type { InviteEvent } from "../src/backend/review/core";
import { nextThreadId, tutorOwesMove, waitsForLearner } from "../src/backend/review/tutor";
import type { TutorInput, TutorOutput } from "../src/backend/review/tutor";
import { createMemo } from "../src/backend/providers/memo";
import type { Task } from "../src/backend/providers/memo";
import type { Db } from "../src/backend/db";
import { asSeq } from "../src/backend/db";
import { fail, fakeTask, ok, testDb } from "./fakes";
import type { FakeStep } from "./fakes";
import type { IdPart } from "../src/shared/ids";

const SRC = stableId("src", "youtube", "lecture");
const CONCEPT = stableId("cpt", "c");
const seq = (n: number) => asSeq(n);

// ───────────────────────────── the fake preparation world ─────────────────────────────

type WorldClaim = { text: string; evidence: EvidenceId[]; status: ClaimStatus; checkedAt?: Seq };

class World {
  readonly captureId: CaptureId = randomId("cap");
  chunks: ChunkRevision[] = [];
  claims = new Map<ClaimId, WorldClaim>();
  evidence = new Map<EvidenceId, Interval>();
  gaps: Gap[] = [];
  pendingChunks = new Set<ChunkRevisionId>();
  stops: (readonly ChunkRevisionId[])[] = [];
  captureState: "capturing" | "stopped" = "capturing";

  constructor(readonly db: Db) {}

  /** Closes chunk `ordinal`, or appends a new revision of it when it already closed. */
  close(ordinal: number, start: number, end: number, provenance: ChunkProvenance = "boundary"): ChunkRevision {
    const material = Material.of([[SRC, [interval(start, end)]]]);
    const chunkId = stableId("chk", this.captureId, ordinal);
    const latest = this.chunks.find((c) => c.chunkId === chunkId) ?? null;
    const rev: ChunkRevision = {
      id: stableId("crv", ordinal, start, end),
      chunkId,
      captureId: this.captureId,
      ordinal,
      revisionNo: (latest?.revisionNo ?? 0) + 1,
      material,
      windows: [],
      provenance,
      closedAtSeq: this.db.nextSeq(),
      supersedes: latest?.id ?? null,
    };
    this.chunks = [...this.chunks.filter((c) => c.ordinal !== ordinal), rev];
    this.revisions.push(rev);
    return rev;
  }

  revisions: ChunkRevision[] = [];

  /** A claim whose single piece of evidence sits at [start, end). */
  claim(n: number, start: number, end: number, status: ClaimStatus = "supported_by_check", text = `claim ${n}`): ClaimId {
    const id = stableId("clm", "k", n);
    const ev = stableId("ev", "w", n);
    this.evidence.set(ev, interval(start, end));
    this.claims.set(id, { text, evidence: [ev], status });
    return id;
  }

  /** A check result lands: new status, stamped with the check's seq. */
  check(id: ClaimId, status: ClaimStatus): void {
    const c = this.claims.get(id)!;
    c.status = status;
    c.checkedAt = this.db.nextSeq();
  }

  private inside(material: Material, ids: readonly EvidenceId[]): boolean {
    return ids.every((e) => Material.covers(material, SRC, this.evidence.get(e)!));
  }

  readonly deps = {
    currentChunks: (_: CaptureId): readonly ChunkRevision[] => this.chunks,
    chunkHistory: (chunkId: ChunkId): readonly ChunkRevision[] => this.revisions.filter((r) => r.chunkId === chunkId),
    prep: (id: ChunkRevisionId): ChunkPrep => {
      const rev = this.chunks.find((c) => c.id === id)!;
      const claims = [...this.claims].filter(([, c]) => this.inside(rev.material, c.evidence)).map(([cid, c]) => ({ id: cid, status: c.status }) as unknown as Claim);
      const terminal = claims.every((c) => !c.status.startsWith("awaiting"));
      return {
        chunkRevisionId: id,
        interpretation: "done",
        claims,
        finished: !this.pendingChunks.has(id) && terminal,
        supportedCount: claims.filter((c) => c.status === "supported_by_check").length,
      };
    },
    stopEarly: (_: CaptureId, ids: readonly ChunkRevisionId[]) => {
      this.stops.push(ids);
      for (const id of ids) {
        this.pendingChunks.delete(id);
        const rev = this.chunks.find((c) => c.id === id)!;
        for (const c of this.claims.values()) if (c.status.startsWith("awaiting") && this.inside(rev.material, c.evidence)) c.status = "dropped";
      }
      return this.db.nextSeq();
    },
    assessableIn: (_: CaptureId, material: Material): readonly AssessableClaim[] =>
      [...this.claims]
        .filter(([, c]) => c.status === "supported_by_check" && this.inside(material, c.evidence))
        .map(([id, c]) => ({ id, conceptId: CONCEPT, text: c.text, evidence: c.evidence, assumptions: [] }) as unknown as AssessableClaim),
    claimsIn: (_: CaptureId, material: Material): readonly Claim[] =>
      [...this.claims]
        .filter(([, c]) => this.inside(material, c.evidence))
        .map(([id, c]) => ({ id, status: c.status, originalCheck: c.checkedAt ? { atSeq: c.checkedAt } : null, revisionCheck: null }) as unknown as Claim),
    bundle: (material: Material): EvidenceBundle => ({
      material,
      passages: [...this.evidence]
        .filter(([, i]) => Material.covers(material, SRC, i))
        .map(([id, i]) => ({ kind: "passage", id, sourceId: SRC, interval: i, text: `passage ${id}` }) as unknown as Passage),
      frames: [],
      gaps: this.gaps.filter((g) => Material.get(material, g.sourceId).overlapFraction(g.interval) > 0),
      ads: [],
    }),
    watchedSeconds: (_: CaptureId) => this.chunks.reduce((s, c) => s + Material.duration(c.material), 0),
    runWrapUp: () => Promise.reject(new Error("wrap-up is not under test")),
    nextSeq: () => this.db.nextSeq(),
  };
}

// ───────────────────────────── the fake tutor ─────────────────────────────

const lastOf = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

/** The documented subset of W8's behaviour that W7's plumbing depends on. */
const kit: TutorKit = {
  reviewState(reviewId, turns, corrs, softTargetS): ReviewState {
    const tutors = turns.filter((t): t is Extract<Turn, { actor: "tutor" }> => t.actor === "tutor");
    const learners = turns.filter((t): t is Extract<Turn, { actor: "learner" }> => t.actor === "learner");
    const lastLearner = lastOf(learners) ?? null;
    const lastAct = lastLearner?.act.kind;
    const ended = tutors.some((t) => t.move.kind === "wrap_up");
    const lastThreadMove = lastOf(tutors.filter((t) => ["ask_main", "ask_followup", "close_thread"].includes(t.move.kind)));
    const openThread = lastThreadMove && lastThreadMove.move.kind !== "close_thread" ? lastThreadMove.threadId : null;
    return {
      reviewId,
      phase: ended ? "ended" : lastAct === "pause" ? "paused" : "active",
      mainQuestions: tutors.filter((t) => t.move.kind === "ask_main").length,
      openThread,
      lastLearnerAct: lastLearner,
      detour: { kind: "none" },
      openDispute: null,
      corrections: corrs,
      activeSeconds: turns.length > 1 ? (lastOf(turns)!.atMs - turns[0]!.atMs) / 1000 : 0,
      softTargetS,
      softTargetOffered: turns.some((t) => t.actor === "code" && t.notice.kind === "soft_target_reached"),
      wrapUpRequested: false,
    };
  },
  allowedMoves(state) {
    if (state.phase !== "active") return new Set<TutorMoveKind>();
    if (state.corrections.some((c) => !c.disclosed)) return new Set<TutorMoveKind>(["disclose_correction"]);
    return new Set<TutorMoveKind>(state.openThread ? ["ask_followup", "close_thread", "wrap_up"] : ["ask_main", "wrap_up"]);
  },
  parseMoveHeader(text) {
    const nl = text.indexOf("\n");
    if (nl < 0) return { kind: "pending" };
    try {
      const move = JSON.parse(text.slice(0, nl)) as TutorMove;
      if (typeof move.kind !== "string") throw new Error("no kind");
      return { kind: "header", move, rest: text.slice(nl + 1) };
    } catch {
      return { kind: "invalid", why: "first line is not a move header" };
    }
  },
  validateMove(move, input) {
    if (!input.allowed.includes(move.kind)) return { ok: false, why: `${move.kind} is not allowed now` };
    if (move.kind === "ask_main" && !move.claimIds.every((id) => input.claims.some((c) => c.id === id))) return { ok: false, why: "claim is not assessable" };
    return { ok: true };
  },
};

const THREAD: ThreadId = stableId("thr", 1);
const SECOND_THREAD: ThreadId = stableId("thr", 2);

function askMain(...claimIds: ClaimId[]): TutorMove {
  return { kind: "ask_main", threadId: THREAD, claimIds: claimIds as [ClaimId, ...ClaimId[]] };
}

/** Header line, then prose, cut into small deltas so the header arrives in pieces. */
function reply(move: TutorMove, say: string): FakeStep<TutorOutput> {
  const text = `${JSON.stringify(move)}\n${say}`;
  return ok({ move, say }, { deltas: text.match(/[\s\S]{1,9}/g) ?? [] });
}

type Script = (input: TutorInput, call: number) => FakeStep<TutorOutput> | Promise<FakeStep<TutorOutput>>;

function tutorHarness(db: Db, script: Script) {
  const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
  const base = fakeTask<IdPart, TutorOutput>({ purpose: "tutor_turn", provider: "claude", answer: (i, n) => script(i as unknown as TutorInput, n) });
  const task: Task<TutorInput, TutorOutput> = {
    ...(base as unknown as Task<TutorInput, TutorOutput>),
    canonicalInput: (i) => ({ turns: i.turns.map((t) => t.id), repair: i.repairNote, claims: i.claims.map((c) => c.id) }),
  };
  return {
    calls: base.calls as unknown as TutorInput[],
    runTutor: (input: TutorInput, streamTo: (d: string) => void, signal: AbortSignal) => memo.run(task, input, { signal, streamTo }),
    clearFailures: memo.clearFailures,
  };
}

// ───────────────────────────── harness ─────────────────────────────

type Rig = ReturnType<typeof rig>;

function rig(script: Script = () => fail("no tutor scripted"), config: { softTargetS?: number; estimateS?: (n: number) => number | null; timeInviteGapS?: number } = {}) {
  const db = testDb();
  const world = new World(db);
  const tutor = tutorHarness(db, script);
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const reviews: Reviews = createReviews(db, { ...world.deps, runTutor: tutor.runTutor, clearFailures: tutor.clearFailures }, { tutor: kit, now: () => t, ...config });
  return { db, world, tutor, reviews, clock, capture: world.captureId };
}

const reviewRows = (db: Db) => db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reviews").get()!.n;
const turnRows = (db: Db, actor: string) => db.sql.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_turns WHERE actor = ?").get(actor)!.n;

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const types = (events: readonly TurnEvent[]) => events.map((e) => e.type);
const answer = (text = "an answer"): LearnerAct => ({ kind: "answer", text, modality: "text" });

function started(r: StartResult) {
  if (r.kind !== "started") throw new Error(`expected started, got ${r.kind}`);
  return r;
}

/** One finished chunk [0, 300) with one supported claim, a review started on it. */
function startedRig(script: Script = () => reply(askMain(), ""), config = {}, withSecondClaim = false) {
  const r = rig(script, config);
  r.world.close(0, 0, 300);
  const claim = r.world.claim(1, 10, 20);
  const claim2 = withSecondClaim ? r.world.claim(2, 30, 40) : null;
  const reviewId = randomId("rvw");
  const res = started(r.reviews.start(r.capture, "prepared_only", reviewId));
  return { ...r, claim, claim2, reviewId, scope: res.scope };
}

// ───────────────────────────── core: invite fold ─────────────────────────────

describe("foldInvites (flow C invite policy)", () => {
  const closed = (n: number, provenance: ChunkProvenance, watchedS: number): InviteEvent => ({
    kind: "chunk_closed", seq: seq(n), provenance, chunk: stableId("crv", n), watchedS,
  });
  const answered = (n: number, a: "review_now" | "later" | "wait" | "stop_early", watchedS: number): InviteEvent => ({ kind: "answer", seq: seq(n), answer: a, watchedS });
  const fold = (events: readonly InviteEvent[], gapS: number) => foldInvites(events, gapS).state;

  test("a boundary close invites", () => {
    expect(fold([closed(1, "boundary", 300)], 900)).toEqual({ state: "invited", atChunk: stableId("crv", 1) });
  });

  test("a time-cap close invites only after the gap since the last invite", () => {
    const events = [closed(1, "boundary", 300), closed(2, "time", 780)];
    expect(fold(events, 900)).toEqual({ state: "invited", atChunk: stableId("crv", 1) });
    expect(fold([...events, closed(3, "time", 1260)], 900)).toEqual({ state: "invited", atChunk: stableId("crv", 3) });
  });

  test("a time-cap close with nothing before it invites once enough was watched", () => {
    expect(fold([closed(1, "time", 480)], 900)).toEqual({ state: "none" });
    expect(fold([closed(1, "time", 960)], 900)).toMatchObject({ state: "invited" });
  });

  test("session_end sends no invite", () => {
    expect(fold([closed(1, "session_end", 5000)], 900)).toEqual({ state: "none" });
  });

  test("a chunk first stored with its boundary already revised closed at a boundary, so it invites", () => {
    expect(fold([closed(1, "boundary_revised", 300)], 900)).toEqual({ state: "invited", atChunk: stableId("crv", 1) });
  });

  test("a repeated answer to the same invite changes nothing; the next invite takes answers afresh", () => {
    const once = [closed(1, "boundary", 300), answered(2, "later", 300), closed(3, "time", 700)];
    const twice = [...once, answered(4, "later", 700)];
    expect(foldInvites(twice, 900)).toEqual(foldInvites(once, 900));
    expect(fold([...twice, closed(5, "time", 1250)], 900)).toMatchObject({ state: "invited" });
    expect(fold([...twice, closed(5, "boundary", 800), answered(6, "later", 800), closed(7, "time", 1250)], 900)).toEqual({ state: "later" });
  });

  test("Later waits for the next boundary close, and restarts the time-cap gap", () => {
    const afterLater = [closed(1, "boundary", 300), answered(2, "later", 300)];
    expect(fold(afterLater, 900)).toEqual({ state: "later" });
    expect(fold([...afterLater, closed(3, "time", 780)], 900)).toEqual({ state: "later" });
    expect(fold([...afterLater, closed(3, "time", 1300)], 900)).toMatchObject({ state: "invited" });
    expect(fold([...afterLater, closed(3, "boundary", 400)], 900)).toMatchObject({ state: "invited" });
  });

  test("Wait shows waiting; review_now, stop_early and a started review clear the invite", () => {
    const invited = closed(1, "boundary", 300);
    expect(fold([invited, answered(2, "wait", 300)], 900)).toEqual({ state: "waiting" });
    expect(fold([invited, answered(2, "review_now", 300)], 900)).toEqual({ state: "none" });
    expect(fold([invited, answered(2, "stop_early", 300)], 900)).toEqual({ state: "none" });
    expect(fold([invited, { kind: "review_started", seq: seq(2) }], 900)).toEqual({ state: "none" });
  });

  test("events are folded in seq order whatever order they arrive in", () => {
    expect(fold([answered(2, "later", 300), closed(1, "boundary", 300)], 900)).toEqual({ state: "later" });
  });
});

// ───────────────────────────── core: scope and corrections ─────────────────────────────

describe("freezeScope", () => {
  const world = new World(testDb());
  const a = world.close(0, 0, 300);
  const b = world.close(1, 300, 600);
  world.claim(1, 10, 20);
  world.claim(2, 400, 410, "unverified");
  const prep = (rev: ChunkRevision, finished = true): { rev: ChunkRevision; prep: ChunkPrep } => ({ rev, prep: { ...world.deps.prep(rev.id), finished } });

  test("R10: no supported claim in scope means no scope", () => {
    expect(freezeScope([prep(b)], world.deps.assessableIn.bind(null, world.captureId), () => [], seq(1))).toBeNull();
    expect(freezeScope([], () => [], () => [], seq(1))).toBeNull();
  });

  test("only finished chunks enter the scope; the rest are reported as still preparing", () => {
    const scope = freezeScope([prep(b, false), prep(a)], world.deps.assessableIn.bind(null, world.captureId), () => [], seq(7))!;
    expect(scope.chunkRevisions).toEqual([a.id]);
    expect(Material.equals(scope.material, a.material)).toBe(true);
    expect(scope.claimsAtStart).toEqual([stableId("clm", "k", 1)]);
    expect(scope.frozenAtSeq).toBe(seq(7));
    expect(scope.partial).toEqual([{ kind: "chunks_still_preparing", count: 1 }]);
  });

  test("gaps and unverified claims are recorded as partial reasons", () => {
    const gap: Gap = { sourceId: SRC, interval: interval(100, 120), channel: "frames", reason: "frame_stall" };
    const scope = freezeScope([prep(a), prep(b)], world.deps.assessableIn.bind(null, world.captureId), () => [gap], seq(7))!;
    expect(scope.partial).toEqual([{ kind: "capture_gap", gap }, { kind: "unverified_claims", count: 1 }]);
  });
});

describe("corrections (R7)", () => {
  const w = new World(testDb());
  const scopeRev = w.close(0, 0, 100);
  const c1 = w.claim(1, 10, 20);
  const c2 = w.claim(2, 30, 40);
  const scope = freezeScope([{ rev: scopeRev, prep: w.deps.prep(scopeRev.id) }], (m) => w.deps.assessableIn(w.captureId, m), () => [], seq(5))!;
  const rid: ReviewId = randomId("rvw");
  const texts = new Map([[c1, "claim 1"], [c2, "claim 2"]]);
  const inScope = new Set(w.deps.bundle(scope.material).passages.map((p) => p.id));
  const usable = (...ids: ClaimId[]) => w.deps.assessableIn(w.captureId, Material.of([[SRC, [interval(0, 1000)]]])).filter((c) => ids.includes(c.id));
  const unchanged = () => null;

  test("nothing changed, nothing to disclose", () => {
    expect(corrections(rid, scope, usable(c1, c2), new Set(), texts, inScope, unchanged)).toEqual([]);
  });

  test("a claim that stops being usable is withdrawn; changed text is a correction", () => {
    const changed = usable(c1).map((c) => ({ ...c, text: "claim 1, reworded" }) as AssessableClaim);
    const out = corrections(rid, scope, changed, new Set(), texts, inScope, unchanged);
    expect(out.map((c) => [c.claimId, c.change, c.disclosed])).toEqual([[c1, "text_changed", false], [c2, "withdrawn", false]]);
  });

  test("a correction already disclosed is marked disclosed", () => {
    const [first] = corrections(rid, scope, usable(c1), new Set(), texts, inScope, unchanged);
    const again = corrections(rid, scope, usable(c1), new Set([first!.id]), texts, inScope, unchanged);
    expect(again[0]).toMatchObject({ claimId: c2, change: "withdrawn", disclosed: true });
  });

  test("each occurrence of a change is its own correction: new text, or a claim state reached by a new check", () => {
    const disclosed = new Set(corrections(rid, scope, usable(c1), new Set(), texts, inScope, () => ({ checkedAt: 7 })).map((c) => c.id));
    const reworded = (text: string) => usable(c1, c2).map((c) => (c.id === c2 ? ({ ...c, text }) as AssessableClaim : c));
    expect(corrections(rid, scope, usable(c1), disclosed, texts, inScope, () => ({ checkedAt: 7 }))).toMatchObject([{ change: "withdrawn", disclosed: true }]);
    expect(corrections(rid, scope, usable(c1), disclosed, texts, inScope, () => ({ checkedAt: 9 }))).toMatchObject([{ change: "withdrawn", disclosed: false }]);
    const once = new Set(corrections(rid, scope, reworded("v1"), new Set(), texts, inScope, unchanged).map((c) => c.id));
    expect(corrections(rid, scope, reworded("v1"), once, texts, inScope, unchanged)).toMatchObject([{ change: "text_changed", disclosed: true }]);
    expect(corrections(rid, scope, reworded("v2"), once, texts, inScope, unchanged)).toMatchObject([{ change: "text_changed", disclosed: false }]);
  });

  test("a newly usable claim is a correction only when all its evidence is inside the scope material", () => {
    const w2 = new World(testDb());
    w2.claim(3, 50, 60);
    w2.claim(4, 500, 510);
    const fresh = w2.deps.assessableIn(w2.captureId, Material.of([[SRC, [interval(0, 1000)]]]));
    const inside = new Set([...inScope, ...[...w2.evidence].filter(([, i]) => i.start < 100).map(([id]) => id)]);
    const out = corrections(rid, scope, [...usable(c1, c2), ...fresh], new Set(), texts, inside, unchanged);
    expect(out.map((c) => [c.claimId, c.change])).toEqual([[stableId("clm", "k", 3), "new_in_scope"]]);
  });
});

describe("takeSentences", () => {
  test("splits at sentence ends followed by whitespace and keeps the unfinished tail", () => {
    expect(takeSentences("First one. Second one? Third, not yet")).toEqual({ sentences: ["First one.", "Second one?"], rest: "Third, not yet" });
    expect(takeSentences("It is 3.5 here")).toEqual({ sentences: [], rest: "It is 3.5 here" });
  });
});

// ───────────────────────────── invites through createReviews ─────────────────────────────

describe("invite", () => {
  test("follows the closes of the capture and the learner's answers", () => {
    const r = rig();
    expect(r.reviews.invite(r.capture)).toEqual({ state: "none" });
    const a = r.world.close(0, 0, 300);
    expect(r.reviews.invite(r.capture)).toEqual({ state: "invited", atChunk: a.id });
    expect(r.reviews.answerInvite(r.capture, "later")).toEqual({ state: "later" });
    r.world.close(1, 300, 780, "time");
    expect(r.reviews.invite(r.capture)).toEqual({ state: "later" });
    const c = r.world.close(2, 780, 1100);
    expect(r.reviews.invite(r.capture)).toEqual({ state: "invited", atChunk: c.id });
    expect(r.reviews.answerInvite(r.capture, "wait")).toEqual({ state: "waiting" });
  });

  test("an outstanding boundary invite survives a revision of that chunk's boundary, and names the new revision", () => {
    const r = rig();
    r.world.close(0, 0, 300);
    const revised = r.world.close(0, 0, 330, "boundary_revised");
    expect(r.reviews.invite(r.capture)).toEqual({ state: "invited", atChunk: revised.id });
  });

  test("a boundary revision after Later is the same close, not a new invite", () => {
    const r = rig();
    r.world.close(0, 0, 300);
    r.reviews.answerInvite(r.capture, "later");
    r.world.close(0, 0, 330, "boundary_revised");
    expect(r.reviews.invite(r.capture)).toEqual({ state: "later" });
  });

  test("a retried Later stores nothing and does not push the next time-cap invite back", () => {
    const r = rig();
    r.world.close(0, 0, 300);
    r.reviews.answerInvite(r.capture, "later");
    r.world.close(1, 300, 700, "time");
    expect(r.reviews.answerInvite(r.capture, "later")).toEqual({ state: "later" });
    expect(r.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM invite_answers").get()!.n).toBe(1);
    r.world.close(2, 700, 1250, "time");
    expect(r.reviews.invite(r.capture)).toMatchObject({ state: "invited" });
  });

  test("a session_end close sends no invite, and Review now stays available", () => {
    const r = rig();
    r.world.close(0, 0, 300, "session_end");
    r.world.claim(1, 10, 20);
    expect(r.reviews.invite(r.capture)).toEqual({ state: "none" });
    expect(r.reviews.options(r.capture).kind).toBe("ready");
  });

  test("starting a review clears the invite", () => {
    const r = rig();
    r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20);
    expect(r.reviews.invite(r.capture).state).toBe("invited");
    started(r.reviews.start(r.capture, "prepared_only", randomId("rvw")));
    expect(r.reviews.invite(r.capture)).toEqual({ state: "none" });
  });

  test("R5: Later is an invite fact only; nothing preparation sees changes", () => {
    const r = rig();
    const pending = r.world.close(0, 0, 300);
    r.world.pendingChunks.add(pending.id);
    const before = r.reviews.options(r.capture);
    expect(r.reviews.answerInvite(r.capture, "later")).toEqual({ state: "later" });
    expect(r.world.stops).toEqual([]);
    expect(r.world.pendingChunks.has(pending.id)).toBe(true);
    expect(r.reviews.options(r.capture)).toEqual(before);
    expect(r.db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM invite_answers").get()!.n).toBe(1);
  });
});

// ───────────────────────────── options ─────────────────────────────

describe("options", () => {
  test("ready: a finished chunk with a supported claim, previewed", () => {
    const r = rig();
    const a = r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20);
    r.world.claim(2, 30, 40, "unverified");
    expect(r.reviews.options(r.capture)).toEqual({
      kind: "ready",
      scope: { chunkRevisions: [a.id], supportedClaims: 1, partial: [{ kind: "unverified_claims", count: 1 }] },
    });
  });

  test("processing: pending chunks, what is ready now, and an estimate only when the scheduler has one", () => {
    const r = rig();
    const done = r.world.close(0, 0, 300);
    const busy = r.world.close(1, 300, 600);
    r.world.claim(1, 10, 20);
    r.world.pendingChunks.add(busy.id);
    const opts = r.reviews.options(r.capture);
    expect(opts).toMatchObject({ kind: "processing", pendingChunks: 1, estimateS: null, readyNow: { chunkRevisions: [done.id], supportedClaims: 1 } });

    const reliable = rig(undefined, { estimateS: (n) => n * 40 });
    reliable.world.close(0, 0, 300);
    reliable.world.pendingChunks.add(reliable.world.chunks[0]!.id);
    expect(reliable.reviews.options(reliable.capture)).toMatchObject({ kind: "processing", readyNow: null, estimateS: 40 });
  });

  test("nothing_to_review: shows the gaps, the unverified claims and the interval to rewatch", () => {
    const r = rig();
    r.world.close(0, 0, 300);
    const unverified = r.world.claim(1, 10, 20, "unverified");
    r.world.gaps = [{ sourceId: SRC, interval: interval(100, 130), channel: "frames", reason: "frame_stall" }];
    const opts = r.reviews.options(r.capture);
    if (opts.kind !== "nothing_to_review") throw new Error(opts.kind);
    expect(opts.gaps).toHaveLength(1);
    expect(opts.unverified.map((c) => c.id)).toEqual([unverified]);
    expect(opts.rewatch.map((x) => [x.sourceId, Number(x.interval.start), Number(x.interval.end)])).toEqual([[SRC, 100, 130], [SRC, 0, 300]]);
  });

  test("nothing_to_review before anything is captured", () => {
    const r = rig();
    expect(r.reviews.options(r.capture)).toEqual({ kind: "nothing_to_review", gaps: [], unverified: [], rewatch: [] });
  });

  test("material an earlier review already covered is not offered again", () => {
    const r = startedRig();
    expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
    const next = r.world.close(1, 300, 600);
    r.world.claim(2, 310, 320);
    expect(r.reviews.options(r.capture)).toMatchObject({ kind: "ready", scope: { chunkRevisions: [next.id] } });
  });
});

// ───────────────────────────── start ─────────────────────────────

describe("start", () => {
  test("R10: zero supported claims returns nothing_to_review and writes no review row", () => {
    const r = rig();
    r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20, "unverified");
    const res = r.reviews.start(r.capture, "prepared_only", randomId("rvw"));
    expect(res.kind).toBe("nothing_to_review");
    expect(reviewRows(r.db)).toBe(0);
  });

  test("R10: still-preparing chunks alone do not start a review", () => {
    const r = rig();
    const a = r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20);
    r.world.pendingChunks.add(a.id);
    expect(r.reviews.start(r.capture, "prepared_only", randomId("rvw")).kind).toBe("nothing_to_review");
    expect(reviewRows(r.db)).toBe(0);
  });

  test("freezes the finished chunks, their material and their supported claims", () => {
    const r = rig();
    const a = r.world.close(0, 0, 300);
    const busy = r.world.close(1, 300, 600);
    r.world.pendingChunks.add(busy.id);
    const c = r.world.claim(1, 10, 20);
    const res = started(r.reviews.start(r.capture, "prepared_only", randomId("rvw")));
    expect(res.scope.chunkRevisions).toEqual([a.id]);
    expect(res.scope.claimsAtStart).toEqual([c]);
    expect(Material.equals(res.scope.material, a.material)).toBe(true);
    expect(res.scope.partial).toEqual([{ kind: "chunks_still_preparing", count: 1 }]);
    expect(r.world.stops).toEqual([]);
  });

  test("stop_early cancels the pending chunks first and keeps every finished claim", () => {
    const r = rig();
    const done = r.world.close(0, 0, 300);
    const busy = r.world.close(1, 300, 600);
    r.world.pendingChunks.add(busy.id);
    r.world.claim(1, 10, 20);
    r.world.claim(2, 400, 410, "awaiting_check");
    const res = started(r.reviews.start(r.capture, "stop_early", randomId("rvw")));
    expect(r.world.stops).toEqual([[busy.id]]);
    expect(res.scope.chunkRevisions).toEqual([done.id, busy.id]);
    expect(res.scope.partial).toEqual([{ kind: "stopped_early", droppedClaims: 1 }]);
  });

  test("idempotent on the app-minted reviewId: a retry returns the stored scope and changes nothing", () => {
    const r = rig();
    r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20);
    const id = randomId("rvw");
    const first = started(r.reviews.start(r.capture, "prepared_only", id));
    r.world.close(1, 300, 600);
    r.world.claim(2, 310, 320);
    const second = started(r.reviews.start(r.capture, "prepared_only", id));
    expect(second.scope).toEqual(first.scope);
    expect(reviewRows(r.db)).toBe(1);
    expect(r.reviews.view(id).scope).toEqual(first.scope);
  });

  test("a retried stop_early start does not cancel anything a second time", () => {
    const r = rig();
    r.world.close(0, 0, 300);
    const busy = r.world.close(1, 300, 600);
    r.world.pendingChunks.add(busy.id);
    r.world.claim(1, 10, 20);
    const id = randomId("rvw");
    r.reviews.start(r.capture, "stop_early", id);
    r.reviews.start(r.capture, "stop_early", id);
    expect(r.world.stops).toHaveLength(1);
  });

  test("R7: the stored scope rejects UPDATE", () => {
    const r = startedRig();
    expect(() => r.db.sql.run("UPDATE reviews SET scope_json = '{}'")).toThrow(/append-only/);
  });
});

// ───────────────────────────── R7: scope never grows ─────────────────────────────

describe("a recurring correction is disclosed each time", () => {
  /** Each turn the tutor discloses the first pending correction, or wraps up when none is pending. */
  function disclosingRig(text = "v0") {
    const r = rig();
    r.world.close(0, 0, 300);
    const claim = r.world.claim(1, 10, 20, "supported_by_check", text);
    const reviewId = randomId("rvw");
    started(r.reviews.start(r.capture, "prepared_only", reviewId));
    const t = tutorHarness(r.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      return pending
        ? reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.")
        : reply({ kind: "ask_main", threadId: THREAD, claimIds: [input.claims[0]!.id] }, "A question.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const pending = () => reviews.view(reviewId).state.corrections.filter((c) => !c.disclosed);
    const turn = () => collect(reviews.turn(reviewId, randomId("turn"), answer()));
    return { ...r, claim, reviewId, reviews, pending, turn };
  }

  test("a second text change after the first was disclosed must be disclosed too", async () => {
    const x = disclosingRig("v0");
    x.world.claims.get(x.claim)!.text = "v1";
    await x.turn();
    expect(x.pending()).toEqual([]);
    x.world.claims.get(x.claim)!.text = "v2";
    expect(x.pending()).toMatchObject([{ claimId: x.claim, change: "text_changed" }]);
  });

  test("withdrawn, disclosed, reinstated by a new check, then withdrawn again must be disclosed again", async () => {
    const x = disclosingRig();
    x.world.check(x.claim, "unverified");
    await x.turn();
    expect(x.pending()).toEqual([]);
    x.world.check(x.claim, "supported_by_check");
    expect(x.pending()).toEqual([]);
    x.world.check(x.claim, "unverified");
    expect(x.pending()).toMatchObject([{ claimId: x.claim, change: "withdrawn" }]);
  });

  test("a withdrawal that persists is disclosed once", async () => {
    const x = disclosingRig();
    x.world.check(x.claim, "unverified");
    await x.turn();
    await x.turn();
    expect(x.pending()).toEqual([]);
  });
});

describe("R7 scope never grows (the TLC counterexample)", () => {
  /** Review starts on [0, 60); a later window moves the boundary so the chunk now reaches [0, 120) with a new claim in the new half. */
  function counterexample() {
    const r = rig((input) => reply(askMain(...input.claims.map((c) => c.id) as [ClaimId, ...ClaimId[]]), "What does the first claim say?"));
    const rev = r.world.close(0, 0, 60);
    const old = r.world.claim(1, 10, 20);
    const reviewId = randomId("rvw");
    const scope = started(r.reviews.start(r.capture, "prepared_only", reviewId)).scope;
    const moved = r.world.close(0, 0, 120, "boundary_revised");
    const added = r.world.claim(2, 70, 80);
    return { ...r, rev, moved, old, added, reviewId, scope };
  }

  test("the open review keeps its frozen material and claims", () => {
    const x = counterexample();
    const view = x.reviews.view(x.reviewId);
    expect(view.scope).toEqual(x.scope);
    expect(Material.duration(view.scope.material)).toBe(60);
    expect(view.scope.claimsAtStart).toEqual([x.old]);
  });

  test("the tutor is only ever given claims and evidence inside the frozen material", async () => {
    const x = counterexample();
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    const input = x.tutor.calls[0]!;
    expect(input.claims.map((c) => c.id)).toEqual([x.old]);
    expect(input.evidence.passages.map((p) => p.id)).toEqual([stableId("ev", "w", 1)]);
    expect(x.reviews.view(x.reviewId).state.corrections).toEqual([]);
  });

  test("a dependency that ignores the material it was given still cannot add material", async () => {
    const x = counterexample();
    const leaky = createReviews(x.db, { ...x.world.deps, assessableIn: (_, __) => x.world.deps.assessableIn(x.capture, x.moved.material), runTutor: x.tutor.runTutor, clearFailures: x.tutor.clearFailures }, { tutor: kit });
    await collect(leaky.turn(x.reviewId, randomId("turn"), answer()));
    expect(x.tutor.calls[0]!.claims.map((c) => c.id)).toEqual([x.old]);
    expect(leaky.view(x.reviewId).state.corrections).toEqual([]);
  });

  test("the moved boundary becomes separate, later material instead", () => {
    const x = counterexample();
    expect(x.reviews.options(x.capture)).toMatchObject({ kind: "ready", scope: { chunkRevisions: [x.moved.id] } });
  });

  test("a claim inside the scope that is withdrawn is disclosed as a correction, and the tutor must disclose it first", async () => {
    const x = counterexample();
    x.world.claims.get(x.old)!.status = "unverified";
    const t = tutorHarness(x.db, (input) =>
      reply({ kind: "disclose_correction", correctionId: input.state.corrections[0]!.id, threadIds: [], evidence: [] }, "I need to correct something."),
    );
    const reviews = createReviews(x.db, { ...x.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const events = await collect(reviews.turn(x.reviewId, randomId("turn"), answer()));
    expect(t.calls[0]!.allowed).toEqual(["disclose_correction"]);
    expect(events.find((e) => e.type === "turn_failed")).toBeUndefined();
    const turns = reviews.view(x.reviewId).turns;
    expect(turns.filter((t) => t.actor === "code")).toMatchObject([{ notice: { kind: "correction_pending", affectedClaims: [x.old] } }]);
    expect(reviews.view(x.reviewId).state.corrections).toMatchObject([{ claimId: x.old, change: "withdrawn", disclosed: true }]);
  });
});

// ───────────────────────────── a pending correction never sticks the review ─────────────────────────────

describe("code-written disclose_correction when the model fails", () => {
  /** The real W8 rules (allowedMoves, validateMove), so the code move passes the same check a model move would. */
  function stuck(script: Script) {
    const r = startedRig(undefined, {}, true);
    const t = tutorHarness(r.db, script);
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 });
    return { ...r, t, reviews };
  }
  /** Invalid while a correction is pending (so code writes the disclosure); a valid question once it is not. */
  const useless: Script = (input) =>
    input.allowed.includes("ask_main")
      ? reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "A question.")
      : reply({ kind: "wrap_up" }, "Bye.");
  const disclosures = (reviews: Reviews, reviewId: ReviewId) =>
    reviews.view(reviewId).turns.filter((t) => t.actor === "tutor" && t.move.kind === "disclose_correction");

  test("a withdrawn claim: after two failed model calls code discloses it, names the claim and cites no evidence", async () => {
    const x = stuck(useless);
    x.world.claims.get(x.claim)!.status = "unverified";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));

    expect(x.t.calls).toHaveLength(3);
    expect(x.t.calls[0]!.allowed).toEqual(["disclose_correction"]);
    const move = events.find((e) => e.type === "move");
    expect(move).toMatchObject({ move: { kind: "disclose_correction", threadIds: [], evidence: [] } });
    const said = events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("");
    expect(said).toContain("claim 1");
    expect(said).toMatch(/no longer/);
    expect(events.filter((e) => e.type === "move").map((e) => e.type === "move" && e.move.kind)).toEqual(["disclose_correction", "ask_main"]);
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(x.reviews.view(x.reviewId).state.corrections).toMatchObject([{ claimId: x.claim, change: "withdrawn", disclosed: true }]);
  });

  test("a reworded claim on an open thread: the disclosure names the new text, the thread, and only the claim's own evidence", async () => {
    let call = 0;
    const x = stuck((input) => {
      call++;
      if (call === 1) return reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "Question one.");
      return input.allowed.includes("ask_followup") ? reply({ kind: "ask_followup", threadId: input.state.openThread! }, "Say more.") : reply({ kind: "wrap_up" }, "Bye.");
    });
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer("first")));
    x.world.claims.get(x.claim)!.text = "claim 1, reworded";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer("second")));

    const open = nextThreadId({ reviewId: x.reviewId, mainQuestions: 0 });
    expect(events.find((e) => e.type === "move")).toMatchObject({
      move: { kind: "disclose_correction", threadIds: [open], evidence: [stableId("ev", "w", 1)] },
    });
    const said = events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("");
    expect(said).toContain("claim 1, reworded");
    expect(x.reviews.view(x.reviewId).state.corrections).toMatchObject([{ change: "text_changed", disclosed: true }]);
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("a retried turn replays the same code move and writes nothing twice", async () => {
    const x = stuck(useless);
    x.world.claims.get(x.claim)!.status = "unverified";
    const turnId = randomId("turn");
    const first = await collect(x.reviews.turn(x.reviewId, turnId, answer()));
    const turnsBefore = x.reviews.view(x.reviewId).turns;
    const again = await collect(x.reviews.turn(x.reviewId, turnId, answer()));

    expect(x.t.calls).toHaveLength(3);
    expect(x.reviews.view(x.reviewId).turns).toEqual(turnsBefore);
    expect(disclosures(x.reviews, x.reviewId)).toHaveLength(1);
    expect(again.filter((e) => e.type === "move")).toEqual(first.filter((e) => e.type === "move"));
    expect(again.filter((e) => e.type === "sentence")).toEqual(first.filter((e) => e.type === "sentence"));
  });

  test("when the disclosure and a closing move are both allowed, the disclosure comes first", async () => {
    const r = startedRig();
    r.world.claims.get(r.claim)!.status = "unverified";
    const t = tutorHarness(r.db, () => reply({ kind: "propose_detour", topic: "x", reason: "y", needsResource: null }, "Detour."));
    const both: TutorKit = { ...kit, allowedMoves: () => new Set<TutorMoveKind>(["wrap_up", "disclose_correction"]) };
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: both });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "disclose_correction" } });
  });

  test("when the model succeeds its own disclosure is used and code writes nothing", async () => {
    const x = stuck((input) =>
      input.allowed.includes("disclose_correction")
        ? reply({ kind: "disclose_correction", correctionId: input.state.corrections.find((c) => !c.disclosed)!.id, threadIds: [], evidence: [] }, "Model words.")
        : reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "Then a question."),
    );
    x.world.claims.get(x.claim)!.status = "unverified";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    expect(x.t.calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("")).toBe("Model words.Then a question.");
    expect(disclosures(x.reviews, x.reviewId)).toMatchObject([{ say: "Model words." }]);
  });
});

// ───────────────────────────── turns ─────────────────────────────

describe("turn", () => {
  test("streams learner_turn_stored, the prose by delta and sentence, the move once stored, then turn_complete", async () => {
    const r = startedRig();
    const move = askMain(r.claim);
    const t = tutorHarness(r.db, () => reply(move, "What is the main idea? Say it in your own words."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit, now: () => 1 });
    const turnId = randomId("turn");
    const events: TurnEvent[] = [];
    let storedWhenMoveSent: readonly Turn[] = [];
    for await (const e of reviews.turn(r.reviewId, turnId, answer())) {
      if (e.type === "move") storedWhenMoveSent = reviews.view(r.reviewId).turns;
      events.push(e);
    }

    expect(types(events)[0]).toBe("learner_turn_stored");
    expect(types(events)[1]).toBe("say_delta");
    expect(types(events).slice(-2)).toEqual(["move", "turn_complete"]);
    expect(storedWhenMoveSent.filter((x) => x.actor === "tutor")).toMatchObject([{ move }]);
    expect(events.filter((e) => e.type === "move")).toEqual([{ type: "move", turnId: stableId("turn", r.reviewId, turnId, "tutor"), move }]);
    expect(events.filter((e) => e.type === "say_delta").map((e) => e.type === "say_delta" && e.text).join("")).toBe("What is the main idea? Say it in your own words.");
    expect(events.filter((e) => e.type === "sentence").map((e) => e.type === "sentence" && e.text)).toEqual(["What is the main idea?", "Say it in your own words."]);
    const stored = reviews.view(r.reviewId).turns;
    expect(stored.map((x) => x.actor)).toEqual(["learner", "tutor"]);
    expect(stored[1]).toMatchObject({ actor: "tutor", threadId: THREAD, say: "What is the main idea? Say it in your own words." });
  });

  test("every learner turn carries the thread open when it was said", async () => {
    const r = startedRig();
    let call = 0;
    const t = tutorHarness(r.db, () => {
      call++;
      if (call === 1) return reply(askMain(r.claim), "Question.");
      if (call === 2) return reply({ kind: "ask_followup", threadId: THREAD }, "Say more.");
      if (call === 3) return reply({ kind: "close_thread", threadId: THREAD }, "Good.");
      return reply({ kind: "ask_main", threadId: SECOND_THREAD, claimIds: [r.claim] }, "Next question.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    for (let i = 0; i < 4; i++) await collect(reviews.turn(r.reviewId, randomId("turn"), answer(String(i))));
    const learners = reviews.view(r.reviewId).turns.filter((x) => x.actor === "learner");
    expect(learners.map((x) => x.threadId)).toEqual([null, THREAD, THREAD, SECOND_THREAD]);
  });

  test("the learner turn is committed before the model is called", async () => {
    const r = rig();
    r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20);
    const reviewId = randomId("rvw");
    let seenDuringCall: readonly Turn[] = [];
    const t = tutorHarness(r.db, () => {
      seenDuringCall = r.reviews.view(reviewId).turns;
      return reply({ kind: "wrap_up" }, "Done.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    started(reviews.start(r.capture, "prepared_only", reviewId));
    await collect(reviews.turn(reviewId, randomId("turn"), answer("my answer")));
    expect(seenDuringCall.map((x) => x.actor)).toEqual(["learner"]);
  });

  test("idempotent on turnId: a resend appends nothing, replays the reply, and pays for no second call", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply(askMain(r.claim), "First question. Second part."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const turnId = randomId("turn");
    const first = await collect(reviews.turn(r.reviewId, turnId, answer()));
    const again = await collect(reviews.turn(r.reviewId, turnId, answer()));

    expect(t.calls).toHaveLength(1);
    expect(turnRows(r.db, "learner")).toBe(1);
    expect(turnRows(r.db, "tutor")).toBe(1);
    expect(again.filter((e) => e.type === "move")).toEqual(first.filter((e) => e.type === "move"));
    expect(again.filter((e) => e.type === "sentence")).toEqual(first.filter((e) => e.type === "sentence"));
    expect(types(again).at(-1)).toBe("turn_complete");
  });

  test("a failed model call keeps the learner turn; resending the same turnId calls the model once more and completes it", async () => {
    let healthy = false;
    const r = startedRig();
    const t = tutorHarness(r.db, (): FakeStep<TutorOutput> => (healthy ? reply(askMain(r.claim), "Try this.") : fail("boom")));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const turnId = randomId("turn");
    const failed = await collect(reviews.turn(r.reviewId, turnId, answer("kept")));
    expect(failed.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    expect(t.calls).toHaveLength(1);
    expect(turnRows(r.db, "learner")).toBe(1);
    expect(turnRows(r.db, "tutor")).toBe(0);

    healthy = true;
    const retried = await collect(reviews.turn(r.reviewId, turnId, answer("kept")));
    expect(types(retried).at(-1)).toBe("turn_complete");
    expect(t.calls).toHaveLength(2);
    expect(turnRows(r.db, "learner")).toBe(1);
    expect(turnRows(r.db, "tutor")).toBe(1);
  });

  test("a resend that fails again is retryable again, one model call per send", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => fail("still down"));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const turnId = randomId("turn");
    for (let send = 1; send <= 3; send++) {
      const events = await collect(reviews.turn(r.reviewId, turnId, answer()));
      expect(events.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
      expect(t.calls).toHaveLength(send);
    }
  });

  test("an invalid header is aborted before anything is spoken, then repaired once", async () => {
    const r = startedRig();
    const notAssessable = stableId("clm", "k", 999);
    const t = tutorHarness(r.db, (input) =>
      input.repairNote === null ? reply(askMain(notAssessable), "SPOKEN-WITHOUT-LEAVE. More words.") : reply(askMain(r.claim), "A valid question."),
    );
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));

    expect(t.calls.map((c) => c.repairNote)).toEqual([null, "claim is not assessable"]);
    expect(JSON.stringify(events)).not.toContain("SPOKEN-WITHOUT-LEAVE");
    expect(events.filter((e) => e.type === "move")).toHaveLength(1);
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { claimIds: [r.claim] } });
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("R3: a claim that loses its check while the model talks is neither stored nor sent as the move; the repair sees the change", async () => {
    const r = startedRig(undefined, {}, true);
    const t = tutorHarness(r.db, (input) => {
      if (input.state.corrections.length > 0 && input.state.corrections.every((c) => c.disclosed)) return reply(askMain(r.claim2!), "Tell me about claim two.");
      if (input.repairNote === null) {
        r.world.check(r.claim, "unverified");
        return reply(askMain(r.claim), "Tell me about claim one.");
      }
      return reply({ kind: "disclose_correction", correctionId: input.state.corrections[0]!.id, threadIds: [], evidence: [] }, "That claim did not hold up.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));

    const namesClaim = (move: TutorMove) => move.kind === "ask_main" && move.claimIds.includes(r.claim);
    expect(events.filter((e) => e.type === "move" && namesClaim(e.move))).toEqual([]);
    expect(reviews.view(r.reviewId).turns.filter((x) => x.actor === "tutor" && namesClaim(x.move))).toEqual([]);
    expect(t.calls).toHaveLength(3);
    expect(t.calls[1]!.repairNote).not.toBeNull();
    expect(t.calls[1]!.claims.map((c) => c.id)).not.toContain(r.claim);
    expect(t.calls[1]!.allowed).toEqual(["disclose_correction"]);
    expect(events.filter((e) => e.type === "move")).toMatchObject([{ move: { kind: "disclose_correction" } }, { move: { kind: "ask_main" } }]);
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("an invalid header that never repairs falls back to a code-authored move, never a stuck review", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply({ kind: "propose_detour", topic: "x", reason: "y", needsResource: null }, "Let us detour."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));

    expect(t.calls).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("detour");
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "wrap_up" } });
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(reviews.view(r.reviewId).turns.at(-1)).toMatchObject({ actor: "tutor", move: { kind: "wrap_up" } });
  });

  test("an ended review takes no new learner turn, so a saved record stays final (R15)", async () => {
    const r = startedRig(() => reply({ kind: "wrap_up" }, "Done."));
    await collect(r.reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(r.reviews.view(r.reviewId).state.phase).toBe("ended");
    const before = r.reviews.view(r.reviewId).turns.length;

    const late = await collect(r.reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(late).toEqual([{ type: "turn_failed", error: "this review has ended", retryable: false }]);
    expect(r.reviews.view(r.reviewId).turns).toHaveLength(before);
  });

  test("with a thread open the fallback closes the thread", async () => {
    const r = startedRig();
    let call = 0;
    const t = tutorHarness(r.db, () => (++call === 1 ? reply(askMain(r.claim), "Question one.") : reply({ kind: "detour_step" }, "Nope.")));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    await collect(reviews.turn(r.reviewId, randomId("turn"), answer("first")));
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer("second")));
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "close_thread", threadId: THREAD } });
  });

  test("with no fallback move and both invalid outputs stored, turn_failed says a resend will not help", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply({ kind: "wrap_up" }, "Bye."));
    const onlyAskMain: TutorKit = { ...kit, allowedMoves: () => new Set<TutorMoveKind>(["ask_main"]) };
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: onlyAskMain });
    const turnId = randomId("turn");
    expect((await collect(reviews.turn(r.reviewId, turnId, answer()))).at(-1)).toMatchObject({ type: "turn_failed", retryable: false });
    await collect(reviews.turn(r.reviewId, turnId, answer()));
    expect(t.calls).toHaveLength(2);
  });

  test("a paused review stores the learner's act and calls no model", async () => {
    const r = startedRig();
    const events = await collect(r.reviews.turn(r.reviewId, randomId("turn"), { kind: "pause" }));
    expect(types(events)).toEqual(["learner_turn_stored", "turn_complete"]);
    expect(r.tutor.calls).toHaveLength(0);
    expect(r.reviews.view(r.reviewId).state.phase).toBe("paused");
  });

  test("an unknown review fails the turn without retry", async () => {
    const r = rig();
    const events = await collect(r.reviews.turn(randomId("rvw"), randomId("turn"), answer()));
    expect(events).toEqual([{ type: "turn_failed", error: expect.stringContaining("unknown review"), retryable: false }]);
  });
});

describe("soft time target", () => {
  async function runToClose(softTargetS: number, elapsedMs: number) {
    let call = 0;
    const r = startedRig(undefined, { softTargetS });
    const t = tutorHarness(r.db, () => (++call === 1 ? reply(askMain(r.claim), "Question.") : reply({ kind: "close_thread", threadId: THREAD }, "Good enough.")));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit, softTargetS, now: () => r.clock.advance(0) });
    await collect(reviews.turn(r.reviewId, randomId("turn"), answer("a")));
    r.clock.advance(elapsedMs);
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer("b")));
    return { events, notices: reviews.view(r.reviewId).turns.filter((x) => x.actor === "code") };
  }

  test("is offered once, at the natural pause after a thread closes, never as a cutoff", async () => {
    const { events, notices } = await runToClose(600, 700_000);
    expect(notices).toMatchObject([{ notice: { kind: "soft_target_reached", elapsedS: 700 } }]);
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("is not offered before the target", async () => {
    const { notices } = await runToClose(600, 100_000);
    expect(notices).toEqual([]);
  });
});

// ───────────────────────────── R9 ─────────────────────────────

describe("R9 review and capture are independent", () => {
  test("start() leaves capture alone, and stopping capture neither ends nor pauses the review", async () => {
    const r = rig(() => reply(askMain(), "Question."));
    r.world.close(0, 0, 300);
    const claim = r.world.claim(1, 10, 20);
    const t = tutorHarness(r.db, () => reply(askMain(claim), "Question."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });

    expect(r.world.captureState).toBe("capturing");
    const reviewId = randomId("rvw");
    started(reviews.start(r.capture, "prepared_only", reviewId));
    expect(r.world.captureState).toBe("capturing");

    r.world.captureState = "stopped";
    expect(reviews.view(reviewId).state.phase).toBe("active");
    const events = await collect(reviews.turn(reviewId, randomId("turn"), answer()));
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(reviews.view(reviewId).state.phase).toBe("active");
  });

  test("a review keeps working while new chunks close and are invited about", async () => {
    const r = startedRig(() => reply({ kind: "wrap_up" }, "Done."));
    r.world.close(1, 300, 600);
    r.world.claim(2, 310, 320);
    expect(r.reviews.invite(r.capture)).toMatchObject({ state: "invited" });
    expect(r.reviews.view(r.reviewId).scope).toEqual(r.scope);
  });
});

// ───────────────────────────── begin: the tutor opens the review ─────────────────────────────

describe("begin (flow D: the tutor opens with a recall question)", () => {
  const begin: LearnerAct = { kind: "begin" };
  /** The real W8 rules, so ask_main must carry the thread id code minted. */
  function opening() {
    const r = startedRig();
    const t = tutorHarness(r.db, (input) => reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "What is the main idea?"));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 });
    return { ...r, t, reviews };
  }

  test("accepted as the very first turn: the allowed move is ask_main and the stored tutor turn is a main question", async () => {
    const x = opening();
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    expect(x.t.calls[0]!.allowed).toEqual(["ask_main"]);
    expect(types(events)).toContain("learner_turn_stored");
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "ask_main" } });
    expect(types(events).at(-1)).toBe("turn_complete");
    const turns = x.reviews.view(x.reviewId).turns;
    expect(turns.map((t) => t.actor)).toEqual(["learner", "tutor"]);
    expect(turns[0]).toMatchObject({ act: { kind: "begin" } });
    expect(x.reviews.view(x.reviewId).state.mainQuestions).toBe(1);
  });

  test("a resend of the same begin turn id stores nothing twice", async () => {
    const x = opening();
    const id = randomId("turn");
    await collect(x.reviews.turn(x.reviewId, id, begin));
    await collect(x.reviews.turn(x.reviewId, id, begin));
    expect(x.reviews.view(x.reviewId).turns).toHaveLength(2);
  });

  test("refused, and stored nowhere, when any turn already exists", async () => {
    const x = opening();
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    const before = x.reviews.view(x.reviewId).turns.length;
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    expect(events).toEqual([{ type: "turn_failed", error: "this review has already begun", retryable: false }]);
    expect(x.reviews.view(x.reviewId).turns).toHaveLength(before);
  });
});

// ───────────────────────────── material used up by earlier reviews ─────────────────────────────

describe("which earlier reviews use up material", () => {
  const endingScript: Script = () => reply({ kind: "wrap_up" }, "Done.");
  const end = (r: ReturnType<typeof startedRig>) => collect(r.reviews.turn(r.reviewId, randomId("turn"), { kind: "end" }));

  test("an ended review with no answer, skip or don't-know frees its material for a new review", async () => {
    const r = startedRig(endingScript);
    expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
    await end(r);
    expect(r.reviews.view(r.reviewId).state.phase).toBe("ended");
    expect(r.reviews.view(r.reviewId).turns.some((t) => t.actor === "learner" && ["answer", "skip", "dont_know"].includes(t.act.kind))).toBe(false);

    expect(r.reviews.options(r.capture)).toMatchObject({ kind: "ready", scope: { chunkRevisions: r.scope.chunkRevisions } });
    const again = started(r.reviews.start(r.capture, "prepared_only", randomId("rvw")));
    expect(again.scope.chunkRevisions).toEqual(r.scope.chunkRevisions);
    // R7: the ended review's own frozen scope is unchanged.
    expect(Material.canonical(r.reviews.view(r.reviewId).scope.material)).toEqual(Material.canonical(r.scope.material));
  });

  for (const act of [answer(), { kind: "skip" }, { kind: "dont_know" }] as LearnerAct[]) {
    test(`an ended review where the learner gave a ${act.kind} still uses its material up`, async () => {
      const r = startedRig(endingScript);
      await collect(r.reviews.turn(r.reviewId, randomId("turn"), act));
      expect(r.reviews.view(r.reviewId).state.phase).toBe("ended");
      expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
    });
  }

  test("a review that is active or paused with no response still holds its material, so two cannot run at once", async () => {
    const r = startedRig(endingScript);
    expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
    await collect(r.reviews.turn(r.reviewId, randomId("turn"), { kind: "pause" }));
    expect(r.reviews.view(r.reviewId).state.phase).toBe("paused");
    expect(r.reviews.options(r.capture).kind).toBe("nothing_to_review");
  });

  test("freed material is offered together with new material, and list() names the reviews newest first", async () => {
    const r = startedRig(endingScript);
    await end(r);
    r.world.close(1, 300, 600);
    r.world.claim(2, 310, 320);
    const opts = r.reviews.options(r.capture);
    expect(opts.kind === "ready" && opts.scope.chunkRevisions.length).toBe(2);
    r.clock.advance(1000);
    const second = started(r.reviews.start(r.capture, "prepared_only", randomId("rvw")));
    expect(r.reviews.list(r.capture).map((x) => x.reviewId)).toEqual([second.reviewId, r.reviewId]);
  });
});

// ───────────────────────────── a turn never ends with nothing to answer ─────────────────────────────

describe("a request goes on until a move waits for the learner", () => {
  const moveKinds = (events: readonly TurnEvent[]) => events.flatMap((e) => (e.type === "move" ? [e.move.kind] : []));
  const begin: LearnerAct = { kind: "begin" };

  /** Pending corrections are disclosed one per call; once none is pending the tutor asks. */
  function chaining() {
    const r = startedRig(undefined, {}, true);
    const t = tutorHarness(r.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      if (pending) return reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.");
      return reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]?.id ?? r.claim] }, "A question.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    return { ...r, t, reviews };
  }

  test("begin with pending corrections: every correction is disclosed, then a question, in the one request", async () => {
    const x = chaining();
    x.world.check(x.claim, "unverified");
    x.world.claims.get(x.claim2!)!.text = "claim 2, reworded";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    expect(moveKinds(events)).toEqual(["disclose_correction", "disclose_correction", "ask_main"]);
    expect(types(events).filter((t) => t === "turn_complete")).toHaveLength(1);
    expect(types(events).at(-1)).toBe("turn_complete");
    const tutors = x.reviews.view(x.reviewId).turns.filter((t) => t.actor === "tutor");
    expect(tutors.map((t) => t.actor === "tutor" && t.move.kind)).toEqual(["disclose_correction", "disclose_correction", "ask_main"]);
    expect(x.reviews.view(x.reviewId).state.openThread).not.toBeNull();
  });

  test("a correction on a claim already asked about is disclosed, then the next move follows", async () => {
    const x = chaining();
    await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    x.world.claims.get(x.claim)!.text = "claim 1, reworded";
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), answer()));
    expect(moveKinds(events)[0]).toBe("disclose_correction");
    expect(moveKinds(events).length).toBeGreaterThan(1);
  });

  test("a thread that is closed goes on to the next move", async () => {
    const r = startedRig();
    let call = 0;
    const t = tutorHarness(r.db, () => {
      call++;
      if (call === 1) return reply(askMain(r.claim), "Question.");
      if (call === 2) return reply({ kind: "close_thread", threadId: THREAD }, "Moving on.");
      return reply({ kind: "wrap_up" }, "Bye.");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(moveKinds(events)).toEqual(["close_thread", "wrap_up"]);
  });

  test("a move that waits for the learner ends the request", async () => {
    const x = chaining();
    const events = await collect(x.reviews.turn(x.reviewId, randomId("turn"), begin));
    expect(moveKinds(events)).toEqual(["ask_main"]);
    expect(x.t.calls).toHaveLength(1);
  });

  test("the cap: a tutor that only ever discloses stops at the maximum, never loops", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply({ kind: "disclose_correction", correctionId: "c", threadIds: [], evidence: [] }, "Again."));
    const always: TutorKit = { ...kit, allowedMoves: () => new Set<TutorMoveKind>(["disclose_correction"]) };
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: always });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));
    expect(moveKinds(events)).toHaveLength(MAX_MOVES_PER_TURN);
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(reviews.view(r.reviewId).turns.filter((x) => x.actor === "tutor")).toHaveLength(MAX_MOVES_PER_TURN);
  });

  test("a retried request replays every stored move", async () => {
    const x = chaining();
    x.world.check(x.claim, "unverified");
    const turnId = randomId("turn");
    const first = await collect(x.reviews.turn(x.reviewId, turnId, begin));
    const again = await collect(x.reviews.turn(x.reviewId, turnId, begin));
    expect(moveKinds(again)).toEqual(moveKinds(first));
    expect(x.t.calls).toHaveLength(2);
  });

  test("waitsForLearner: only a disclosure or a closed thread lets the turn go on", () => {
    expect(waitsForLearner({ kind: "disclose_correction", correctionId: "c", threadIds: [], evidence: [] })).toBe(false);
    expect(waitsForLearner({ kind: "close_thread", threadId: THREAD })).toBe(false);
    for (const move of [askMain(), { kind: "ask_followup", threadId: THREAD }, { kind: "wrap_up" }, { kind: "hint", threadId: THREAD }] as TutorMove[]) {
      expect(waitsForLearner(move)).toBe(true);
    }
  });
});

describe("an interrupted chain is resumable, and a review with no usable claim ends honestly", () => {
  const moveKinds = (events: readonly TurnEvent[]) => events.flatMap((e) => (e.type === "move" ? [e.move.kind] : []));
  const tutorRows = (reviews: Reviews, reviewId: ReviewId) => reviews.view(reviewId).turns.filter((t) => t.actor === "tutor");

  function crashing() {
    const r = startedRig(undefined, {}, true);
    let down = false;
    const t = tutorHarness(r.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      if (pending) return reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.");
      return down ? fail("boom") : reply({ kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [input.claims[0]!.id] }, "Which claim holds?");
    });
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 });
    return { ...r, t, reviews, setDown: (v: boolean) => void (down = v) };
  }

  test("a chain that stops after a disclosure: the view says the tutor owes a move; a resend continues once and ends with a question", async () => {
    const x = crashing();
    x.world.check(x.claim2!, "unverified");
    x.setDown(true);
    const turnId = randomId("turn");
    const failed = await collect(x.reviews.turn(x.reviewId, turnId, { kind: "begin" }));
    expect(moveKinds(failed)).toEqual(["disclose_correction"]);
    expect(failed.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    const view = x.reviews.view(x.reviewId);
    expect(view.owesMove).toBe(true);
    expect(view.state.phase).toBe("active");

    x.setDown(false);
    const again = await collect(x.reviews.turn(x.reviewId, turnId, { kind: "begin" }));
    expect(moveKinds(again)).toEqual(["disclose_correction", "ask_main"]);
    expect(types(again).at(-1)).toBe("turn_complete");
    expect(tutorRows(x.reviews, x.reviewId)).toHaveLength(2);
    expect(x.reviews.view(x.reviewId).turns.filter((t) => t.actor === "learner")).toHaveLength(1);
    expect(x.reviews.view(x.reviewId).owesMove).toBe(false);
  });

  test("owesMove: not for a waiting move, the soft-target prompt, a paused or an ended review", () => {
    const rvw: ReviewId = stableId("rvw", 1);
    const base = (n: number) => ({ id: stableId("turn", n), reviewId: rvw, seq: asSeq(n), atMs: n, threadId: null });
    const tutor = (n: number, move: TutorMove): Turn => ({ ...base(n), actor: "tutor", move, say: "" });
    const note = (n: number): Turn => ({ ...base(n), actor: "code", notice: { kind: "soft_target_reached", elapsedS: 1 } });
    const learner = (n: number): Turn => ({ ...base(n), actor: "learner", act: answer() });
    const close: TutorMove = { kind: "close_thread", threadId: THREAD };
    expect(tutorOwesMove([learner(1), tutor(2, close)], "active")).toBe(true);
    expect(tutorOwesMove([learner(1), tutor(2, askMain())], "active")).toBe(false);
    expect(tutorOwesMove([learner(1), tutor(2, close), note(3)], "active")).toBe(false);
    expect(tutorOwesMove([tutor(2, close), learner(3)], "active")).toBe(false);
    expect(tutorOwesMove([learner(1), tutor(2, close)], "paused")).toBe(false);
    expect(tutorOwesMove([learner(1), tutor(2, close)], "ended")).toBe(false);
    expect(tutorOwesMove([], "active")).toBe(false);
  });

  test("every claim withdrawn: the disclosure, then an honest wrap_up, never turn_failed", async () => {
    const base = startedRig();
    const t = tutorHarness(base.db, (input) => {
      const pending = input.state.corrections.find((c) => !c.disclosed);
      if (pending) return reply({ kind: "disclose_correction", correctionId: pending.id, threadIds: [], evidence: [] }, "A correction.");
      return reply(askMain(stableId("clm", "gone")), "A question.");
    });
    const r = { ...base, tutor: t, reviews: createReviews(base.db, { ...base.world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { now: () => 1_000_000 }) };
    r.world.check(r.claim, "unverified");
    const events = await collect(r.reviews.turn(r.reviewId, randomId("turn"), { kind: "begin" }));
    expect(events.find((e) => e.type === "turn_failed")).toBeUndefined();
    expect(moveKinds(events)).toEqual(["disclose_correction", "wrap_up"]);
    expect(events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("")).toContain("nothing left I can fairly ask you about");
    expect(r.tutor.calls.at(-1)!.allowed).toEqual(["wrap_up"]);
    expect(r.reviews.view(r.reviewId).state.phase).toBe("ended");
    expect(r.reviews.view(r.reviewId).owesMove).toBe(false);
  });
});
