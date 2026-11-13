import { describe, expect, test } from "bun:test";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, ChunkRevisionId, IdPart, MemoKey } from "../src/shared/ids";
import type { ChunkRevision, ClaimDraft, ClaimStatus, Frame, Passage, Purpose, Provider, ResourceConnection, Verdict } from "../src/shared/domain";
import { Material, interval, media } from "../src/shared/time";
import { createMemo } from "../src/backend/providers/memo";
import type { Lookup, Task } from "../src/backend/providers/memo";
import type { ClaudeCli } from "../src/backend/providers/claude";
import type { ClaimSupportInput } from "../src/backend/providers/jev-tasks";
import type { WorkItem } from "../src/backend/scheduler";
import { createPreparation } from "../src/backend/preparation";
import { assessable, deriveClaimStatus, validateDraft } from "../src/backend/preparation/core";
import type { Check } from "../src/backend/preparation/core";
import { canonicalInterpretation, canonicalResourceSearch, canonicalRevision, interpretTask } from "../src/backend/preparation/tasks";
import type { InterpretationInput, InterpretationOutput, ResourceSearchInput, RevisionInput } from "../src/backend/preparation/tasks";
import { deferred, fail, fakeTask, ok, testUserDb, testSeq, usage } from "./fakes";
import type { FakeStep, FakeTask } from "./fakes";

// ───────────────────────────── evidence fixtures ─────────────────────────────

const SRC = stableId("src", "youtube", "18.06-l1");
const TRV = stableId("trv", SRC, "panel", "en", "fixture");

/** Six 10 s caption passages covering [0, 60). */
const P = Array.from({ length: 6 }, (_, k) => ({
  kind: "passage",
  id: stableId("ev", TRV, k * 10, k * 10 + 10),
  sourceId: SRC,
  transcriptRevId: TRV,
  interval: interval(k * 10, k * 10 + 10),
  text: `passage ${k}`,
  origin: "panel",
}) as Passage);
const BOARD = { kind: "frame", id: stableId("ev", "cap", "board"), sourceId: SRC, mediaS: media(15), width: 640, height: 360, teaching: "kept" } as Frame;

const span = (start: number, end: number) => Material.of([[SRC, [interval(start, end)]]]);

function draft(text: string, evidence: readonly (Passage | Frame)[], visualDependent = false): ClaimDraft {
  return { text, evidence: evidence.map((e) => e.id) as unknown as ClaimDraft["evidence"], visualDependent, assumptions: [] };
}

function output(concepts: readonly { label: string; claims: readonly ClaimDraft[] }[], extra: Partial<Pick<InterpretationOutput, "links" | "supersedes">> = {}): InterpretationOutput {
  return {
    concepts: concepts.map((c) => ({ label: c.label, summary: `${c.label} summary`, claims: c.claims, confusions: [] })),
    links: extra.links ?? [],
    supersedes: extra.supersedes ?? [],
  };
}

const verdict = (v: Verdict) => ok<Check>({ verdict: v, p: v === "yes" ? 0.9 : v === "no" ? 0.1 : 0.5 });

// ───────────────────────────── a capture under preparation ───────────────────

type Answer<I, O> = (input: I) => FakeStep<O> | Promise<FakeStep<O>>;

function scripted<I, O>(purpose: Purpose, provider: Provider, canonical: (i: I) => IdPart, answer: () => Answer<I, O>): FakeTask<I, O> {
  const t = fakeTask<IdPart, O>({ purpose, provider, maxAttempts: 1, answer: (i) => answer()(i as unknown as I) });
  return Object.assign(t, { canonicalInput: canonical }) as unknown as FakeTask<I, O>;
}

const checkCanonical = (i: ClaimSupportInput): IdPart => ({
  claim: { text: i.claim.text, evidence: [...i.claim.evidence], visualDependent: i.claim.visualDependent, assumptions: [...i.claim.assumptions] },
  passages: i.passages.map((p) => p.id),
  frames: i.frames.map((f) => f.frame.id),
});

function world(opts: { readonly interpret?: Task<InterpretationInput, InterpretationOutput> } = {}) {
  const db = testUserDb();
  const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
  const captureId = randomId("cap") as CaptureId;
  const revisions = new Map<ChunkRevisionId, ChunkRevision>();
  const latest = new Map<number, ChunkRevision>();

  const script: {
    interpret: Answer<InterpretationInput, InterpretationOutput>;
    check: Answer<ClaimSupportInput, Check>;
    revise: Answer<RevisionInput, ClaimDraft>;
    resources: Answer<ResourceSearchInput, readonly ResourceConnection[]>;
  } = {
    interpret: () => ok(output([])),
    check: () => verdict("yes"),
    revise: (i) => ok(i.original),
    resources: () => ok([]),
  };

  const tasks = {
    interpret: (opts.interpret ?? scripted("interpretation", "claude", canonicalInterpretation, () => script.interpret)) as FakeTask<InterpretationInput, InterpretationOutput>,
    revise: scripted("claim_revision", "claude", canonicalRevision, () => script.revise),
    checkClaim: scripted("claim_check", "jev", checkCanonical, () => script.check),
    searchResources: scripted("resource_search", "claude", canonicalResourceSearch, () => script.resources),
  };

  const prep = createPreparation(db, {
    chunk: (id) => revisions.get(id) ?? null,
    currentChunks: () => [...latest.values()],
    bundle: (material) => ({
      material,
      passages: P.filter((p) => Material.covers(material, p.sourceId, p.interval)),
      frames: [BOARD].filter((f) => Material.get(material, f.sourceId).intervals().some((i) => i.start <= f.mediaS && f.mediaS < i.end)),
      gaps: [],
      ads: [],
    }),
    lookup: memo.lookup,
    run: (task, input, signal) => memo.run(task, input, { signal }),
    clearFailures: memo.clearFailures,
    tasks,
    frameBytes: () => new Uint8Array([0xff, 0xd8]),
  });

  /** Segmentation's side: append a revision of chunk `ordinal` covering [start, end). */
  function close(ordinal: number, start: number, end: number): ChunkRevision {
    const chunkId = stableId("chk", captureId, ordinal);
    const material = span(start, end);
    const prior = latest.get(ordinal) ?? null;
    const rev: ChunkRevision = {
      id: stableId("crv", chunkId, Material.canonical(material)),
      chunkId,
      captureId,
      ordinal,
      revisionNo: (prior?.revisionNo ?? 0) + 1,
      material,
      windows: [],
      provenance: prior ? "boundary_revised" : "boundary",
      closedAtSeq: db.nextSeq(),
      supersedes: prior?.id ?? null,
    };
    revisions.set(rev.id, rev);
    latest.set(ordinal, rev);
    return rev;
  }

  /** The scheduler's side: run every demanded item; held calls stay in flight. */
  const running = new Map<MemoKey, Promise<unknown>>();
  function start(item: WorkItem): Promise<unknown> {
    const p = item.run(new AbortController().signal).finally(() => running.delete(item.key));
    running.set(item.key, p);
    return p;
  }
  async function drain(): Promise<void> {
    for (let round = 0; round < 20; round++) {
      await Promise.race([Promise.allSettled(running.values()), Bun.sleep(10)]);
      const fresh = prep.demand(captureId).filter((i) => !running.has(i.key));
      if (fresh.length === 0) return;
      await Promise.race([Promise.allSettled(fresh.map(start)), Bun.sleep(10)]);
    }
  }

  const statusOf = (rev: ChunkRevision, text: string): ClaimStatus | undefined =>
    prep.prep(rev.id).claims.find((c) => c.original.text === text)?.status;
  const usable = (material: Material) => prep.assessableIn(captureId, material).map((a) => a.text);
  const demanded = (purpose: Purpose) => prep.demand(captureId).filter((i) => i.purpose === purpose);

  return { db, memo, captureId, script, tasks, prep, close, drain, running, statusOf, usable, demanded };
}

/** A check held in flight until the test releases it. */
function hold<O>() {
  const gate = deferred<FakeStep<O>>();
  return { answer: () => gate.promise, release: gate.resolve };
}

// ───────────────────────────── pure core ─────────────────────────────────────

describe("deriveClaimStatus", () => {
  const key = "key_aaaaaaaaaaaaaaaaaaaaaaaaaa" as MemoKey;
  const hit = <O>(value: O, seq = 1): Lookup<O> => ({ kind: "hit", key, value, atSeq: testSeq(seq) });
  const failed = (seq = 1): Lookup<never> => ({ kind: "failed", key, attempts: 3, lastError: "boom", atSeq: testSeq(seq) });
  const missing: Lookup<never> = { kind: "missing", key };
  const yes = hit<Check>({ verdict: "yes", p: 0.9 });
  const no = hit<Check>({ verdict: "no", p: 0.1 });
  const unsure = hit<Check>({ verdict: "uncertain", p: 0.5 });
  const revised = hit(draft("narrower", [P[0]!]));
  const status = (l: Partial<Parameters<typeof deriveClaimStatus>[0]>, cutoff: number | null = null) =>
    deriveClaimStatus({ originalCheck: missing, revision: null, revisionCheck: null, supersessionCheck: null, ...l }, cutoff === null ? null : testSeq(cutoff));

  test("a yes on the original check supports the claim", () => {
    expect(status({ originalCheck: yes })).toBe("supported_by_check");
  });

  test("R4: no, one revision, then no/uncertain/failed on the recheck is unverified", () => {
    expect(status({ originalCheck: no })).toBe("awaiting_revision");
    expect(status({ originalCheck: no, revision: revised })).toBe("awaiting_recheck");
    expect(status({ originalCheck: no, revision: revised, revisionCheck: no })).toBe("unverified");
    expect(status({ originalCheck: no, revision: revised, revisionCheck: unsure })).toBe("unverified");
    expect(status({ originalCheck: no, revision: revised, revisionCheck: failed() })).toBe("unverified");
    expect(status({ originalCheck: no, revision: failed() })).toBe("unverified");
    expect(status({ originalCheck: no, revision: revised, revisionCheck: yes })).toBe("supported_by_check");
  });

  test("a failed or invalid original check is never a yes: it goes to revision", () => {
    expect(status({ originalCheck: failed() })).toBe("awaiting_revision");
    expect(status({ originalCheck: { kind: "invalid_refs" } })).toBe("awaiting_revision");
    expect(status({ originalCheck: no, revision: revised, revisionCheck: { kind: "invalid_refs" } })).toBe("unverified");
  });

  test("R8: a result stored after the stop-early cutoff is ignored, one stored before it counts", () => {
    expect(status({ originalCheck: hit<Check>({ verdict: "yes", p: 0.9 }, 10) }, 5)).toBe("dropped");
    expect(status({ originalCheck: hit<Check>({ verdict: "yes", p: 0.9 }, 3) }, 5)).toBe("supported_by_check");
    expect(status({ originalCheck: no, revision: hit(draft("x", [P[0]!]), 9) }, 5)).toBe("dropped");
    expect(status({ originalCheck: no, revision: revised, revisionCheck: no }, 5)).toBe("unverified");
  });

  test("R3: a supported claim under supersession recheck is pending until the recheck says yes", () => {
    expect(status({ originalCheck: yes, supersessionCheck: missing })).toBe("awaiting_recheck");
    expect(status({ originalCheck: yes, supersessionCheck: missing }, 5)).toBe("dropped");
    expect(status({ originalCheck: yes, supersessionCheck: no })).toBe("unverified");
    expect(status({ originalCheck: yes, supersessionCheck: yes })).toBe("supported_by_check");
  });
});

describe("validateDraft and assessable", () => {
  const bundle = { material: span(0, 20), passages: [P[0]!, P[1]!], frames: [BOARD], gaps: [], ads: [] };

  test("refs must exist in the chunk, and a visual claim must cite a frame", () => {
    expect(validateDraft(draft("ok", [P[0]!]), bundle).ok).toBe(true);
    expect(validateDraft(draft("outside", [P[4]!]), bundle).ok).toBe(false);
    expect(validateDraft(draft("visual, no frame", [P[0]!], true), bundle).ok).toBe(false);
    expect(validateDraft(draft("visual", [P[0]!, BOARD], true), bundle).ok).toBe(true);
  });

  test("R3: assessable() refuses anything but supported_by_check and carries the draft that passed", () => {
    const base = {
      id: stableId("clm", "k", 0),
      sourceChunkId: stableId("chk", "c", 0),
      conceptId: stableId("cpt", "pivots"),
      original: draft("too broad", [P[0]!]),
      originalCheck: { verdict: "no" as const, p: 0.1, reason: "jev" as const, memoKey: "key_aaaaaaaaaaaaaaaaaaaaaaaaaa" as MemoKey, atSeq: testSeq(1) },
      revision: draft("narrow", [P[1]!]),
      revisionCheck: null,
    };
    for (const s of ["awaiting_check", "awaiting_revision", "awaiting_recheck", "unverified", "dropped"] as const) {
      expect(assessable({ ...base, status: s })).toBeNull();
    }
    expect(assessable({ ...base, status: "supported_by_check" })).toMatchObject({ text: "narrow", evidence: [P[1]!.id] });
  });
});

// ───────────────────────────── preparation over a capture ────────────────────

describe("preparation", () => {
  test("a closed chunk is interpreted, checked, revised once where needed, and finishes ready", async () => {
    const w = world();
    const r1 = w.close(0, 0, 30);
    w.script.interpret = () => ok(output([{
      label: "Row picture",
      claims: [draft("rows are lines", [P[0]!]), draft("too broad", [P[1]!]), draft("the board shows two lines", [P[1]!], true)],
    }], { links: [{ fromLabel: "Row picture", toLabel: "Column picture", type: "contrasts_with", evidence: [P[2]!.id], rationale: "two views" }] }));
    w.script.check = (i) => verdict(i.claim.text === "too broad" ? "no" : "yes");
    w.script.revise = (i) => ok(i.original.visualDependent ? draft("the board shows two lines", [P[1]!, BOARD], true) : draft("narrower", [P[1]!]));

    expect(w.prep.prep(r1.id)).toMatchObject({ interpretation: "pending", finished: false });
    await w.drain();

    const prep = w.prep.prep(r1.id);
    expect(prep).toMatchObject({ interpretation: "done", finished: true, supportedCount: 3 });
    expect(w.usable(r1.material).sort()).toEqual(["narrower", "rows are lines", "the board shows two lines"]);
    expect(w.tasks.revise.calls.map((c) => [c.original.text, c.check.verdict]).sort()).toEqual([["the board shows two lines", "no"], ["too broad", "no"]]);
    expect(w.tasks.checkClaim.calls.some((c) => c.claim.text === "the board shows two lines" && c.frames.length === 0)).toBe(false);

    const conceptId = prep.claims[0]!.conceptId;
    expect(w.prep.concepts([conceptId])).toEqual([{ id: conceptId, label: "Row picture", summary: "Row picture summary" }]);
    expect(w.prep.linkSuggestions([conceptId])).toMatchObject([{ from: conceptId, type: "contrasts_with", evidence: [P[2]!.id] }]);
    expect(w.demanded("claim_check")).toEqual([]);
  });

  test("a claim with nothing supported keeps the chunk finished but unready, and its evidence visible", async () => {
    const w = world();
    const r1 = w.close(0, 0, 20);
    w.script.interpret = () => ok(output([{ label: "A", claims: [draft("wrong", [P[0]!])] }]));
    w.script.check = () => verdict("uncertain");
    await w.drain();
    expect(w.prep.prep(r1.id)).toMatchObject({ finished: true, supportedCount: 0, claims: [{ status: "unverified", original: { evidence: [P[0]!.id] } }] });
    expect(w.usable(r1.material)).toEqual([]);
  });

  test("R3 TLC path: supported, review starts, a later window moves the boundary, the tutor may use only checked claims", async () => {
    const w = world();
    const r1 = w.close(0, 0, 30);
    w.script.interpret = (i) => i.newMaterial.passages.some((p) => p.id === P[0]!.id)
      ? ok(output([{ label: "A", claims: [draft("qualified later", [P[0]!]), draft("stable", [P[1]!])] }]))
      : ok(output([{ label: "B", claims: [draft("new", [P[3]!])] }], { supersedes: i.existingClaims.filter((c) => c.text === "qualified later").map((c) => ({ claimId: c.id, reason: "P3 narrows it" })) }));
    await w.drain();
    expect(w.usable(r1.material).sort()).toEqual(["qualified later", "stable"]);

    const recheck = hold<Check>();
    w.script.check = (i) => (i.passages.some((p) => p.id === P[3]!.id) && i.claim.text === "qualified later" ? recheck.answer() : verdict("yes"));
    const r2 = w.close(0, 0, 40);
    await w.drain();

    const delta = w.tasks.interpret.calls[1]!;
    expect(delta.newMaterial.passages.map((p) => p.id)).toEqual([P[3]!.id]);
    expect(delta.existingClaims.map((c) => c.text).sort()).toEqual(["qualified later", "stable"]);
    expect(w.statusOf(r2, "qualified later")).toBe("awaiting_recheck");
    expect(w.usable(r1.material)).toEqual(["stable"]);
    expect(w.prep.prep(r2.id).finished).toBe(false);
    expect(w.tasks.checkClaim.calls.filter((c) => c.claim.text === "stable")).toHaveLength(1);

    recheck.release(verdict("yes"));
    await w.drain();
    expect(w.usable(r1.material).sort()).toEqual(["qualified later", "stable"]);
    expect(w.usable(r2.material).sort()).toEqual(["new", "qualified later", "stable"]);
  });

  test("R4 TLC path: not supported, revised, the boundary moves, not supported again: unverified with one revision", async () => {
    const w = world();
    const r1 = w.close(0, 0, 30);
    w.script.interpret = (i) => ok(i.newMaterial.passages.some((p) => p.id === P[0]!.id)
      ? output([{ label: "A", claims: [draft("overreach", [P[0]!])] }])
      : output([{ label: "B", claims: [] }]));
    w.script.check = () => verdict("no");
    const revision = hold<ClaimDraft>();
    w.script.revise = revision.answer;
    await w.drain();
    expect(w.statusOf(r1, "overreach")).toBe("awaiting_revision");
    const before = w.prep.prep(r1.id).claims[0]!.id;

    revision.release(ok(draft("still overreach", [P[0]!])));
    const r2 = w.close(0, 0, 40);
    await w.drain();

    const claim = w.prep.prep(r2.id).claims.find((c) => c.original.text === "overreach")!;
    expect(claim).toMatchObject({ id: before, status: "unverified", revision: { text: "still overreach" } });
    expect(w.tasks.revise.calls).toHaveLength(1);
    expect(w.demanded("claim_revision")).toEqual([]);
  });

  test("R4: retry re-checks a failed claim without granting a second revision", async () => {
    const w = world();
    const r1 = w.close(0, 0, 20);
    w.script.interpret = () => ok(output([{ label: "A", claims: [draft("claim", [P[0]!])] }]));
    w.script.check = () => fail("jev down");
    w.script.revise = () => ok(draft("revised claim", [P[0]!]));
    await w.drain();
    expect(w.statusOf(r1, "claim")).toBe("unverified");
    expect(w.tasks.revise.calls.map((c) => c.check.verdict)).toEqual(["uncertain"]);

    w.script.check = (i) => verdict(i.claim.text === "claim" ? "no" : "yes");
    w.prep.retry(w.captureId, [r1.id]);
    await w.drain();

    expect(w.statusOf(r1, "claim")).toBe("supported_by_check");
    expect(w.usable(r1.material)).toEqual(["revised claim"]);
    expect(w.tasks.revise.calls).toHaveLength(1);
  });

  test("R8 TLC path: a later window moves the boundary while a check is in flight; the outdated result lands on no current chunk", async () => {
    const w = world();
    const r1 = w.close(0, 0, 60);
    w.script.interpret = () => ok(output([{ label: "A", claims: [draft("early", [P[0]!]), draft("straddles", [P[1]!, P[3]!]), draft("late", [P[4]!])] }]));
    const late = hold<Check>();
    w.script.check = (i) => (i.claim.text === "straddles" ? late.answer() : verdict("yes"));
    await w.drain();
    expect(w.statusOf(r1, "straddles")).toBe("awaiting_check");
    const stale = w.demanded("claim_check").map((i) => i.key);
    expect(stale).toHaveLength(1);

    const a = w.close(0, 0, 30);
    const b = w.close(1, 30, 60);
    expect(w.demanded("claim_check").map((i) => i.key)).not.toContain(stale[0]);

    late.release(verdict("yes"));
    await w.running.get(stale[0]!);
    await w.drain();

    expect(w.prep.prep(a.id)).toMatchObject({ finished: true, supportedCount: 1 });
    expect(w.prep.prep(b.id)).toMatchObject({ finished: true, supportedCount: 1 });
    expect([...w.usable(a.material), ...w.usable(b.material)].sort()).toEqual(["early", "late"]);
    expect(w.tasks.interpret.calls).toHaveLength(1);
    expect(w.tasks.checkClaim.calls.filter((c) => c.claim.text === "late")).toHaveLength(1);
  });

  test("R8: Stop early cancels in-flight checks; the late result is stored but never applied until retry", async () => {
    const w = world();
    const r1 = w.close(0, 0, 20);
    w.script.interpret = () => ok(output([{ label: "A", claims: [draft("done", [P[0]!]), draft("slow", [P[1]!])] }]));
    const slow = hold<Check>();
    w.script.check = (i) => (i.claim.text === "slow" ? slow.answer() : verdict("yes"));
    await w.drain();
    const inflight = w.demanded("claim_check").map((i) => i.key);

    w.prep.stopEarly(w.captureId, [r1.id]);
    expect(w.prep.demand(w.captureId)).toEqual([]);
    expect(w.prep.prep(r1.id)).toMatchObject({ finished: true, supportedCount: 1 });
    slow.release(verdict("yes"));
    await w.running.get(inflight[0]!);

    expect(w.memo.lookup(w.tasks.checkClaim, w.tasks.checkClaim.calls.find((c) => c.claim.text === "slow")!).kind).toBe("hit");
    expect(w.statusOf(r1, "slow")).toBe("dropped");
    expect(w.usable(r1.material)).toEqual(["done"]);

    w.prep.retry(w.captureId, [r1.id]);
    expect(w.statusOf(r1, "slow")).toBe("supported_by_check");
    expect(w.tasks.checkClaim.calls.filter((c) => c.claim.text === "slow")).toHaveLength(1);
  });

  test("R8: an interpretation that lands after Stop early adds no claims; new material keeps preparing", async () => {
    const w = world();
    const r1 = w.close(0, 0, 20);
    const interp = hold<InterpretationOutput>();
    w.script.interpret = interp.answer;
    await w.drain();
    const key = w.demanded("interpretation")[0]!.key;
    w.prep.stopEarly(w.captureId, [r1.id]);
    expect(w.prep.prep(r1.id)).toMatchObject({ interpretation: "cancelled", finished: true, claims: [] });

    interp.release(ok(output([{ label: "A", claims: [draft("late", [P[0]!])] }])));
    await w.running.get(key);
    expect(w.prep.claimsIn(w.captureId, r1.material)).toEqual([]);

    w.script.interpret = () => ok(output([{ label: "B", claims: [draft("after stop", [P[2]!])] }]));
    const r2 = w.close(0, 0, 30);
    await w.drain();
    expect(w.tasks.interpret.calls.map((c) => c.newMaterial.passages.map((p) => p.text))).toEqual([["passage 0", "passage 1"], ["passage 2"]]);
    expect(w.usable(r2.material)).toEqual(["after stop"]);
  });

  test("a failed interpretation finishes the chunk with nothing to review; retry runs it again", async () => {
    const w = world();
    const r1 = w.close(0, 0, 20);
    w.script.interpret = () => fail("claude exited 1");
    await w.drain();
    expect(w.prep.prep(r1.id)).toMatchObject({ interpretation: "failed", finished: true, supportedCount: 0 });

    w.script.interpret = () => ok(output([{ label: "A", claims: [draft("second try", [P[0]!])] }]));
    w.prep.retry(w.captureId, [r1.id]);
    await w.drain();
    expect(w.prep.prep(r1.id)).toMatchObject({ interpretation: "done", supportedCount: 1 });
  });

  test("R6: readiness ignores resource search, which runs last on supported claims and records citations", async () => {
    const w = world();
    const r1 = w.close(0, 0, 20);
    w.script.interpret = () => ok(output([{ label: "Elimination", claims: [draft("pivots", [P[0]!]), draft("wrong", [P[1]!])] }]));
    w.script.check = (i) => verdict(i.claim.text === "pivots" ? "yes" : "no");
    w.script.revise = () => ok(draft("still wrong", [P[1]!]));
    const search = hold<readonly ResourceConnection[]>();
    w.script.resources = search.answer;
    await w.drain();

    const prep = w.prep.prep(r1.id);
    const conceptId = prep.claims[0]!.conceptId;
    expect(prep).toMatchObject({ finished: true, supportedCount: 1 });
    expect(w.prep.resources(conceptId).state).toBe("searching");
    expect(w.tasks.searchResources.calls.map((c) => c.supportedClaims.map((a) => a.text))).toEqual([["pivots"]]);

    const found: ResourceConnection = {
      id: stableId("res", conceptId, "https://ocw.mit.edu/18-06"), conceptId, url: "https://ocw.mit.edu/18-06", title: "18.06 notes",
      provenance: "web_search", relevance: "Worked elimination examples", supportingPassages: [P[0]!.id],
    };
    search.release(ok([found]));
    await w.drain();
    expect(w.prep.resources(conceptId)).toEqual({ state: "found", connections: [found] });
    expect(w.prep.prep(r1.id)).toEqual(prep);
  });

  test("R6: a failed resource search leaves the chunk ready", async () => {
    const w = world();
    const r1 = w.close(0, 0, 20);
    w.script.interpret = () => ok(output([{ label: "A", claims: [draft("c", [P[0]!])] }]));
    w.script.resources = () => fail("web search refused");
    await w.drain();
    const conceptId = w.prep.prep(r1.id).claims[0]!.conceptId;
    expect(w.prep.resources(conceptId).state).toBe("failed");
    expect(w.prep.prep(r1.id)).toMatchObject({ finished: true, supportedCount: 1 });
    expect(w.prep.resources(stableId("cpt", "never seen")).state).toBe("not_started");
  });

  test("R5: an answered Later leaves demand unchanged, and preparation then finishes", async () => {
    const w = world();
    const r1 = w.close(0, 0, 20);
    w.script.interpret = () => ok(output([{ label: "A", claims: [draft("c", [P[0]!])] }]));
    const before = w.prep.demand(w.captureId).map((i) => i.key);
    w.db.sql.query(`INSERT INTO invite_answers (seq, user_id, capture_id, answer, watched_s, at_ms) VALUES (?, ?, ?, 'later', 20, 0)`).run(w.db.nextSeq(), w.db.userId, w.captureId);
    expect(w.prep.demand(w.captureId).map((i) => i.key)).toEqual(before);
    await w.drain();
    expect(w.prep.prep(r1.id)).toMatchObject({ finished: true, supportedCount: 1 });
  });

  test("demand and derivation are idempotent: draining twice makes no new calls", async () => {
    const w = world();
    w.close(0, 0, 30);
    w.script.interpret = () => ok(output([{ label: "A", claims: [draft("c", [P[0]!])] }]));
    await w.drain();
    const calls = [w.tasks.interpret.calls.length, w.tasks.checkClaim.calls.length, w.tasks.searchResources.calls.length];
    await w.drain();
    expect([w.tasks.interpret.calls.length, w.tasks.checkClaim.calls.length, w.tasks.searchResources.calls.length]).toEqual(calls);
    expect(w.prep.demand(w.captureId)).toEqual([]);
  });
});

describe("a claim citing evidence the model was never shown", () => {
  const UNSEEN = stableId("ev", "never-shown");

  /** The Claude CLI's structured call, scripted by attempt number. Output is re-validated by the task's own schema, as in production. */
  function fakeClaude(answer: (attemptNo: number) => unknown): ClaudeCli & { calls: number } {
    const claude = {
      calls: 0,
      async structured<O>(_req: unknown, schema: { parse(x: unknown): O }) {
        claude.calls += 1;
        return { output: schema.parse(answer(claude.calls)), usage: usage() };
      },
      async streamText() {
        throw new Error("unused");
      },
    };
    return claude as unknown as ClaudeCli & { calls: number };
  }

  const raw = (claims: readonly { text: string; evidence: readonly string[] }[]) => ({
    concepts: [{ label: "A", summary: "A summary", claims: claims.map((c) => ({ ...c, visualDependent: false, assumptions: [] })), confusions: [] }],
    links: [],
    supersedes: [],
  });
  const good = (text: string, k: number) => ({ text, evidence: [P[k]!.id as string] });
  const bad = (text: string) => ({ text, evidence: [UNSEEN as string] });

  test("one bad claim among three: the two good claims are kept, the bad one is dropped and reported, and it is never assessable", async () => {
    const claude = fakeClaude(() => raw([good("first", 0), bad("ghost"), good("second", 1)]));
    const w = world({ interpret: interpretTask(claude, () => null) });
    const r1 = w.close(0, 0, 20);
    await w.drain();

    expect(w.prep.prep(r1.id)).toMatchObject({ interpretation: "done", finished: true, supportedCount: 2 });
    expect(w.prep.prep(r1.id).claims.map((c) => c.original.text)).toEqual(["first", "second"]);
    expect(w.usable(r1.material)).toEqual(["first", "second"]);
    expect(w.tasks.checkClaim.calls.map((c) => c.claim.text)).not.toContain("ghost");
    expect(w.tasks.revise.calls).toHaveLength(0);

    // The first attempt is still retried; only the final one drops.
    expect(claude.calls).toBe(2);
    const unit = w.db.sql.query<{ memo_key: string }, []>(`SELECT memo_key FROM prep_inputs WHERE kind = 'interpretation'`).get()!;
    const stored = w.memo.inspect(unit.memo_key as MemoKey)!;
    expect(stored.failure).toBeNull();
    expect((stored.output as { dropped: unknown }).dropped).toEqual([
      { text: "ghost", evidence: [UNSEEN], reason: `cites unknown evidence: ${UNSEEN}` },
    ]);
  });

  test("a first attempt with a bad claim is retried, and a clean second attempt keeps every claim", async () => {
    const claude = fakeClaude((n) => (n === 1 ? raw([good("first", 0), bad("ghost")]) : raw([good("first", 0), good("second", 1)])));
    const w = world({ interpret: interpretTask(claude, () => null) });
    const r1 = w.close(0, 0, 20);
    await w.drain();

    expect(claude.calls).toBe(2);
    expect(w.usable(r1.material)).toEqual(["first", "second"]);
    const unit = w.db.sql.query<{ memo_key: string }, []>(`SELECT memo_key FROM prep_inputs WHERE kind = 'interpretation'`).get()!;
    expect(w.memo.inspect(unit.memo_key as MemoKey)!.output).not.toHaveProperty("dropped");
  });

  test("every claim bad: the same recorded, retryable failure as before, and no claims", async () => {
    let answer: () => unknown = () => raw([bad("ghost one"), bad("ghost two")]);
    const claude = fakeClaude(() => answer());
    const w = world({ interpret: interpretTask(claude, () => null) });
    const r1 = w.close(0, 0, 20);
    await w.drain();

    expect(w.prep.prep(r1.id)).toMatchObject({ interpretation: "failed", finished: true, supportedCount: 0, claims: [] });
    expect(claude.calls).toBe(2);
    const unit = w.db.sql.query<{ memo_key: string }, []>(`SELECT memo_key FROM prep_inputs WHERE kind = 'interpretation'`).get()!;
    const failure = w.memo.inspect(unit.memo_key as MemoKey)!.failure;
    expect(failure).toMatchObject({ attempts: 2, terminal: true });
    expect(failure!.lastError).toBe(`ProviderError: claim "ghost one" cites unknown evidence: ${UNSEEN}`);
    expect(w.usable(r1.material)).toEqual([]);

    answer = () => raw([good("recovered", 0)]);
    w.prep.retry(w.captureId, [r1.id]);
    await w.drain();
    expect(w.prep.prep(r1.id)).toMatchObject({ interpretation: "done", supportedCount: 1 });
  });

  test("a fully valid interpretation takes one call, stores exactly what it did before, and keeps its memo key", async () => {
    const claude = fakeClaude(() => raw([good("first", 0), good("second", 1)]));
    const task = interpretTask(claude, () => null);
    const w = world({ interpret: task });
    const r1 = w.close(0, 0, 20);
    await w.drain();

    expect(claude.calls).toBe(1);
    expect(w.usable(r1.material)).toEqual(["first", "second"]);
    const unit = w.db.sql.query<{ memo_key: string }, []>(`SELECT memo_key FROM prep_inputs WHERE kind = 'interpretation'`).get()!;
    const stored = w.memo.inspect(unit.memo_key as MemoKey)!;
    expect(stored.version).toBe("interpret-v1");
    expect(Object.keys(stored.output as object).sort()).toEqual(["concepts", "links", "supersedes"]);
    const input: InterpretationInput = {
      chunkRevisionId: r1.id,
      newMaterial: { material: r1.material, passages: [P[0]!, P[1]!], frames: [BOARD], gaps: [], ads: [] },
      existingClaims: [],
      gaps: [],
    };
    expect(w.memo.key(task, input)).toBe(unit.memo_key as MemoKey);
  });
});
