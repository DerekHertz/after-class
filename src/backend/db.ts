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
import { stableId } from "../shared/ids";
import type { UserId } from "../shared/ids";

export type Db = {
  readonly sql: Database;
  /** Monotonic across every fact table. Rolled back with its transaction, so a Seq is never handed out twice. */
  nextSeq(): Seq;
  tx<T>(fn: () => T): T;
  close(): void;
};

/** A `Db` bound to the user whose data the holder may touch. Modules move from `Db` to `UserDb` one at a time. */
export type UserDb = Db & { readonly userId: UserId };

export const OWNERS = ["kernel", "providers", "evidence", "segmentation", "preparation", "review", "record"] as const;
export type Owner = (typeof OWNERS)[number];

export type Migration = { readonly id: string; readonly sql: string };

/** Only the db mints Seqs; rows read back carry them as plain integers. */
export function asSeq(n: number): Seq {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`asSeq: ${n}`);
  return n as Seq;
}

const PURPOSES = `'boundary','frame_change','claim_check','interpretation','claim_revision','resource_search','tutor_turn','wrap_up'`;
/** 003-diagram-purpose adds "diagram_summary"; 001 keeps the list it was applied with (its text is hashed). */
const PURPOSES_WITH_DIAGRAM = `${PURPOSES},'diagram_summary'`;
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
    {
      id: "002-users",
      sql: `
-- One row per person. The local app has exactly one, inserted by ensureLocalUser at boot and not by this migration,
-- so an upgraded database and a fresh one take the same path.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL
) STRICT;`,
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
    {
      id: "002-voice-usage",
      sql: `
-- R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
-- Text-to-speech has no memo key and no token counts, so its calls get their own table instead of a rebuild of
-- usage_events (whose provider and purpose CHECKs are frozen). ElevenLabs bills characters at a plan-dependent rate,
-- so the cost is stored as unknown, with the characters sent.
CREATE TABLE voice_usage_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('elevenlabs')),
  model TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  characters INTEGER NOT NULL CHECK (characters >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','error','aborted')),
  cost_kind TEXT NOT NULL CHECK (cost_kind = 'unknown'),
  cost_reason TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
) STRICT;
${appendOnly("voice_usage_events", "R17")}
CREATE TRIGGER voice_usage_events_no_delete BEFORE DELETE ON voice_usage_events
BEGIN SELECT RAISE(ABORT, 'R17: usage events are never deleted'); END;`,
    },
    {
      id: "003-diagram-purpose",
      sql: `
-- The purpose CHECKs of memo_inputs and usage_events are frozen text, so adding "diagram_summary" rebuilds both tables
-- with every row copied and every trigger and index put back. memo and memo_failures point at memo_inputs, so the foreign
-- key check waits until the transaction ends; the rows go back into the new memo_inputs before it does.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE memo_inputs_save AS SELECT * FROM memo_inputs;
CREATE TABLE usage_events_save AS SELECT * FROM usage_events;
DROP TABLE usage_events;
DROP TABLE memo_inputs;

CREATE TABLE memo_inputs (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('jev','claude')),
  purpose TEXT NOT NULL CHECK (purpose IN (${PURPOSES_WITH_DIAGRAM})),
  version TEXT NOT NULL,
  model TEXT NOT NULL,
  input_json TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL
) STRICT;
INSERT INTO memo_inputs SELECT key, provider, purpose, version, model, input_json, first_seen_ms FROM memo_inputs_save;

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  memo_key TEXT NOT NULL REFERENCES memo_inputs(key),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  provider TEXT NOT NULL CHECK (provider IN ('jev','claude')),
  model TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (${PURPOSES_WITH_DIAGRAM})),
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
INSERT INTO usage_events SELECT id, memo_key, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens, cache_read_tokens,
  cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms FROM usage_events_save;
DROP TABLE usage_events_save;
DROP TABLE memo_inputs_save;
CREATE INDEX usage_events_by_purpose ON usage_events (purpose, started_ms);
${appendOnly("usage_events", "R17")}
CREATE TRIGGER usage_events_no_delete BEFORE DELETE ON usage_events
BEGIN SELECT RAISE(ABORT, 'R17: usage events are never deleted'); END;`,
    },
    {
      id: "004-user-id",
      sql: `
-- Phase 1 tenancy: every row of the five per-user providers tables names its user. SQLite cannot add a NOT NULL column
-- that references users(id), so each table is rebuilt: saved, dropped, recreated with user_id, refilled with every row
-- under the local user, with every CHECK, index and trigger put back. The memo key stays a hash of the call alone, so a
-- recorded key still hits; the row is keyed by (user_id, key), which is what keeps two users from sharing a memo row.
-- The local user row exists before the copy: ensureLocalUser runs after openDb, so a database with rows gets it here.
-- usage_events also gains capture_id, null when the caller had no capture.
PRAGMA defer_foreign_keys = ON;

INSERT INTO users (id, created_ms)
SELECT '${stableId("usr", "local")}', CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE (EXISTS (SELECT 1 FROM memo_inputs) OR EXISTS (SELECT 1 FROM voice_usage_events))
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = '${stableId("usr", "local")}');

CREATE TABLE memo_inputs_save AS SELECT key, provider, purpose, version, model, input_json, first_seen_ms FROM memo_inputs;
CREATE TABLE memo_save AS SELECT key, output_json, seq, stored_ms FROM memo;
CREATE TABLE memo_failures_save AS SELECT key, attempts, last_error, seq, terminal FROM memo_failures;
CREATE TABLE usage_events_save AS SELECT id, memo_key, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens,
  cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms FROM usage_events;
CREATE TABLE voice_usage_events_save AS SELECT id, provider, model, voice_id, characters, outcome, cost_kind, cost_reason, started_ms, duration_ms
  FROM voice_usage_events;
DROP TABLE usage_events;
DROP TABLE memo;
DROP TABLE memo_failures;
DROP TABLE memo_inputs;
DROP TABLE voice_usage_events;

CREATE TABLE memo_inputs (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('jev','claude')),
  purpose TEXT NOT NULL CHECK (purpose IN (${PURPOSES_WITH_DIAGRAM})),
  version TEXT NOT NULL,
  model TEXT NOT NULL,
  input_json TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
) STRICT;
INSERT INTO memo_inputs (user_id, key, provider, purpose, version, model, input_json, first_seen_ms)
SELECT '${stableId("usr", "local")}', key, provider, purpose, version, model, input_json, first_seen_ms FROM memo_inputs_save;

CREATE TABLE memo (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  output_json TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  stored_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id, key) REFERENCES memo_inputs(user_id, key)
) STRICT;
INSERT INTO memo (user_id, key, output_json, seq, stored_ms)
SELECT '${stableId("usr", "local")}', key, output_json, seq, stored_ms FROM memo_save;
${appendOnly("memo", "R8")}

CREATE TABLE memo_failures (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  last_error TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id, key) REFERENCES memo_inputs(user_id, key)
) STRICT;
INSERT INTO memo_failures (user_id, key, attempts, last_error, seq, terminal)
SELECT '${stableId("usr", "local")}', key, attempts, last_error, seq, terminal FROM memo_failures_save;

-- R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  memo_key TEXT NOT NULL,
  capture_id TEXT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  provider TEXT NOT NULL CHECK (provider IN ('jev','claude')),
  model TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (${PURPOSES_WITH_DIAGRAM})),
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
  UNIQUE (user_id, memo_key, attempt_no),
  FOREIGN KEY (user_id, memo_key) REFERENCES memo_inputs(user_id, key),
  CHECK ((cost_kind = 'unknown') = (cost_usd IS NULL)),
  CHECK ((cost_kind = 'unknown') = (cost_reason IS NOT NULL)),
  CHECK ((cost_kind IN ('notional','estimated')) = (cost_basis IS NOT NULL))
) STRICT;
INSERT INTO usage_events (id, user_id, memo_key, capture_id, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens,
  cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
SELECT id, '${stableId("usr", "local")}', memo_key, NULL, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens,
  cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms FROM usage_events_save;
CREATE INDEX usage_events_by_purpose ON usage_events (user_id, purpose, started_ms);
${appendOnly("usage_events", "R17")}
CREATE TRIGGER usage_events_no_delete BEFORE DELETE ON usage_events
BEGIN SELECT RAISE(ABORT, 'R17: usage events are never deleted'); END;

-- R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
CREATE TABLE voice_usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('elevenlabs')),
  model TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  characters INTEGER NOT NULL CHECK (characters >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','error','aborted')),
  cost_kind TEXT NOT NULL CHECK (cost_kind = 'unknown'),
  cost_reason TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
) STRICT;
INSERT INTO voice_usage_events (id, user_id, provider, model, voice_id, characters, outcome, cost_kind, cost_reason, started_ms, duration_ms)
SELECT id, '${stableId("usr", "local")}', provider, model, voice_id, characters, outcome, cost_kind, cost_reason, started_ms, duration_ms
FROM voice_usage_events_save;
${appendOnly("voice_usage_events", "R17")}
CREATE TRIGGER voice_usage_events_no_delete BEFORE DELETE ON voice_usage_events
BEGIN SELECT RAISE(ABORT, 'R17: usage events are never deleted'); END;

DROP TABLE usage_events_save;
DROP TABLE memo_failures_save;
DROP TABLE memo_save;
DROP TABLE memo_inputs_save;
DROP TABLE voice_usage_events_save;`,
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
    {
      id: "003-user-id",
      sql: `
-- Every evidence row belongs to a user. SQLite cannot add a NOT NULL column that references users, and the keys widen to
-- (user_id, ...) because passage evidence ids are derived from the transcript, so two users who watch the same video and
-- interval get the same id. Each table is rebuilt: rows are saved, the table and its triggers are dropped (DROP does not fire
-- triggers), the table is made again with user_id, and the rows go back as the local user.
-- Existing rows can only be the local app's, so the local user's row is inserted here when there is any evidence to attach it to.
-- A fresh database gets its user from ensureLocalUser at boot, as before.
INSERT INTO users (id, created_ms)
SELECT '${stableId("usr", "local")}', COALESCE((SELECT MIN(received_ms) FROM capture_facts), (SELECT MIN(created_ms) FROM evidence_snapshots),
  (SELECT MIN(deleted_ms) FROM evidence_deletions), 0)
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = '${stableId("usr", "local")}')
  AND (EXISTS (SELECT 1 FROM capture_facts) OR EXISTS (SELECT 1 FROM frames) OR EXISTS (SELECT 1 FROM evidence_snapshots)
    OR EXISTS (SELECT 1 FROM evidence_deletions));

CREATE TABLE capture_facts_save AS SELECT seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms FROM capture_facts;
CREATE TABLE frames_save AS SELECT evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq FROM frames;
CREATE TABLE evidence_snapshots_save AS SELECT evidence_id, kind, source_id, start_s, end_s, text, frame_path, created_ms, transcript_rev_id, origin,
  width, height FROM evidence_snapshots;
CREATE TABLE evidence_deletions_save AS SELECT evidence_id, request_id, deleted_ms, seq FROM evidence_deletions;
DROP TABLE capture_facts;
DROP TABLE frames;
DROP TABLE evidence_snapshots;
DROP TABLE evidence_deletions;

CREATE TABLE capture_facts (
  seq INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  capture_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL CHECK (client_seq >= 0),
  wall_ms REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('control','source','transcript','transcript_unavailable','span','ad','frame','channel','transcription_choice')),
  body_json TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  UNIQUE (user_id, capture_id, client_seq)
) STRICT;
INSERT INTO capture_facts (seq, user_id, capture_id, client_seq, wall_ms, kind, body_json, received_ms)
SELECT seq, '${stableId("usr", "local")}', capture_id, client_seq, wall_ms, kind, body_json, received_ms FROM capture_facts_save ORDER BY seq;
CREATE INDEX capture_facts_by_capture ON capture_facts (user_id, capture_id);
${appendOnly("capture_facts")}

CREATE TABLE frames (
  user_id TEXT NOT NULL REFERENCES users(id),
  evidence_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  frame_id TEXT NOT NULL,
  media_s REAL NOT NULL CHECK (media_s >= 0),
  width INTEGER NOT NULL CHECK (width BETWEEN 280 AND 1568),
  height INTEGER NOT NULL CHECK (height BETWEEN 280 AND 1568),
  path TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (user_id, evidence_id),
  UNIQUE (user_id, capture_id, frame_id)
) STRICT;
INSERT INTO frames (user_id, evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq)
SELECT '${stableId("usr", "local")}', evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq FROM frames_save ORDER BY seq;
CREATE INDEX frames_by_source ON frames (user_id, source_id, media_s);
CREATE INDEX frames_by_capture ON frames (user_id, capture_id);
${appendOnly("frames")}

CREATE TABLE evidence_snapshots (
  user_id TEXT NOT NULL REFERENCES users(id),
  evidence_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('passage','frame')),
  source_id TEXT NOT NULL,
  start_s REAL NOT NULL CHECK (start_s >= 0),
  end_s REAL NOT NULL CHECK (end_s >= start_s),
  text TEXT,
  frame_path TEXT,
  created_ms INTEGER NOT NULL,
  transcript_rev_id TEXT,
  origin TEXT,
  width INTEGER,
  height INTEGER,
  PRIMARY KEY (user_id, evidence_id),
  CHECK ((kind = 'passage') = (text IS NOT NULL)),
  CHECK ((kind = 'frame') = (frame_path IS NOT NULL))
) STRICT;
INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, text, frame_path, created_ms, transcript_rev_id, origin, width, height)
SELECT '${stableId("usr", "local")}', evidence_id, kind, source_id, start_s, end_s, text, frame_path, created_ms, transcript_rev_id, origin, width, height
FROM evidence_snapshots_save;
${appendOnly("evidence_snapshots", "R16")}

CREATE TABLE evidence_deletions (
  user_id TEXT NOT NULL REFERENCES users(id),
  evidence_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  deleted_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (user_id, evidence_id)
) STRICT;
INSERT INTO evidence_deletions (user_id, evidence_id, request_id, deleted_ms, seq)
SELECT '${stableId("usr", "local")}', evidence_id, request_id, deleted_ms, seq FROM evidence_deletions_save ORDER BY seq;

DROP TABLE capture_facts_save;
DROP TABLE frames_save;
DROP TABLE evidence_snapshots_save;
DROP TABLE evidence_deletions_save;

-- R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry."
-- Same triggers as 001, with the user's own tombstone as the release. note_evidence and reviews have no user_id until the
-- record and review migrations, so a note or review of another user that cites the same evidence id also holds it: the
-- safe direction, and record's migration narrows it.
CREATE TRIGGER evidence_snapshots_r16 BEFORE DELETE ON evidence_snapshots
WHEN EXISTS (
    SELECT 1 FROM note_evidence ne
    WHERE ne.evidence_id = OLD.evidence_id
      AND NOT EXISTS (SELECT 1 FROM note_deletions nd WHERE nd.note_id = ne.note_id))
  AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.user_id = OLD.user_id AND d.evidence_id = OLD.evidence_id)
BEGIN SELECT RAISE(ABORT, 'R16: evidence cited by a note is deleted only by the user'); END;

CREATE TRIGGER capture_facts_r16 BEFORE DELETE ON capture_facts
WHEN ${PENDING_SAVE_HOLDS("OLD.capture_id")}
BEGIN SELECT RAISE(ABORT, 'R16: raw evidence of an unsaved review is held'); END;

CREATE TRIGGER frames_r16 BEFORE DELETE ON frames
WHEN ${PENDING_SAVE_HOLDS("OLD.capture_id")}
  AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.user_id = OLD.user_id AND d.evidence_id = OLD.evidence_id)
BEGIN SELECT RAISE(ABORT, 'R16: frames of an unsaved review are held'); END;`,
    },
    {
      id: "004-capture-owners",
      sql: `
-- A capture id belongs to the first user that ingests it, for good. Frame evidence ids and file paths derive from the capture id,
-- so this keeps them unique to one user even after expiry deletes the capture's facts. Backfilled from the rows that exist.
CREATE TABLE capture_owners (
  capture_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  claimed_ms INTEGER NOT NULL
) STRICT;
INSERT INTO capture_owners (capture_id, user_id, claimed_ms)
SELECT capture_id, MIN(user_id), MIN(received_ms) FROM capture_facts GROUP BY capture_id;
INSERT INTO capture_owners (capture_id, user_id, claimed_ms)
SELECT capture_id, MIN(user_id), 0 FROM frames
WHERE capture_id NOT IN (SELECT capture_id FROM capture_owners) GROUP BY capture_id;
${appendOnly("capture_owners")}`,
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
    {
      id: "002-frozen-inputs",
      sql: `
-- A job's input, frozen when the job first runs: later evidence changes (frame judgments, deletions,
-- a retried check) never re-key work that already started. One row per (kind, subject).
-- R4: "A claim gets at most one revision; after that it's unverified." A revision row's subject is its claim.
CREATE TABLE prep_inputs (
  kind TEXT NOT NULL CHECK (kind IN ('interpretation','revision','resource_search')),
  subject_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  memo_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (kind, subject_id)
) STRICT;
CREATE INDEX prep_inputs_by_capture ON prep_inputs (capture_id, kind, seq);
CREATE INDEX prep_inputs_by_key ON prep_inputs (memo_key);
${appendOnly("prep_inputs")}`,
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
    {
      id: "002-user-id",
      sql: `
-- Every review row belongs to a user. A review id is minted by the app and stays unique across users, because the tutor and
-- code turn ids, the notes and the observations are derived from it; the user_id column records whose it is, and a review is
-- never deleted, so that ownership cannot lapse. A turn id is minted by the app too and may repeat across users, so turns key by
-- (user_id, id), and a turn must belong to a review of the same user. Rebuilt like evidence/003-user-id: rows are saved, the
-- tables and their triggers dropped (DROP does not fire triggers), made again with user_id, and the rows go back as the local user.
-- Existing rows can only be the local app's, so the local user's row is inserted here when there are any; a fresh database
-- gets its user from ensureLocalUser at boot.
INSERT INTO users (id, created_ms)
SELECT '${stableId("usr", "local")}', COALESCE((SELECT MIN(at_ms) FROM invite_answers), (SELECT MIN(started_ms) FROM reviews),
  (SELECT MIN(at_ms) FROM review_turns), 0)
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = '${stableId("usr", "local")}')
  AND (EXISTS (SELECT 1 FROM invite_answers) OR EXISTS (SELECT 1 FROM reviews) OR EXISTS (SELECT 1 FROM review_turns));

CREATE TABLE invite_answers_save AS SELECT seq, capture_id, answer, watched_s, at_ms FROM invite_answers;
CREATE TABLE reviews_save AS SELECT id, capture_id, choice, scope_json, frozen_at_seq, started_ms FROM reviews;
CREATE TABLE review_turns_save AS SELECT id, review_id, seq, actor, thread_id, body_json, at_ms FROM review_turns;
DROP TABLE review_turns;
DROP TABLE reviews;
DROP TABLE invite_answers;

CREATE TABLE invite_answers (
  seq INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  capture_id TEXT NOT NULL,
  answer TEXT NOT NULL CHECK (answer IN ('review_now','later','wait','stop_early')),
  watched_s REAL NOT NULL CHECK (watched_s >= 0),
  at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO invite_answers (seq, user_id, capture_id, answer, watched_s, at_ms)
SELECT seq, '${stableId("usr", "local")}', capture_id, answer, watched_s, at_ms FROM invite_answers_save ORDER BY seq;
CREATE INDEX invite_answers_by_capture ON invite_answers (user_id, capture_id);
${appendOnly("invite_answers")}

-- R7: "Once a review starts, its scope never grows; corrections can change claims inside it but can't add material."
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  capture_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('prepared_only','stop_early')),
  scope_json TEXT NOT NULL,
  frozen_at_seq INTEGER NOT NULL UNIQUE,
  started_ms INTEGER NOT NULL,
  UNIQUE (user_id, id)
) STRICT;
INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms)
SELECT id, '${stableId("usr", "local")}', capture_id, choice, scope_json, frozen_at_seq, started_ms FROM reviews_save ORDER BY frozen_at_seq;
CREATE INDEX reviews_by_capture ON reviews (user_id, capture_id);
${appendOnly("reviews", "R7")}

CREATE TABLE review_turns (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  actor TEXT NOT NULL CHECK (actor IN ('learner','tutor','code')),
  thread_id TEXT,
  body_json TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, review_id) REFERENCES reviews (user_id, id)
) STRICT;
INSERT INTO review_turns (user_id, id, review_id, seq, actor, thread_id, body_json, at_ms)
SELECT '${stableId("usr", "local")}', id, review_id, seq, actor, thread_id, body_json, at_ms FROM review_turns_save ORDER BY seq;
CREATE INDEX review_turns_by_review ON review_turns (user_id, review_id, seq);
${appendOnly("review_turns")}

DROP TABLE invite_answers_save;
DROP TABLE reviews_save;
DROP TABLE review_turns_save;

-- R16: the raw evidence of an unsaved review is held. Same triggers as evidence/003, now holding only for a review of the same user.
-- saved_reviews has no user_id until record/004-user-id, which narrows its half of the condition.
DROP TRIGGER capture_facts_r16;
DROP TRIGGER frames_r16;
CREATE TRIGGER capture_facts_r16 BEFORE DELETE ON capture_facts
WHEN EXISTS (
    SELECT 1 FROM reviews r
    WHERE r.user_id = OLD.user_id AND r.capture_id = OLD.capture_id
      AND NOT EXISTS (SELECT 1 FROM saved_reviews s WHERE s.review_id = r.id))
BEGIN SELECT RAISE(ABORT, 'R16: raw evidence of an unsaved review is held'); END;

CREATE TRIGGER frames_r16 BEFORE DELETE ON frames
WHEN EXISTS (
    SELECT 1 FROM reviews r
    WHERE r.user_id = OLD.user_id AND r.capture_id = OLD.capture_id
      AND NOT EXISTS (SELECT 1 FROM saved_reviews s WHERE s.review_id = r.id))
  AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.user_id = OLD.user_id AND d.evidence_id = OLD.evidence_id)
BEGIN SELECT RAISE(ABORT, 'R16: frames of an unsaved review are held'); END;`,
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
    {
      id: "002-observation-assessable",
      sql: `
-- R3: whether every claim the thread asked about was still assessable when the review was saved.
ALTER TABLE observations ADD COLUMN assessable INTEGER NOT NULL DEFAULT 1 CHECK (assessable IN (0, 1));`,
    },
    {
      id: "003-save-failures",
      sql: `
-- A save that failed and has not succeeded since: what "save_pending" means, kept so a restart does not forget it.
-- A review is saved when saved_reviews has its row, whatever this table says.
CREATE TABLE save_failures (
  review_id TEXT PRIMARY KEY,
  error TEXT NOT NULL,
  failed_ms INTEGER NOT NULL
) STRICT;`,
    },
  ],
};

export type TableScope = "user" | "shared" | "identity";

/**
 * Whether a table's rows belong to one user. Every table must appear here (test/db.test.ts), so a new table has to
 * pick a side. "user" tables get a `user_id` column in the Phase 1 PRs, one per owning module, and the boundary test
 * for them follows. "shared" tables hold lecture-derived or process-wide rows. "identity" is `users` itself.
 */
export const TABLE_SCOPES: { readonly [table: string]: TableScope } = {
  users: "identity",
  seq_counter: "shared", // becomes a per-user sequence row in the Postgres phase
  schema_migrations: "shared",
  // The memo mixes lecture-derived rows with tutor_turn and wrap_up rows that hold a learner's answers, dialogue and notes,
  // so it is per-user until the budget phase moves lecture-only purposes into a separate shared cache.
  memo_inputs: "user",
  memo: "user",
  memo_failures: "user",
  usage_events: "user",
  voice_usage_events: "user",
  capture_facts: "user",
  frames: "user",
  evidence_snapshots: "user",
  evidence_deletions: "user",
  capture_owners: "user",
  chunk_revisions: "user",
  claim_index: "user",
  concept_index: "user", // content-derived, but carries a per-pipeline seq
  prep_controls: "user",
  prep_inputs: "user",
  invite_answers: "user",
  reviews: "user",
  review_turns: "user",
  notes: "user",
  note_edits: "user",
  note_deletions: "user",
  note_evidence: "user",
  observations: "user",
  observation_decisions: "user",
  link_suggestions: "user",
  link_decisions: "user",
  saved_reviews: "user",
  save_failures: "user",
};

/** The local app's only user. Derived, so every boot on every machine names it the same. */
export const LOCAL_USER: UserId = stableId("usr", "local");

/** Insert the local user if absent and return its id. Idempotent. A hosted deployment maps its accounts to rows instead. */
export function ensureLocalUser(db: Db): UserId {
  db.sql.query("INSERT OR IGNORE INTO users (id, created_ms) VALUES (?, ?)").run(LOCAL_USER, Date.now());
  return LOCAL_USER;
}

/** Bind a handle to a user that has a `users` row. The handle shares the connection and the Seq counter. */
export function scopeDb(db: Db, userId: UserId): UserDb {
  const known = db.sql.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get(userId);
  if (!known) throw new Error(`scopeDb: no such user ${userId}`);
  return { sql: db.sql, nextSeq: () => db.nextSeq(), tx: (fn) => db.tx(fn), close: () => db.close(), userId };
}

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
