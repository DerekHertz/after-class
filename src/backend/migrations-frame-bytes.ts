/**
 * The evidence module's size columns, kept beside migrations.ts because that file is at the lint line limit.
 * `SIZE_COLUMNS` closes the `evidence` array there.
 */
import type { Migration } from "./migrations";

export const FRAME_BYTES: Migration = {
  id: "005-frame-bytes",
  sql: `
-- The size of each frame file, so a user's stored bytes (the quota) is a sum over rows and falls when a frame is deleted.
-- Frames stored before this column read 0: their size is not in the database, and frames is append-only.
ALTER TABLE frames ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;`,
};

export const SNAPSHOT_BYTES: Migration = {
  id: "006-snapshot-bytes",
  sql: `
-- The size of a cited frame's file. A snapshot keeps its frame after raw expiry deletes the frames row, so without this the quota
-- stops counting bytes that stay on disk. Snapshots written before this column read 0, and evidence_snapshots is append-only.
ALTER TABLE evidence_snapshots ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;`,
};

export const SIZE_COLUMNS: readonly Migration[] = [FRAME_BYTES, SNAPSHOT_BYTES];
