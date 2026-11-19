/**
 * The preparation module's ask record, kept beside migrations.ts because that file is at the lint line limit.
 * It is the last entry of the `preparation` array there.
 */
import type { Migration } from "./migrations";
import { appendOnly } from "./migrations-sql";

export const PREP_ASKS: Migration = {
  id: "004-prep-asks",
  sql: `
-- Lazy preparation (flow C, amendment of 2026-11-18): a lecture's chunks wait for Claude until the learner asks for its review with
-- Review now or Wait. One row per asked lecture, written once, so asking again changes nothing and a restart keeps the ask.
CREATE TABLE prep_asks (
  user_id TEXT NOT NULL REFERENCES users(id),
  capture_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, capture_id)
) STRICT;
-- A lecture whose preparation started under the old flow counts as asked, so its work goes on after the upgrade.
INSERT INTO prep_asks (user_id, capture_id, at_ms) SELECT DISTINCT user_id, capture_id, 0 FROM prep_inputs;
${appendOnly("prep_asks")}`,
};
