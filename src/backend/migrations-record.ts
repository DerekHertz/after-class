/**
 * The record module's tenancy migration, kept beside migrations.ts because that file is at the lint line limit.
 * It is the last entry of the `record` array there.
 */
import { stableId } from "../shared/ids";
import type { Migration } from "./migrations";

export const OBSERVATION_STATUSES = `'independent','partial','after_help','unresolved','not_assessed'`;

export const RECORD_USER_ID: Migration = {
  id: "004-user-id",
  sql: `
-- Every record row belongs to a user. Notes and observations derive their ids from a review id, which is one user's, but a link id
-- derives from two concept ids that every user who watches the same lecture shares, so every key leads with user_id. Each table is
-- rebuilt like evidence/003-user-id: rows are saved, the tables dropped, made again with user_id, and the rows go back as the local user.
-- notes, observations and link_suggestions were read in insertion order through rowid; they get an ord column of their own instead
-- (numbered by rowid here, then one past the user's highest).
-- Existing rows can only be the local app's, so the local user's row is inserted here when there are any.
INSERT INTO users (id, created_ms)
SELECT '${stableId("usr", "local")}', COALESCE((SELECT MIN(saved_ms) FROM notes), (SELECT MIN(saved_ms) FROM saved_reviews),
  (SELECT MIN(failed_ms) FROM save_failures), (SELECT MIN(saved_ms) FROM observations), (SELECT MIN(saved_ms) FROM link_suggestions),
  (SELECT MIN(deleted_ms) FROM note_deletions), (SELECT MIN(edited_ms) FROM note_edits), (SELECT MIN(decided_ms) FROM observation_decisions),
  (SELECT MIN(decided_ms) FROM link_decisions), 0)
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = '${stableId("usr", "local")}')
  AND (EXISTS (SELECT 1 FROM notes) OR EXISTS (SELECT 1 FROM note_edits) OR EXISTS (SELECT 1 FROM note_deletions) OR EXISTS (SELECT 1 FROM note_evidence)
OR EXISTS (SELECT 1 FROM observations) OR EXISTS (SELECT 1 FROM observation_decisions) OR EXISTS (SELECT 1 FROM link_suggestions)
OR EXISTS (SELECT 1 FROM link_decisions) OR EXISTS (SELECT 1 FROM saved_reviews) OR EXISTS (SELECT 1 FROM save_failures));

CREATE TABLE notes_save AS SELECT ROW_NUMBER() OVER (ORDER BY rowid) AS ord, id, review_id, concept_id, generated_json, saved_ms FROM notes;
CREATE TABLE note_edits_save AS SELECT note_id, text, edited_ms FROM note_edits;
CREATE TABLE note_deletions_save AS SELECT note_id, deleted_ms FROM note_deletions;
CREATE TABLE note_evidence_save AS SELECT note_id, evidence_id FROM note_evidence;
CREATE TABLE observations_save AS SELECT ROW_NUMBER() OVER (ORDER BY rowid) AS ord, id, review_id, thread_id, claim_ids_json, concept_ids_json, proposed,
  facts_json, saved_ms, assessable FROM observations;
CREATE TABLE observation_decisions_save AS SELECT observation_id, kind, value, decided_ms FROM observation_decisions;
CREATE TABLE link_suggestions_save AS SELECT ROW_NUMBER() OVER (ORDER BY rowid) AS ord, id, review_id, from_concept, to_concept, type, evidence_json,
  rationale, saved_ms FROM link_suggestions;
CREATE TABLE link_decisions_save AS SELECT link_id, decision_json, decided_ms FROM link_decisions;
CREATE TABLE saved_reviews_save AS SELECT review_id, bundle_hash, saved_ms FROM saved_reviews;
CREATE TABLE save_failures_save AS SELECT review_id, error, failed_ms FROM save_failures;
DROP TABLE notes;
DROP TABLE note_edits;
DROP TABLE note_deletions;
DROP TABLE note_evidence;
DROP TABLE observations;
DROP TABLE observation_decisions;
DROP TABLE link_suggestions;
DROP TABLE link_decisions;
DROP TABLE saved_reviews;
DROP TABLE save_failures;

CREATE TABLE notes (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  generated_json TEXT NOT NULL,
  saved_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, ord)
) STRICT;
INSERT INTO notes (user_id, id, ord, review_id, concept_id, generated_json, saved_ms)
SELECT '${stableId("usr", "local")}', id, ord, review_id, concept_id, generated_json, saved_ms FROM notes_save;
CREATE INDEX notes_by_review ON notes (user_id, review_id);

CREATE TABLE note_edits (
  user_id TEXT NOT NULL REFERENCES users(id),
  note_id TEXT NOT NULL,
  text TEXT NOT NULL,
  edited_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, note_id)
) STRICT;
INSERT INTO note_edits (user_id, note_id, text, edited_ms) SELECT '${stableId("usr", "local")}', note_id, text, edited_ms FROM note_edits_save;

CREATE TABLE note_deletions (
  user_id TEXT NOT NULL REFERENCES users(id),
  note_id TEXT NOT NULL,
  deleted_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, note_id)
) STRICT;
INSERT INTO note_deletions (user_id, note_id, deleted_ms) SELECT '${stableId("usr", "local")}', note_id, deleted_ms FROM note_deletions_save;

CREATE TABLE note_evidence (
  user_id TEXT NOT NULL REFERENCES users(id),
  note_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (user_id, note_id, evidence_id)
) STRICT;
INSERT INTO note_evidence (user_id, note_id, evidence_id) SELECT '${stableId("usr", "local")}', note_id, evidence_id FROM note_evidence_save;
CREATE INDEX note_evidence_by_evidence ON note_evidence (user_id, evidence_id);

-- R14: 'disputed' is code's clamp at read time, never a stored proposal or override.
CREATE TABLE observations (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL,
  concept_ids_json TEXT NOT NULL,
  proposed TEXT NOT NULL CHECK (proposed IN (${OBSERVATION_STATUSES})),
  facts_json TEXT NOT NULL,
  saved_ms INTEGER NOT NULL,
  assessable INTEGER NOT NULL DEFAULT 1 CHECK (assessable IN (0, 1)),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, ord),
  UNIQUE (user_id, review_id, thread_id)
) STRICT;
INSERT INTO observations (user_id, id, ord, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms, assessable)
SELECT '${stableId("usr", "local")}', id, ord, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms, assessable FROM observations_save;

CREATE TABLE observation_decisions (
  user_id TEXT NOT NULL REFERENCES users(id),
  observation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dispute_resolution','override')),
  value TEXT NOT NULL,
  decided_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, observation_id, kind),
  CHECK (kind <> 'dispute_resolution' OR value IN ('learner_was_right','it_was_my_gap')),
  CHECK (kind <> 'override' OR value IN (${OBSERVATION_STATUSES}))
) STRICT;
INSERT INTO observation_decisions (user_id, observation_id, kind, value, decided_ms)
SELECT '${stableId("usr", "local")}', observation_id, kind, value, decided_ms FROM observation_decisions_save;

CREATE TABLE link_suggestions (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  from_concept TEXT NOT NULL,
  to_concept TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('prerequisite_of','part_of','example_of','contrasts_with','related_to')),
  evidence_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  saved_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, ord)
) STRICT;
INSERT INTO link_suggestions (user_id, id, ord, review_id, from_concept, to_concept, type, evidence_json, rationale, saved_ms)
SELECT '${stableId("usr", "local")}', id, ord, review_id, from_concept, to_concept, type, evidence_json, rationale, saved_ms FROM link_suggestions_save;

CREATE TABLE link_decisions (
  user_id TEXT NOT NULL REFERENCES users(id),
  link_id TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  decided_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, link_id)
) STRICT;
INSERT INTO link_decisions (user_id, link_id, decision_json, decided_ms) SELECT '${stableId("usr", "local")}', link_id, decision_json, decided_ms FROM link_decisions_save;

-- A review with no row here is unsaved or save_pending; its capture's raw evidence is held (R16 triggers).
CREATE TABLE saved_reviews (
  user_id TEXT NOT NULL REFERENCES users(id),
  review_id TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  saved_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, review_id)
) STRICT;
INSERT INTO saved_reviews (user_id, review_id, bundle_hash, saved_ms) SELECT '${stableId("usr", "local")}', review_id, bundle_hash, saved_ms FROM saved_reviews_save;

CREATE TABLE save_failures (
  user_id TEXT NOT NULL REFERENCES users(id),
  review_id TEXT NOT NULL,
  error TEXT NOT NULL,
  failed_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, review_id)
) STRICT;
INSERT INTO save_failures (user_id, review_id, error, failed_ms) SELECT '${stableId("usr", "local")}', review_id, error, failed_ms FROM save_failures_save;

DROP TABLE notes_save;
DROP TABLE note_edits_save;
DROP TABLE note_deletions_save;
DROP TABLE note_evidence_save;
DROP TABLE observations_save;
DROP TABLE observation_decisions_save;
DROP TABLE link_suggestions_save;
DROP TABLE link_decisions_save;
DROP TABLE saved_reviews_save;
DROP TABLE save_failures_save;

-- R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry." A note holds the snapshot of its own user
-- only, a deleted note of that user releases it, and a review is saved by its own user's saved_reviews row.
DROP TRIGGER evidence_snapshots_r16;
DROP TRIGGER capture_facts_r16;
DROP TRIGGER frames_r16;
CREATE TRIGGER evidence_snapshots_r16 BEFORE DELETE ON evidence_snapshots
WHEN EXISTS (
SELECT 1 FROM note_evidence ne
WHERE ne.user_id = OLD.user_id AND ne.evidence_id = OLD.evidence_id
  AND NOT EXISTS (SELECT 1 FROM note_deletions nd WHERE nd.user_id = ne.user_id AND nd.note_id = ne.note_id))
  AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.user_id = OLD.user_id AND d.evidence_id = OLD.evidence_id)
BEGIN SELECT RAISE(ABORT, 'R16: evidence cited by a note is deleted only by the user'); END;

CREATE TRIGGER capture_facts_r16 BEFORE DELETE ON capture_facts
WHEN EXISTS (
SELECT 1 FROM reviews r
WHERE r.user_id = OLD.user_id AND r.capture_id = OLD.capture_id
  AND NOT EXISTS (SELECT 1 FROM saved_reviews s WHERE s.user_id = r.user_id AND s.review_id = r.id))
BEGIN SELECT RAISE(ABORT, 'R16: raw evidence of an unsaved review is held'); END;

CREATE TRIGGER frames_r16 BEFORE DELETE ON frames
WHEN EXISTS (
SELECT 1 FROM reviews r
WHERE r.user_id = OLD.user_id AND r.capture_id = OLD.capture_id
  AND NOT EXISTS (SELECT 1 FROM saved_reviews s WHERE s.user_id = r.user_id AND s.review_id = r.id))
  AND NOT EXISTS (SELECT 1 FROM evidence_deletions d WHERE d.user_id = OLD.user_id AND d.evidence_id = OLD.evidence_id)
BEGIN SELECT RAISE(ABORT, 'R16: frames of an unsaved review are held'); END;`,
};
