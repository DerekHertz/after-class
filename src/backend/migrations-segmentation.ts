/**
 * The segmentation module's migrations, kept apart from migrations.ts because that file is at the lint line limit.
 */
import { stableId } from "../shared/ids";
import type { Migration } from "./migrations";
import { appendOnly } from "./migrations-sql";

export const SEGMENTATION: readonly Migration[] = [
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
  {
    id: "002-user-id",
    sql: `
-- Phase 1 tenancy: every chunk revision names its user. SQLite cannot add a NOT NULL column that references users(id),
-- so the table is saved, dropped, recreated and refilled under the local user, with its CHECKs, index and append-only
-- trigger put back. A chunk id derives from the capture id and a revision id from the chunk and its material, so two
-- users who hold one capture id make the same ids. The keys therefore lead with user_id, and the id stays as derived.
-- The local user row exists before the copy: ensureLocalUser runs after openDb, so a database with rows gets it here.
PRAGMA defer_foreign_keys = ON;

INSERT INTO users (id, created_ms)
SELECT '${stableId("usr", "local")}', CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM chunk_revisions)
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = '${stableId("usr", "local")}');

CREATE TABLE chunk_revisions_save AS SELECT id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance,
  closed_at_seq, supersedes FROM chunk_revisions;
DROP TABLE chunk_revisions;

CREATE TABLE chunk_revisions (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  material_json TEXT NOT NULL,
  windows_json TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('boundary','boundary_revised','time','session_end')),
  closed_at_seq INTEGER NOT NULL UNIQUE,
  supersedes TEXT,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, chunk_id, revision_no),
  FOREIGN KEY (user_id, supersedes) REFERENCES chunk_revisions(user_id, id),
  CHECK ((revision_no = 1) = (supersedes IS NULL))
) STRICT;
INSERT INTO chunk_revisions (user_id, id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq, supersedes)
SELECT '${stableId("usr", "local")}', id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq, supersedes
FROM chunk_revisions_save;
DROP TABLE chunk_revisions_save;
CREATE INDEX chunk_revisions_by_capture ON chunk_revisions (user_id, capture_id, ordinal, revision_no);
${appendOnly("chunk_revisions")}`,
  },
  {
    id: "003-plain-first-cap",
    sql: `
-- Captures planned before the first chunk had its own cap (#247). They keep the plain cap, so a stored lecture is never
-- re-planned under the shorter one and its prepared chunks and reviews stay as they are.
CREATE TABLE plain_first_cap_captures (
  user_id TEXT NOT NULL REFERENCES users(id),
  capture_id TEXT NOT NULL,
  PRIMARY KEY (user_id, capture_id)
) STRICT;
INSERT INTO plain_first_cap_captures (user_id, capture_id) SELECT DISTINCT user_id, capture_id FROM chunk_revisions;`,
  },
];
