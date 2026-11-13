import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LOCAL_USER, MIGRATIONS, ensureLocalUser, openDb, scopeDb } from "../src/backend/db";
import type { Db } from "../src/backend/db";
import { createRecord } from "../src/backend/record";
import type { ReviewId } from "../src/shared/ids";
import { stableId } from "../src/shared/ids";
import { LINK, post, registerCleanup, savedRig, send } from "./http-fixtures";
import { otherUserDb, testDb } from "./fakes";
import { tmpDir } from "./tmp";

registerCleanup();

const rowsOf = (db: Db, sql: string, ...params: string[]) => db.sql.query<{ n: number }, string[]>(sql).get(...params)!.n;

/** Two users in one database, each with a finished and saved review behind their own server. Both reviews hold the same claims, concepts and link. */
async function twoSaved() {
  const raw = testDb();
  const alice = await savedRig(scopeDb(raw, ensureLocalUser(raw)));
  const bob = await savedRig(otherUserDb(raw, "bob"));
  return { raw, alice, bob };
}

describe("two users in one database: the record", () => {
  test("each user saved a review of the same claims and the same link: the rows are two sets, and each view shows only its own", async () => {
    const { raw, alice, bob } = await twoSaved();
    const a = await alice.record();
    const b = await bob.record();
    expect(a.notes).toHaveLength(1);
    expect(b.notes).toHaveLength(1);
    expect(a.links.map((l) => l.id)).toEqual([LINK.id]);
    expect(b.links.map((l) => l.id)).toEqual([LINK.id]);
    expect(a.notes[0]!.reviewId).toBe(alice.reviewId);
    expect(b.notes[0]!.reviewId).toBe(bob.reviewId);
    expect((await alice.record("")).notes.map((n) => n.reviewId)).toEqual([alice.reviewId]);
    expect(a.observations.map((o) => o.reviewId)).toEqual([alice.reviewId, alice.reviewId]);
    for (const table of ["notes", "observations", "link_suggestions", "saved_reviews"]) {
      expect(rowsOf(raw, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, alice.db.userId)).toBeGreaterThan(0);
      expect(rowsOf(raw, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, bob.db.userId)).toBeGreaterThan(0);
    }
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM link_suggestions WHERE id = ?", LINK.id)).toBe(2);
  });

  test("a note, an observation or a link id the other user holds is 404 on every record command, and nothing of the owner's changes", async () => {
    const { raw, alice, bob } = await twoSaved();
    const mine = await alice.record();
    const note = mine.notes[0]!.id;
    const obs = mine.observations[0]!.id;
    const link = stableId("lnk", "only-alice");
    raw.sql.run(
      "INSERT INTO link_suggestions (user_id, id, ord, review_id, from_concept, to_concept, type, evidence_json, rationale, saved_ms) VALUES (?, ?, 99, ?, ?, ?, 'part_of', '[]', 'why', 0)",
      [alice.db.userId, link, alice.reviewId, stableId("cpt", "a"), stableId("cpt", "b")],
    );
    const snapshot = () => JSON.stringify(raw.sql.query("SELECT user_id, note_id AS k, text AS v FROM note_edits").all()) + rowsOf(raw, "SELECT (SELECT COUNT(*) FROM note_deletions) + (SELECT COUNT(*) FROM observation_decisions) + (SELECT COUNT(*) FROM link_decisions) AS n");
    const before = snapshot();

    expect((await send(bob.base, "PATCH", `/record/notes/${note}`, { text: "stolen" })).status).toBe(404);
    expect((await send(bob.base, "DELETE", `/record/notes/${note}`)).status).toBe(404);
    expect((await send(bob.base, "POST", `/record/observations/${obs}/dispute-resolution`, { outcome: "it_was_my_gap" })).status).toBe(404);
    expect((await send(bob.base, "POST", `/record/observations/${obs}/override`, { status: "independent" })).status).toBe(404);
    expect((await send(bob.base, "POST", `/record/links/${link}`, { decision: "accepted" })).status).toBe(404);
    expect(snapshot()).toBe(before);

    const after = await alice.record();
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0]!.userEdit).toBeNull();
    expect(after.links.find((l) => l.id === link)!.decision).toBe("suggested");
  });

  test("the link id both users hold is decided separately, and a note edit or deletion by one never reaches the other", async () => {
    const { alice, bob } = await twoSaved();
    const link = LINK.id;
    expect((await send(alice.base, "POST", `/record/links/${link}`, { decision: "rejected" })).status).toBe(204);
    expect((await alice.record()).links[0]!.decision).toBe("rejected");
    expect((await bob.record()).links[0]!.decision).toBe("suggested");

    const a = (await alice.record()).notes[0]!;
    const b = (await bob.record()).notes[0]!;
    expect(a.id).not.toBe(b.id);
    expect((await send(alice.base, "PATCH", `/record/notes/${a.id}`, { text: "alice's words" })).status).toBe(204);
    expect((await send(alice.base, "DELETE", `/record/notes/${a.id}`)).status).toBe(204);
    expect((await alice.record()).notes).toEqual([]);
    const still = (await bob.record()).notes;
    expect(still).toHaveLength(1);
    expect(still[0]!.userEdit).toBeNull();
  });

  test("R14: a dispute resolution or an override by one user never reaches the other's observation", async () => {
    const { raw, alice, bob } = await twoSaved();
    const obs = (await alice.record()).observations[0]!.id;
    expect((await send(alice.base, "POST", `/record/observations/${obs}/override`, { status: "unresolved" })).status).toBe(204);
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM observation_decisions WHERE user_id = ?", alice.db.userId)).toBe(1);
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM observation_decisions WHERE user_id = ?", bob.db.userId)).toBe(0);
    const bobs = (await bob.record()).observations;
    expect(bobs.every((o) => o.status !== "unresolved")).toBe(true);
  });

  test("R15: saving again answers from the user's own first save, and the other user's save of the same claims does not count as it", async () => {
    const { raw, alice, bob } = await twoSaved();
    const counts = (user: string) => ["notes", "observations", "link_suggestions", "saved_reviews"].map((t) => rowsOf(raw, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, user));
    const before = [counts(alice.db.userId), counts(bob.db.userId)];
    expect((await post(alice.base, `/reviews/${alice.reviewId}/save`, {})).status).toBe(200);
    expect((await post(bob.base, `/reviews/${bob.reviewId}/save`, {})).status).toBe(200);
    expect([counts(alice.db.userId), counts(bob.db.userId)]).toEqual(before);
    expect((await post(bob.base, `/reviews/${alice.reviewId}/save`, {})).status).toBe(404);
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM saved_reviews WHERE user_id = ?", bob.db.userId)).toBe(1);
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM save_failures")).toBe(0);
  });

  test("the save state of a review is its own user's: another user's saved row for the same id does not make it saved", async () => {
    const { raw, alice, bob } = await twoSaved();
    expect(alice.record).toBeDefined();
    expect(bob.reviews.view(bob.reviewId).saved).toBe("unsaved");
    const state = (rig: typeof alice, id: ReviewId) => createRecord(rig.db, { turns: () => [], claims: () => [], wrapUp: () => Promise.reject(new Error("no")), snapshotEvidenceInTx: () => {} }).saveState(id);
    expect(state(alice, alice.reviewId)).toBe("saved");
    expect(state(bob, alice.reviewId)).toBe("unsaved");
    raw.sql.run("INSERT INTO save_failures (user_id, review_id, error, failed_ms) VALUES (?, ?, 'x', 0)", [bob.db.userId, alice.reviewId]);
    expect(state(bob, alice.reviewId)).toBe("save_pending");
    expect(state(alice, alice.reviewId)).toBe("saved");
  });

  test("notes, observations and links come back in the order they were saved, per user", async () => {
    const { alice, bob } = await twoSaved();
    const ids = (r: Awaited<ReturnType<typeof alice.record>>) => [r.notes.map((n) => n.id), r.observations.map((o) => o.id)];
    const first = ids(await alice.record());
    expect(first[1]).toHaveLength(2);
    expect(ids(await alice.record())).toEqual(first);
    expect(ids(await bob.record())[1]).toHaveLength(2);
  });

  test("R16: a note holds only its own user's snapshot, and a pending review's hold on raw evidence is only its own user's, even if another user has a saved row with the same review id", () => {
    const raw = testDb();
    const a = scopeDb(raw, ensureLocalUser(raw));
    const b = otherUserDb(raw, "bob");
    const evidence = stableId("ev", "shared");
    const capture = stableId("cap", "shared");
    for (const u of [a, b]) {
      raw.sql.run("INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, text, created_ms) VALUES (?, ?, 'passage', 's', 1, 2, 'text', 0)", [u.userId, evidence]);
      raw.sql.run("INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, ?, 0, 0, 'span', '{}', 0)", [u.userId, raw.nextSeq(), capture]);
    }
    raw.sql.run("INSERT INTO note_evidence (user_id, note_id, evidence_id) VALUES (?, ?, ?)", [a.userId, stableId("note", "a"), evidence]);
    raw.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [b.userId]);
    expect(() => raw.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [a.userId])).toThrow(/R16: evidence cited by a note/);
    raw.sql.run("INSERT INTO note_deletions (user_id, note_id, deleted_ms) VALUES (?, ?, 0)", [b.userId, stableId("note", "a")]);
    expect(() => raw.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [a.userId])).toThrow(/R16/);
    raw.sql.run("INSERT INTO note_deletions (user_id, note_id, deleted_ms) VALUES (?, ?, 0)", [a.userId, stableId("note", "a")]);
    raw.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [a.userId]);

    const review = stableId("rvw", "b");
    raw.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, ?, 'prepared_only', '{}', ?, 0)", [review, b.userId, capture, raw.nextSeq()]);
    raw.sql.run("INSERT INTO saved_reviews (user_id, review_id, bundle_hash, saved_ms) VALUES (?, ?, 'h', 0)", [a.userId, review]);
    raw.sql.run("DELETE FROM capture_facts WHERE user_id = ?", [a.userId]);
    expect(() => raw.sql.run("DELETE FROM capture_facts WHERE user_id = ?", [b.userId])).toThrow(/R16: raw evidence of an unsaved review is held/);
    raw.sql.run("INSERT INTO saved_reviews (user_id, review_id, bundle_hash, saved_ms) VALUES (?, ?, 'h', 0)", [b.userId, review]);
    raw.sql.run("DELETE FROM capture_facts WHERE user_id = ?", [b.userId]);
  });
});

describe("a database from before the record got user_id", () => {
  const OLD = { ...MIGRATIONS, record: MIGRATIONS.record.filter((m) => m.id !== "004-user-id") };
  const REVIEW = stableId("rvw", "old");
  const CAPTURE = stableId("cap", "old");
  const NOTE_A = stableId("note", "a");
  const NOTE_B = stableId("note", "b");
  const OBS_A = stableId("obs", "a");
  const OBS_B = stableId("obs", "b");
  const LINK_ID = stableId("lnk", "x");
  const EV = stableId("ev", "cited");

  /** Rows in all ten tables, inserted out of id order so the saved order shows. */
  function oldDatabase() {
    const dir = tmpDir("afterclass-record-upgrade-");
    const path = join(dir, "afterclass.sqlite");
    const old = openDb(path, OLD);
    const run = (sql: string, ...p: (string | number)[]) => old.sql.run(sql, p);
    run("INSERT INTO notes (id, review_id, concept_id, generated_json, saved_ms) VALUES (?, ?, 'cpt_1', '[]', 700)", NOTE_B, REVIEW);
    run("INSERT INTO notes (id, review_id, concept_id, generated_json, saved_ms) VALUES (?, ?, 'cpt_2', '[]', 700)", NOTE_A, REVIEW);
    run("INSERT INTO note_edits (note_id, text, edited_ms) VALUES (?, 'my words', 710)", NOTE_A);
    run("INSERT INTO note_deletions (note_id, deleted_ms) VALUES (?, 720)", NOTE_B);
    run("INSERT INTO note_evidence (note_id, evidence_id) VALUES (?, ?)", NOTE_A, EV);
    const facts = '{"asked":1}';
    run(
      "INSERT INTO observations (id, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms, assessable) VALUES (?, ?, 'thr_2', '[]', '[]', 'independent', ?, 700, 0)",
      OBS_B, REVIEW, facts,
    );
    run(
      "INSERT INTO observations (id, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms, assessable) VALUES (?, ?, 'thr_1', '[]', '[]', 'partial', ?, 700, 1)",
      OBS_A, REVIEW, facts,
    );
    run("INSERT INTO observation_decisions (observation_id, kind, value, decided_ms) VALUES (?, 'override', 'unresolved', 730)", OBS_A);
    run("INSERT INTO link_suggestions (id, review_id, from_concept, to_concept, type, evidence_json, rationale, saved_ms) VALUES (?, ?, 'cpt_1', 'cpt_2', 'part_of', '[]', 'why', 700)", LINK_ID, REVIEW);
    run("INSERT INTO link_decisions (link_id, decision_json, decided_ms) VALUES (?, '\"accepted\"', 740)", LINK_ID);
    run("INSERT INTO saved_reviews (review_id, bundle_hash, saved_ms) VALUES (?, 'h', 750)", REVIEW);
    run("INSERT INTO save_failures (review_id, error, failed_ms) VALUES (?, 'earlier', 650)", stableId("rvw", "other"));
    const lastSeq = old.nextSeq();
    old.close();
    return { path, lastSeq };
  }

  const upgraded = () => {
    const o = oldDatabase();
    return { ...o, db: openDb(o.path) };
  };

  test("every row is kept and becomes the local user's, in the order it was saved, and the local user's row exists", () => {
    const { db, lastSeq } = upgraded();
    expect(db.sql.query("SELECT id, created_ms FROM users").all()).toEqual([{ id: LOCAL_USER, created_ms: 700 }]);
    for (const [table, n] of [["notes", 2], ["note_edits", 1], ["note_deletions", 1], ["note_evidence", 1], ["observations", 2], ["observation_decisions", 1], ["link_suggestions", 1], ["link_decisions", 1], ["saved_reviews", 1], ["save_failures", 1]] as const) {
      expect(rowsOf(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, LOCAL_USER)).toBe(n);
    }
    expect(db.sql.query("SELECT id, ord FROM notes ORDER BY ord").all()).toEqual([{ id: NOTE_B, ord: 1 }, { id: NOTE_A, ord: 2 }]);
    expect(db.sql.query("SELECT id, ord, assessable FROM observations ORDER BY ord").all()).toEqual([{ id: OBS_B, ord: 1, assessable: 0 }, { id: OBS_A, ord: 2, assessable: 1 }]);
    expect(db.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.nextSeq()).toBe((lastSeq + 1) as typeof lastSeq);
    db.close();
  });

  test("the record reads the old rows as the local user's, edits and decisions included, and a second user sees none", () => {
    const { db } = upgraded();
    const make = (user: ReturnType<typeof scopeDb>) => createRecord(user, { turns: () => [], claims: () => [], wrapUp: () => Promise.reject(new Error("no")), snapshotEvidenceInTx: () => {} });
    const mine = make(scopeDb(db, LOCAL_USER));
    const view = mine.view({});
    expect(view.notes.map((n) => [n.id, n.userEdit, n.evidence])).toEqual([[NOTE_A, "my words", [EV]]]);
    expect(view.links.map((l) => [l.id, l.decision])).toEqual([[LINK_ID, "accepted"]]);
    expect(mine.saveState(REVIEW as ReviewId)).toBe("saved");
    expect(mine.saveState(stableId("rvw", "other") as ReviewId)).toBe("save_pending");
    const theirs = make(otherUserDb(db, "bob"));
    expect(theirs.view({})).toEqual({ notes: [], observations: [], links: [], unavailableEvidence: [] });
    expect(theirs.saveState(REVIEW as ReviewId)).toBe("unsaved");
    db.close();
  });

  test("the R16 triggers still fire against the upgraded rows, and match the same user", () => {
    const { db } = upgraded();
    const other = otherUserDb(db, "bob");
    db.sql.run("INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, text, created_ms) VALUES (?, ?, 'passage', 's', 1, 2, 't', 0)", [LOCAL_USER, EV]);
    db.sql.run("INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, text, created_ms) VALUES (?, ?, 'passage', 's', 1, 2, 't', 0)", [other.userId, EV]);
    db.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [other.userId]);
    expect(() => db.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [LOCAL_USER])).toThrow(/R16: evidence cited by a note is deleted only by the user/);
    db.sql.run("INSERT INTO note_deletions (user_id, note_id, deleted_ms) VALUES (?, ?, 1)", [LOCAL_USER, NOTE_A]);
    db.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [LOCAL_USER]);

    db.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES ('rvw_p', ?, ?, 'prepared_only', '{}', ?, 0)", [LOCAL_USER, CAPTURE, db.nextSeq()]);
    db.sql.run("INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, ?, 0, 0, 'span', '{}', 0)", [LOCAL_USER, db.nextSeq(), CAPTURE]);
    expect(() => db.sql.run("DELETE FROM capture_facts")).toThrow(/R16: raw evidence of an unsaved review is held/);
    db.sql.run("INSERT INTO saved_reviews (user_id, review_id, bundle_hash, saved_ms) VALUES (?, 'rvw_p', 'h', 0)", [LOCAL_USER]);
    db.sql.run("DELETE FROM capture_facts");
    db.close();
  });

  test("the constraints still hold: user_id is required and must exist, the keys are per user, and the CHECKs are back", () => {
    const { db } = upgraded();
    const other = otherUserDb(db, "bob");
    const note = (user: string | null, id: string) =>
      db.sql.run("INSERT INTO notes (user_id, id, ord, review_id, concept_id, generated_json, saved_ms) VALUES (?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM notes), 'r', 'c', '[]', 0)", [user, id]);
    expect(() => note(null, "n_x")).toThrow(/NOT NULL/);
    expect(() => note(stableId("usr", "nobody"), "n_x")).toThrow(/FOREIGN KEY/);
    expect(() => note(LOCAL_USER, NOTE_A)).toThrow(/UNIQUE/);
    note(other.userId, NOTE_A);
    expect(() => db.sql.run("INSERT INTO link_decisions (user_id, link_id, decision_json, decided_ms) VALUES (?, ?, '{}', 0)", [LOCAL_USER, LINK_ID])).toThrow(/UNIQUE/);
    db.sql.run("INSERT INTO link_decisions (user_id, link_id, decision_json, decided_ms) VALUES (?, ?, '{}', 0)", [other.userId, LINK_ID]);
    expect(() =>
      db.sql.run("INSERT INTO observation_decisions (user_id, observation_id, kind, value, decided_ms) VALUES (?, ?, 'dispute_resolution', 'maybe', 0)", [LOCAL_USER, OBS_A]),
    ).toThrow(/CHECK/);
    expect(() =>
      db.sql.run("INSERT INTO observations (user_id, id, ord, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms) VALUES (?, 'o', 9, 'r', 't', '[]', '[]', 'disputed', '{}', 0)", [LOCAL_USER]),
    ).toThrow(/CHECK/);
    expect(() =>
      db.sql.run("INSERT INTO link_suggestions (user_id, id, ord, review_id, from_concept, to_concept, type, evidence_json, rationale, saved_ms) VALUES (?, 'l', 9, 'r', 'a', 'b', 'bogus', '[]', 'x', 0)", [LOCAL_USER]),
    ).toThrow(/CHECK/);
    expect(() =>
      db.sql.run("INSERT INTO observations (user_id, id, ord, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms) VALUES (?, 'o2', 9, ?, 'thr_1', '[]', '[]', 'partial', '{}', 0)", [LOCAL_USER, REVIEW]),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  test("an empty database upgrades without a user row", () => {
    const dir = tmpDir("afterclass-record-empty-");
    const path = join(dir, "afterclass.sqlite");
    openDb(path, OLD).close();
    const db = openDb(path);
    expect(db.sql.query("SELECT id FROM users").all()).toEqual([]);
    db.close();
  });
});
