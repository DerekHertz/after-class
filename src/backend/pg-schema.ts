/**
 * The PostgreSQL schema, written fresh at the final shape of the SQLite migrations in migrations.ts (it does not replay
 * their history). One append-only array per owning module, as in migrations.ts: to change your tables, append a
 * migration to your own array. The runner in pg.ts refuses a migration whose text changed after it was applied.
 *
 * Differences from the SQLite schema, each one deliberate and pinned by test/pg-schema.test.ts:
 * - Seqs are per user (pg.ts `nextSeq`), so `seq_counter` is one row per user, and every key that held a Seq alone
 *   (`seq UNIQUE`, `seq PRIMARY KEY`, `frozen_at_seq UNIQUE`, `closed_at_seq UNIQUE`) leads with `user_id`.
 * - INTEGER is `bigint`, REAL is `double precision` (PostgreSQL `real` is 4 bytes), a `*_json` column is `jsonb`, and
 *   every text column sorts by bytes (`COLLATE "C"`), as SQLite does.
 * - A trigger condition lives in its PL/pgSQL body (PostgreSQL refuses a subquery in a trigger WHEN), and every
 *   append-only table refuses TRUNCATE, which fires no row trigger.
 */
import type { Migration, Owner } from "./migrations";

const TEXT = `text COLLATE "C"`;

const PURPOSES = `'boundary','frame_change','claim_check','interpretation','claim_revision','resource_search','tutor_turn','wrap_up','diagram_summary'`;
const OBSERVATION_STATUSES = `'independent','partial','after_help','unresolved','not_assessed'`;

/** No UPDATE and no TRUNCATE. `rule` prefixes the message, as in migrations.ts, so a test can match `/R17/`. */
const appendOnly = (table: string, rule?: string) => {
  const prefix = rule ? `${rule}: ` : "";
  return `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse('${prefix}${table} is append-only');
CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION refuse('${prefix}${table} is append-only and cannot be truncated');`;
};

const noDelete = (table: string) => `
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse('R17: usage events are never deleted');`;

export const PG_MIGRATIONS: { readonly [O in Owner]: readonly Migration[] } = {
  kernel: [
    {
      id: "001-baseline",
      sql: `
-- Raises its first trigger argument. Every refusal below is this function with its own message.
CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END $fn$;

CREATE TABLE users (
  id ${TEXT} PRIMARY KEY,
  created_ms bigint NOT NULL
);

-- One Seq counter per user. nextSeq takes it under the user's command lock, so a user's Seqs commit in order.
CREATE TABLE seq_counter (
  user_id ${TEXT} PRIMARY KEY REFERENCES users(id),
  value bigint NOT NULL CHECK (value >= 1)
);`,
    },
  ],

  providers: [
    {
      id: "001-baseline",
      sql: `
CREATE TABLE memo_inputs (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  key ${TEXT} NOT NULL,
  provider ${TEXT} NOT NULL CHECK (provider IN ('jev','claude')),
  purpose ${TEXT} NOT NULL CHECK (purpose IN (${PURPOSES})),
  version ${TEXT} NOT NULL,
  model ${TEXT} NOT NULL,
  input_json jsonb NOT NULL,
  first_seen_ms bigint NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE memo (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  key ${TEXT} NOT NULL,
  output_json jsonb NOT NULL,
  seq bigint NOT NULL,
  stored_ms bigint NOT NULL,
  PRIMARY KEY (user_id, key),
  UNIQUE (user_id, seq),
  FOREIGN KEY (user_id, key) REFERENCES memo_inputs(user_id, key)
);
${appendOnly("memo", "R8")}

CREATE TABLE memo_failures (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  key ${TEXT} NOT NULL,
  attempts bigint NOT NULL CHECK (attempts > 0),
  last_error ${TEXT} NOT NULL,
  seq bigint NOT NULL,
  terminal bigint NOT NULL CHECK (terminal IN (0, 1)),
  PRIMARY KEY (user_id, key),
  UNIQUE (user_id, seq),
  FOREIGN KEY (user_id, key) REFERENCES memo_inputs(user_id, key)
);

-- R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
CREATE TABLE usage_events (
  id ${TEXT} PRIMARY KEY,
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  memo_key ${TEXT} NOT NULL,
  capture_id ${TEXT},
  attempt_no bigint NOT NULL CHECK (attempt_no > 0),
  provider ${TEXT} NOT NULL CHECK (provider IN ('jev','claude')),
  model ${TEXT} NOT NULL,
  purpose ${TEXT} NOT NULL CHECK (purpose IN (${PURPOSES})),
  outcome ${TEXT} NOT NULL CHECK (outcome IN ('ok','error','aborted')),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens bigint CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cost_kind ${TEXT} NOT NULL CHECK (cost_kind IN ('measured','notional','estimated','unknown')),
  cost_usd double precision CHECK (cost_usd IS NULL OR cost_usd >= 0),
  cost_basis ${TEXT},
  cost_reason ${TEXT},
  started_ms bigint NOT NULL,
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  UNIQUE (user_id, memo_key, attempt_no),
  FOREIGN KEY (user_id, memo_key) REFERENCES memo_inputs(user_id, key),
  CHECK ((cost_kind = 'unknown') = (cost_usd IS NULL)),
  CHECK ((cost_kind = 'unknown') = (cost_reason IS NOT NULL)),
  CHECK ((cost_kind IN ('notional','estimated')) = (cost_basis IS NOT NULL))
);
CREATE INDEX usage_events_by_purpose ON usage_events (user_id, purpose, started_ms);
${appendOnly("usage_events", "R17")}
${noDelete("usage_events")}

-- R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
-- Text-to-speech has no memo key and no token counts. ElevenLabs bills characters at a plan-dependent rate, so the cost is unknown.
CREATE TABLE voice_usage_events (
  id ${TEXT} PRIMARY KEY,
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  provider ${TEXT} NOT NULL CHECK (provider IN ('elevenlabs')),
  model ${TEXT} NOT NULL,
  voice_id ${TEXT} NOT NULL,
  characters bigint NOT NULL CHECK (characters >= 0),
  outcome ${TEXT} NOT NULL CHECK (outcome IN ('ok','error','aborted')),
  cost_kind ${TEXT} NOT NULL CHECK (cost_kind = 'unknown'),
  cost_reason ${TEXT} NOT NULL,
  started_ms bigint NOT NULL,
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0)
);
${appendOnly("voice_usage_events", "R17")}
${noDelete("voice_usage_events")}`,
    },
  ],

  evidence: [
    {
      id: "001-baseline",
      sql: `
-- Frame bytes are stripped from body_json; they live in the frame store at frames.path.
CREATE TABLE capture_facts (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  seq bigint NOT NULL,
  capture_id ${TEXT} NOT NULL,
  client_seq bigint NOT NULL CHECK (client_seq >= 0),
  wall_ms double precision NOT NULL,
  kind ${TEXT} NOT NULL CHECK (kind IN ('control','source','transcript','transcript_unavailable','span','ad','frame','channel','transcription_choice')),
  body_json jsonb NOT NULL,
  received_ms bigint NOT NULL,
  PRIMARY KEY (user_id, seq),
  UNIQUE (user_id, capture_id, client_seq)
);
CREATE INDEX capture_facts_by_capture ON capture_facts (user_id, capture_id);
${appendOnly("capture_facts")}

CREATE TABLE frames (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  evidence_id ${TEXT} NOT NULL,
  capture_id ${TEXT} NOT NULL,
  source_id ${TEXT} NOT NULL,
  frame_id ${TEXT} NOT NULL,
  media_s double precision NOT NULL CHECK (media_s >= 0),
  width bigint NOT NULL CHECK (width BETWEEN 280 AND 1568),
  height bigint NOT NULL CHECK (height BETWEEN 280 AND 1568),
  path ${TEXT} NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (user_id, evidence_id),
  UNIQUE (user_id, seq),
  UNIQUE (user_id, capture_id, frame_id)
);
CREATE INDEX frames_by_source ON frames (user_id, source_id, media_s);
CREATE INDEX frames_by_capture ON frames (user_id, capture_id);
${appendOnly("frames")}

-- Copies of cited evidence, written in the save transaction. Content-addressed and insert-only.
CREATE TABLE evidence_snapshots (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  evidence_id ${TEXT} NOT NULL,
  kind ${TEXT} NOT NULL CHECK (kind IN ('passage','frame')),
  source_id ${TEXT} NOT NULL,
  start_s double precision NOT NULL CHECK (start_s >= 0),
  end_s double precision NOT NULL CHECK (end_s >= start_s),
  text ${TEXT},
  frame_path ${TEXT},
  created_ms bigint NOT NULL,
  transcript_rev_id ${TEXT},
  origin ${TEXT},
  width bigint,
  height bigint,
  PRIMARY KEY (user_id, evidence_id),
  CHECK ((kind = 'passage') = (text IS NOT NULL)),
  CHECK ((kind = 'frame') = (frame_path IS NOT NULL))
);
${appendOnly("evidence_snapshots", "R16")}

-- Tombstones for evidence the user deleted. The only thing that lets cited evidence go.
CREATE TABLE evidence_deletions (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  evidence_id ${TEXT} NOT NULL,
  request_id ${TEXT} NOT NULL,
  deleted_ms bigint NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (user_id, evidence_id),
  UNIQUE (user_id, seq)
);

-- A capture id belongs to the first user that ingests it, for good. Expiry never deletes it.
CREATE TABLE capture_owners (
  capture_id ${TEXT} PRIMARY KEY,
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  claimed_ms bigint NOT NULL
);
${appendOnly("capture_owners")}`,
    },
  ],

  segmentation: [
    {
      id: "001-baseline",
      sql: `
-- A chunk id derives from the capture id and a revision id from the chunk and its material, so two users who hold one
-- capture id make the same ids. The keys lead with user_id.
CREATE TABLE chunk_revisions (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  id ${TEXT} NOT NULL,
  chunk_id ${TEXT} NOT NULL,
  capture_id ${TEXT} NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  revision_no bigint NOT NULL CHECK (revision_no >= 1),
  material_json jsonb NOT NULL,
  windows_json jsonb NOT NULL,
  provenance ${TEXT} NOT NULL CHECK (provenance IN ('boundary','boundary_revised','time','session_end')),
  closed_at_seq bigint NOT NULL,
  supersedes ${TEXT},
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, closed_at_seq),
  UNIQUE (user_id, chunk_id, revision_no),
  FOREIGN KEY (user_id, supersedes) REFERENCES chunk_revisions(user_id, id),
  CHECK ((revision_no = 1) = (supersedes IS NULL))
);
CREATE INDEX chunk_revisions_by_capture ON chunk_revisions (user_id, capture_id, ordinal, revision_no);
${appendOnly("chunk_revisions")}`,
    },
  ],

  preparation: [
    {
      id: "001-baseline",
      sql: `
-- Index over interpretation memo outputs, so claims of a capture are found without scanning the memo.
CREATE TABLE claim_index (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  id ${TEXT} NOT NULL,
  capture_id ${TEXT} NOT NULL,
  source_chunk_id ${TEXT} NOT NULL,
  interpretation_key ${TEXT} NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  concept_id ${TEXT} NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, seq),
  UNIQUE (user_id, interpretation_key, ordinal)
);
CREATE INDEX claim_index_by_capture ON claim_index (user_id, capture_id);

CREATE TABLE concept_index (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  id ${TEXT} NOT NULL,
  label ${TEXT} NOT NULL,
  summary ${TEXT} NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, seq)
);

-- Stop early / retry facts. A result counts only if its memo seq precedes the covering stop_early.
CREATE TABLE prep_controls (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  seq bigint NOT NULL,
  capture_id ${TEXT} NOT NULL,
  action ${TEXT} NOT NULL CHECK (action IN ('stop_early','retry')),
  chunk_revision_id ${TEXT} NOT NULL,
  at_ms bigint NOT NULL,
  PRIMARY KEY (user_id, seq, chunk_revision_id)
);
CREATE INDEX prep_controls_by_capture ON prep_controls (user_id, capture_id, seq);
${appendOnly("prep_controls")}

-- A job's input, frozen when the job first runs. One row per (user, kind, subject).
-- R4: "A claim gets at most one revision; after that it's unverified." A revision row's subject is its claim.
-- memo_key has no foreign key: a frozen input is written before its memo row exists.
CREATE TABLE prep_inputs (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  kind ${TEXT} NOT NULL CHECK (kind IN ('interpretation','revision','resource_search')),
  subject_id ${TEXT} NOT NULL,
  capture_id ${TEXT} NOT NULL,
  memo_key ${TEXT} NOT NULL,
  input_json jsonb NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (user_id, kind, subject_id),
  UNIQUE (user_id, seq)
);
CREATE INDEX prep_inputs_by_capture ON prep_inputs (user_id, capture_id, kind, seq);
CREATE INDEX prep_inputs_by_key ON prep_inputs (user_id, memo_key);
${appendOnly("prep_inputs")}`,
    },
  ],

  review: [
    {
      id: "001-baseline",
      sql: `
CREATE TABLE invite_answers (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  seq bigint NOT NULL,
  capture_id ${TEXT} NOT NULL,
  answer ${TEXT} NOT NULL CHECK (answer IN ('review_now','later','wait','stop_early')),
  watched_s double precision NOT NULL CHECK (watched_s >= 0),
  at_ms bigint NOT NULL,
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX invite_answers_by_capture ON invite_answers (user_id, capture_id);
${appendOnly("invite_answers")}

-- R7: "Once a review starts, its scope never grows; corrections can change claims inside it but can't add material."
-- A review id is minted by the app and belongs to the first user that starts it, so id alone is the key.
CREATE TABLE reviews (
  id ${TEXT} PRIMARY KEY,
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  capture_id ${TEXT} NOT NULL,
  choice ${TEXT} NOT NULL CHECK (choice IN ('prepared_only','stop_early')),
  scope_json jsonb NOT NULL,
  frozen_at_seq bigint NOT NULL,
  started_ms bigint NOT NULL,
  UNIQUE (user_id, frozen_at_seq),
  UNIQUE (user_id, id)
);
CREATE INDEX reviews_by_capture ON reviews (user_id, capture_id);
${appendOnly("reviews", "R7")}

CREATE TABLE review_turns (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  id ${TEXT} NOT NULL,
  review_id ${TEXT} NOT NULL,
  seq bigint NOT NULL,
  actor ${TEXT} NOT NULL CHECK (actor IN ('learner','tutor','code')),
  thread_id ${TEXT},
  body_json jsonb NOT NULL,
  at_ms bigint NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, seq),
  FOREIGN KEY (user_id, review_id) REFERENCES reviews (user_id, id)
);
CREATE INDEX review_turns_by_review ON review_turns (user_id, review_id, seq);
${appendOnly("review_turns")}`,
    },
  ],

  record: [
    {
      id: "001-baseline",
      sql: `
-- Generated columns only; the save upserts these by stable id (R15). User edits live in note_edits (R8).
CREATE TABLE notes (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  id ${TEXT} NOT NULL,
  ord bigint NOT NULL,
  review_id ${TEXT} NOT NULL,
  concept_id ${TEXT} NOT NULL,
  generated_json jsonb NOT NULL,
  saved_ms bigint NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, ord)
);
CREATE INDEX notes_by_review ON notes (user_id, review_id);

CREATE TABLE note_edits (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  note_id ${TEXT} NOT NULL,
  text ${TEXT} NOT NULL,
  edited_ms bigint NOT NULL,
  PRIMARY KEY (user_id, note_id)
);

CREATE TABLE note_deletions (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  note_id ${TEXT} NOT NULL,
  deleted_ms bigint NOT NULL,
  PRIMARY KEY (user_id, note_id)
);

CREATE TABLE note_evidence (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  note_id ${TEXT} NOT NULL,
  evidence_id ${TEXT} NOT NULL,
  PRIMARY KEY (user_id, note_id, evidence_id)
);
CREATE INDEX note_evidence_by_evidence ON note_evidence (user_id, evidence_id);

-- R14: 'disputed' is code's clamp at read time, never a stored proposal or override.
CREATE TABLE observations (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  id ${TEXT} NOT NULL,
  ord bigint NOT NULL,
  review_id ${TEXT} NOT NULL,
  thread_id ${TEXT} NOT NULL,
  claim_ids_json jsonb NOT NULL,
  concept_ids_json jsonb NOT NULL,
  proposed ${TEXT} NOT NULL CHECK (proposed IN (${OBSERVATION_STATUSES})),
  facts_json jsonb NOT NULL,
  saved_ms bigint NOT NULL,
  assessable bigint NOT NULL DEFAULT 1 CHECK (assessable IN (0, 1)),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, ord),
  UNIQUE (user_id, review_id, thread_id)
);

CREATE TABLE observation_decisions (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  observation_id ${TEXT} NOT NULL,
  kind ${TEXT} NOT NULL CHECK (kind IN ('dispute_resolution','override')),
  value ${TEXT} NOT NULL,
  decided_ms bigint NOT NULL,
  PRIMARY KEY (user_id, observation_id, kind),
  CHECK (kind <> 'dispute_resolution' OR value IN ('learner_was_right','it_was_my_gap')),
  CHECK (kind <> 'override' OR value IN (${OBSERVATION_STATUSES}))
);

CREATE TABLE link_suggestions (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  id ${TEXT} NOT NULL,
  ord bigint NOT NULL,
  review_id ${TEXT} NOT NULL,
  from_concept ${TEXT} NOT NULL,
  to_concept ${TEXT} NOT NULL,
  type ${TEXT} NOT NULL CHECK (type IN ('prerequisite_of','part_of','example_of','contrasts_with','related_to')),
  evidence_json jsonb NOT NULL,
  rationale ${TEXT} NOT NULL,
  saved_ms bigint NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, ord)
);

CREATE TABLE link_decisions (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  link_id ${TEXT} NOT NULL,
  decision_json jsonb NOT NULL,
  decided_ms bigint NOT NULL,
  PRIMARY KEY (user_id, link_id)
);

-- A review with no row here is unsaved or save_pending; its capture's raw evidence is held (R16 triggers below).
CREATE TABLE saved_reviews (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  review_id ${TEXT} NOT NULL,
  bundle_hash ${TEXT} NOT NULL,
  saved_ms bigint NOT NULL,
  PRIMARY KEY (user_id, review_id)
);

-- A save that failed and has not succeeded since: what "save_pending" means, kept so a restart does not forget it.
CREATE TABLE save_failures (
  user_id ${TEXT} NOT NULL REFERENCES users(id),
  review_id ${TEXT} NOT NULL,
  error ${TEXT} NOT NULL,
  failed_ms bigint NOT NULL,
  PRIMARY KEY (user_id, review_id)
);

-- R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry."
-- A live note of the same user citing a snapshot holds it, unless that user tombstoned the evidence. A review with no
-- saved_reviews row of its own user holds its capture's raw facts and frames. The conditions read rows other
-- transactions may be writing, so every command that deletes evidence takes the user's command lock first (pg.ts).
CREATE FUNCTION evidence_snapshots_r16() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (
      SELECT 1 FROM note_evidence ne
      WHERE ne.user_id = OLD.user_id AND ne.evidence_id = OLD.evidence_id
        AND NOT EXISTS (SELECT 1 FROM note_deletions nd WHERE nd.user_id = ne.user_id AND nd.note_id = ne.note_id))
    AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.user_id = OLD.user_id AND d.evidence_id = OLD.evidence_id)
  THEN
    RAISE EXCEPTION 'R16: evidence cited by a note is deleted only by the user';
  END IF;
  RETURN OLD;
END $fn$;
CREATE TRIGGER evidence_snapshots_r16 BEFORE DELETE ON evidence_snapshots FOR EACH ROW EXECUTE FUNCTION evidence_snapshots_r16();

CREATE FUNCTION capture_facts_r16() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (
      SELECT 1 FROM reviews r
      WHERE r.user_id = OLD.user_id AND r.capture_id = OLD.capture_id
        AND NOT EXISTS (SELECT 1 FROM saved_reviews s WHERE s.user_id = r.user_id AND s.review_id = r.id))
  THEN
    RAISE EXCEPTION 'R16: raw evidence of an unsaved review is held';
  END IF;
  RETURN OLD;
END $fn$;
CREATE TRIGGER capture_facts_r16 BEFORE DELETE ON capture_facts FOR EACH ROW EXECUTE FUNCTION capture_facts_r16();

CREATE FUNCTION frames_r16() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (
      SELECT 1 FROM reviews r
      WHERE r.user_id = OLD.user_id AND r.capture_id = OLD.capture_id
        AND NOT EXISTS (SELECT 1 FROM saved_reviews s WHERE s.user_id = r.user_id AND s.review_id = r.id))
    AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.user_id = OLD.user_id AND d.evidence_id = OLD.evidence_id)
  THEN
    RAISE EXCEPTION 'R16: frames of an unsaved review are held';
  END IF;
  RETURN OLD;
END $fn$;
CREATE TRIGGER frames_r16 BEFORE DELETE ON frames FOR EACH ROW EXECUTE FUNCTION frames_r16();`,
    },
  ],
};
