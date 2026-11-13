import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LOCAL_USER, MIGRATIONS, ensureLocalUser, openDb, scopeDb } from "../src/backend/db";
import type { Db, UserDb } from "../src/backend/db";
import { createReviews } from "../src/backend/review";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, ReviewId, TurnId } from "../src/shared/ids";
import { bearer, count, pick, post, registerCleanup, reviewRig, said } from "./http-fixtures";
import { World, askMain, kit, reply, tutorHarness } from "./review-fixtures";
import { otherUserDb, testDb } from "./fakes";
import { tmpDir } from "./tmp";

registerCleanup();

/** Two users in one database, each with the real review and record modules behind their own server. */
function twoUsers() {
  const raw = testDb();
  const alice = reviewRig(pick, { db: scopeDb(raw, ensureLocalUser(raw)) });
  const bob = reviewRig(pick, { db: otherUserDb(raw, "bob") });
  return { raw, alice, bob };
}

const rowsOf = (db: Db, sql: string, ...params: string[]) => db.sql.query<{ n: number }, string[]>(sql).get(...params)!.n;

describe("two users in one database: reviews", () => {
  test("a review id another user holds is refused: 404 over HTTP, RangeError in the module, and nothing is stored or changed", async () => {
    const { raw, alice, bob } = twoUsers();
    alice.prepare();
    bob.prepare();
    const a = await alice.startReview();
    expect(a.status).toBe(200);
    const before = rowsOf(raw, "SELECT COUNT(*) AS n FROM reviews");

    const forged = await bob.startReview(a.reviewId);
    expect(forged.status).toBe(404);
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM reviews")).toBe(before);
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM reviews WHERE id = ? AND user_id = ?", a.reviewId, alice.db.userId)).toBe(1);

    const direct = createReviews(bob.db, { ...bob.world.deps, runTutor: () => Promise.reject(new Error("no")), clearFailures: () => {} }, { tutor: kit });
    expect(direct.heldByAnotherUser(a.reviewId)).toBe(true);
    expect(() => direct.start(bob.capture, "prepared_only", a.reviewId)).toThrow(RangeError);
    expect(createReviews(alice.db, { ...alice.world.deps, runTutor: () => Promise.reject(new Error("no")), clearFailures: () => {} }, { tutor: kit }).heldByAnotherUser(a.reviewId)).toBe(false);
  });

  test("another user's review id reads, turns, saves and lists nothing, and an id nobody holds answers the same", async () => {
    const { alice, bob } = twoUsers();
    alice.prepare();
    bob.prepare();
    const a = await alice.startReview();
    await alice.turn(a.reviewId, { kind: "resume" });

    expect((await bob.view(a.reviewId)).status).toBe(404);
    expect((await bob.view(randomId("rvw"))).status).toBe(404);
    expect((await alice.view(a.reviewId)).status).toBe(200);
    expect((await bob.turn(a.reviewId, { kind: "resume" })).status).toBe(404);
    expect((await post(bob.base, `/reviews/${a.reviewId}/save`, {})).status).toBe(404);
    expect((await fetch(`${bob.base}/record?reviewId=${a.reviewId}`, { headers: bearer })).status).toBe(404);
    expect(count(bob.db, "SELECT COUNT(*) AS n FROM review_turns WHERE user_id = '" + alice.db.userId + "' AND actor = 'learner'")).toBe(1);
  });

  test("R15: the same turn id from two users is two turns: neither replays, joins or blocks the other", async () => {
    const { raw, alice, bob } = twoUsers();
    alice.prepare();
    bob.prepare();
    const a = await alice.startReview();
    const b = await bob.startReview();
    const shared = randomId("turn");

    const [ta, tb] = await Promise.all([alice.turn(a.reviewId, { kind: "resume" }, shared), bob.turn(b.reviewId, { kind: "resume" }, shared)]);
    expect(ta.status).toBe(200);
    expect(tb.status).toBe(200);
    expect(ta.events.some((e) => e.type === "move")).toBe(true);
    expect(tb.events.some((e) => e.type === "move")).toBe(true);
    expect(alice.model.calls).toHaveLength(1);
    expect(bob.model.calls).toHaveLength(1);
    for (const [user, review] of [[alice.db.userId, a.reviewId], [bob.db.userId, b.reviewId]] as const) {
      expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM review_turns WHERE user_id = ? AND review_id = ? AND id = ?", user, review, shared)).toBe(1);
    }

    const sendA = await alice.turn(a.reviewId, said("lines meeting at a point"), randomId("turn"));
    expect(sendA.events.some((e) => e.type === "turn_complete")).toBe(true);
    const learnerOfB = bob.db.sql.query<{ body_json: string }, [string]>("SELECT body_json FROM review_turns WHERE user_id = ? AND actor = 'learner'").all(bob.db.userId);
    expect(learnerOfB).toHaveLength(1);
    expect(learnerOfB[0]!.body_json).not.toContain("lines meeting");
  });

  test("a turn running for one user does not make another user's turn on the same turn id or another review wait or answer 409", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const raw = testDb();
    const alice = reviewRig((input) => gate.then(() => pick(input)), { db: scopeDb(raw, ensureLocalUser(raw)) });
    const bob = reviewRig(pick, { db: otherUserDb(raw, "bob") });
    alice.prepare();
    bob.prepare();
    const a = await alice.startReview();
    const b = await bob.startReview();
    const shared = randomId("turn");

    const running = alice.turn(a.reviewId, { kind: "resume" }, shared);
    await Bun.sleep(30);
    const own = await bob.turn(b.reviewId, { kind: "resume" }, shared);
    expect(own.status).toBe(200);
    expect(own.events.some((e) => e.type === "move")).toBe(true);
    expect((await bob.turn(a.reviewId, { kind: "resume" })).status).toBe(404);
    release();
    expect((await running).events.some((e) => e.type === "move")).toBe(true);
  });

  test("the invite, the review list and the scope already reviewed are per user, even for a capture id both name", () => {
    const raw = testDb();
    const mk = (db: UserDb) => {
      const world = new World(db);
      world.close(0, 0, 300);
      world.claim(1, 10, 20);
      const t = tutorHarness(db, () => reply(askMain(), ""));
      return { db, world, reviews: createReviews(db, { ...world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit }) };
    };
    const a = mk(scopeDb(raw, ensureLocalUser(raw)));
    const b = mk(otherUserDb(raw, "bob"));
    const capture: CaptureId = a.world.captureId;

    expect(a.reviews.answerInvite(capture, "later")).toMatchObject({ state: "later" });
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM invite_answers WHERE user_id = ?", b.db.userId)).toBe(0);
    expect(b.reviews.invite(capture)).not.toMatchObject({ state: "later" });

    const started = a.reviews.start(capture, "prepared_only", randomId("rvw"));
    expect(started.kind).toBe("started");
    expect(a.reviews.options(capture).kind).toBe("nothing_to_review");
    expect(b.reviews.options(capture).kind).toBe("ready");
    expect(b.reviews.list(capture)).toEqual([]);
    expect(a.reviews.list(capture)).toHaveLength(1);
  });

  test("R16: a review holds only its own user's raw evidence, at the table level where two users share a capture id", () => {
    const raw = testDb();
    const a = scopeDb(raw, ensureLocalUser(raw));
    const b = otherUserDb(raw, "bob");
    const capture = stableId("cap", "shared");
    for (const u of [a, b]) {
      raw.sql.run("INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, ?, 0, 0, 'span', '{}', 0)", [u.userId, raw.nextSeq(), capture]);
      raw.sql.run(
        "INSERT INTO frames (user_id, evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq) VALUES (?, ?, ?, 's', 'f', 1, 640, 360, ?, ?)",
        [u.userId, stableId("ev", capture, "f"), capture, `p-${u.userId}`, raw.nextSeq()],
      );
    }
    raw.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, ?, 'prepared_only', '{}', ?, 0)", [
      stableId("rvw", "a"), a.userId, capture, raw.nextSeq(),
    ]);
    raw.sql.run("DELETE FROM frames WHERE user_id = ?", [b.userId]);
    raw.sql.run("DELETE FROM capture_facts WHERE user_id = ?", [b.userId]);
    expect(() => raw.sql.run("DELETE FROM frames WHERE user_id = ?", [a.userId])).toThrow(/R16: frames of an unsaved review are held/);
    expect(() => raw.sql.run("DELETE FROM capture_facts WHERE user_id = ?", [a.userId])).toThrow(/R16: raw evidence of an unsaved review is held/);
  });

  test("a turn must belong to a review of the same user, and a review id is unique across users", () => {
    const raw = testDb();
    const a = scopeDb(raw, ensureLocalUser(raw));
    const b = otherUserDb(raw, "bob");
    const review = stableId("rvw", "a");
    const insertReview = (user: string, id = review) =>
      raw.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, 'cap_x', 'prepared_only', '{}', ?, 0)", [id, user, raw.nextSeq()]);
    const insertTurn = (user: string, id: string) =>
      raw.sql.run("INSERT INTO review_turns (user_id, id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES (?, ?, ?, ?, 'learner', NULL, '{}', 0)", [user, id, review, raw.nextSeq()]);
    insertReview(a.userId);
    expect(() => insertReview(b.userId)).toThrow(/UNIQUE/);
    expect(() => insertTurn(b.userId, "turn_1")).toThrow(/FOREIGN KEY/);
    insertTurn(a.userId, "turn_1");
    expect(() => insertTurn(a.userId, "turn_1")).toThrow(/UNIQUE/);
    insertReview(b.userId, stableId("rvw", "b"));
    raw.sql.run("INSERT INTO review_turns (user_id, id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES (?, 'turn_1', ?, ?, 'learner', NULL, '{}', 0)", [b.userId, stableId("rvw", "b"), raw.nextSeq()]);
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM review_turns WHERE id = 'turn_1'")).toBe(2);
  });
});

describe("a database from before reviews got user_id", () => {
  const OLD = { ...MIGRATIONS, review: MIGRATIONS.review.filter((m) => m.id !== "002-user-id"), record: MIGRATIONS.record.filter((m) => m.id !== "004-user-id") };
  const CAPTURE = stableId("cap", "old");
  const REVIEW = stableId("rvw", "old");
  /** A real review's scope_json, so the reviews module can read it back after the upgrade. */
  async function realScope(): Promise<string> {
    const rig = reviewRig();
    rig.prepare();
    await rig.startReview();
    return rig.db.sql.query<{ scope_json: string }, []>("SELECT scope_json FROM reviews").get()!.scope_json;
  }

  async function oldDatabase() {
    const dir = tmpDir("afterclass-review-upgrade-");
    const path = join(dir, "afterclass.sqlite");
    const scope = await realScope();
    const old = openDb(path, OLD);
    old.sql.run("INSERT INTO invite_answers (seq, capture_id, answer, watched_s, at_ms) VALUES (?, ?, 'later', 30, 400)", [old.nextSeq(), CAPTURE]);
    old.sql.run("INSERT INTO reviews (id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, 'prepared_only', ?, ?, 500)", [REVIEW, CAPTURE, scope, old.nextSeq()]);
    old.sql.run("INSERT INTO review_turns (id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES ('turn_old', ?, ?, 'learner', NULL, ?, 600)", [
      REVIEW, old.nextSeq(), JSON.stringify({ act: { kind: "resume" } }),
    ]);
    const lastSeq = old.nextSeq();
    old.close();
    return { path, lastSeq };
  }

  const upgraded = async () => {
    const o = await oldDatabase();
    return { ...o, db: openDb(o.path) };
  };

  test("every row is kept and becomes the local user's, and the local user's row exists", async () => {
    const { db, lastSeq } = await upgraded();
    expect(db.sql.query("SELECT id, created_ms FROM users").all()).toEqual([{ id: LOCAL_USER, created_ms: 400 }]);
    expect(rowsOf(db, "SELECT COUNT(*) AS n FROM invite_answers WHERE user_id = ?", LOCAL_USER)).toBe(1);
    expect(rowsOf(db, "SELECT COUNT(*) AS n FROM reviews WHERE user_id = ? AND id = ?", LOCAL_USER, REVIEW)).toBe(1);
    expect(db.sql.query("SELECT id, review_id, actor, at_ms FROM review_turns WHERE user_id = ?").all(LOCAL_USER)).toEqual([
      { id: "turn_old", review_id: REVIEW, actor: "learner", at_ms: 600 },
    ]);
    expect(db.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.nextSeq()).toBe((lastSeq + 1) as typeof lastSeq);
    db.close();
  });

  test("the reviews module reads the old review, its turn and its invite answer as the local user's, and a second user sees none of it", async () => {
    const { db } = await upgraded();
    const make = (user: UserDb) => {
      const world = new World(user);
      const t = tutorHarness(user, () => reply(askMain(), ""));
      return createReviews(user, { ...world.deps, runTutor: t.runTutor, clearFailures: t.clearFailures }, { tutor: kit });
    };
    const mine = make(scopeDb(db, LOCAL_USER));
    expect(mine.view(REVIEW as ReviewId).turns.map((t) => t.id)).toEqual(["turn_old" as TurnId]);
    expect(mine.list(CAPTURE as CaptureId)).toHaveLength(1);
    const theirs = make(otherUserDb(db, "bob"));
    expect(() => theirs.view(REVIEW as ReviewId)).toThrow(/unknown review/);
    expect(theirs.list(CAPTURE as CaptureId)).toEqual([]);
    expect(theirs.heldByAnotherUser(REVIEW as ReviewId)).toBe(true);
    db.close();
  });

  test("the append-only, R7 and R16 triggers still fire, and the evidence triggers now match the same user", async () => {
    const { db } = await upgraded();
    expect(() => db.sql.run("UPDATE reviews SET scope_json = '{}'")).toThrow(/R7: reviews is append-only/);
    expect(() => db.sql.run("UPDATE review_turns SET body_json = '{}'")).toThrow(/review_turns is append-only/);
    expect(() => db.sql.run("UPDATE invite_answers SET watched_s = 0")).toThrow(/invite_answers is append-only/);

    const other = otherUserDb(db, "bob");
    for (const u of [LOCAL_USER, other.userId]) {
      db.sql.run("INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, ?, 0, 0, 'span', '{}', 0)", [u, db.nextSeq(), CAPTURE]);
    }
    db.sql.run("DELETE FROM capture_facts WHERE user_id = ?", [other.userId]);
    expect(() => db.sql.run("DELETE FROM capture_facts WHERE user_id = ?", [LOCAL_USER])).toThrow(/R16: raw evidence of an unsaved review is held/);
    db.close();
  });

  test("the constraints still hold: user_id is required and must exist, ids are unique, turns follow their review's user", async () => {
    const { db } = await upgraded();
    const review = (user: string | null, id: string) =>
      db.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, 'c', 'prepared_only', '{}', ?, 0)", [id, user, db.nextSeq()]);
    expect(() => review(null, "rvw_n")).toThrow(/NOT NULL/);
    expect(() => review(stableId("usr", "nobody"), "rvw_n")).toThrow(/FOREIGN KEY/);
    expect(() => review(LOCAL_USER, REVIEW)).toThrow(/UNIQUE/);
    expect(() => db.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES ('rvw_c', ?, 'c', 'bogus', '{}', ?, 0)", [LOCAL_USER, db.nextSeq()])).toThrow(/CHECK/);
    expect(() => db.sql.run("INSERT INTO invite_answers (seq, user_id, capture_id, answer, watched_s, at_ms) VALUES (?, ?, 'c', 'maybe', 0, 0)", [db.nextSeq(), LOCAL_USER])).toThrow(/CHECK/);
    const other = otherUserDb(db, "bob");
    expect(() => db.sql.run("INSERT INTO review_turns (user_id, id, review_id, seq, actor, thread_id, body_json, at_ms) VALUES (?, 't', ?, ?, 'learner', NULL, '{}', 0)", [other.userId, REVIEW, db.nextSeq()])).toThrow(/FOREIGN KEY/);
    db.close();
  });

  test("an empty database upgrades without a user row", () => {
    const dir = tmpDir("afterclass-review-empty-");
    const path = join(dir, "afterclass.sqlite");
    openDb(path, OLD).close();
    const db = openDb(path);
    expect(db.sql.query("SELECT id FROM users").all()).toEqual([]);
    db.close();
  });
});
