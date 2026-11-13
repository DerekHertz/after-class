/**
 * Preparation and tenancy: claim_index, concept_index, prep_controls and prep_inputs name their user, two users in one
 * database who watch the same lecture (so derive the same claim, concept and revision ids and the same memo keys) never
 * see or change each other's claims, concepts, controls or frozen inputs, and the 003-user-id rebuild keeps the
 * append-only triggers and every constraint. No call leaves the process: every task is a fake.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableId } from "../src/shared/ids";
import type { CaptureId, ChunkRevisionId, ConceptId, IdPart, MemoKey } from "../src/shared/ids";
import type { ChunkRevision, ClaimDraft, Frame, Passage, Provider, Purpose, ResourceConnection } from "../src/shared/domain";
import { Material, interval } from "../src/shared/time";
import { LOCAL_USER, MIGRATIONS, ensureLocalUser, openDb, scopeDb } from "../src/backend/db";
import type { UserDb } from "../src/backend/db";
import { createMemo } from "../src/backend/providers/memo";
import type { ClaimSupportInput } from "../src/backend/providers/jev-tasks";
import type { WorkItem } from "../src/backend/scheduler";
import { createPreparation } from "../src/backend/preparation";
import type { Check } from "../src/backend/preparation/core";
import { canonicalInterpretation, canonicalResourceSearch, canonicalRevision } from "../src/backend/preparation/tasks";
import type { InterpretationOutput, ResourceSearchInput, RevisionInput } from "../src/backend/preparation/tasks";
import { deferred, fakeTask, ok, otherUserDb, testUserDb } from "./fakes";
import type { FakeStep, FakeTask } from "./fakes";

const SRC = stableId("src", "youtube", "shared-lecture");
const TRV = stableId("trv", SRC, "panel", "en", "fixture");
const CAP = stableId("cap", "shared") as CaptureId;

const P = Array.from({ length: 6 }, (_, k) => ({
  kind: "passage", id: stableId("ev", TRV, k * 10, k * 10 + 10), sourceId: SRC, transcriptRevId: TRV,
  interval: interval(k * 10, k * 10 + 10), text: `passage ${k}`, origin: "panel",
}) as Passage);
const span = (start: number, end: number) => Material.of([[SRC, [interval(start, end)]]]);
const draft = (text: string, ...evidence: Passage[]): ClaimDraft => ({ text, evidence: evidence.map((e) => e.id) as unknown as ClaimDraft["evidence"], visualDependent: false, assumptions: [] });

type Concept = { readonly label: string; readonly claims: readonly ClaimDraft[]; readonly confusions?: InterpretationOutput["concepts"][number]["confusions"] };
const output = (concepts: readonly Concept[], links: InterpretationOutput["links"] = []): InterpretationOutput => ({
  concepts: concepts.map((c) => ({ label: c.label, summary: `${c.label} summary`, claims: c.claims, confusions: c.confusions ?? [] })),
  links,
  supersedes: [],
});

type Answer<O> = () => FakeStep<O> | Promise<FakeStep<O>>;
function scripted<I, O>(purpose: Purpose, provider: Provider, canonical: (i: I) => IdPart, answer: (i: I) => FakeStep<O> | Promise<FakeStep<O>>): FakeTask<I, O> {
  const t = fakeTask<IdPart, O>({ purpose, provider, maxAttempts: 1, answer: (i) => answer(i as unknown as I) });
  return Object.assign(t, { canonicalInput: canonical }) as unknown as FakeTask<I, O>;
}
const checkCanonical = (i: ClaimSupportInput): IdPart => ({
  claim: { text: i.claim.text, evidence: [...i.claim.evidence], visualDependent: i.claim.visualDependent, assumptions: [...i.claim.assumptions] },
  passages: i.passages.map((p) => p.id),
  frames: i.frames.map((f) => f.frame.id),
});

/** One user's preparation over the lecture every user watches. `interpret` and `search` are that user's scripted answers. */
function preparationOf(db: UserDb, script: { interpret: Answer<InterpretationOutput>; search?: (i: ResourceSearchInput) => FakeStep<readonly ResourceConnection[]> }) {
  const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
  const revisions = new Map<ChunkRevisionId, ChunkRevision>();
  const latest = new Map<number, ChunkRevision>();
  const tasks = {
    interpret: scripted("interpretation", "claude", canonicalInterpretation, () => script.interpret()),
    revise: scripted<RevisionInput, ClaimDraft>("claim_revision", "claude", canonicalRevision, (i) => ok(i.original)),
    checkClaim: scripted<ClaimSupportInput, Check>("claim_check", "jev", checkCanonical, () => ok({ verdict: "yes", p: 0.9 })),
    searchResources: scripted<ResourceSearchInput, readonly ResourceConnection[]>("resource_search", "claude", canonicalResourceSearch, (i) => script.search?.(i) ?? ok([])),
  };
  const prep = createPreparation(db, {
    chunk: (id) => revisions.get(id) ?? null,
    currentChunks: () => [...latest.values()],
    bundle: (material) => ({
      material,
      passages: P.filter((p) => Material.covers(material, p.sourceId, p.interval)),
      frames: [] as Frame[], gaps: [], ads: [],
    }),
    lookup: memo.lookup,
    run: (task, input, signal) => memo.run(task, input, { signal }),
    clearFailures: memo.clearFailures,
    tasks,
  });

  /** Segmentation's side: this user's chunk 0 covers [start, end). The id derives from the capture and material alone. */
  function close(start: number, end: number): ChunkRevision {
    const chunkId = stableId("chk", CAP, 0);
    const material = span(start, end);
    const rev: ChunkRevision = {
      id: stableId("crv", chunkId, Material.canonical(material)), chunkId, captureId: CAP, ordinal: 0, revisionNo: 1,
      material, windows: [], provenance: "boundary", closedAtSeq: db.nextSeq(), supersedes: null,
    };
    revisions.set(rev.id, rev);
    latest.set(0, rev);
    return rev;
  }

  const running = new Map<MemoKey, Promise<unknown>>();
  const start = (item: WorkItem) => {
    const p = item.run(new AbortController().signal).finally(() => running.delete(item.key));
    running.set(item.key, p);
    return p;
  };
  async function drain(): Promise<void> {
    for (let round = 0; round < 20; round++) {
      await Promise.allSettled(running.values());
      const fresh = prep.demand(CAP).filter((i) => !running.has(i.key));
      if (fresh.length === 0) return;
      await Promise.allSettled(fresh.map(start));
    }
  }
  return { db, memo, tasks, prep, close, start, drain, texts: (rev: ChunkRevision) => prep.prep(rev.id).claims.map((c) => c.original.text) };
}

const count = (db: UserDb, sql: string) => db.sql.query<{ n: number }, []>(sql).get()!.n;
const rowsOf = (db: UserDb, table: string, userId: string) => count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = '${userId}'`);
const POINTS = [{ label: "Pivots", claims: [draft("a pivot is a nonzero entry", P[0]!)] }];

describe("two users watch one lecture in one database", () => {
  test("each interprets, indexes and reads its own claims and concepts under identical ids", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const wa = preparationOf(a, { interpret: () => ok(output(POINTS)) });
    const wb = preparationOf(b, { interpret: () => ok(output([{ label: "Pivots", claims: [draft("a pivot is a nonzero entry", P[0]!), draft("pivots drive elimination", P[1]!)] }])) });
    const ra = wa.close(0, 20);
    const rb = wb.close(0, 20);
    expect(rb.id).toBe(ra.id);

    await wa.drain();
    expect(wa.texts(ra)).toEqual(["a pivot is a nonzero entry"]);
    expect(wb.prep.prep(rb.id)).toMatchObject({ interpretation: "pending", claims: [] });
    expect(wb.prep.demand(CAP).map((i) => i.purpose)).toEqual(["interpretation"]);

    await wb.drain();
    expect(wb.texts(rb)).toEqual(["a pivot is a nonzero entry", "pivots drive elimination"]);
    expect(wa.texts(ra)).toEqual(["a pivot is a nonzero entry"]);
    expect(wa.tasks.interpret.calls).toHaveLength(1);
    expect(wb.tasks.interpret.calls).toHaveLength(1);

    const idsA = wa.prep.prep(ra.id).claims.map((c) => c.id);
    expect(wb.prep.prep(rb.id).claims[0]!.id).toBe(idsA[0]!);
    // One concept row each; prep_inputs holds the interpretation and the resource search the claims led to.
    for (const [table, n] of [["prep_inputs", 2], ["concept_index", 1]] as const) {
      expect(rowsOf(a, table, a.userId)).toBe(n);
      expect(rowsOf(a, table, b.userId)).toBe(n);
    }
    expect(rowsOf(a, "claim_index", a.userId)).toBe(1);
    expect(rowsOf(a, "claim_index", b.userId)).toBe(2);
    expect(wa.prep.assessableIn(CAP, ra.material).map((c) => c.text)).toEqual(["a pivot is a nonzero entry"]);
    expect(wb.prep.assessableIn(CAP, rb.material)).toHaveLength(2);
  });

  test("concepts, confusions and link suggestions come from the caller's own index and memo", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const link = { fromLabel: "Pivots", toLabel: "Rank", type: "prerequisite_of" as const, evidence: [P[0]!.id], rationale: "rank counts pivots" };
    const confused = (text: string): Concept => ({ ...POINTS[0]!, confusions: [{ text, evidence: [P[0]!.id] as unknown as ClaimDraft["evidence"] }] });
    const wa = preparationOf(a, { interpret: () => ok(output([confused("A's mix-up"), ...POINTS.slice(1), { label: "Rank", claims: [draft("rank is the pivot count", P[1]!)] }], [link])) });
    const wb = preparationOf(b, { interpret: () => ok(output([confused("B's mix-up"), ...POINTS.slice(1)])) });
    const ra = wa.close(0, 20);
    wb.close(0, 20);
    await wa.drain();
    await wb.drain();

    const pivots = stableId("cpt", "pivots") as ConceptId;
    const rank = stableId("cpt", "rank") as ConceptId;
    expect(wa.prep.concepts([pivots, rank]).map((c) => c.label).sort()).toEqual(["Pivots", "Rank"]);
    expect(wb.prep.concepts([pivots, rank]).map((c) => c.label)).toEqual(["Pivots"]);
    expect(wa.prep.confusions([pivots]).map((c) => c.text)).toEqual(["A's mix-up"]);
    expect(wb.prep.confusions([pivots]).map((c) => c.text)).toEqual(["B's mix-up"]);
    expect(wa.prep.linkSuggestions([pivots])).toHaveLength(1);
    expect(wb.prep.linkSuggestions([pivots, rank])).toEqual([]);
    expect(wa.prep.claimsIn(CAP, ra.material)).toHaveLength(2);
  });

  test("one user's stop early cancels that user's work only", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const wa = preparationOf(a, { interpret: () => ok(output(POINTS)) });
    const wb = preparationOf(b, { interpret: () => ok(output(POINTS)) });
    const ra = wa.close(0, 20);
    const rb = wb.close(0, 20);

    wa.prep.stopEarly(CAP, [ra.id]);
    expect(wa.prep.demand(CAP)).toEqual([]);
    expect(wa.prep.prep(ra.id).interpretation).toBe("cancelled");
    expect(wb.prep.prep(rb.id).interpretation).toBe("pending");
    expect(wb.prep.demand(CAP).map((i) => i.purpose)).toEqual(["interpretation"]);
    await wb.drain();
    expect(wb.prep.prep(rb.id)).toMatchObject({ interpretation: "done", supportedCount: 1 });
    expect(rowsOf(a, "prep_controls", a.userId)).toBe(1);
    expect(rowsOf(a, "prep_controls", b.userId)).toBe(0);

    wb.prep.retry(CAP, [rb.id]);
    expect(wa.prep.prep(ra.id).interpretation).toBe("cancelled");
  });

  test('R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes." A cancelled job of one user stores late and changes nothing for the other', async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const gate = deferred<FakeStep<InterpretationOutput>>();
    const wa = preparationOf(a, { interpret: () => gate.promise });
    const wb = preparationOf(b, { interpret: () => ok(output(POINTS)) });
    const ra = wa.close(0, 20);
    const rb = wb.close(0, 20);

    const held = wa.prep.demand(CAP).map(wa.start);
    await Bun.sleep(0);
    wa.prep.stopEarly(CAP, [ra.id]);
    await wb.drain();
    expect(wb.prep.prep(rb.id)).toMatchObject({ interpretation: "done", supportedCount: 1 });

    gate.resolve(ok(output([{ label: "Pivots", claims: [draft("late and wrong", P[2]!)] }])));
    await Promise.allSettled(held);
    expect(wa.prep.prep(ra.id)).toMatchObject({ interpretation: "cancelled", claims: [] });
    expect(wb.texts(rb)).toEqual(["a pivot is a nonzero entry"]);
    expect(rowsOf(a, "claim_index", a.userId)).toBe(0);
    expect(rowsOf(a, "claim_index", b.userId)).toBe(1);
  });

  test("a frozen input is per user: a second user's different resource-search input is not dropped by the first's", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const connection = (concept: ConceptId, url: string): ResourceConnection => ({ id: stableId("res", concept, url) as never, conceptId: concept, url, title: url, provenance: "web_search", relevance: "r", supportingPassages: [] });
    const search = (url: string) => (i: ResourceSearchInput) => ok([connection(i.concept.id, `${url}-${i.supportedClaims.length}`)] as readonly ResourceConnection[]);
    const wa = preparationOf(a, { interpret: () => ok(output(POINTS)), search: search("https://a.example/") });
    const wb = preparationOf(b, {
      interpret: () => ok(output([{ label: "Pivots", claims: [draft("a pivot is a nonzero entry", P[0]!), draft("pivots drive elimination", P[1]!)] }])),
      search: search("https://b.example/"),
    });
    wa.close(0, 20);
    wb.close(0, 20);
    await wa.drain();
    await wb.drain();

    const pivots = stableId("cpt", "pivots") as ConceptId;
    expect(wa.tasks.searchResources.calls.map((c) => c.supportedClaims.length)).toEqual([1]);
    expect(wb.tasks.searchResources.calls.map((c) => c.supportedClaims.length)).toEqual([2]);
    expect(wa.prep.resources(pivots).connections.map((c) => c.url)).toEqual(["https://a.example/-1"]);
    expect(wb.prep.resources(pivots).connections.map((c) => c.url)).toEqual(["https://b.example/-2"]);
    expect(rowsOf(a, "prep_inputs", a.userId)).toBe(2);
    expect(rowsOf(a, "prep_inputs", b.userId)).toBe(2);
  });

  test("prep_inputs.memo_key resolves through the same user's memo only", async () => {
    const a = testUserDb();
    const b = otherUserDb(a);
    const wa = preparationOf(a, { interpret: () => ok(output(POINTS)) });
    const wb = preparationOf(b, { interpret: () => ok(output(POINTS)) });
    const ra = wa.close(0, 20);
    const rb = wb.close(0, 20);
    await wa.drain();

    const keyA = a.sql.query<{ memo_key: string }, [string]>("SELECT memo_key FROM prep_inputs WHERE user_id = ? AND kind = 'interpretation'").get(a.userId)!.memo_key as MemoKey;
    expect(wa.memo.inspect(keyA)?.output).toBeDefined();
    expect(wb.memo.inspect(keyA)).toBeNull();
    // B has frozen nothing yet, so reading B's claims neither borrows A's frozen input nor A's memo row.
    expect(wb.prep.prep(rb.id)).toMatchObject({ interpretation: "pending", claims: [] });
    expect(count(a, `SELECT COUNT(*) AS n FROM prep_inputs WHERE user_id = '${b.userId}'`)).toBe(0);
    expect(wa.prep.prep(ra.id).claims).toHaveLength(1);
  });
});

describe("migration preparation/003-user-id", () => {
  const withFile = <T>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "afterclass-prep-tenancy-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const before = { ...MIGRATIONS, preparation: MIGRATIONS.preparation.filter((m) => m.id !== "003-user-id") };

  function seedOld(path: string) {
    const db = openDb(path, before);
    db.sql.run("INSERT INTO claim_index VALUES ('clm_1','cap_1','chk_1','key_1',0,'cpt_1',1), ('clm_2','cap_1','chk_1','key_1',1,'cpt_1',2)");
    db.sql.run("INSERT INTO concept_index VALUES ('cpt_1','Pivots','summary',3)");
    db.sql.run("INSERT INTO prep_controls VALUES (4,'cap_1','stop_early','crv_1',10), (4,'cap_1','stop_early','crv_2',10), (5,'cap_1','retry','crv_1',11)");
    db.sql.run(`INSERT INTO prep_inputs VALUES
      ('interpretation','crv_1','cap_1','key_1','{"a":1}',6), ('revision','clm_1','cap_1','key_2','{"b":2}',7), ('resource_search','cpt_1','cap_1','key_3','{"c":3}',8)`);
    db.close();
  }

  test("every old row moves to the local user with its values, and the local user exists", () => {
    withFile((dir) => {
      const path = join(dir, "afterclass.sqlite");
      seedOld(path);
      const db = openDb(path);
      expect(db.sql.query("SELECT id FROM users").all()).toEqual([{ id: LOCAL_USER }]);
      expect(db.sql.query("SELECT user_id, id, capture_id, source_chunk_id, interpretation_key, ordinal, concept_id, seq FROM claim_index ORDER BY id").all()).toEqual([
        { user_id: LOCAL_USER, id: "clm_1", capture_id: "cap_1", source_chunk_id: "chk_1", interpretation_key: "key_1", ordinal: 0, concept_id: "cpt_1", seq: 1 },
        { user_id: LOCAL_USER, id: "clm_2", capture_id: "cap_1", source_chunk_id: "chk_1", interpretation_key: "key_1", ordinal: 1, concept_id: "cpt_1", seq: 2 },
      ]);
      expect(db.sql.query("SELECT user_id, id, label, summary, seq FROM concept_index").all()).toEqual([{ user_id: LOCAL_USER, id: "cpt_1", label: "Pivots", summary: "summary", seq: 3 }]);
      expect(db.sql.query("SELECT user_id, seq, action, chunk_revision_id, at_ms FROM prep_controls ORDER BY seq, chunk_revision_id").all()).toEqual([
        { user_id: LOCAL_USER, seq: 4, action: "stop_early", chunk_revision_id: "crv_1", at_ms: 10 },
        { user_id: LOCAL_USER, seq: 4, action: "stop_early", chunk_revision_id: "crv_2", at_ms: 10 },
        { user_id: LOCAL_USER, seq: 5, action: "retry", chunk_revision_id: "crv_1", at_ms: 11 },
      ]);
      expect(db.sql.query("SELECT user_id, kind, subject_id, memo_key, input_json, seq FROM prep_inputs ORDER BY seq").all()).toEqual([
        { user_id: LOCAL_USER, kind: "interpretation", subject_id: "crv_1", memo_key: "key_1", input_json: '{"a":1}', seq: 6 },
        { user_id: LOCAL_USER, kind: "revision", subject_id: "clm_1", memo_key: "key_2", input_json: '{"b":2}', seq: 7 },
        { user_id: LOCAL_USER, kind: "resource_search", subject_id: "cpt_1", memo_key: "key_3", input_json: '{"c":3}', seq: 8 },
      ]);
      expect(db.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.sql.query("SELECT name FROM sqlite_master WHERE name LIKE '%\\_save' ESCAPE '\\'").all()).toEqual([]);
      db.close();
    });
  });

  test("rows in only one of the four tables still bring the local user", () => {
    withFile((dir) => {
      const path = join(dir, "afterclass.sqlite");
      const old = openDb(path, before);
      old.sql.run("INSERT INTO prep_controls VALUES (1,'cap_1','retry','crv_1',1)");
      old.close();
      const db = openDb(path);
      expect(db.sql.query("SELECT id FROM users").all()).toEqual([{ id: LOCAL_USER }]);
      db.close();
    });
  });

  test("a database with no rows gets no user from the migration", () => {
    withFile((dir) => {
      const db = openDb(join(dir, "afterclass.sqlite"));
      expect(db.sql.query("SELECT id FROM users").all()).toEqual([]);
      db.close();
    });
  });

  test("an upgraded database prepares as the local user from its old rows, with no new model call", async () => {
    await withFileAsync(async (dir) => {
      const fresh = openDb(join(dir, "fresh.sqlite"));
      const a = scopeDb(fresh, ensureLocalUser(fresh));
      const wa = preparationOf(a, { interpret: () => ok(output(POINTS)) });
      const rev = wa.close(0, 20);
      await wa.drain();
      expect(wa.texts(rev)).toEqual(["a pivot is a nonzero entry"]);

      // Rebuild what the database looked like before the migration: memo rows with their user, preparation rows without.
      const path = join(dir, "old.sqlite");
      const old = openDb(path, before);
      old.sql.query("INSERT INTO users (id, created_ms) VALUES (?, 0)").run(LOCAL_USER);
      const copy = (table: string, columns: string, to = columns) => {
        const rows = fresh.sql.query<Record<string, unknown>, []>(`SELECT ${columns} FROM ${table}`).all();
        const names = to.split(", ");
        for (const r of rows) old.sql.query(`INSERT INTO ${table} (${to}) VALUES (${names.map(() => "?").join(", ")})`).run(...(Object.values(r) as never[]));
      };
      copy("memo_inputs", "user_id, key, provider, purpose, version, model, input_json, first_seen_ms");
      copy("memo", "user_id, key, output_json, seq, stored_ms");
      copy("claim_index", "id, capture_id, source_chunk_id, interpretation_key, ordinal, concept_id, seq");
      copy("concept_index", "id, label, summary, seq");
      copy("prep_inputs", "kind, subject_id, capture_id, memo_key, input_json, seq");
      const top = fresh.sql.query<{ value: number }, []>("SELECT value FROM seq_counter").get()!.value;
      old.sql.query("UPDATE seq_counter SET value = ?").run(top);
      old.close();
      fresh.close();

      const raw = openDb(path);
      const upgraded = scopeDb(raw, LOCAL_USER);
      const again = preparationOf(upgraded, { interpret: () => ok(output([])) });
      const same = again.close(0, 20);
      expect(same.id).toBe(rev.id);
      expect(again.texts(same)).toEqual(["a pivot is a nonzero entry"]);
      expect(again.prep.prep(same.id)).toMatchObject({ interpretation: "done", supportedCount: 1 });
      expect(again.prep.demand(CAP).filter((i) => i.purpose === "interpretation")).toEqual([]);
      expect(again.tasks.interpret.calls).toEqual([]);
      expect(again.prep.concepts([stableId("cpt", "pivots") as ConceptId]).map((c) => c.label)).toEqual(["Pivots"]);
      raw.close();
    });
  });

  test("the append-only triggers and every constraint still hold after the rebuild, and a second user may reuse an id", () => {
    withFile((dir) => {
      const path = join(dir, "afterclass.sqlite");
      seedOld(path);
      const db = openDb(path);
      db.sql.query("INSERT INTO users (id, created_ms) VALUES ('usr_other', 0)").run();
      expect(() => db.sql.run("UPDATE prep_controls SET action = 'retry'")).toThrow(/prep_controls is append-only/);
      expect(() => db.sql.run("UPDATE prep_inputs SET input_json = '{}'")).toThrow(/prep_inputs is append-only/);

      const claim = (over: Partial<Record<"user_id" | "id" | "ordinal" | "key" | "seq", string | number>>) => {
        const r = { user_id: LOCAL_USER, id: "clm_9", ordinal: 5, key: "key_9", seq: 20, ...over };
        db.sql.query("INSERT INTO claim_index (user_id, id, capture_id, source_chunk_id, interpretation_key, ordinal, concept_id, seq) VALUES (?, ?, 'cap_1', 'chk_1', ?, ?, 'cpt_1', ?)")
          .run(r.user_id as string, r.id as string, r.key as string, r.ordinal as number, r.seq as number);
      };
      expect(() => claim({ id: "clm_1", seq: 21 })).toThrow(/UNIQUE/);
      expect(() => claim({ key: "key_1", ordinal: 0, seq: 22 })).toThrow(/UNIQUE/);
      expect(() => claim({ seq: 1 })).toThrow(/UNIQUE/);
      expect(() => claim({ ordinal: -1 })).toThrow(/CHECK/);
      expect(() => claim({ user_id: "usr_missing" })).toThrow(/FOREIGN KEY/);
      claim({ user_id: "usr_other", id: "clm_1", key: "key_1", ordinal: 0, seq: 23 });
      expect(() => db.sql.run("INSERT INTO claim_index (id, capture_id, source_chunk_id, interpretation_key, ordinal, concept_id, seq) VALUES ('n','c','c','k',0,'c',30)")).toThrow(/NOT NULL/);

      const control = (userId: string, seq: number, chunk: string, action: string) =>
        db.sql.query("INSERT INTO prep_controls (user_id, seq, capture_id, action, chunk_revision_id, at_ms) VALUES (?, ?, 'cap_1', ?, ?, 0)").run(userId, seq, action, chunk);
      expect(() => control(LOCAL_USER, 4, "crv_1", "retry")).toThrow(/UNIQUE/);
      expect(() => control(LOCAL_USER, 40, "crv_1", "pause")).toThrow(/CHECK/);
      expect(() => control("usr_missing", 41, "crv_1", "retry")).toThrow(/FOREIGN KEY/);
      control("usr_other", 4, "crv_1", "stop_early");

      const frozen = (userId: string, kind: string, subject: string, seq: number) =>
        db.sql.query("INSERT INTO prep_inputs (user_id, kind, subject_id, capture_id, memo_key, input_json, seq) VALUES (?, ?, ?, 'cap_1', 'k', '{}', ?)").run(userId, kind, subject, seq);
      expect(() => frozen(LOCAL_USER, "interpretation", "crv_1", 50)).toThrow(/UNIQUE/);
      expect(() => frozen(LOCAL_USER, "interpretation", "crv_7", 6)).toThrow(/UNIQUE/);
      expect(() => frozen(LOCAL_USER, "guess", "crv_7", 51)).toThrow(/CHECK/);
      expect(() => frozen("usr_missing", "interpretation", "crv_7", 52)).toThrow(/FOREIGN KEY/);
      frozen("usr_other", "interpretation", "crv_1", 53);

      expect(() => db.sql.run("INSERT INTO concept_index (id, label, summary, seq) VALUES ('c','l','s',60)")).toThrow(/NOT NULL/);
      db.sql.query("INSERT INTO concept_index (user_id, id, label, summary, seq) VALUES ('usr_other', 'cpt_1', 'Other', 's', 61)").run();
      expect(() => db.sql.query("INSERT INTO concept_index (user_id, id, label, summary, seq) VALUES ('usr_other', 'cpt_1', 'Dup', 's', 62)").run()).toThrow(/UNIQUE/);
      db.close();
    });
  });
});

async function withFileAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "afterclass-prep-tenancy-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
