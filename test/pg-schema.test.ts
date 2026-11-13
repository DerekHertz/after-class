/**
 * The PostgreSQL schema (src/backend/pg-schema.ts) against the SQLite one (openDb ':memory:'): the same tables, columns,
 * NOT NULLs, keys, foreign keys and indexes, every SQLite CHECK refusing the same bad row on PostgreSQL, and the
 * triggers refusing the same statements on the same rows. The only differences allowed are the ones pg-schema.ts
 * names, written out below.
 */
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { openDb } from "../src/backend/db";
import { pgDatabases, skipWithoutPg } from "./pg-fixtures";

const skip = skipWithoutPg(import.meta.path);
const dbs = pgDatabases();

type Value = string | number | null;
type Outcome = "ok" | `refused: ${string}`;
type Engine = { readonly name: string; exec(sql: string): Promise<Outcome>; query<R>(sql: string): Promise<R[]>; close(): Promise<void> };

/** Every key that held a Seq alone leads with user_id on PostgreSQL, because Seqs are per user there. */
const SEQ_KEY: Readonly<Record<string, string>> = {
  capture_facts: "seq",
  invite_answers: "seq",
  memo: "seq",
  memo_failures: "seq",
  frames: "seq",
  evidence_deletions: "seq",
  chunk_revisions: "closed_at_seq",
  claim_index: "seq",
  concept_index: "seq",
  prep_inputs: "seq",
  reviews: "frozen_at_seq",
  review_turns: "seq",
};
const pgKey = (table: string, cols: string) => (SEQ_KEY[table] === cols ? `user_id,${cols}` : cols);

/** seq_counter is one row per user on PostgreSQL; its shape is checked on its own. */
const RESHAPED = new Set(["seq_counter"]);

function sqliteEngine(): Engine {
  const db = openDb(":memory:");
  return {
    name: "sqlite",
    exec: async (sql) => {
      try {
        db.sql.run(sql);
        return "ok";
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    },
    query: async <R>(sql: string) => db.sql.query<R, []>(sql).all(),
    close: async () => db.close(),
  };
}

async function pgEngine(): Promise<Engine> {
  const sql = new SQL({ url: await dbs.freshUrl(), max: 1 });
  return {
    name: "postgres",
    exec: async (text) => {
      try {
        await sql.unsafe(text);
        return "ok";
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    },
    query: async <R>(text: string) => (await sql.unsafe(text)) as R[],
    close: () => sql.close(),
  };
}

async function both<T>(fn: (e: Engine) => Promise<T>): Promise<{ sqlite: T; postgres: T }> {
  const s = sqliteEngine();
  const p = await pgEngine();
  try {
    return { sqlite: await fn(s), postgres: await fn(p) };
  } finally {
    await s.close();
    await p.close();
  }
}

const lit = (v: Value) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const insert = (table: string, row: Readonly<Record<string, Value>>) =>
  `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(lit).join(", ")})`;

const A = "usr_a";
const B = "usr_b";

/** One valid row per table, in foreign key order. On both engines they insert, and each probe below varies one. */
const BASE: readonly (readonly [string, Readonly<Record<string, Value>>])[] = [
  ["users", { id: A, created_ms: 0 }],
  ["users", { id: B, created_ms: 0 }],
  ["memo_inputs", { user_id: A, key: "k1", provider: "jev", purpose: "boundary", version: "v1", model: "m", input_json: "{}", first_seen_ms: 0 }],
  ["memo", { user_id: A, key: "k1", output_json: "{}", seq: 1, stored_ms: 0 }],
  ["memo_failures", { user_id: A, key: "k1", attempts: 1, last_error: "e", seq: 2, terminal: 0 }],
  [
    "usage_events",
    {
      id: "use_1", user_id: A, memo_key: "k1", capture_id: null, attempt_no: 1, provider: "jev", model: "m", purpose: "boundary", outcome: "ok",
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cost_kind: "unknown", cost_usd: null, cost_basis: null, cost_reason: "r",
      started_ms: 0, duration_ms: 0,
    },
  ],
  [
    "voice_usage_events",
    { id: "vu_1", user_id: A, provider: "elevenlabs", model: "m", voice_id: "v", characters: 1, outcome: "ok", cost_kind: "unknown", cost_reason: "r", started_ms: 0, duration_ms: 0 },
  ],
  ["capture_facts", { user_id: A, seq: 3, capture_id: "cap_1", client_seq: 0, wall_ms: 0, kind: "span", body_json: "{}", received_ms: 0 }],
  ["frames", { user_id: A, evidence_id: "ev_f", capture_id: "cap_1", source_id: "src", frame_id: "f1", media_s: 1, width: 1280, height: 720, path: "/f", seq: 4 }],
  ["evidence_snapshots", { user_id: A, evidence_id: "ev_p", kind: "passage", source_id: "src", start_s: 1, end_s: 2, text: "t", frame_path: null, created_ms: 0 }],
  ["evidence_deletions", { user_id: A, evidence_id: "ev_x", request_id: "req", deleted_ms: 0, seq: 5 }],
  ["capture_owners", { capture_id: "cap_1", user_id: A, claimed_ms: 0 }],
  [
    "chunk_revisions",
    { user_id: A, id: "crv_1", chunk_id: "chk_1", capture_id: "cap_1", ordinal: 0, revision_no: 1, material_json: "[]", windows_json: "[]", provenance: "boundary", closed_at_seq: 6, supersedes: null },
  ],
  ["claim_index", { user_id: A, id: "clm_1", capture_id: "cap_1", source_chunk_id: "chk_1", interpretation_key: "k1", ordinal: 0, concept_id: "cpt_1", seq: 7 }],
  ["concept_index", { user_id: A, id: "cpt_1", label: "l", summary: "s", seq: 8 }],
  ["prep_controls", { user_id: A, seq: 9, capture_id: "cap_1", action: "retry", chunk_revision_id: "crv_1", at_ms: 0 }],
  ["prep_inputs", { user_id: A, kind: "interpretation", subject_id: "crv_1", capture_id: "cap_1", memo_key: "k1", input_json: "{}", seq: 10 }],
  ["invite_answers", { user_id: A, seq: 11, capture_id: "cap_1", answer: "later", watched_s: 0, at_ms: 0 }],
  ["reviews", { id: "rvw_1", user_id: A, capture_id: "cap_1", choice: "prepared_only", scope_json: "{}", frozen_at_seq: 12, started_ms: 0 }],
  ["review_turns", { user_id: A, id: "turn_1", review_id: "rvw_1", seq: 13, actor: "learner", thread_id: null, body_json: "{}", at_ms: 0 }],
  ["notes", { user_id: A, id: "note_1", ord: 1, review_id: "rvw_1", concept_id: "cpt_1", generated_json: "[]", saved_ms: 0 }],
  ["note_edits", { user_id: A, note_id: "note_1", text: "x", edited_ms: 0 }],
  ["note_deletions", { user_id: A, note_id: "note_9", deleted_ms: 0 }],
  ["note_evidence", { user_id: A, note_id: "note_1", evidence_id: "ev_p" }],
  [
    "observations",
    { user_id: A, id: "obs_1", ord: 1, review_id: "rvw_1", thread_id: "thr_1", claim_ids_json: "[]", concept_ids_json: "[]", proposed: "partial", facts_json: "{}", saved_ms: 0, assessable: 1 },
  ],
  ["observation_decisions", { user_id: A, observation_id: "obs_1", kind: "override", value: "partial", decided_ms: 0 }],
  ["link_suggestions", { user_id: A, id: "lnk_1", ord: 1, review_id: "rvw_1", from_concept: "a", to_concept: "b", type: "part_of", evidence_json: "[]", rationale: "r", saved_ms: 0 }],
  ["link_decisions", { user_id: A, link_id: "lnk_1", decision_json: `"accepted"`, decided_ms: 0 }],
  ["saved_reviews", { user_id: A, review_id: "rvw_9", bundle_hash: "h", saved_ms: 0 }],
  ["save_failures", { user_id: A, review_id: "rvw_9", error: "e", failed_ms: 0 }],
];
const baseOf = (table: string) => BASE.find(([t]) => t === table)![1];

/** Each varies one base row so that exactly one SQLite CHECK fails. Together they must cover every CHECK. */
const CHECK_PROBES: readonly (readonly [string, Readonly<Record<string, Value>>])[] = [
  ["memo_inputs", { provider: "x" }],
  ["memo_inputs", { purpose: "x" }],
  ["memo_failures", { attempts: 0 }],
  ["memo_failures", { terminal: 2 }],
  ["usage_events", { attempt_no: 0 }],
  ["usage_events", { provider: "x" }],
  ["usage_events", { purpose: "x" }],
  ["usage_events", { outcome: "x" }],
  ["usage_events", { input_tokens: -1 }],
  ["usage_events", { output_tokens: -1 }],
  ["usage_events", { cache_read_tokens: -1 }],
  ["usage_events", { cost_kind: "free", cost_usd: 1, cost_reason: null }],
  ["usage_events", { cost_kind: "measured", cost_usd: -1, cost_reason: null }],
  ["usage_events", { cost_kind: "unknown", cost_usd: 0 }],
  ["usage_events", { cost_kind: "unknown", cost_reason: null }],
  ["usage_events", { cost_kind: "notional", cost_usd: 1, cost_reason: null, cost_basis: null }],
  ["usage_events", { duration_ms: -1 }],
  ["voice_usage_events", { provider: "x" }],
  ["voice_usage_events", { characters: -1 }],
  ["voice_usage_events", { outcome: "x" }],
  ["voice_usage_events", { cost_kind: "measured" }],
  ["voice_usage_events", { duration_ms: -1 }],
  ["capture_facts", { client_seq: -1 }],
  ["capture_facts", { kind: "x" }],
  ["frames", { media_s: -1 }],
  ["frames", { width: 100 }],
  ["frames", { height: 2000 }],
  ["evidence_snapshots", { kind: "x", text: null }],
  ["evidence_snapshots", { start_s: -1 }],
  ["evidence_snapshots", { end_s: 0.5 }],
  ["evidence_snapshots", { text: null }],
  ["evidence_snapshots", { kind: "frame", text: null }],
  ["chunk_revisions", { ordinal: -1 }],
  ["chunk_revisions", { revision_no: 0, supersedes: "crv_1" }],
  ["chunk_revisions", { provenance: "x" }],
  ["chunk_revisions", { revision_no: 2 }],
  ["claim_index", { ordinal: -1 }],
  ["prep_controls", { action: "x" }],
  ["prep_inputs", { kind: "x" }],
  ["invite_answers", { answer: "x" }],
  ["invite_answers", { watched_s: -1 }],
  ["reviews", { choice: "x" }],
  ["review_turns", { actor: "x" }],
  ["observations", { proposed: "disputed" }],
  ["observations", { assessable: 2 }],
  ["observation_decisions", { kind: "x" }],
  ["observation_decisions", { kind: "dispute_resolution", value: "partial" }],
  ["observation_decisions", { kind: "override", value: "disputed" }],
  ["link_suggestions", { type: "x" }],
];

/** The CHECK expressions in a CREATE TABLE statement, whitespace collapsed. */
function checksIn(createSql: string): string[] {
  const out: string[] = [];
  for (const m of createSql.matchAll(/\bCHECK\s*\(/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; depth > 0; i++) depth += createSql[i] === "(" ? 1 : createSql[i] === ")" ? -1 : 0;
    out.push(createSql.slice(start, i - 1).replace(/\s+/g, " ").trim());
  }
  return out;
}

async function seed(e: Engine): Promise<void> {
  for (const [table, row] of BASE) {
    const outcome = await e.exec(insert(table, row));
    if (outcome !== "ok") throw new Error(`${e.name}: base row of ${table}: ${outcome}`);
  }
}

describe.skipIf(skip)("PostgreSQL schema parity with SQLite: shape", () => {
  type Shape = {
    columns: Map<string, { type: string; notNull: boolean; hasDefault: boolean }>;
    pk: string;
    uniques: Set<string>;
    fks: Set<string>;
    indexes: Set<string>;
    checks: number;
  };

  async function sqliteShapes(): Promise<Map<string, Shape>> {
    const e = sqliteEngine();
    const shapes = new Map<string, Shape>();
    const tables = await e.query<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    for (const { name, sql } of tables) {
      const info = await e.query<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>(`PRAGMA table_info(${name})`);
      const indexList = await e.query<{ name: string; unique: number; origin: string }>(`PRAGMA index_list(${name})`);
      const colsOf = async (index: string) => (await e.query<{ name: string }>(`PRAGMA index_info(${index})`)).map((r) => r.name).join(",");
      const fkRows = await e.query<{ id: number; table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${name})`);
      const fks = new Map<number, { table: string; from: string[]; to: string[] }>();
      for (const r of fkRows) {
        const fk = fks.get(r.id) ?? { table: r.table, from: [], to: [] };
        fk.from.push(r.from);
        fk.to.push(r.to);
        fks.set(r.id, fk);
      }
      shapes.set(name, {
        columns: new Map(info.map((c) => [c.name, { type: c.type, notNull: c.notnull === 1 || c.pk > 0, hasDefault: c.dflt_value !== null }])),
        pk: info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(","),
        uniques: new Set(await Promise.all(indexList.filter((i) => i.unique === 1 && i.origin === "u").map((i) => colsOf(i.name)))),
        fks: new Set([...fks.values()].map((f) => `${f.from.join(",")} -> ${f.table}(${f.to.join(",")})`)),
        indexes: new Set(await Promise.all(indexList.filter((i) => i.origin === "c").map(async (i) => `${i.name}(${await colsOf(i.name)})`))),
        checks: checksIn(sql).length,
      });
    }
    await e.close();
    return shapes;
  }

  async function pgShapes(): Promise<Map<string, Shape & { collations: Map<string, string | null> }>> {
    const e = await pgEngine();
    const cols = await e.query<{ t: string; c: string; type: string; nullable: string; dflt: string | null; collation: string | null }>(`
      SELECT table_name AS t, column_name AS c, data_type AS type, is_nullable AS nullable, column_default AS dflt, collation_name AS collation
      FROM information_schema.columns WHERE table_schema = 'public'`);
    const cons = await e.query<{ t: string; type: string; cols: string; ref: string | null; ref_cols: string | null }>(`
      SELECT rel.relname AS t, con.contype AS type,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
        frel.relname AS ref,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_cols
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
      LEFT JOIN pg_class frel ON frel.oid = con.confrelid
      WHERE n.nspname = 'public'`);
    const idx = await e.query<{ t: string; name: string; cols: string }>(`
      SELECT t.relname AS t, i.relname AS name,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols
      FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND NOT ix.indisunique`);
    await e.close();
    const shapes = new Map<string, Shape & { collations: Map<string, string | null> }>();
    for (const t of new Set(cols.map((c) => c.t))) {
      const mine = cols.filter((c) => c.t === t);
      const con = cons.filter((c) => c.t === t);
      shapes.set(t, {
        columns: new Map(mine.map((c) => [c.c, { type: c.type, notNull: c.nullable === "NO", hasDefault: c.dflt !== null }])),
        collations: new Map(mine.map((c) => [c.c, c.collation])),
        pk: con.find((c) => c.type === "p")?.cols ?? "",
        uniques: new Set(con.filter((c) => c.type === "u").map((c) => c.cols)),
        fks: new Set(con.filter((c) => c.type === "f").map((c) => `${c.cols} -> ${c.ref}(${c.ref_cols})`)),
        indexes: new Set(idx.filter((i) => i.t === t).map((i) => `${i.name}(${i.cols})`)),
        checks: con.filter((c) => c.type === "c").length,
      });
    }
    return shapes;
  }

  const expectedType = (column: string, sqliteType: string) =>
    sqliteType === "INTEGER" ? "bigint" : sqliteType === "REAL" ? "double precision" : column.endsWith("_json") ? "jsonb" : "text";

  test("the same tables, and each one's columns, types, NOT NULLs, defaults, keys, foreign keys, indexes and CHECK count", async () => {
    const [lite, pg] = await Promise.all([sqliteShapes(), pgShapes()]);
    expect([...pg.keys()].sort()).toEqual([...lite.keys()].sort());
    const drift: string[] = [];
    const differ = (table: string, what: string, sqlite: unknown, postgres: unknown) => {
      if (JSON.stringify(sqlite) !== JSON.stringify(postgres)) drift.push(`${table} ${what}: sqlite ${JSON.stringify(sqlite)}, postgres ${JSON.stringify(postgres)}`);
    };
    for (const [table, l] of lite) {
      if (RESHAPED.has(table)) continue;
      const p = pg.get(table)!;
      differ(table, "columns", [...l.columns.keys()].sort(), [...p.columns.keys()].sort());
      for (const [column, lc] of l.columns) {
        const pc = p.columns.get(column);
        if (!pc) continue;
        differ(table, `${column} type`, expectedType(column, lc.type), pc.type);
        differ(table, `${column} NOT NULL`, lc.notNull, pc.notNull);
        differ(table, `${column} default`, lc.hasDefault, pc.hasDefault);
        if (pc.type === "text") differ(table, `${column} collation`, "C", p.collations.get(column));
      }
      differ(table, "primary key", pgKey(table, l.pk), p.pk);
      differ(table, "unique keys", [...l.uniques].map((u) => pgKey(table, u)).sort(), [...p.uniques].sort());
      differ(table, "foreign keys", [...l.fks].sort(), [...p.fks].sort());
      differ(table, "indexes", [...l.indexes].sort(), [...p.indexes].sort());
      differ(table, "CHECK count", l.checks, p.checks);
    }
    expect(drift).toEqual([]);
  });

  test("seq_counter is one row per user on PostgreSQL, in place of SQLite's single row", async () => {
    const pg = (await pgShapes()).get("seq_counter")!;
    expect([...pg.columns].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["user_id", { type: "text", notNull: true, hasDefault: false }],
      ["value", { type: "bigint", notNull: true, hasDefault: false }],
    ]);
    expect([pg.pk, [...pg.fks], pg.checks]).toEqual(["user_id", ["user_id -> users(id)"], 1]);
  });
});

describe.skipIf(skip)("PostgreSQL schema parity with SQLite: CHECKs", () => {
  test("every SQLite CHECK is tripped by a probe, and PostgreSQL refuses each probe with a CHECK violation", async () => {
    const lite = sqliteEngine();
    const pg = await pgEngine();
    try {
      await seed(lite);
      await seed(pg);
      const tables = await lite.query<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
      const declared = new Set(tables.filter((t) => !RESHAPED.has(t.name)).flatMap((t) => checksIn(t.sql).map((c) => `${t.name}: ${c}`)));
      const tripped = new Set<string>();
      const problems: string[] = [];
      for (const [table, change] of CHECK_PROBES) {
        const sql = insert(table, { ...baseOf(table), ...change });
        const l = await lite.exec(sql);
        const failed = l.match(/^refused: CHECK constraint failed: (.+)$/)?.[1];
        if (!failed) problems.push(`${table} ${JSON.stringify(change)}: sqlite ${l}`);
        else tripped.add(`${table}: ${failed.replace(/\s+/g, " ").trim()}`);
        const p = await pg.exec(sql);
        if (!/violates check constraint/.test(p)) problems.push(`${table} ${JSON.stringify(change)}: postgres ${p}`);
      }
      expect(problems).toEqual([]);
      expect([...declared].filter((c) => !tripped.has(c))).toEqual([]);
      expect(tripped.size).toBe(CHECK_PROBES.length);
    } finally {
      await lite.close();
      await pg.close();
    }
  });
});

describe.skipIf(skip)("PostgreSQL schema parity with SQLite: triggers", () => {
  /** Run `steps` on both engines from the seeded state; each step's outcome is the rule message or "ok". */
  async function scenario(steps: readonly string[]): Promise<{ sqlite: string[]; postgres: string[] }> {
    return both(async (e) => {
      await seed(e);
      const out: string[] = [];
      for (const s of steps) out.push(ruleOf(await e.exec(s)));
      return out;
    });
  }

  /** "ok", the R-message of a trigger, or the kind of constraint that refused. */
  const ruleOf = (o: Outcome) =>
    o === "ok"
      ? "ok"
      : /FOREIGN KEY|foreign key/.test(o)
        ? "foreign key"
        : (o.match(/(R\d+: [^"]*?|\w+ is append-only)(?: and cannot be truncated)?$/)?.[1] ?? o);

  test("every table refuses UPDATE and DELETE on both engines exactly when SQLite does, with the same message", async () => {
    const tables = BASE.map(([t]) => t).filter((t, i, all) => all.indexOf(t) === i);
    const probe = async (e: Engine) => {
      await seed(e);
      const out: Record<string, { update: string; delete: string }> = {};
      for (const table of tables) {
        const column = Object.keys(baseOf(table)).find((c) => c !== "user_id" && c !== "id")!;
        const attempt = async (sql: string) => {
          await e.exec("BEGIN");
          const result = ruleOf(await e.exec(sql));
          await e.exec("ROLLBACK");
          return result;
        };
        out[table] = { update: await attempt(`UPDATE ${table} SET ${column} = ${column}`), delete: await attempt(`DELETE FROM ${table}`) };
      }
      return out;
    };
    const { sqlite, postgres } = await both(probe);
    expect(postgres).toEqual(sqlite);
    const refusedUpdates = Object.entries(sqlite).filter(([, o]) => o.update !== "ok").map(([t, o]) => `${t}: ${o.update}`);
    expect(refusedUpdates.sort()).toEqual(
      [
        "capture_facts: capture_facts is append-only",
        "capture_owners: capture_owners is append-only",
        "chunk_revisions: chunk_revisions is append-only",
        "evidence_snapshots: R16: evidence_snapshots is append-only",
        "frames: frames is append-only",
        "invite_answers: invite_answers is append-only",
        "memo: R8: memo is append-only",
        "prep_controls: prep_controls is append-only",
        "prep_inputs: prep_inputs is append-only",
        "review_turns: review_turns is append-only",
        "reviews: R7: reviews is append-only",
        "usage_events: R17: usage_events is append-only",
        "voice_usage_events: R17: voice_usage_events is append-only",
      ].sort(),
    );
    expect(Object.fromEntries(Object.entries(sqlite).filter(([, o]) => o.delete.startsWith("R")).map(([t, o]) => [t, o.delete]))).toEqual({
      capture_facts: "R16: raw evidence of an unsaved review is held",
      frames: "R16: frames of an unsaved review are held",
      evidence_snapshots: "R16: evidence cited by a note is deleted only by the user",
      usage_events: "R17: usage events are never deleted",
      voice_usage_events: "R17: usage events are never deleted",
    });
  });

  const DELETE_SNAPSHOT = `DELETE FROM evidence_snapshots WHERE user_id = '${A}' AND evidence_id = 'ev_p'`;
  const DELETE_FACTS = `DELETE FROM capture_facts WHERE user_id = '${A}' AND capture_id = 'cap_1'`;
  const DELETE_FRAME = `DELETE FROM frames WHERE user_id = '${A}' AND evidence_id = 'ev_f'`;
  const CITED_SNAPSHOT = "R16: evidence cited by a note is deleted only by the user";

  test.each([
    ["R16: a saved note's evidence is not deleted by expiry", [DELETE_SNAPSHOT], [CITED_SNAPSHOT]],
    [
      "R16: deleting the citing note releases the snapshot",
      [DELETE_SNAPSHOT, insert("note_deletions", { user_id: A, note_id: "note_1", deleted_ms: 0 }), DELETE_SNAPSHOT],
      [CITED_SNAPSHOT, "ok", "ok"],
    ],
    [
      "R16: the user deleting the evidence releases it",
      [insert("evidence_deletions", { user_id: A, evidence_id: "ev_p", request_id: "r", deleted_ms: 0, seq: 99 }), DELETE_SNAPSHOT],
      ["ok", "ok"],
    ],
    [
      "R16: another user's tombstone or deleted note does not release it",
      [
        insert("evidence_deletions", { user_id: B, evidence_id: "ev_p", request_id: "r", deleted_ms: 0, seq: 99 }),
        insert("note_deletions", { user_id: B, note_id: "note_1", deleted_ms: 0 }),
        DELETE_SNAPSHOT,
      ],
      ["ok", "ok", CITED_SNAPSHOT],
    ],
    [
      "R16: another user's note citing the same evidence id does not hold this user's snapshot",
      [
        insert("note_deletions", { user_id: A, note_id: "note_1", deleted_ms: 0 }),
        insert("note_evidence", { user_id: B, note_id: "note_1", evidence_id: "ev_p" }),
        DELETE_SNAPSHOT,
      ],
      ["ok", "ok", "ok"],
    ],
    [
      "R16: an unsaved review holds its capture's facts and frames until it is saved",
      [DELETE_FACTS, DELETE_FRAME, insert("saved_reviews", { user_id: A, review_id: "rvw_1", bundle_hash: "h", saved_ms: 0 }), DELETE_FACTS, DELETE_FRAME],
      ["R16: raw evidence of an unsaved review is held", "R16: frames of an unsaved review are held", "ok", "ok", "ok"],
    ],
    [
      "R16: another user's saved_reviews row does not save this user's review",
      [insert("saved_reviews", { user_id: B, review_id: "rvw_1", bundle_hash: "h", saved_ms: 0 }), DELETE_FACTS],
      ["ok", "R16: raw evidence of an unsaved review is held"],
    ],
    [
      "R16: the user deleting a frame releases it while the review is unsaved, and the facts stay held",
      [insert("evidence_deletions", { user_id: A, evidence_id: "ev_f", request_id: "r", deleted_ms: 0, seq: 99 }), DELETE_FRAME, DELETE_FACTS],
      ["ok", "ok", "R16: raw evidence of an unsaved review is held"],
    ],
    [
      "R16: another user's unsaved review of the same capture id does not hold this user's facts",
      [
        insert("saved_reviews", { user_id: A, review_id: "rvw_1", bundle_hash: "h", saved_ms: 0 }),
        insert("reviews", { id: "rvw_b", user_id: B, capture_id: "cap_1", choice: "prepared_only", scope_json: "{}", frozen_at_seq: 1, started_ms: 0 }),
        DELETE_FACTS,
      ],
      ["ok", "ok", "ok"],
    ],
    [
      "R17: a usage event is never edited or deleted, whatever its cost",
      [
        `UPDATE usage_events SET cost_kind = 'measured', cost_usd = 0, cost_reason = NULL`,
        `DELETE FROM usage_events WHERE id = 'use_1'`,
        `UPDATE voice_usage_events SET characters = 2`,
        `DELETE FROM voice_usage_events`,
      ],
      ["R17: usage_events is append-only", "R17: usage events are never deleted", "R17: voice_usage_events is append-only", "R17: usage events are never deleted"],
    ],
  ] as const)("%s", async (_, steps, expected) => {
    const { sqlite, postgres } = await scenario(steps);
    expect(sqlite).toEqual([...expected]);
    expect(postgres).toEqual(sqlite);
  });

  test("PostgreSQL refuses TRUNCATE of every append-only table, which would skip the row triggers", async () => {
    const e = await pgEngine();
    try {
      await seed(e);
      const appendOnly = (await e.query<{ t: string }>(`SELECT tgrelid::regclass::text AS t FROM pg_trigger WHERE tgname LIKE '%\\_no\\_update' ORDER BY 1`)).map((r) => r.t);
      expect(appendOnly).toHaveLength(13);
      const refused: string[] = [];
      for (const table of appendOnly) refused.push(ruleOf(await e.exec(`TRUNCATE ${table} CASCADE`)));
      expect(refused).toEqual(appendOnly.map((t) => (t === "usage_events" || t === "voice_usage_events" ? `R17: ${t} is append-only` : expect.stringContaining(`${t} is append-only`))));
      const left = await e.query<{ n: string }>(`SELECT (SELECT count(*) FROM usage_events) + (SELECT count(*) FROM capture_facts) + (SELECT count(*) FROM evidence_snapshots) AS n`);
      expect(left).toEqual([{ n: "3" }]);
    } finally {
      await e.close();
    }
  });

  test("every SQLite trigger has a PostgreSQL trigger of the same name on the same table", async () => {
    const { sqlite, postgres } = await both((e) =>
      e.name === "sqlite"
        ? e.query<{ t: string; name: string }>("SELECT tbl_name AS t, name FROM sqlite_master WHERE type = 'trigger'")
        : e.query<{ t: string; name: string }>("SELECT tgrelid::regclass::text AS t, tgname AS name FROM pg_trigger WHERE NOT tgisinternal"),
    );
    const pg = new Set(postgres.map((r) => `${r.t}.${r.name}`));
    expect(sqlite.map((r) => `${r.t}.${r.name}`).filter((n) => !pg.has(n))).toEqual([]);
    expect(sqlite).toHaveLength(18);
  });
});
