/**
 * Segmentation and tenancy: every chunk revision names its user, two users in one database never see or change each
 * other's chunks even when they hold one capture id and so derive identical chunk and revision ids, and the
 * 002-user-id rebuild keeps the append-only trigger and every constraint. No call leaves the process.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundaryJudgment, CaptureStatus, Passage, Seq } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { CaptureId, WindowId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { LOCAL_USER, MIGRATIONS, asSeq, ensureLocalUser, openDb, scopeDb } from "../src/backend/db";
import type { UserDb } from "../src/backend/db";
import type { WatchOrder } from "../src/backend/evidence";
import { serve } from "../src/backend/http";
import { createLedger } from "../src/backend/providers/ledger";
import type { Lookup } from "../src/backend/providers/memo";
import type { Preparation } from "../src/backend/preparation";
import { SEGMENTATION_DEFAULTS, buildWindows, createSegmentation } from "../src/backend/segmentation";
import type { SegmentationConfig } from "../src/backend/segmentation";
import { otherUserDb, testUserDb } from "./fakes";

const CFG: SegmentationConfig = { ...SEGMENTATION_DEFAULTS, windowNewS: 30, contextS: 60, timeCapS: 150, reviseOnNextNoNo: true };
const SRC = stableId("src", "youtube", "shared-lecture");
const CAP = stableId("cap", "shared") as CaptureId;
const count = (db: UserDb, sql: string) => db.sql.query<{ n: number }, []>(sql).get()!.n;

function passages(seconds: number): Passage[] {
  return Array.from({ length: seconds / 10 }, (_, k) => ({
    kind: "passage", id: stableId("ev", SRC, k * 10, k * 10 + 10), sourceId: SRC, transcriptRevId: stableId("trv", SRC),
    interval: interval(k * 10, k * 10 + 10), text: `caption ${k}`, origin: "panel",
  }) as unknown as Passage);
}

function order(all: readonly Passage[]): WatchOrder {
  const status: CaptureStatus = { state: "capturing" };
  return {
    passages: all.map((passage, k) => ({ passage, firstWatchedAtSeq: asSeq(k + 1), sourceIndex: 0 })),
    frameCandidates: [], status, stoppedAtSeq: null, watchedSeconds: all.length * 10,
  };
}

/** One user's segmentation over the same scripted lecture every user watches; `judge` sets a window's verdict. */
function segmentationOf(db: UserDb, seconds: number) {
  const all = passages(seconds);
  const ids = buildWindows(CAP, order(all), CFG).map((w) => w.id);
  const lookups = new Map<WindowId, Lookup<BoundaryJudgment>>();
  const seg = createSegmentation(db, {
    watchOrder: () => order(all),
    lookupBoundary: (input) => lookups.get(input.window.id) ?? { kind: "missing", key: "key_x" as never },
    boundaryInput: (window) => ({ window, newPassages: [], contextPassages: [], frames: [] }),
    nextSeq: () => db.nextSeq(),
  }, CFG, undefined);
  const judge = (k: number, newConcept: "yes" | "no", stoppingPoint: "yes" | "no") =>
    lookups.set(ids[k]!, {
      kind: "hit", key: "key_x" as never, atSeq: 1 as Seq,
      value: { windowId: ids[k]!, newConcept, stoppingPoint, pNewConcept: null, pStoppingPoint: null, questionVersion: "v1" },
    });
  return { seg, judge };
}

/** Windows 0 and 1 continue, window 2 opens a new topic: chunk 0 closes over windows 0 and 1. */
function closeFirstChunk(s: ReturnType<typeof segmentationOf>) {
  s.judge(0, "no", "no");
  s.judge(1, "no", "no");
  s.judge(2, "yes", "yes");
  return s.seg.sync(CAP);
}

describe("two users share one database and one capture id", () => {
  test("each makes the same chunk and revision ids, stores its own rows, and reads only them", () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const segA = segmentationOf(a, 90);
    const segB = segmentationOf(b, 90);
    const closedA = closeFirstChunk(segA).closed;
    expect(segA.seg.current(CAP)).toHaveLength(1);
    expect(segB.seg.current(CAP)).toEqual([]);

    const closedB = closeFirstChunk(segB).closed;
    expect(closedB).toHaveLength(1);
    expect(closedB[0]!.id).toBe(closedA[0]!.id);
    expect(closedB[0]!.chunkId).toBe(closedA[0]!.chunkId);
    expect(count(a, `SELECT COUNT(*) AS n FROM chunk_revisions WHERE user_id = '${a.userId}'`)).toBe(1);
    expect(count(a, `SELECT COUNT(*) AS n FROM chunk_revisions WHERE user_id = '${b.userId}'`)).toBe(1);
    expect(segB.seg.revision(closedA[0]!.id)?.id).toBe(closedB[0]!.id);
    expect(segB.seg.history(closedA[0]!.chunkId)).toHaveLength(1);
    expect(segA.seg.sync(CAP).closed).toEqual([]);
  });

  test("one user's revision of a chunk does not append to, supersede or change the other's history", () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const segA = segmentationOf(a, 120);
    const segB = segmentationOf(b, 120);
    const first = closeFirstChunk(segA).closed[0]!;
    closeFirstChunk(segB);

    segA.judge(3, "no", "no");
    const second = segA.seg.sync(CAP).closed[0]!;
    expect(second).toMatchObject({ revisionNo: 2, supersedes: first.id });
    expect(segA.seg.history(first.chunkId).map((r) => r.revisionNo)).toEqual([1, 2]);
    expect(segB.seg.history(first.chunkId).map((r) => r.revisionNo)).toEqual([1]);
    expect(segB.seg.revision(second.id)).toBeNull();
    expect(Material.equals(segB.seg.current(CAP)[0]!.material, first.material)).toBe(true);
  });

  test("a revision cannot supersede a revision of another user", () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const first = closeFirstChunk(segmentationOf(a, 90)).closed[0]!;
    const insert = (userId: string, id: string, revisionNo: number, supersedes: string | null) =>
      a.sql.query(
        `INSERT INTO chunk_revisions (user_id, id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq, supersedes)
         VALUES (?, ?, ?, ?, 0, ?, '[]', '[]', 'boundary_revised', ?, ?)`,
      ).run(userId, id, first.chunkId, CAP, revisionNo, a.nextSeq(), supersedes);
    expect(() => insert(b.userId, "crv_b2", 2, first.id)).toThrow(/FOREIGN KEY/);
    insert(a.userId, "crv_a2", 2, first.id);
  });

  test("heldByAnotherUser is true only for a capture the other user holds and the caller does not", () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const segA = segmentationOf(a, 90);
    const segB = segmentationOf(b, 90);
    expect(segB.seg.heldByAnotherUser(CAP)).toBe(false);
    closeFirstChunk(segA);
    expect(segA.seg.heldByAnotherUser(CAP)).toBe(false);
    expect(segB.seg.heldByAnotherUser(CAP)).toBe(true);
    closeFirstChunk(segB);
    expect(segB.seg.heldByAnotherUser(CAP)).toBe(false);
    expect(segB.seg.heldByAnotherUser(stableId("cap", "nobody") as CaptureId)).toBe(false);
  });

  test("POST /captures/:id/retry-preparation answers 404 for a capture only another user holds, and 204 for one nobody holds", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    closeFirstChunk(segmentationOf(a, 90));
    const token = "tok-seg-tenancy-1";
    const retries: string[] = [];
    const preparation = { prep: () => ({ finished: false, supportedCount: 0 }), retry: (id: string) => void retries.push(id) } as unknown as Preparation;
    const server = serve({
      modules: { ledger: createLedger(b), evidence: {} as never, reviews: {} as never, preparation, segmentation: segmentationOf(b, 90).seg },
      auth: { port: 0, extensionId: "abcdefghijklmnopabcdefghijklmnop", token },
      appDir: tmpdir(),
    });
    try {
      const retry = (capture: string) =>
        fetch(`http://127.0.0.1:${server.port}/captures/${capture}/retry-preparation`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
        });
      expect((await retry(CAP)).status).toBe(404);
      expect((await retry(stableId("cap", "nobody"))).status).toBe(204);
      expect(retries).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });
});

describe("migration segmentation/002-user-id", () => {
  const withFile = <T>(fn: (path: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "afterclass-seg-tenancy-"));
    try {
      return fn(join(dir, "afterclass.sqlite"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const before = { ...MIGRATIONS, segmentation: MIGRATIONS.segmentation.filter((m) => m.id !== "002-user-id") };

  function seedOld(path: string) {
    const db = openDb(path, before);
    db.sql.run(`INSERT INTO chunk_revisions VALUES
      ('crv_1','chk_1','cap_1',0,1,'[["src",[[0,30]]]]','["win_1"]','boundary',1,NULL),
      ('crv_2','chk_1','cap_1',0,2,'[["src",[[0,60]]]]','["win_1","win_2"]','boundary_revised',2,'crv_1'),
      ('crv_3','chk_2','cap_1',1,1,'[]','[]','session_end',3,NULL)`);
    db.close();
  }

  test("every old row moves to the local user with its values, and the local user exists", () => {
    withFile((path) => {
      seedOld(path);
      const db = openDb(path);
      expect(db.sql.query("SELECT id FROM users").all()).toEqual([{ id: LOCAL_USER }]);
      expect(db.sql.query("SELECT user_id, id, chunk_id, ordinal, revision_no, closed_at_seq, supersedes FROM chunk_revisions ORDER BY id").all()).toEqual([
        { user_id: LOCAL_USER, id: "crv_1", chunk_id: "chk_1", ordinal: 0, revision_no: 1, closed_at_seq: 1, supersedes: null },
        { user_id: LOCAL_USER, id: "crv_2", chunk_id: "chk_1", ordinal: 0, revision_no: 2, closed_at_seq: 2, supersedes: "crv_1" },
        { user_id: LOCAL_USER, id: "crv_3", chunk_id: "chk_2", ordinal: 1, revision_no: 1, closed_at_seq: 3, supersedes: null },
      ]);
      expect(db.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.sql.query("SELECT name FROM sqlite_master WHERE name LIKE '%\\_save' ESCAPE '\\'").all()).toEqual([]);
      db.close();
    });
  });

  test("an upgraded database reads through segmentation as the local user", () => {
    withFile((path) => {
      seedOld(path);
      const raw = openDb(path);
      const db = scopeDb(raw, ensureLocalUser(raw));
      const seg = createSegmentation(db, { watchOrder: () => order([]), lookupBoundary: () => ({ kind: "missing", key: "k" as never }), boundaryInput: (window) => ({ window, newPassages: [], contextPassages: [], frames: [] }), nextSeq: () => db.nextSeq() }, CFG, undefined);
      expect(seg.current("cap_1" as CaptureId).map((r) => [r.id as string, r.revisionNo])).toEqual([["crv_2", 2], ["crv_3", 1]]);
      expect(seg.history("chk_1" as never).map((r) => r.id as string)).toEqual(["crv_1", "crv_2"]);
      expect(seg.revision("crv_1" as never)?.supersedes).toBeNull();
      db.close();
    });
  });

  test("a database with no rows gets no user from the migration", () => {
    withFile((path) => {
      const db = openDb(path);
      expect(db.sql.query("SELECT id FROM users").all()).toEqual([]);
      db.close();
    });
  });

  test("the append-only trigger and every constraint still hold after the rebuild", () => {
    withFile((path) => {
      seedOld(path);
      const db = openDb(path);
      expect(() => db.sql.run("UPDATE chunk_revisions SET provenance = 'time'")).toThrow(/chunk_revisions is append-only/);
      const insert = (over: Partial<Record<string, string | number | null>>) => {
        const row = { user_id: LOCAL_USER, id: "crv_x", chunk_id: "chk_9", ordinal: 0, revision_no: 1, provenance: "boundary", closed_at_seq: 9, supersedes: null, ...over };
        db.sql.query(
          `INSERT INTO chunk_revisions (user_id, id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq, supersedes)
           VALUES (?, ?, ?, 'cap_1', ?, ?, '[]', '[]', ?, ?, ?)`,
        ).run(row.user_id as string, row.id as string, row.chunk_id as string, row.ordinal as number, row.revision_no as number, row.provenance as string, row.closed_at_seq as number, row.supersedes as string | null);
      };
      expect(() => insert({ id: "crv_1", closed_at_seq: 10 })).toThrow(/UNIQUE/);
      expect(() => insert({ chunk_id: "chk_1", revision_no: 1, closed_at_seq: 11 })).toThrow(/UNIQUE/);
      expect(() => insert({ closed_at_seq: 1 })).toThrow(/UNIQUE/);
      expect(() => insert({ ordinal: -1 })).toThrow(/CHECK/);
      expect(() => insert({ revision_no: 0 })).toThrow(/CHECK/);
      expect(() => insert({ provenance: "made_up" })).toThrow(/CHECK/);
      expect(() => insert({ revision_no: 1, supersedes: "crv_1" })).toThrow(/CHECK/);
      expect(() => insert({ revision_no: 2, supersedes: null })).toThrow(/CHECK/);
      expect(() => insert({ revision_no: 2, supersedes: "crv_missing" })).toThrow(/FOREIGN KEY/);
      expect(() => insert({ user_id: "usr_missing" })).toThrow(/FOREIGN KEY/);
      db.sql.run("INSERT INTO chunk_revisions (id, user_id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq) VALUES ('z', '" + LOCAL_USER + "', 'c', 'cap', 0, 1, '[]', '[]', 'boundary', 99)");
      expect(() => db.sql.run("INSERT INTO chunk_revisions (id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq) VALUES ('y', 'c', 'cap', 0, 1, '[]', '[]', 'boundary', 98)")).toThrow(/NOT NULL/);
      db.close();
    });
  });
});
