import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOCAL_USER, MIGRATIONS, ensureLocalUser, openDb, scopeDb } from "../src/backend/db";
import type { Db, UserDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import { serve } from "../src/backend/http";
import { createLedger } from "../src/backend/providers/ledger";
import type { Reviews } from "../src/backend/review";
import type { CaptureId, EvidenceId, UserId } from "../src/shared/ids";
import { stableId } from "../src/shared/ids";
import { DAY, JPEG, VIDEO, keyOf, stream } from "./evidence-fixtures";
import { CAP, EXT_ID, JSON_HEADERS, TOKEN, bearer, VIDEO as WIRE_VIDEO, fixtureApp, ingest, post, registerCleanup, wireFacts } from "./http-fixtures";
import { otherUserDb, testDb } from "./fakes";
import { tmpDir } from "./tmp";

registerCleanup();

const NOW = 1_000_000;

/** Two users in one database and one data directory, as the hosted app will have them. */
function twoUsers() {
  const dir = tmpDir("afterclass-tenancy-");
  const raw = testDb();
  const clock = { t: NOW };
  const user = (name: string) => {
    const db = otherUserDb(raw, name);
    const id = db.userId;
    const evidence = createEvidence(db, dir, {
      lookupFrameChange: (input) => ({ kind: "missing", key: keyOf(input) }),
      runFrameChange: async () => undefined,
      frameChangeKey: keyOf,
      onChange: () => {},
      now: () => clock.t,
    });
    return { id, db, evidence };
  };
  return { dir, raw, clock, alice: user("alice"), bob: user("bob") };
}

/** One lecture: a watched span [0, 10), a transcript segment inside it and a frame at 3 s. Same video and interval for every user. */
function lecture(captureId?: CaptureId, jpeg: string = JPEG) {
  const s = stream(captureId);
  s.control("start");
  s.source();
  s.transcript([[0, 4, "hello"]]);
  s.span(0, 10);
  s.frame("f1", 3, { jpeg });
  return s;
}

const frameIdOf = (captureId: CaptureId) => stableId("ev", captureId, "f1");

const rows = (db: Db, sql: string, ...params: string[]) => db.sql.query<{ n: number }, string[]>(sql).get(...params)!.n;
const countFor = (db: Db, table: string, userId: UserId) => rows(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId);

describe("two users in one database", () => {
  test("neither sees the other's captures, views, bundles, frames or evidence", () => {
    const { alice, bob } = twoUsers();
    const s = lecture();
    alice.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const material = alice.evidence.watchedMaterial(s.captureId);
    const mine = alice.evidence.bundle(material);
    expect(mine.passages.map((p) => p.text)).toEqual(["hello"]);
    expect(mine.frames).toHaveLength(1);

    expect(bob.evidence.captures()).toEqual([]);
    expect(bob.evidence.activeCaptures()).toEqual([]);
    expect(bob.evidence.captureView(s.captureId).watchedSeconds).toBe(0);
    expect(bob.evidence.watchOrder(s.captureId).passages).toEqual([]);
    expect(bob.evidence.bundle(material)).toMatchObject({ passages: [], frames: [] });
    expect(bob.evidence.frameBytes(frameIdOf(s.captureId))).toBeNull();
    expect(bob.evidence.get([frameIdOf(s.captureId), mine.passages[0]!.id]).size).toBe(0);
    expect(bob.evidence.captureBundle(s.captureId).frames).toEqual([]);
    expect(alice.evidence.captures()).toEqual([s.captureId]);
    expect(alice.evidence.activeCaptures()).toEqual([s.captureId]);
  });

  test("the same video and interval give the same passage id, and the two users' rows stay apart", () => {
    const { raw, alice, bob } = twoUsers();
    const a = lecture();
    const b = lecture();
    alice.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    bob.evidence.ingest({ captureId: b.captureId, facts: b.facts });
    const passageA = alice.evidence.bundle(alice.evidence.watchedMaterial(a.captureId)).passages[0]!;
    const passageB = bob.evidence.bundle(bob.evidence.watchedMaterial(b.captureId)).passages[0]!;
    expect(passageA.id).toBe(passageB.id);

    alice.evidence.snapshotInTx([passageA.id]);
    bob.evidence.snapshotInTx([passageB.id]);
    expect(countFor(raw, "evidence_snapshots", alice.id)).toBe(1);
    expect(countFor(raw, "evidence_snapshots", bob.id)).toBe(1);

    alice.evidence.deleteByUser([passageA.id], "req-a");
    expect(alice.evidence.get([passageA.id]).get(passageA.id)).toMatchObject({ kind: "deleted" });
    expect(bob.evidence.get([passageB.id]).get(passageB.id)).toMatchObject({ kind: "passage", text: "hello" });
    expect(bob.evidence.bundle(bob.evidence.watchedMaterial(b.captureId)).passages).toHaveLength(1);
    expect(alice.evidence.bundle(alice.evidence.watchedMaterial(a.captureId)).passages).toEqual([]);
    expect(countFor(raw, "evidence_deletions", alice.id)).toBe(1);
    expect(countFor(raw, "evidence_deletions", bob.id)).toBe(0);
    expect(countFor(raw, "evidence_snapshots", alice.id)).toBe(0);
    expect(countFor(raw, "evidence_snapshots", bob.id)).toBe(1);
  });

  test("a capture id another user holds is refused and nothing is stored or overwritten", () => {
    const { raw, alice, bob } = twoUsers();
    const s = lecture();
    alice.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const frame = frameIdOf(s.captureId);
    const original = alice.evidence.frameBytes(frame)!;
    const before = rows(raw, "SELECT COUNT(*) AS n FROM capture_facts");

    const other = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]).toString("base64");
    const forged = lecture(s.captureId, other);
    expect(() => bob.evidence.ingest({ captureId: s.captureId, facts: forged.facts })).toThrow(RangeError);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM capture_facts")).toBe(before);
    expect(alice.evidence.frameBytes(frame)).toEqual(original);
    expect(bob.evidence.captures()).toEqual([]);
    expect(bob.evidence.capturedByAnotherUser(s.captureId)).toBe(true);
    expect(alice.evidence.capturedByAnotherUser(s.captureId)).toBe(false);
    expect(alice.evidence.ingest({ captureId: s.captureId, facts: s.facts }).ackedThroughSeq).toBe(s.facts.length - 1);
  });

  test("another user's frame id reads nothing and deletes nothing", () => {
    const { raw, alice, bob } = twoUsers();
    const s = lecture();
    alice.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const frame = frameIdOf(s.captureId);
    expect(bob.evidence.heldByAnotherUser([frame])).toBe(true);
    alice.evidence.snapshotInTx([frame]);
    expect(bob.evidence.heldByAnotherUser([frame])).toBe(true);
    expect(alice.evidence.heldByAnotherUser([frame])).toBe(false);
    expect(bob.evidence.heldByAnotherUser([stableId("ev", "nobody")])).toBe(false);

    bob.evidence.deleteByUser([frame], "req-b");
    expect(alice.evidence.frameBytes(frame)).not.toBeNull();
    expect(bob.evidence.frameBytes(frame)).toBeNull();
    expect(rows(raw, "SELECT COUNT(*) AS n FROM evidence_deletions")).toBe(0);
    expect(countFor(raw, "frames", alice.id)).toBe(1);
    expect(countFor(raw, "evidence_snapshots", alice.id)).toBe(1);
  });

  test("a passage id both users hold is each one's own: neither counts as the other's", () => {
    const { alice, bob } = twoUsers();
    const a = lecture();
    const b = lecture();
    alice.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    bob.evidence.ingest({ captureId: b.captureId, facts: b.facts });
    const id = alice.evidence.bundle(alice.evidence.watchedMaterial(a.captureId)).passages[0]!.id;
    alice.evidence.snapshotInTx([id]);
    expect(bob.evidence.heldByAnotherUser([id])).toBe(false);
  });

  test("expiry for one user never deletes another's facts, frames, files or snapshots", () => {
    const { raw, dir, clock, alice, bob } = twoUsers();
    const a = lecture();
    const b = lecture();
    alice.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    bob.evidence.ingest({ captureId: b.captureId, facts: b.facts });
    const frameB = frameIdOf(b.captureId);
    const passage = alice.evidence.bundle(alice.evidence.watchedMaterial(a.captureId)).passages[0]!.id;
    alice.evidence.snapshotInTx([passage, frameIdOf(a.captureId)]);
    bob.evidence.snapshotInTx([passage, frameB]);
    const bobFile = raw.sql.query<{ path: string }, [string]>("SELECT path FROM frames WHERE user_id = ?").get(bob.id)!.path;
    const bobLink = raw.sql.query<{ frame_path: string }, [string]>("SELECT frame_path FROM evidence_snapshots WHERE user_id = ? AND kind = 'frame'").get(bob.id)!.frame_path;

    clock.t = NOW + 31 * DAY;
    const swept = alice.evidence.sweepExpired(clock.t, 30);
    expect(swept.factsDeleted).toBe(a.facts.length);
    expect(swept.snapshotsDeleted).toBe(2);
    expect(countFor(raw, "capture_facts", alice.id)).toBe(0);
    expect(countFor(raw, "frames", alice.id)).toBe(0);
    expect(countFor(raw, "capture_facts", bob.id)).toBe(b.facts.length);
    expect(countFor(raw, "frames", bob.id)).toBe(1);
    expect(countFor(raw, "evidence_snapshots", bob.id)).toBe(2);
    expect(existsSync(join(dir, bobFile))).toBe(true);
    expect(existsSync(join(dir, bobLink))).toBe(true);
    expect(bob.evidence.frameBytes(frameB)).not.toBeNull();
    expect(bob.evidence.captureView(b.captureId).watchedSeconds).toBe(10);

    expect(bob.evidence.sweepExpired(clock.t, 30).factsDeleted).toBe(b.facts.length);
    expect(existsSync(join(dir, bobFile))).toBe(false);
  });

  test("a capture id stays its first user's after expiry deletes the facts, so the cited snapshot file cannot be shared", () => {
    const { raw, clock, alice, bob } = twoUsers();
    const a = lecture();
    alice.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    const frame = frameIdOf(a.captureId);
    alice.evidence.snapshotInTx([frame]);
    raw.sql.run("INSERT INTO note_evidence (note_id, evidence_id) VALUES (?, ?)", [stableId("note", "cites"), frame]);
    const original = alice.evidence.frameBytes(frame)!;

    clock.t = NOW + 31 * DAY;
    expect(alice.evidence.sweepExpired(clock.t, 30).factsDeleted).toBe(a.facts.length);
    expect(countFor(raw, "capture_facts", alice.id)).toBe(0);
    expect(countFor(raw, "evidence_snapshots", alice.id)).toBe(1);

    expect(bob.evidence.capturedByAnotherUser(a.captureId)).toBe(true);
    const other = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]).toString("base64");
    const claim = lecture(a.captureId, other);
    expect(() => bob.evidence.ingest({ captureId: a.captureId, facts: claim.facts })).toThrow(RangeError);
    bob.evidence.deleteByUser([frame], "req-b");
    expect(alice.evidence.frameBytes(frame)).toEqual(original);
    expect(alice.evidence.ingest({ captureId: a.captureId, facts: a.facts }).ackedThroughSeq).toBe(a.facts.length - 1);
  });

  test('R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry." One user\'s unsaved review holds only that user\'s raw evidence', () => {
    const { raw, clock, alice, bob } = twoUsers();
    const a = lecture();
    const b = lecture();
    alice.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    bob.evidence.ingest({ captureId: b.captureId, facts: b.facts });
    raw.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, ?, 'prepared_only', '{}', ?, 0)", [
      stableId("rvw", "pending"), alice.id, a.captureId, raw.nextSeq(),
    ]);

    clock.t = NOW + 31 * DAY;
    expect(alice.evidence.sweepExpired(clock.t, 30).factsDeleted).toBe(0);
    expect(bob.evidence.sweepExpired(clock.t, 30).factsDeleted).toBe(b.facts.length);
    expect(countFor(raw, "capture_facts", alice.id)).toBe(a.facts.length);
    expect(countFor(raw, "frames", alice.id)).toBe(1);
  });

  test("R16: a tombstone releases only the snapshot of the user who made it", () => {
    const { raw, alice, bob } = twoUsers();
    const a = lecture();
    const b = lecture();
    alice.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    bob.evidence.ingest({ captureId: b.captureId, facts: b.facts });
    const id = alice.evidence.bundle(alice.evidence.watchedMaterial(a.captureId)).passages[0]!.id;
    alice.evidence.snapshotInTx([id]);
    bob.evidence.snapshotInTx([id]);
    raw.sql.run("INSERT INTO note_evidence (note_id, evidence_id) VALUES (?, ?)", [stableId("note", "n"), id]);
    raw.sql.run("INSERT INTO evidence_deletions (user_id, evidence_id, request_id, deleted_ms, seq) VALUES (?, ?, 'req', 0, ?)", [alice.id, id, raw.nextSeq()]);

    expect(() => raw.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [bob.id])).toThrow(/R16/);
    raw.sql.run("DELETE FROM evidence_snapshots WHERE user_id = ?", [alice.id]);
    expect(countFor(raw, "evidence_snapshots", alice.id)).toBe(0);
    expect(countFor(raw, "evidence_snapshots", bob.id)).toBe(1);
  });

  test("a surviving snapshot with no owner row is never shared or unlinked by another user", () => {
    const { raw, dir, alice, bob } = twoUsers();
    const a = lecture();
    const frame = frameIdOf(a.captureId);
    // What an upgraded database can hold: Alice's cited snapshot at the old shared-layout path, her raw capture and any owner row gone.
    const old = join("snapshots", `${frame}.jpg`);
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, old), Buffer.from(JPEG, "base64"));
    raw.sql.run("INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, frame_path, created_ms, width, height) VALUES (?, ?, 'frame', 'src_x', 3, 3, ?, 0, 640, 360)", [
      alice.id, frame, old,
    ]);
    raw.sql.run("INSERT INTO note_evidence (note_id, evidence_id) VALUES (?, ?)", [stableId("note", "cites"), frame]);
    const original = alice.evidence.frameBytes(frame)!;

    const b = lecture(a.captureId);
    bob.evidence.ingest({ captureId: a.captureId, facts: b.facts });
    bob.evidence.snapshotInTx([frame]);
    const bobPath = raw.sql.query<{ frame_path: string }, [string]>("SELECT frame_path FROM evidence_snapshots WHERE user_id = ?").get(bob.id)!.frame_path;
    expect(bobPath).not.toBe(old);
    bob.evidence.deleteByUser([frame], "req-b");
    expect(existsSync(join(dir, old))).toBe(true);
    expect(alice.evidence.frameBytes(frame)).toEqual(original);
  });

  test("a failed ingest rolls back its ownership claim, and the files it wrote are swept as orphans", () => {
    const { raw, dir, alice, bob } = twoUsers();
    const s = lecture();
    raw.sql.run("CREATE TRIGGER boom BEFORE INSERT ON capture_facts BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => alice.evidence.ingest({ captureId: s.captureId, facts: s.facts })).toThrow(/boom/);
    raw.sql.run("DROP TRIGGER boom");
    expect(rows(raw, "SELECT COUNT(*) AS n FROM capture_owners")).toBe(0);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM capture_facts")).toBe(0);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM frames")).toBe(0);
    const jpgs = () => (readdirSync(join(dir, "frames"), { recursive: true }) as string[]).filter((f) => f.endsWith(".jpg"));
    expect(jpgs()).toHaveLength(1);

    expect(bob.evidence.ingest({ captureId: s.captureId, facts: s.facts }).ackedThroughSeq).toBe(s.facts.length - 1);
    expect(alice.evidence.sweepExpired(NOW, 30).framesDeleted).toBe(1);
    expect(jpgs()).toHaveLength(1);
    expect(bob.evidence.frameBytes(frameIdOf(s.captureId))).not.toBeNull();
  });

  test("the same capture id and client sequence may exist for two users at the table level", () => {
    const { raw, alice, bob } = twoUsers();
    const insert = (user: UserId) =>
      raw.sql.run("INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, 'cap_x', 0, 0, 'span', '{}', 0)", [
        user, raw.nextSeq(),
      ]);
    insert(alice.id);
    insert(bob.id);
    expect(() => insert(alice.id)).toThrow(/UNIQUE/);
  });
});

describe("the evidence routes with a second user", () => {
  const servers: { stop(force?: boolean): void | Promise<void> }[] = [];
  afterAll(async () => {
    for (const s of servers.splice(0)) await s.stop(true);
  });

  const FRAME_FACT = { kind: "frame", videoId: WIRE_VIDEO, frameId: "f1", mediaS: 3, width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: JPEG };

  function rig() {
    const { raw, alice, bob } = twoUsers();
    const reviews = { invite: () => ({ state: "none" }), answerInvite: () => ({ state: "later" }) } as unknown as Reviews;
    const appDir = fixtureApp();
    const serveFor = (u: { db: UserDb; evidence: ReturnType<typeof twoUsers>["alice"]["evidence"] }) => {
      const server = serve({ modules: { ledger: createLedger(u.db), evidence: u.evidence, reviews }, auth: { port: 0, extensionId: EXT_ID, token: TOKEN }, appDir });
      servers.push(server);
      return `http://127.0.0.1:${server.port}`;
    };
    return { raw, alice, bob, a: serveFor(alice), b: serveFor(bob) };
  }

  const get = (base: string, path: string) => fetch(`${base}${path}`, { headers: bearer });
  const frame = frameIdOf(CAP);

  async function aliceCaptured() {
    const r = rig();
    const facts = [...wireFacts(0, 3), { ...FRAME_FACT, clientSeq: 3, wallMs: 1200 }];
    expect((await ingest(r.a, facts)).status).toBe(200);
    return r;
  }

  test("GET /captures/:captureId answers 404 for another user's capture and still 200 for the owner", async () => {
    const r = await aliceCaptured();
    expect((await get(r.b, `/captures/${CAP}`)).status).toBe(404);
    expect((await get(r.a, `/captures/${CAP}`)).status).toBe(200);
  });

  test("POST /captures/:captureId/invite answers 404 for another user's capture", async () => {
    const r = await aliceCaptured();
    expect((await post(r.b, `/captures/${CAP}/invite`, { answer: "later" })).status).toBe(404);
    expect((await post(r.a, `/captures/${CAP}/invite`, { answer: "later" })).status).toBe(200);
  });

  test("POST /ingest for another user's capture answers 404 and stores nothing", async () => {
    const r = await aliceCaptured();
    const before = rows(r.raw, "SELECT COUNT(*) AS n FROM capture_facts");
    expect((await ingest(r.b, wireFacts(0, 3))).status).toBe(404);
    expect(rows(r.raw, "SELECT COUNT(*) AS n FROM capture_facts")).toBe(before);
    expect((await ingest(r.a, wireFacts(0, 3))).status).toBe(200);
  });

  test("GET /evidence?captureId= answers 404 for another user's capture; ids and material of another user's evidence come back empty", async () => {
    const r = await aliceCaptured();
    expect((await get(r.b, `/evidence?captureId=${CAP}`)).status).toBe(404);
    const mine = (await (await get(r.a, `/evidence?captureId=${CAP}`)).json()) as { frames: { id: string }[] };
    expect(mine.frames.map((f) => f.id)).toEqual([frame]);
    const theirs = (await (await get(r.b, `/evidence?ids=${frame}`)).json()) as { frames: unknown[]; passages: unknown[] };
    expect(theirs).toMatchObject({ frames: [], passages: [] });
  });

  test("GET /frames/:evidenceId answers 404 for another user's frame and the bytes for the owner", async () => {
    const r = await aliceCaptured();
    expect((await get(r.b, `/frames/${frame}`)).status).toBe(404);
    const ok = await get(r.a, `/frames/${frame}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/jpeg");
  });

  test("POST /record/evidence/delete answers 404 for another user's frame and changes nothing; the owner's delete answers 204", async () => {
    const r = await aliceCaptured();
    r.alice.evidence.snapshotInTx([frame]);
    const denied = await post(r.b, "/record/evidence/delete", { evidenceIds: [frame] }, JSON_HEADERS);
    expect(denied.status).toBe(404);
    expect(rows(r.raw, "SELECT COUNT(*) AS n FROM evidence_deletions")).toBe(0);
    expect(countFor(r.raw, "frames", r.alice.id)).toBe(1);
    expect(countFor(r.raw, "evidence_snapshots", r.alice.id)).toBe(1);
    expect((await get(r.a, `/frames/${frame}`)).status).toBe(200);

    expect((await post(r.a, "/record/evidence/delete", { evidenceIds: [frame] }, JSON_HEADERS)).status).toBe(204);
    expect((await get(r.a, `/frames/${frame}`)).status).toBe(404);
  });
});

describe("a database from before evidence got user_id", () => {
  const OLD = { ...MIGRATIONS, evidence: MIGRATIONS.evidence.filter((m) => m.id !== "003-user-id" && m.id !== "004-capture-owners"), review: MIGRATIONS.review.filter((m) => m.id !== "002-user-id") };
  const CAPTURE = stableId("cap", "old");
  const FRAME = stableId("ev", CAPTURE, "f1");
  const CITED = stableId("ev", "cited");
  const GONE = stableId("ev", "gone");

  /** A database file made with the old schema: facts, a frame, two snapshots (one cited, one tombstoned), a pending review. */
  function oldDatabase() {
    const dir = tmpDir("afterclass-tenancy-upgrade-");
    const path = join(dir, "afterclass.sqlite");
    const framePath = join("frames", "src_old", `${FRAME}.jpg`);
    mkdirSync(dirname(join(dir, framePath)), { recursive: true });
    writeFileSync(join(dir, framePath), Buffer.from(JPEG, "base64"));
    const old = openDb(path, OLD);
    const facts = [
      { kind: "control", body: { kind: "control", action: "start", reason: "user" }, at: 500 },
      { kind: "span", body: { kind: "span", videoId: VIDEO, start: 0, end: 5, rate: 1, tabVisible: true, wallDurationMs: 5000 }, at: 700 },
    ];
    facts.forEach((f, i) =>
      old.sql.run("INSERT INTO capture_facts (seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        old.nextSeq(), CAPTURE, i, 1000 + i, f.kind, JSON.stringify(f.body), f.at,
      ]),
    );
    old.sql.run("INSERT INTO frames (evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq) VALUES (?, ?, 'src_old', 'f1', 3, 640, 360, ?, ?)", [
      FRAME, CAPTURE, framePath, old.nextSeq(),
    ]);
    for (const id of [CITED, GONE]) {
      old.sql.run("INSERT INTO evidence_snapshots (evidence_id, kind, source_id, start_s, end_s, text, created_ms, transcript_rev_id, origin) VALUES (?, 'passage', 'src_old', 1, 2, 'text', 900, 'trv_x', 'panel')", [id]);
      old.sql.run("INSERT INTO note_evidence (note_id, evidence_id) VALUES (?, ?)", [stableId("note", "n"), id]);
    }
    old.sql.run("INSERT INTO evidence_deletions (evidence_id, request_id, deleted_ms, seq) VALUES (?, 'req', 800, ?)", [GONE, old.nextSeq()]);
    old.sql.run("INSERT INTO reviews (id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, 'prepared_only', '{}', ?, 0)", [
      stableId("rvw", "old"), CAPTURE, old.nextSeq(),
    ]);
    const lastSeq = old.nextSeq();
    old.close();
    return { dir, path, lastSeq };
  }

  const upgraded = () => {
    const o = oldDatabase();
    return { ...o, db: openDb(o.path) };
  };

  test("every row is kept and becomes the local user's, and the local user's row exists", () => {
    const { db, lastSeq } = upgraded();
    expect(db.sql.query("SELECT id, created_ms FROM users").all()).toEqual([{ id: LOCAL_USER, created_ms: 500 }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM capture_facts WHERE user_id = ?", LOCAL_USER)).toBe(2);
    expect(rows(db, "SELECT COUNT(*) AS n FROM frames WHERE user_id = ?", LOCAL_USER)).toBe(1);
    expect(rows(db, "SELECT COUNT(*) AS n FROM evidence_snapshots WHERE user_id = ?", LOCAL_USER)).toBe(2);
    expect(rows(db, "SELECT COUNT(*) AS n FROM evidence_deletions WHERE user_id = ?", LOCAL_USER)).toBe(1);
    expect(db.sql.query("SELECT seq, capture_id, client_seq, kind, received_ms FROM capture_facts ORDER BY seq").all()).toEqual([
      { seq: 1, capture_id: CAPTURE, client_seq: 0, kind: "control", received_ms: 500 },
      { seq: 2, capture_id: CAPTURE, client_seq: 1, kind: "span", received_ms: 700 },
    ]);
    expect(db.sql.query("SELECT evidence_id, request_id, deleted_ms, seq FROM evidence_deletions").all()).toEqual([{ evidence_id: GONE, request_id: "req", deleted_ms: 800, seq: 4 }]);
    expect(db.sql.query("SELECT capture_id, user_id, claimed_ms FROM capture_owners").all()).toEqual([{ capture_id: CAPTURE, user_id: LOCAL_USER, claimed_ms: 500 }]);
    expect(db.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(ensureLocalUser(db)).toBe(LOCAL_USER);
    expect(db.nextSeq()).toBe((lastSeq + 1) as typeof lastSeq);
    db.close();
  });

  test("the evidence store reads the old rows as the local user's, frame file included, and keeps the tombstone", () => {
    const { db, dir } = upgraded();
    const store = createEvidence(scopeDb(db, LOCAL_USER), dir, {
      lookupFrameChange: (input) => ({ kind: "missing", key: keyOf(input) }),
      runFrameChange: async () => undefined,
      frameChangeKey: keyOf,
      onChange: () => {},
    });
    expect(store.captures()).toEqual([CAPTURE]);
    expect(store.captureView(CAPTURE).watchedSeconds).toBe(5);
    expect(store.frameBytes(FRAME as EvidenceId)).toEqual(new Uint8Array(Buffer.from(JPEG, "base64")));
    expect(store.get([CITED, GONE]).get(GONE)).toMatchObject({ kind: "deleted", deletedAtMs: 800 });
    expect(store.get([CITED]).get(CITED)).toMatchObject({ kind: "passage", text: "text" });
    db.close();
  });

  test("the append-only and R16 triggers still fire", () => {
    const { db } = upgraded();
    expect(() => db.sql.run("UPDATE capture_facts SET wall_ms = 0")).toThrow(/capture_facts is append-only/);
    expect(() => db.sql.run("UPDATE frames SET media_s = 0")).toThrow(/frames is append-only/);
    expect(() => db.sql.run("UPDATE evidence_snapshots SET text = 'other'")).toThrow(/R16: evidence_snapshots is append-only/);
    expect(() => db.sql.run("DELETE FROM capture_facts")).toThrow(/R16: raw evidence of an unsaved review is held/);
    expect(() => db.sql.run("DELETE FROM frames")).toThrow(/R16: frames of an unsaved review are held/);
    expect(() => db.sql.run("DELETE FROM evidence_snapshots WHERE evidence_id = ?", [CITED])).toThrow(/R16: evidence cited by a note is deleted only by the user/);
    db.sql.run("DELETE FROM evidence_snapshots WHERE evidence_id = ?", [GONE]);
    db.sql.run("INSERT INTO saved_reviews (review_id, bundle_hash, saved_ms) VALUES (?, 'h', 0)", [stableId("rvw", "old")]);
    db.sql.run("DELETE FROM frames");
    db.sql.run("DELETE FROM capture_facts");
    expect(rows(db, "SELECT COUNT(*) AS n FROM capture_facts")).toBe(0);
    db.close();
  });

  test("the constraints still hold: user_id is required and must exist, and the keys are per user", () => {
    const { db } = upgraded();
    const fact = (user: string | null, capture: string, extra = "'span'") =>
      db.sql.run(`INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, ?, 0, 0, ${extra}, '{}', 0)`, [user, db.nextSeq(), capture]);
    expect(() => fact(null, "cap_n")).toThrow(/NOT NULL/);
    expect(() => fact(stableId("usr", "nobody"), "cap_n")).toThrow(/FOREIGN KEY/);
    expect(() => fact(LOCAL_USER, "cap_n", "'bogus'")).toThrow(/CHECK/);
    expect(() => fact(LOCAL_USER, CAPTURE)).toThrow(/UNIQUE/);
    db.sql.run("INSERT INTO users (id, created_ms) VALUES (?, 0)", [stableId("usr", "second")]);
    fact(stableId("usr", "second"), CAPTURE);
    const frame = (width: number) =>
      db.sql.run("INSERT INTO frames (user_id, evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq) VALUES (?, 'ev_z', 'cap_z', 's', 'z', 1, ?, 360, 'p', ?)", [
        LOCAL_USER, width, db.nextSeq(),
      ]);
    expect(() => frame(100)).toThrow(/CHECK/);
    expect(() =>
      db.sql.run("INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, created_ms) VALUES (?, 'ev_z', 'passage', 's', 1, 2, 0)", [LOCAL_USER]),
    ).toThrow(/CHECK/);
    db.close();
  });

  test("an empty database upgrades without a user row", () => {
    const dir = tmpDir("afterclass-tenancy-empty-");
    const path = join(dir, "afterclass.sqlite");
    openDb(path, OLD).close();
    const db = openDb(path);
    expect(db.sql.query("SELECT id FROM users").all()).toEqual([]);
    db.close();
  });
});
