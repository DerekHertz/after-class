import { describe, expect, test } from "bun:test";
import { stableId } from "../src/shared/ids";
import type { CaptureId, ClaimId, ConceptId, EvidenceId, ReviewId, ThreadId, TurnId } from "../src/shared/ids";
import type { AssessableClaim, DisputeState, LearnerAct, SubjectLinkSuggestion, Turn, TutorMove } from "../src/shared/domain";
import { clampStatus, isLearningGap, threadDispute, threadFacts } from "../src/backend/review/clamp";
import type { WrapUpOutput } from "../src/backend/review/tutor";
import { createRecord } from "../src/backend/record";
import type { Db } from "../src/backend/db";
import { testDb, testSeq } from "./fakes";

const REVIEW = stableId("rvw", "review-1") as ReviewId;
const CAPTURE = stableId("cap", "capture-1") as CaptureId;
const T1 = stableId("thr", "t1") as ThreadId;
const T2 = stableId("thr", "t2") as ThreadId;
const ev = (n: number) => stableId("ev", "passage", n) as EvidenceId;
const claimId = (n: number) => stableId("clm", n) as ClaimId;
const concept = (n: number) => stableId("cpt", n) as ConceptId;
const NONE: DisputeState = { kind: "none" };

function claim(n: number, text = `claim ${n}`): AssessableClaim {
  return { id: claimId(n), conceptId: concept(n), text, evidence: [ev(n)], assumptions: [] } as unknown as AssessableClaim;
}

function log() {
  const turns: Turn[] = [];
  let n = 0;
  const base = () => {
    n += 1;
    return { id: stableId("turn", n) as TurnId, reviewId: REVIEW, seq: testSeq(n), atMs: n * 1000 };
  };
  const api = {
    turns,
    learner(act: LearnerAct, threadId: ThreadId | null) {
      turns.push({ ...base(), actor: "learner", threadId, act });
      return api;
    },
    tutor(move: TutorMove, say = "") {
      turns.push({ ...base(), actor: "tutor", threadId: "threadId" in move ? move.threadId : null, move, say });
      return api;
    },
  };
  return api;
}

const ask = (t: ThreadId, n: number): TutorMove => ({ kind: "ask_main", threadId: t, claimIds: [claimId(n)] });
const answer = (text: string): LearnerAct => ({ kind: "answer", text, modality: "speech" });
const facts = (l: ReturnType<typeof log>, t: ThreadId = T1) => threadFacts(t, l.turns);
const clamp = (l: ReturnType<typeof log>, proposed: Parameters<typeof clampStatus>[0], t: ThreadId = T1) =>
  clampStatus(proposed, facts(l, t), threadDispute(t, l.turns), true).status;

describe("R12: help before the answer caps at after_help", () => {
  test.each([
    ["hint", { kind: "hint", threadId: T1 }],
    ["explain", { kind: "explain", threadId: T1, evidence: [] }],
    ["correction disclosure", { kind: "disclose_correction", correctionId: "c1", threadIds: [T1], evidence: [] }],
  ] as const)("%s before the first answer", (_, help) => {
    const l = log().tutor(ask(T1, 1)).learner({ kind: "hint_request" }, T1).tutor(help as TutorMove).learner(answer("rows meet"), T1);
    expect(clampStatus("independent", facts(l), NONE, true)).toEqual({ status: "after_help", clampedFrom: "independent" });
    expect(clamp(l, "partial")).toBe("after_help");
    expect(clamp(l, "unresolved")).toBe("unresolved");
  });

  test("help after the first answer does not cap", () => {
    const l = log().tutor(ask(T1, 1)).learner(answer("rows meet"), T1).tutor({ kind: "hint", threadId: T1 });
    expect(clampStatus("independent", facts(l), NONE, true)).toEqual({ status: "independent", clampedFrom: null });
  });

  test("help on another thread does not cap this one", () => {
    const l = log().tutor(ask(T2, 2)).tutor({ kind: "hint", threadId: T2 }).tutor(ask(T1, 1)).learner(answer("x"), T1);
    expect(clamp(l, "independent")).toBe("independent");
  });
});

describe("R13: skipped or unanswered is not_assessed", () => {
  test("a skipped question", () => {
    const l = log().tutor(ask(T1, 1)).learner({ kind: "skip" }, T1);
    expect(clampStatus("independent", facts(l), NONE, true)).toEqual({ status: "not_assessed", clampedFrom: "independent" });
  });

  test("a question with no learner turn at all", () => {
    expect(clamp(log().tutor(ask(T1, 1)), "independent")).toBe("not_assessed");
  });

  test("only 'I don't know' is unresolved, never understood", () => {
    const l = log().tutor(ask(T1, 1)).learner({ kind: "dont_know" }, T1);
    expect(clamp(l, "independent")).toBe("unresolved");
    expect(clamp(log().tutor(ask(T1, 1)).learner({ kind: "dont_know" }, T1).learner({ kind: "skip" }, T1), "partial")).toBe("not_assessed");
  });

  test("a later substantive answer is assessed on the proposal", () => {
    const l = log().tutor(ask(T1, 1)).learner({ kind: "skip" }, T1).learner(answer("rows"), T1);
    expect(clamp(l, "partial")).toBe("partial");
  });
});

describe("R14: a disputed assessment is never a learning gap unless the learner resolves it so", () => {
  const disputed = () => log().tutor(ask(T1, 1)).learner(answer("x"), T1).learner({ kind: "dispute", text: "the board said columns" }, T1);

  test("open, unsettled, and tutor-'settled' disputes all save as disputed", () => {
    const open = disputed();
    const unsettled = disputed().tutor({ kind: "answer_dispute", threadId: T1, evidence: [ev(1)], settled: false });
    const tutorSettled = disputed().tutor({ kind: "answer_dispute", threadId: T1, evidence: [ev(1)], settled: true });
    for (const l of [open, unsettled, tutorSettled]) {
      const status = clamp(l, "partial");
      expect(status).toBe("disputed");
      expect(isLearningGap({ status, dispute: threadDispute(T1, l.turns) })).toBe(false);
    }
    expect(threadDispute(T1, unsettled.turns)).toEqual({ kind: "unsettled" });
  });

  test("a dispute sent with no thread counts against the open thread, as the tutor's state does", () => {
    const l = log().tutor(ask(T1, 1)).learner(answer("x"), T1).learner({ kind: "dispute", text: "the board said columns" }, null);
    expect(threadDispute(T1, l.turns)).toEqual({ kind: "open", turnId: stableId("turn", 3) });
    expect(clamp(l, "partial")).toBe("disputed");
    expect(threadFacts(T1, l.turns).learnerTurns).toEqual([stableId("turn", 2), stableId("turn", 3)]);
  });

  test("a threadless dispute after the thread closed is not charged to it", () => {
    const l = log().tutor(ask(T1, 1)).learner(answer("x"), T1).tutor({ kind: "close_thread", threadId: T1 }).learner({ kind: "dispute", text: "hm" }, null);
    expect(threadDispute(T1, l.turns)).toEqual(NONE);
    expect(clamp(l, "partial")).toBe("partial");
  });

  test("only the learner's it_was_my_gap resolution lets a gap count", () => {
    expect(isLearningGap({ status: "partial", dispute: { kind: "resolved_by_learner", outcome: "it_was_my_gap" } })).toBe(true);
    expect(isLearningGap({ status: "partial", dispute: { kind: "resolved_by_learner", outcome: "learner_was_right" } })).toBe(false);
    expect(isLearningGap({ status: "after_help", dispute: NONE })).toBe(false);
  });
});

// ───────────────────────────── the record ─────────────────────────────────

const LINK: SubjectLinkSuggestion = {
  id: stableId("lnk", concept(1), concept(2), "prerequisite_of"),
  from: concept(1),
  to: concept(2),
  type: "prerequisite_of",
  evidence: [ev(2)],
  rationale: "rows before columns",
};

/** A finished review: T1 answered, T2 skipped. */
function finishedReview() {
  return log()
    .tutor(ask(T1, 1), "In your own words?")
    .learner(answer("Each equation is a line; they meet at the solution."), T1)
    .tutor({ kind: "close_thread", threadId: T1 })
    .tutor(ask(T2, 2))
    .learner({ kind: "skip" }, T2)
    .learner({ kind: "end" }, null)
    .tutor({ kind: "wrap_up" });
}

const WRAP_UP: WrapUpOutput = {
  observations: [
    { threadId: T1, proposed: "independent", rationale: "explained the row picture unaided" },
    { threadId: T2, proposed: "independent", rationale: "the model overreached" },
  ],
  notes: [{ conceptId: concept(1), tutorSummary: "Row picture: lines meet at the solution.", evidence: [ev(1), "ev_invented"] }],
};

type Harness = ReturnType<typeof harness>;

function harness(opts: { turns?: Turn[]; wrapUp?: () => Promise<WrapUpOutput>; claims?: () => AssessableClaim[]; db?: Db } = {}) {
  const db = opts.db ?? testDb();
  const turns = opts.turns ?? finishedReview().turns;
  const calls = { wrapUp: 0, snapshots: [] as EvidenceId[][] };
  let failSnapshots = 0;
  const record = createRecord(db, {
    turns: () => turns,
    claims: opts.claims ?? (() => [claim(1), claim(2)]),
    wrapUp: async () => {
      calls.wrapUp += 1;
      return opts.wrapUp ? opts.wrapUp() : WRAP_UP;
    },
    snapshotEvidenceInTx: (ids) => {
      if (failSnapshots > 0) {
        failSnapshots -= 1;
        throw new Error("disk full");
      }
      calls.snapshots.push([...ids]);
      for (const id of ids) {
        db.sql.run(
          `INSERT OR IGNORE INTO evidence_snapshots (evidence_id, kind, source_id, start_s, end_s, text, created_ms) VALUES (?, 'passage', 'src', 0, 1, 'text', 0)`,
          [id],
        );
      }
    },
    links: () => [LINK],
  });
  return { db, record, calls, failNextSnapshots: (n: number) => (failSnapshots = n) };
}

const TABLES = ["notes", "note_evidence", "observations", "link_suggestions", "saved_reviews"] as const;

function rows(h: Harness): Record<string, unknown[]> {
  return Object.fromEntries(TABLES.map((t) => [t, h.db.sql.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...(r as object), saved_ms: undefined }))]));
}

describe("R15: retrying a save never creates a duplicate record", () => {
  test("saving twice leaves identical rows and IDs", async () => {
    const h = harness();
    expect(await h.record.save(REVIEW)).toEqual({ kind: "saved", notes: 2, observations: 2, links: 1 });
    const once = rows(h);
    expect(await h.record.save(REVIEW)).toEqual({ kind: "saved", notes: 2, observations: 2, links: 1 });
    expect(rows(h)).toEqual(once);
    expect(h.record.view({ reviewId: REVIEW }).notes.map((n) => n.id)).toEqual([stableId("note", REVIEW, concept(1)), stableId("note", REVIEW, concept(2))]);
    expect(h.record.view({ reviewId: REVIEW }).observations.map((o) => o.id)).toEqual([stableId("obs", REVIEW, T1), stableId("obs", REVIEW, T2)]);
  });

  test("a failed save writes nothing, is retained, and its retry writes the same bundle verbatim", async () => {
    let text = "original claim text";
    const h = harness({ claims: () => [claim(1, text), claim(2)] });
    h.failNextSnapshots(1);
    expect(await h.record.save(REVIEW)).toEqual({ kind: "save_failed", error: "Error: disk full", retryable: true });
    expect(Object.values(rows(h)).every((r) => r.length === 0)).toBe(true);

    text = "changed after the failure";
    expect((await h.record.save(REVIEW)).kind).toBe("saved");
    const source = h.record.view({ reviewId: REVIEW }).notes[0]!.generated.find((s) => s.author === "source");
    expect(source?.text).toBe("original claim text");
    expect(h.calls.wrapUp).toBe(1);
    expect(h.db.sql.query("SELECT COUNT(*) AS n FROM saved_reviews").get()).toEqual({ n: 1 });
  });

  test("a failed wrap-up is a retryable save failure, and the retry saves", async () => {
    let fail = true;
    const h = harness({ wrapUp: async () => (fail ? Promise.reject(new Error("claude timed out")) : WRAP_UP) });
    expect(await h.record.save(REVIEW)).toMatchObject({ kind: "save_failed", retryable: true });
    fail = false;
    expect((await h.record.save(REVIEW)).kind).toBe("saved");
  });
});

describe("saveState reads the persisted save state, not what this process saw", () => {
  const OTHER = stableId("rvw", "review-2") as ReviewId;

  test("unsaved before any save, save_pending after a failed one, saved after the retry", async () => {
    const h = harness();
    expect(h.record.saveState(REVIEW)).toBe("unsaved");
    h.failNextSnapshots(1);
    expect((await h.record.save(REVIEW)).kind).toBe("save_failed");
    expect(h.record.saveState(REVIEW)).toBe("save_pending");
    expect(h.record.saveState(OTHER)).toBe("unsaved");
    expect((await h.record.save(REVIEW)).kind).toBe("saved");
    expect(h.record.saveState(REVIEW)).toBe("saved");
  });

  test("a failed wrap-up is a pending save too", async () => {
    let fail = true;
    const h = harness({ wrapUp: async () => (fail ? Promise.reject(new Error("claude timed out")) : WRAP_UP) });
    await h.record.save(REVIEW);
    expect(h.record.saveState(REVIEW)).toBe("save_pending");
    fail = false;
    await h.record.save(REVIEW);
    expect(h.record.saveState(REVIEW)).toBe("saved");
  });

  test('R15: "Retrying a save never creates a duplicate record." A restart keeps save_pending, and the retry on a fresh record saves once', async () => {
    const first = harness();
    first.failNextSnapshots(1);
    expect((await first.record.save(REVIEW)).kind).toBe("save_failed");

    const restarted = harness({ db: first.db });
    expect(restarted.record.saveState(REVIEW)).toBe("save_pending");
    expect((await restarted.record.save(REVIEW)).kind).toBe("saved");
    expect(restarted.record.saveState(REVIEW)).toBe("saved");
    expect((await restarted.record.save(REVIEW)).kind).toBe("saved");
    expect(rows(restarted).notes).toHaveLength(2);
    expect(rows(restarted).saved_reviews).toHaveLength(1);
    expect(first.db.sql.query("SELECT COUNT(*) AS n FROM save_failures").get()).toEqual({ n: 0 });
  });

  test("a saved review stays saved when a later re-save fails", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    h.failNextSnapshots(1);
    expect((await h.record.save(REVIEW)).kind).toBe("save_failed");
    expect(h.record.saveState(REVIEW)).toBe("saved");
    expect((await h.record.save(REVIEW)).kind).toBe("saved");
  });
});

describe("the learning record", () => {
  test("contributions are attributed: source claims, learner words verbatim, tutor summary", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    const note = h.record.view({ conceptId: concept(1) }).notes[0]!;
    expect(note.generated).toEqual([
      { author: "source", text: "claim 1", turnId: null, evidence: [ev(1)] },
      { author: "learner", text: "Each equation is a line; they meet at the solution.", turnId: stableId("turn", 2), evidence: [] },
      { author: "tutor", text: "Row picture: lines meet at the solution.", turnId: null, evidence: [ev(1)] },
    ]);
    expect(note.evidence).toEqual([ev(1)]);
  });

  test("observations are clamped at read: the skipped thread is not_assessed whatever was proposed", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    const [t1, t2] = h.record.view({ reviewId: REVIEW }).observations;
    expect(t1).toMatchObject({ proposed: "independent", status: "independent", clampedFrom: null });
    expect(t2).toMatchObject({ proposed: "independent", status: "not_assessed", clampedFrom: "independent" });
  });

  test("a learner override is clamped the same way", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    h.record.overrideObservation(stableId("obs", REVIEW, T2), "independent");
    h.record.overrideObservation(stableId("obs", REVIEW, T1), "partial");
    const [t1, t2] = h.record.view({ reviewId: REVIEW }).observations;
    expect(t1!.status).toBe("partial");
    expect(t2!.status).toBe("not_assessed");
  });

  test("user edits live in their own table, merge at read, and survive a re-save", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    const id = stableId("note", REVIEW, concept(1));
    h.record.editNote(id, "my wording");
    await h.record.save(REVIEW);
    const note = h.record.view({ reviewId: REVIEW }).notes.find((n) => n.id === id)!;
    expect(note.userEdit).toBe("my wording");
    expect(note.generated[0]!.author).toBe("source");
  });

  test("a deleted note stays deleted through a re-save", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    const id = stableId("note", REVIEW, concept(1));
    h.record.deleteNote(id);
    expect(await h.record.save(REVIEW)).toMatchObject({ kind: "saved", notes: 1 });
    expect(h.record.view({ reviewId: REVIEW }).notes.map((n) => n.id)).not.toContain(id);
  });

  test("link suggestions can be accepted or corrected", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    expect(h.record.view({ reviewId: REVIEW }).links[0]!.decision).toBe("suggested");
    h.record.decideLink(LINK.id, "accepted");
    expect(h.record.view({ conceptId: concept(2) }).links[0]!.decision).toBe("accepted");
    h.record.decideLink(LINK.id, { corrected: "part_of" });
    expect(h.record.view({ reviewId: REVIEW }).links[0]).toMatchObject({ type: "prerequisite_of", decision: { corrected: "part_of" } });
  });

  test("evidence the user deleted shows as unavailable on the note that cites it", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    h.db.sql.run(`INSERT INTO evidence_deletions (evidence_id, request_id, deleted_ms, seq) VALUES (?, 'req', 42, 1)`, [ev(1)]);
    expect(h.record.view({ reviewId: REVIEW }).unavailableEvidence).toEqual([{ kind: "deleted", id: ev(1), deletedAtMs: 42 }]);
  });
});

describe("a dispute you settle saves the way you settled it; the tutor's proposal can't override it", () => {
  const disputedTurns = () =>
    log().tutor(ask(T1, 1)).learner(answer("they are columns"), T1).learner({ kind: "dispute", text: "the board showed columns" }, T1)
      .learner({ kind: "end" }, null).tutor({ kind: "wrap_up" }).turns;
  const obsId = stableId("obs", REVIEW, T1);

  test.each(["independent", "partial"] as const)("first proposal %s", async (first) => {
    let proposed: WrapUpOutput["observations"][number]["proposed"] = first;
    const h = harness({ turns: disputedTurns(), wrapUp: async () => ({ observations: [{ threadId: T1, proposed, rationale: "r" }], notes: [] }) });
    const saved = async () => {
      await h.record.save(REVIEW);
      return h.record.view({ reviewId: REVIEW }).observations[0]!;
    };
    expect(isLearningGap(await saved())).toBe(false);

    h.record.resolveDispute(obsId, "learner_was_right");
    for (const p of ["independent", "partial", "unresolved"] as const) {
      proposed = p;
      expect(isLearningGap(await saved())).toBe(false);
    }

    h.record.resolveDispute(obsId, "it_was_my_gap");
    for (const [p, status] of [["independent", "unresolved"], ["partial", "partial"], ["after_help", "unresolved"], ["unresolved", "unresolved"]] as const) {
      proposed = p;
      const o = await saved();
      expect(o).toMatchObject({ status, dispute: { kind: "resolved_by_learner", outcome: "it_was_my_gap" } });
      expect(isLearningGap(o)).toBe(true);
    }
  });
});

describe("R3: a claim that is not assessable at save is not assessed", () => {
  test("its observation clamps to not_assessed, a learner override included; assessable threads keep their status", async () => {
    const turns = log()
      .tutor(ask(T1, 1)).learner(answer("rows meet"), T1).tutor({ kind: "close_thread", threadId: T1 })
      .tutor(ask(T2, 2)).learner(answer("columns combine"), T2)
      .learner({ kind: "end" }, null).tutor({ kind: "wrap_up" }).turns;
    const wrapUp: WrapUpOutput = {
      observations: [{ threadId: T1, proposed: "partial", rationale: "r" }, { threadId: T2, proposed: "partial", rationale: "r" }],
      notes: [],
    };
    const h = harness({ turns, wrapUp: async () => wrapUp, claims: () => [claim(1)] });
    await h.record.save(REVIEW);
    const [t1, t2] = h.record.view({ reviewId: REVIEW }).observations;
    expect(t1).toMatchObject({ proposed: "partial", status: "partial" });
    expect(t2).toMatchObject({ proposed: "partial", status: "not_assessed", clampedFrom: "partial" });
    expect(isLearningGap(t2!)).toBe(false);

    h.record.overrideObservation(stableId("obs", REVIEW, T2), "unresolved");
    expect(h.record.view({ reviewId: REVIEW }).observations[1]!.status).toBe("not_assessed");
  });
});

describe("a re-save never re-snapshots evidence the user let go", () => {
  test("evidence only a deleted note cited is not snapshotted again", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    h.record.deleteNote(stableId("note", REVIEW, concept(1)));
    await h.record.save(REVIEW);
    expect(h.calls.snapshots).toEqual([[ev(1), ev(2)].sort(), [ev(2)]]);
  });

  test("evidence the user deleted is not snapshotted again, though a live note still cites it", async () => {
    const h = harness();
    await h.record.save(REVIEW);
    h.db.sql.run(`INSERT INTO evidence_deletions (evidence_id, request_id, deleted_ms, seq) VALUES (?, 'req', 42, 1)`, [ev(2)]);
    await h.record.save(REVIEW);
    expect(h.calls.snapshots).toEqual([[ev(1), ev(2)].sort(), [ev(1)]]);
    expect(h.record.view({ reviewId: REVIEW }).unavailableEvidence).toEqual([{ kind: "deleted", id: ev(2), deletedAtMs: 42 }]);
  });
});

describe("TLC counterexamples from docs/flows/model/out-record/report.md", () => {
  test("R14: ask, answer, dispute, end with a failed save, retry: saved as disputed, not a gap", async () => {
    const turns = log()
      .tutor(ask(T1, 1))
      .learner(answer("they are columns"), T1)
      .learner({ kind: "dispute", text: "the board showed columns" }, T1)
      .learner({ kind: "end" }, null)
      .tutor({ kind: "wrap_up" }).turns;
    const wrapUp: WrapUpOutput = { observations: [{ threadId: T1, proposed: "partial", rationale: "confused rows and columns" }], notes: [] };
    const h = harness({ turns, wrapUp: async () => wrapUp });
    h.failNextSnapshots(1);
    expect((await h.record.save(REVIEW)).kind).toBe("save_failed");
    expect((await h.record.save(REVIEW)).kind).toBe("saved");

    const obsId = stableId("obs", REVIEW, T1);
    const saved = h.record.view({ reviewId: REVIEW }).observations[0]!;
    expect(saved).toMatchObject({ proposed: "partial", status: "disputed", dispute: { kind: "open" } });
    expect(isLearningGap(saved)).toBe(false);

    h.record.resolveDispute(obsId, "learner_was_right");
    expect(isLearningGap(h.record.view({ reviewId: REVIEW }).observations[0]!)).toBe(false);
    h.record.resolveDispute(obsId, "it_was_my_gap");
    const resolved = h.record.view({ reviewId: REVIEW }).observations[0]!;
    expect(resolved).toMatchObject({ status: "partial", dispute: { kind: "resolved_by_learner", outcome: "it_was_my_gap" } });
    expect(isLearningGap(resolved)).toBe(true);
  });

  test("R16: end with a failed save, expiry is refused while pending, retry saves, cited evidence is held until the user deletes the note", async () => {
    const db = testDb();
    db.sql.run(`INSERT INTO reviews (id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, 'prepared_only', '{}', 1, 0)`, [REVIEW, CAPTURE]);
    db.sql.run(`INSERT INTO capture_facts (seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (2, ?, 0, 0, 'span', '{}', 0)`, [CAPTURE]);
    const h = harness({ db });
    const expireRaw = () => db.sql.run(`DELETE FROM capture_facts WHERE capture_id = ?`, [CAPTURE]);
    const expireSnapshots = () => db.sql.run(`DELETE FROM evidence_snapshots`);

    h.failNextSnapshots(1);
    expect((await h.record.save(REVIEW)).kind).toBe("save_failed");
    expect(expireRaw).toThrow(/R16/);

    expect((await h.record.save(REVIEW)).kind).toBe("saved");
    expect(h.calls.snapshots).toEqual([[ev(1), ev(2)].sort()]);
    expect(expireSnapshots).toThrow(/R16/);

    h.record.deleteNote(stableId("note", REVIEW, concept(1)));
    h.record.deleteNote(stableId("note", REVIEW, concept(2)));
    expect(expireSnapshots).not.toThrow();
  });
});
