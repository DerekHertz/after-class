/**
 * bun:sqlite connection, the global fact sequence, and every module's schema.
 *
 * Table ownership: each table belongs to exactly one module, which is its only
 * writer. Ownership is read from the CREATE TABLE statements under each owner
 * below (`tableOwners`), and test/boundaries.test.ts fails when a module's SQL
 * writes a table it does not own. To change your module's schema, append a new
 * migration to your own array. Never edit an applied one: the runner refuses a
 * migration whose text changed after it ran.
 *
 * Single process, synchronous bun:sqlite, WAL: every command is one `tx`, so
 * writers serialize without locks. Nested `tx` calls become savepoints.
 */
import { Database } from "bun:sqlite";
import type { Seq } from "../shared/domain";

export type Db = {
  readonly sql: Database;
  /** Monotonic across every fact table. Rolled back with its transaction, so a Seq is never handed out twice. */
  nextSeq(): Seq;
  tx<T>(fn: () => T): T;
  close(): void;
};

export const OWNERS = ["kernel", "providers", "evidence", "segmentation", "preparation", "review", "record"] as const;
export type Owner = (typeof OWNERS)[number];

export type Migration = { readonly id: string; readonly sql: string };

/** Only the db mints Seqs; rows read back carry them as plain integers. */
export function asSeq(n: number): Seq {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`asSeq: ${n}`);
  return n as Seq;
}

const PURPOSES = `'boundary','frame_change','claim_check','interpretation','claim_revision','resource_search','tutor_turn','wrap_up'`;
const OBSERVATION_STATUSES = `'independent','partial','after_help','unresolved','not_assessed'`;

/** R16 holds: an unsaved review keeps its capture's raw evidence. Shared by the raw-evidence triggers. */
const PENDING_SAVE_HOLDS = (captureCol: string) => `EXISTS (
    SELECT 1 FROM reviews r
    WHERE r.capture_id = ${captureCol}
      AND NOT EXISTS (SELECT 1 FROM saved_reviews s WHERE s.review_id = r.id))`;

const appendOnly = (table: string, rule?: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${rule ? `${rule}: ` : ""}${table} is append-only'); END;`;

export const MIGRATIONS: { readonly [O in Owner]: readonly Migration[] } = {
  kernel: [
    {
      id: "001-seq",
      sql: `
CREATE TABLE seq_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL) STRICT;
INSERT INTO seq_counter (id, value) VALUES (1, 0);`,
    },
  ],

  providers: [
    {
      id: "001-memo-usage",
      sql: `
CREATE TABLE memo_inputs (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('jev','claude')),
  purpose TEXT NOT NULL CHECK (purpose IN (${PURPOSES})),
  version TEXT NOT NULL,
  model TEXT NOT NULL,
  input_json TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE memo (
  key TEXT PRIMARY KEY REFERENCES memo_inputs(key),
  output_json TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  stored_ms INTEGER NOT NULL
) STRICT;
${appendOnly("memo", "R8")}

CREATE TABLE memo_failures (
  key TEXT PRIMARY KEY REFERENCES memo_inputs(key),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  last_error TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1))
) STRICT;

-- R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  memo_key TEXT NOT NULL REFERENCES memo_inputs(key),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  provider TEXT NOT NULL CHECK (provider IN ('jev','claude')),
  model TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (${PURPOSES})),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','error','aborted')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cost_kind TEXT NOT NULL CHECK (cost_kind IN ('measured','notional','estimated','unknown')),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  cost_basis TEXT,
  cost_reason TEXT,
  started_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  UNIQUE (memo_key, attempt_no),
  CHECK ((cost_kind = 'unknown') = (cost_usd IS NULL)),
  CHECK ((cost_kind = 'unknown') = (cost_reason IS NOT NULL)),
  CHECK ((cost_kind IN ('notional','estimated')) = (cost_basis IS NOT NULL))
) STRICT;
CREATE INDEX usage_events_by_purpose ON usage_events (purpose, started_ms);
${appendOnly("usage_events", "R17")}
CREATE TRIGGER usage_events_no_delete BEFORE DELETE ON usage_events
BEGIN SELECT RAISE(ABORT, 'R17: usage events are never deleted'); END;`,
    },
  ],

  evidence: [
    {
      id: "001-capture-evidence",
      sql: `
-- Frame bytes are stripped from body_json; they live on disk at frames.path.
CREATE TABLE capture_facts (
  seq INTEGER PRIMARY KEY,
  capture_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL CHECK (client_seq >= 0),
  wall_ms REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('control','source','transcript','transcript_unavailable','span','ad','frame','channel','transcription_choice')),
  body_json TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  UNIQUE (capture_id, client_seq)
) STRICT;
${appendOnly("capture_facts")}

CREATE TABLE frames (
  evidence_id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  frame_id TEXT NOT NULL,
  media_s REAL NOT NULL CHECK (media_s >= 0),
  width INTEGER NOT NULL CHECK (width BETWEEN 280 AND 1568),
  height INTEGER NOT NULL CHECK (height BETWEEN 280 AND 1568),
  path TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  UNIQUE (capture_id, frame_id)
) STRICT;
CREATE INDEX frames_by_source ON frames (source_id, media_s);
${appendOnly("frames")}

-- Copies of cited evidence, written in the save transaction. Content-addressed and insert-only.
CREATE TABLE evidence_snapshots (
  evidence_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('passage','frame')),
  source_id TEXT NOT NULL,
  start_s REAL NOT NULL CHECK (start_s >= 0),
  end_s REAL NOT NULL CHECK (end_s >= start_s),
  text TEXT,
  frame_path TEXT,
  created_ms INTEGER NOT NULL,
  CHECK ((kind = 'passage') = (text IS NOT NULL)),
  CHECK ((kind = 'frame') = (frame_path IS NOT NULL))
) STRICT;
${appendOnly("evidence_snapshots", "R16")}

-- Tombstones for evidence the user deleted. The only thing that lets cited evidence go.
CREATE TABLE evidence_deletions (
  evidence_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  deleted_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL UNIQUE
) STRICT;

-- R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry."
-- A live (not user-deleted) note citing a snapshot blocks its deletion unless the user tombstoned that evidence.
CREATE TRIGGER evidence_snapshots_r16 BEFORE DELETE ON evidence_snapshots
WHEN EXISTS (
    SELECT 1 FROM note_evidence ne
    WHERE ne.evidence_id = OLD.evidence_id
      AND NOT EXISTS (SELECT 1 FROM note_deletions nd WHERE nd.note_id = ne.note_id))
  AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.evidence_id = OLD.evidence_id)
BEGIN SELECT RAISE(ABORT, 'R16: evidence cited by a note is deleted only by the user'); END;

-- R16, pending saves count as citing: a review that has no saved record yet keeps its capture's raw evidence.
CREATE TRIGGER capture_facts_r16 BEFORE DELETE ON capture_facts
WHEN ${PENDING_SAVE_HOLDS("OLD.capture_id")}
BEGIN SELECT RAISE(ABORT, 'R16: raw evidence of an unsaved review is held'); END;

CREATE TRIGGER frames_r16 BEFORE DELETE ON frames
WHEN ${PENDING_SAVE_HOLDS("OLD.capture_id")}
  AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.evidence_id = OLD.evidence_id)
BEGIN SELECT RAISE(ABORT, 'R16: frames of an unsaved review are held'); END;`,
    },
    {
      id: "002-snapshot-fields",
      sql: `
-- A snapshot must rebuild a Passage or Frame after its raw facts expire, so it carries the fields 001 left out.
ALTER TABLE evidence_snapshots ADD COLUMN transcript_rev_id TEXT;
ALTER TABLE evidence_snapshots ADD COLUMN origin TEXT;
ALTER TABLE evidence_snapshots ADD COLUMN width INTEGER;
ALTER TABLE evidence_snapshots ADD COLUMN height INTEGER;
CREATE INDEX frames_by_capture ON frames (capture_id);`,
    },
  ],

  segmentation: [
    {
      id: "001-chunk-revisions",
      sql: `
CREATE TABLE chunk_revisions (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  material_json TEXT NOT NULL,
  windows_json TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('boundary','boundary_revised','time','session_end')),
  closed_at_seq INTEGER NOT NULL UNIQUE,
  supersedes TEXT REFERENCES chunk_revisions(id),
  UNIQUE (chunk_id, revision_no),
  CHECK ((revision_no = 1) = (supersedes IS NULL))
) STRICT;
CREATE INDEX chunk_revisions_by_capture ON chunk_revisions (capture_id, ordinal, revision_no);
${appendOnly("chunk_revisions")}`,
    },
  ],

  preparation: [
    {
      id: "001-claims-controls",
      sql: `
-- Index over interpretation memo outputs, so claims of a capture are found without scanning the memo.
CREATE TABLE claim_index (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  source_chunk_id TEXT NOT NULL,
  interpretation_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  concept_id TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  UNIQUE (interpretation_key, ordinal)
) STRICT;
CREATE INDEX claim_index_by_capture ON claim_index (capture_id);

CREATE TABLE concept_index (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE
) STRICT;

-- Stop early / retry facts. A result counts only if its memo seq precedes the covering stop_early.
CREATE TABLE prep_controls (
  seq INTEGER NOT NULL,
  capture_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('stop_early','retry')),
  chunk_revision_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (seq, chunk_revision_id)
) STRICT;
${appendOnly("prep_controls")}`,
    },
  ],

  review: [
    {
      id: "001-invites-reviews-turns",
      sql: `
CREATE TABLE invite_answers (
  seq INTEGER PRIMARY KEY,
  capture_id TEXT NOT NULL,
  answer TEXT NOT NULL CHECK (answer IN ('review_now','later','wait','stop_early')),
  watched_s REAL NOT NULL CHECK (watched_s >= 0),
  at_ms INTEGER NOT NULL
) STRICT;
${appendOnly("invite_answers")}

-- R7: "Once a review starts, its scope never grows; corrections can change claims inside it but can't add material."
-- The id is minted by the app, so a retried start inserts nothing.
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('prepared_only','stop_early')),
  scope_json TEXT NOT NULL,
  frozen_at_seq INTEGER NOT NULL UNIQUE,
  started_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX reviews_by_capture ON reviews (capture_id);
${appendOnly("reviews", "R7")}

CREATE TABLE review_turns (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  seq INTEGER NOT NULL UNIQUE,
  actor TEXT NOT NULL CHECK (actor IN ('learner','tutor','code')),
  thread_id TEXT,
  body_json TEXT NOT NULL,
  at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX review_turns_by_review ON review_turns (review_id, seq);
${appendOnly("review_turns")}`,
    },
  ],

  record: [
    {
      id: "001-learning-record",
      sql: `
-- Generated columns only; the save upserts these by stable id (R15). User edits live in note_edits (R8).
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  generated_json TEXT NOT NULL,
  saved_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX notes_by_review ON notes (review_id);

CREATE TABLE note_edits (
  note_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  edited_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE note_deletions (
  note_id TEXT PRIMARY KEY,
  deleted_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE note_evidence (
  note_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (note_id, evidence_id)
) STRICT;
CREATE INDEX note_evidence_by_evidence ON note_evidence (evidence_id);

-- R14: 'disputed' is code's clamp at read time, never a stored proposal or override.
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL,
  concept_ids_json TEXT NOT NULL,
  proposed TEXT NOT NULL CHECK (proposed IN (${OBSERVATION_STATUSES})),
  facts_json TEXT NOT NULL,
  saved_ms INTEGER NOT NULL,
  UNIQUE (review_id, thread_id)
) STRICT;

CREATE TABLE observation_decisions (
  observation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dispute_resolution','override')),
  value TEXT NOT NULL,
  decided_ms INTEGER NOT NULL,
  PRIMARY KEY (observation_id, kind),
  CHECK (kind <> 'dispute_resolution' OR value IN ('learner_was_right','it_was_my_gap')),
  CHECK (kind <> 'override' OR value IN (${OBSERVATION_STATUSES}))
) STRICT;

CREATE TABLE link_suggestions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  from_concept TEXT NOT NULL,
  to_concept TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('prerequisite_of','part_of','example_of','contrasts_with','related_to')),
  evidence_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  saved_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE link_decisions (
  link_id TEXT PRIMARY KEY,
  decision_json TEXT NOT NULL,
  decided_ms INTEGER NOT NULL
) STRICT;

-- A review with no row here is unsaved or save_pending; its capture's raw evidence is held (R16 triggers above).
CREATE TABLE saved_reviews (
  review_id TEXT PRIMARY KEY,
  bundle_hash TEXT NOT NULL,
  saved_ms INTEGER NOT NULL
) STRICT;`,
    },
  ],
};

/** Table name → owning module, read from the CREATE TABLE statements above. */
export function tableOwners(migrations: typeof MIGRATIONS = MIGRATIONS): ReadonlyMap<string, Owner> {
  const owners = new Map<string, Owner>();
  for (const owner of OWNERS) {
    for (const m of migrations[owner]) {
      for (const match of m.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) {
        const table = match[1]!;
        const prior = owners.get(table);
        if (prior && prior !== owner) throw new Error(`table ${table} declared by both ${prior} and ${owner}`);
        owners.set(table, owner);
      }
    }
  }
  owners.set("schema_migrations", "kernel");
  return owners;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Open (or create) the database and apply pending migrations in owner order.
 * `path` is a file path or ":memory:" for tests.
 */
export function openDb(path: string, migrations: typeof MIGRATIONS = MIGRATIONS): Db {
  const sql = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") sql.run("PRAGMA journal_mode = WAL");
  sql.run("PRAGMA foreign_keys = ON");
  sql.run("PRAGMA busy_timeout = 5000");

  sql.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    owner TEXT NOT NULL, id TEXT NOT NULL, sha256 TEXT NOT NULL, applied_ms INTEGER NOT NULL,
    PRIMARY KEY (owner, id)) STRICT`);
  const applied = sql.query<{ sha256: string }, [string, string]>("SELECT sha256 FROM schema_migrations WHERE owner = ? AND id = ?");
  const record = sql.query("INSERT INTO schema_migrations (owner, id, sha256, applied_ms) VALUES (?, ?, ?, ?)");

  tableOwners(migrations);
  for (const owner of OWNERS) {
    for (const m of migrations[owner]) {
      const hash = sha256(m.sql);
      const prior = applied.get(owner, m.id);
      if (prior) {
        if (prior.sha256 !== hash) throw new Error(`migration ${owner}/${m.id} changed after it was applied; append a new migration instead`);
        continue;
      }
      sql.transaction(() => {
        sql.run(m.sql);
        record.run(owner, m.id, hash, Date.now());
      })();
    }
  }

  const bump = sql.query<{ value: number }, []>("UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value");
  return {
    sql,
    nextSeq: () => asSeq(bump.get()!.value),
    tx: <T>(fn: () => T): T => sql.transaction(fn)(),
    close: () => sql.close(),
  };
}
