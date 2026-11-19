/**
 * The preparation module's ask record, kept beside migrations.ts because that file is at the lint line limit.
 * It is the last entry of the `preparation` array there.
 */
import type { Migration } from "./migrations";

export const PREP_ASKS: Migration = {
  id: "004-prep-asks",
  sql: `
-- Lazy preparation (flow C, amendment of 2026-11-18): a lecture's chunks wait for Claude until the learner asks for its review with
-- Review now or Wait. One row per ask. An ask is open until a review of its lecture starts, which closes it with that review's id.
-- Asking while an ask is open stores nothing; asking after it closed opens the next one. Any row means the lecture is prepared.
CREATE TABLE prep_asks (
  user_id TEXT NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL,
  capture_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  closed_ms INTEGER,
  review_id TEXT,
  PRIMARY KEY (user_id, seq),
  CHECK (review_id IS NULL OR closed_ms IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX prep_asks_one_open ON prep_asks (user_id, capture_id) WHERE closed_ms IS NULL;
CREATE INDEX prep_asks_by_capture ON prep_asks (user_id, capture_id, seq);
CREATE TRIGGER prep_asks_close_once BEFORE UPDATE ON prep_asks
WHEN OLD.closed_ms IS NOT NULL OR NEW.closed_ms IS NULL OR NEW.user_id IS NOT OLD.user_id OR NEW.seq IS NOT OLD.seq
  OR NEW.capture_id IS NOT OLD.capture_id OR NEW.at_ms IS NOT OLD.at_ms
BEGIN SELECT RAISE(ABORT, 'prep_asks: an ask only closes, once'); END;
-- A lecture whose preparation started under the old flow counts as asked, so its work goes on after the upgrade. Its ask is closed,
-- with no review, so the upgrade starts no review on its own.
INSERT INTO prep_asks (user_id, seq, capture_id, at_ms, closed_ms, review_id)
SELECT user_id, MIN(seq), capture_id, 0, 0, NULL FROM prep_inputs GROUP BY user_id, capture_id;`,
};

export const PREP_ASK_REFUSED: Migration = {
  id: "005-prep-ask-refused",
  sql: `
-- An ask ends refused when the day's review limit refuses the review it asked for. A refused ask is closed with no review.
ALTER TABLE prep_asks ADD COLUMN refused INTEGER NOT NULL DEFAULT 0
  CHECK (refused = 0 OR (refused = 1 AND closed_ms IS NOT NULL AND review_id IS NULL));`,
};
