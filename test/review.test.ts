import { describe, expect, test } from "bun:test";
import { createReviews } from "../src/backend/review";
import type { InviteEvent } from "../src/backend/review/core";
import { corrections, foldInvites, freezeScope, takeSentences } from "../src/backend/review/core";
import type { AssessableClaim, ChunkPrep, ChunkProvenance, ChunkRevision, Gap } from "../src/shared/domain";
import type { ClaimId, ConceptId, ReviewId } from "../src/shared/ids";
import { randomId, stableId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { testUserDb } from "./fakes";
import { CONCEPT, SRC, World, kit, reviewRows, rig, seq, started, startedRig } from "./review-fixtures";

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
  const world = new World(testUserDb());
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
  const w = new World(testUserDb());
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
    const w2 = new World(testUserDb());
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
    const opts = r.reviews.options(r.capture);
    expect(opts).toMatchObject({
      kind: "ready",
      scope: { chunkRevisions: [a.id], supportedClaims: 1, topics: [], partial: [{ kind: "unverified_claims", count: 1 }] },
    });
    expect(opts.kind === "ready" && Material.equals(opts.scope.material, a.material)).toBe(true);
  });

  test("the preview names the topics of its supported claims, each once, not one per claim", () => {
    const r = rig();
    const asked: ConceptId[][] = [];
    const reviews = createReviews(r.db, {
      ...r.world.deps, runTutor: r.tutor.runTutor, clearFailures: r.tutor.clearFailures,
      concepts: (ids) => { asked.push([...ids]); return ids.map((id) => ({ id, label: "Pivots", summary: "" })); },
    }, { tutor: kit });
    r.world.close(0, 0, 300);
    r.world.claim(1, 10, 20);
    r.world.claim(2, 30, 40);
    const opts = reviews.options(r.capture);
    expect(opts).toMatchObject({ kind: "ready", scope: { supportedClaims: 2, topics: [{ id: CONCEPT, label: "Pivots" }] } });
    expect(asked).toEqual([[CONCEPT]]);
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
