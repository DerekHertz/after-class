/**
 * The evidence module's frame size column, kept beside migrations.ts because that file is at the lint line limit.
 * It is the last entry of the `evidence` array there.
 */
import type { Migration } from "./migrations";

export const FRAME_BYTES: Migration = {
  id: "005-frame-bytes",
  sql: `
-- The size of each frame file, so a user's stored bytes (the quota) is a sum over rows and falls when a frame is deleted.
-- Frames stored before this column read 0: their size is not in the database, and frames is append-only.
ALTER TABLE frames ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;`,
};
