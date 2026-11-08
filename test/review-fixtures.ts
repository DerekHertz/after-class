import type { Db } from "../src/backend/db";
import { asSeq } from "../src/backend/db";
import type { Task } from "../src/backend/providers/memo";
import { createMemo } from "../src/backend/providers/memo";
import type { Reviews, TutorKit } from "../src/backend/review";
import { createReviews } from "../src/backend/review";
import type { TutorInput, TutorOutput } from "../src/backend/review/tutor";
import type { AssessableClaim, ChunkPrep, ChunkProvenance, ChunkRevision, Claim, ClaimStatus, EvidenceBundle, Gap, LearnerAct, Passage, ReviewState, Seq, StartResult, Turn, TurnEvent, TutorMove, TutorMoveKind, } from "../src/shared/domain";
import type { CaptureId, ChunkId, ChunkRevisionId, ClaimId, EvidenceId, IdPart, ThreadId } from "../src/shared/ids";
import { randomId, stableId } from "../src/shared/ids";
import type { Interval } from "../src/shared/time";
import { Material, interval } from "../src/shared/time";
import type { FakeStep } from "./fakes";
import { fail, fakeTask, ok, testDb } from "./fakes";

export const SRC = stableId("src", "youtube", "lecture");

export const CONCEPT = stableId("cpt", "c");

export const seq = (n: number) => asSeq(n);

// ───────────────────────────── the fake preparation world ─────────────────────────────

type WorldClaim = { text: string; evidence: EvidenceId[]; status: ClaimStatus; checkedAt?: Seq };

export class World {
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
    currentChunks: (_input: CaptureId): readonly ChunkRevision[] => this.chunks,
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
    stopEarly: (_input: CaptureId, ids: readonly ChunkRevisionId[]) => {
      this.stops.push(ids);
      for (const id of ids) {
        this.pendingChunks.delete(id);
        const rev = this.chunks.find((c) => c.id === id)!;
        for (const c of this.claims.values()) if (c.status.startsWith("awaiting") && this.inside(rev.material, c.evidence)) c.status = "dropped";
      }
      return this.db.nextSeq();
    },
    assessableIn: (_input: CaptureId, material: Material): readonly AssessableClaim[] =>
      [...this.claims]
        .filter(([, c]) => c.status === "supported_by_check" && this.inside(material, c.evidence))
        .map(([id, c]) => ({ id, conceptId: CONCEPT, text: c.text, evidence: c.evidence, assumptions: [] }) as unknown as AssessableClaim),
    claimsIn: (_input: CaptureId, material: Material): readonly Claim[] =>
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
    watchedSeconds: (_input: CaptureId) => this.chunks.reduce((s, c) => s + Material.duration(c.material), 0),
    runWrapUp: () => Promise.reject(new Error("wrap-up is not under test")),
    nextSeq: () => this.db.nextSeq(),
  };
}

// ───────────────────────────── the fake tutor ─────────────────────────────

const lastOf = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

/** The documented subset of W8's behaviour that W7's plumbing depends on. */
export const kit: TutorKit = {
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
      quickChecks: 0,
      fuzzy: [],
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

export const THREAD: ThreadId = stableId("thr", 1);

export const SECOND_THREAD: ThreadId = stableId("thr", 2);

export function askMain(...claimIds: ClaimId[]): TutorMove {
  return { kind: "ask_main", threadId: THREAD, claimIds: claimIds as [ClaimId, ...ClaimId[]] };
}

/** Header line, then prose, cut into small deltas so the header arrives in pieces. */
export function reply(move: TutorMove, say: string): FakeStep<TutorOutput> {
  const text = `${JSON.stringify(move)}\n${say}`;
  return ok({ move, say }, { deltas: text.match(/[\s\S]{1,9}/g) ?? [] });
}

export type Script = (input: TutorInput, call: number) => FakeStep<TutorOutput> | Promise<FakeStep<TutorOutput>>;

export function tutorHarness(db: Db, script: Script) {
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


export function rig(script: Script = () => fail("no tutor scripted"), config: { softTargetS?: number; estimateS?: (n: number) => number | null; timeInviteGapS?: number } = {}) {
  const db = testDb();
  const world = new World(db);
  const tutor = tutorHarness(db, script);
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const reviews: Reviews = createReviews(db, { ...world.deps, runTutor: tutor.runTutor, clearFailures: tutor.clearFailures }, { tutor: kit, now: () => t, ...config });
  return { db, world, tutor, reviews, clock, capture: world.captureId };
}

export const reviewRows = (db: Db) => db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reviews").get()!.n;

export const turnRows = (db: Db, actor: string) => db.sql.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_turns WHERE actor = ?").get(actor)!.n;

export async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export const types = (events: readonly TurnEvent[]) => events.map((e) => e.type);

export const answer = (text = "an answer"): LearnerAct => ({ kind: "answer", text, modality: "text" });

export function started(r: StartResult) {
  if (r.kind !== "started") throw new Error(`expected started, got ${r.kind}`);
  return r;
}

/** One finished chunk [0, 300) with one supported claim, a review started on it. */
export function startedRig(script: Script = () => reply(askMain(), ""), config = {}, withSecondClaim = false) {
  const r = rig(script, config);
  r.world.close(0, 0, 300);
  const claim = r.world.claim(1, 10, 20);
  const claim2 = withSecondClaim ? r.world.claim(2, 30, 40) : null;
  const reviewId = randomId("rvw");
  const res = started(r.reviews.start(r.capture, "prepared_only", reviewId));
  return { ...r, claim, claim2, reviewId, scope: res.scope };
}
