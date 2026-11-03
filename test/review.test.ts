/**
 * Review lifecycle (W7). Preparation and the tutor are fakes: a World that
 * answers the dependency questions from plain data, and a scripted tutor task
 * that runs through the real memo so streaming and abort take the real path.
 * The W8 functions (reviewState, allowedMoves, header parse, validateMove) are
 * replaced by a small TutorKit, so these tests do not depend on W8's bodies.
 */
import { describe, expect, test } from "bun:test";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, ChunkRevisionId, ClaimId, EvidenceId, ReviewId, ThreadId, TurnId } from "../src/shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkProvenance, ChunkRevision, Claim, ClaimStatus, EvidenceBundle, Gap, LearnerAct, Passage, ReviewState,
  StartResult, Turn, TurnEvent, TutorMove, TutorMoveKind,
} from "../src/shared/domain";
import { Material, interval } from "../src/shared/time";
import type { Interval } from "../src/shared/time";
import { createReviews } from "../src/backend/review";
import type { Reviews, TutorKit } from "../src/backend/review";
import { corrections, foldInvites, freezeScope, takeSentences } from "../src/backend/review/core";
import type { InviteEvent } from "../src/backend/review/core";
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

type WorldClaim = { text: string; evidence: EvidenceId[]; status: ClaimStatus };

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

  close(ordinal: number, start: number, end: number, provenance: ChunkProvenance = "boundary"): ChunkRevision {
    const material = Material.of([[SRC, [interval(start, end)]]]);
    const rev: ChunkRevision = {
      id: stableId("crv", ordinal, start, end),
      chunkId: stableId("chk", this.captureId, ordinal),
      captureId: this.captureId,
      ordinal,
      revisionNo: 1,
      material,
      windows: [],
      provenance,
      closedAtSeq: this.db.nextSeq(),
      supersedes: null,
    };
    this.chunks = [...this.chunks.filter((c) => c.ordinal !== ordinal), rev];
    return rev;
  }

  /** A claim whose single piece of evidence sits at [start, end). */
  claim(n: number, start: number, end: number, status: ClaimStatus = "supported_by_check", text = `claim ${n}`): ClaimId {
    const id = stableId("clm", "k", n);
    const ev = stableId("ev", "w", n);
    this.evidence.set(ev, interval(start, end));
    this.claims.set(id, { text, evidence: [ev], status });
    return id;
  }

  private inside(material: Material, ids: readonly EvidenceId[]): boolean {
    return ids.every((e) => Material.covers(material, SRC, this.evidence.get(e)!));
  }

  readonly deps = {
    currentChunks: (_: CaptureId): readonly ChunkRevision[] => this.chunks,
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
      [...this.claims].filter(([, c]) => this.inside(material, c.evidence)).map(([id, c]) => ({ id, status: c.status }) as unknown as Claim),
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
  const reviews: Reviews = createReviews(db, { ...world.deps, runTutor: tutor.runTutor }, { tutor: kit, now: () => t, ...config });
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
function startedRig(script: Script = () => reply(askMain(), ""), config = {}) {
  const r = rig(script, config);
  r.world.close(0, 0, 300);
  const claim = r.world.claim(1, 10, 20);
  const reviewId = randomId("rvw");
  const res = started(r.reviews.start(r.capture, "prepared_only", reviewId));
  return { ...r, claim, reviewId, scope: res.scope };
}

// ───────────────────────────── core: invite fold ─────────────────────────────

describe("foldInvites (flow C invite policy)", () => {
  const closed = (n: number, provenance: ChunkProvenance, watchedS: number): InviteEvent => ({
    kind: "chunk_closed", seq: seq(n), provenance, chunk: stableId("crv", n), watchedS,
  });
  const answered = (n: number, a: "review_now" | "later" | "wait" | "stop_early", watchedS: number): InviteEvent => ({ kind: "answer", seq: seq(n), answer: a, watchedS });

  test("a boundary close invites", () => {
    expect(foldInvites([closed(1, "boundary", 300)], 900)).toEqual({ state: "invited", atChunk: stableId("crv", 1) });
  });

  test("a time-cap close invites only after the gap since the last invite", () => {
    const events = [closed(1, "boundary", 300), closed(2, "time", 780)];
    expect(foldInvites(events, 900)).toEqual({ state: "invited", atChunk: stableId("crv", 1) });
    expect(foldInvites([...events, closed(3, "time", 1260)], 900)).toEqual({ state: "invited", atChunk: stableId("crv", 3) });
  });

  test("a time-cap close with nothing before it invites once enough was watched", () => {
    expect(foldInvites([closed(1, "time", 480)], 900)).toEqual({ state: "none" });
    expect(foldInvites([closed(1, "time", 960)], 900)).toMatchObject({ state: "invited" });
  });

  test("session_end sends no invite", () => {
    expect(foldInvites([closed(1, "session_end", 5000)], 900)).toEqual({ state: "none" });
  });

  test("a revised boundary leaves the state as it was", () => {
    expect(foldInvites([closed(1, "boundary_revised", 300)], 900)).toEqual({ state: "none" });
    expect(foldInvites([closed(1, "boundary", 300), answered(2, "later", 300), closed(3, "boundary_revised", 300)], 900)).toEqual({ state: "later" });
  });

  test("Later waits for the next boundary close, and restarts the time-cap gap", () => {
    const afterLater = [closed(1, "boundary", 300), answered(2, "later", 300)];
    expect(foldInvites(afterLater, 900)).toEqual({ state: "later" });
    expect(foldInvites([...afterLater, closed(3, "time", 780)], 900)).toEqual({ state: "later" });
    expect(foldInvites([...afterLater, closed(3, "time", 1300)], 900)).toMatchObject({ state: "invited" });
    expect(foldInvites([...afterLater, closed(3, "boundary", 400)], 900)).toMatchObject({ state: "invited" });
  });

  test("Wait shows waiting; review_now, stop_early and a started review clear the invite", () => {
    const invited = closed(1, "boundary", 300);
    expect(foldInvites([invited, answered(2, "wait", 300)], 900)).toEqual({ state: "waiting" });
    expect(foldInvites([invited, answered(2, "review_now", 300)], 900)).toEqual({ state: "none" });
    expect(foldInvites([invited, answered(2, "stop_early", 300)], 900)).toEqual({ state: "none" });
    expect(foldInvites([invited, { kind: "review_started", seq: seq(2) }], 900)).toEqual({ state: "none" });
  });

  test("events are folded in seq order whatever order they arrive in", () => {
    expect(foldInvites([answered(2, "later", 300), closed(1, "boundary", 300)], 900)).toEqual({ state: "later" });
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

  test("nothing changed, nothing to disclose", () => {
    expect(corrections(rid, scope, usable(c1, c2), new Set(), texts, inScope)).toEqual([]);
  });

  test("a claim that stops being usable is withdrawn; changed text is a correction", () => {
    const changed = usable(c1).map((c) => ({ ...c, text: "claim 1, reworded" }) as AssessableClaim);
    const out = corrections(rid, scope, changed, new Set(), texts, inScope);
    expect(out.map((c) => [c.claimId, c.change, c.disclosed])).toEqual([[c1, "text_changed", false], [c2, "withdrawn", false]]);
  });

  test("a correction already disclosed is marked disclosed", () => {
    const [first] = corrections(rid, scope, usable(c1), new Set(), texts, inScope);
    const again = corrections(rid, scope, usable(c1), new Set([first!.id]), texts, inScope);
    expect(again[0]).toMatchObject({ claimId: c2, change: "withdrawn", disclosed: true });
  });

  test("a newly usable claim is a correction only when all its evidence is inside the scope material", () => {
    const w2 = new World(testDb());
    w2.claim(3, 50, 60);
    w2.claim(4, 500, 510);
    const fresh = w2.deps.assessableIn(w2.captureId, Material.of([[SRC, [interval(0, 1000)]]]));
    const inside = new Set([...inScope, ...[...w2.evidence].filter(([, i]) => i.start < 100).map(([id]) => id)]);
    const out = corrections(rid, scope, [...usable(c1, c2), ...fresh], new Set(), texts, inside);
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
    const leaky = createReviews(x.db, { ...x.world.deps, assessableIn: (_, __) => x.world.deps.assessableIn(x.capture, x.moved.material), runTutor: x.tutor.runTutor }, { tutor: kit });
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
    const reviews = createReviews(x.db, { ...x.world.deps, runTutor: t.runTutor }, { tutor: kit });
    const events = await collect(reviews.turn(x.reviewId, randomId("turn"), answer()));
    expect(t.calls[0]!.allowed).toEqual(["disclose_correction"]);
    expect(events.find((e) => e.type === "turn_failed")).toBeUndefined();
    const turns = reviews.view(x.reviewId).turns;
    expect(turns.filter((t) => t.actor === "code")).toMatchObject([{ notice: { kind: "correction_pending", affectedClaims: [x.old] } }]);
    expect(reviews.view(x.reviewId).state.corrections).toMatchObject([{ claimId: x.old, change: "withdrawn", disclosed: true }]);
  });
});

// ───────────────────────────── turns ─────────────────────────────

describe("turn", () => {
  test("streams learner_turn_stored, the validated move, the prose by delta and sentence, then turn_complete", async () => {
    const r = startedRig();
    const move = askMain(r.claim);
    const t = tutorHarness(r.db, () => reply(move, "What is the main idea? Say it in your own words."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit, now: () => 1 });
    const turnId = randomId("turn");
    const events = await collect(reviews.turn(r.reviewId, turnId, answer()));

    expect(types(events)[0]).toBe("learner_turn_stored");
    expect(types(events)[1]).toBe("move");
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(events.filter((e) => e.type === "move")).toEqual([{ type: "move", turnId: stableId("turn", r.reviewId, turnId, "tutor"), move }]);
    expect(events.filter((e) => e.type === "say_delta").map((e) => e.type === "say_delta" && e.text).join("")).toBe("What is the main idea? Say it in your own words.");
    expect(events.filter((e) => e.type === "sentence").map((e) => e.type === "sentence" && e.text)).toEqual(["What is the main idea?", "Say it in your own words."]);
    const stored = reviews.view(r.reviewId).turns;
    expect(stored.map((x) => x.actor)).toEqual(["learner", "tutor"]);
    expect(stored[1]).toMatchObject({ actor: "tutor", threadId: THREAD, say: "What is the main idea? Say it in your own words." });
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
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit });
    started(reviews.start(r.capture, "prepared_only", reviewId));
    await collect(reviews.turn(reviewId, randomId("turn"), answer("my answer")));
    expect(seenDuringCall.map((x) => x.actor)).toEqual(["learner"]);
  });

  test("idempotent on turnId: a resend appends nothing, replays the reply, and pays for no second call", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply(askMain(r.claim), "First question. Second part."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit });
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

  test("a failed model call keeps the learner turn; resending the same turnId then completes it", async () => {
    let healthy = false;
    const r = startedRig();
    const t = tutorHarness(r.db, (): FakeStep<TutorOutput> => (healthy ? reply(askMain(r.claim), "Try this.") : fail("boom")));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit });
    const turnId = randomId("turn");
    const failed = await collect(reviews.turn(r.reviewId, turnId, answer("kept")));
    expect(failed.at(-1)).toMatchObject({ type: "turn_failed", retryable: true });
    expect(turnRows(r.db, "learner")).toBe(1);
    expect(turnRows(r.db, "tutor")).toBe(0);

    healthy = true;
    r.db.sql.run("DELETE FROM memo_failures");
    const retried = await collect(reviews.turn(r.reviewId, turnId, answer("kept")));
    expect(types(retried).at(-1)).toBe("turn_complete");
    expect(turnRows(r.db, "learner")).toBe(1);
    expect(turnRows(r.db, "tutor")).toBe(1);
  });

  test("an invalid header is aborted before anything is spoken, then repaired once", async () => {
    const r = startedRig();
    const notAssessable = stableId("clm", "k", 999);
    const t = tutorHarness(r.db, (input) =>
      input.repairNote === null ? reply(askMain(notAssessable), "SPOKEN-WITHOUT-LEAVE. More words.") : reply(askMain(r.claim), "A valid question."),
    );
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));

    expect(t.calls.map((c) => c.repairNote)).toEqual([null, "claim is not assessable"]);
    expect(JSON.stringify(events)).not.toContain("SPOKEN-WITHOUT-LEAVE");
    expect(events.filter((e) => e.type === "move")).toHaveLength(1);
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { claimIds: [r.claim] } });
    expect(types(events).at(-1)).toBe("turn_complete");
  });

  test("an invalid header that never repairs falls back to a code-authored move, never a stuck review", async () => {
    const r = startedRig();
    const t = tutorHarness(r.db, () => reply({ kind: "propose_detour", topic: "x", reason: "y", needsResource: null }, "Let us detour."));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit });
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer()));

    expect(t.calls).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("detour");
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "wrap_up" } });
    expect(types(events).at(-1)).toBe("turn_complete");
    expect(reviews.view(r.reviewId).turns.at(-1)).toMatchObject({ actor: "tutor", move: { kind: "wrap_up" } });
  });

  test("with a thread open the fallback closes the thread", async () => {
    const r = startedRig();
    let call = 0;
    const t = tutorHarness(r.db, () => (++call === 1 ? reply(askMain(r.claim), "Question one.") : reply({ kind: "detour_step" }, "Nope.")));
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit });
    await collect(reviews.turn(r.reviewId, randomId("turn"), answer("first")));
    const events = await collect(reviews.turn(r.reviewId, randomId("turn"), answer("second")));
    expect(events.find((e) => e.type === "move")).toMatchObject({ move: { kind: "close_thread", threadId: THREAD } });
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
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit, softTargetS, now: () => r.clock.advance(0) });
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
    const reviews = createReviews(r.db, { ...r.world.deps, runTutor: t.runTutor }, { tutor: kit });

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
