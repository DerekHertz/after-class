/**
 * The review module's tutor cache table, kept beside migrations.ts because that file is at the lint line limit.
 * It is the last entry of the `review` array there.
 */
import type { Migration } from "./migrations";

export const TUTOR_CACHE: Migration = {
  id: "003-tutor-cache",
  sql: `
-- One row per review that has sent a tutor request, written by review/tutor.ts as each request is admitted, right before it is
-- sent. last_start_ms is when the latest of them started. ttl is the cache lifetime the review's requests now ask for: '5m' until
-- one starts more than 4.5 minutes after the one before it, then '1h' for good. A request the budget held never started, so it
-- writes nothing. Not part of any memo key: a resent turn still finds its stored reply.
CREATE TABLE tutor_cache (
  user_id TEXT NOT NULL REFERENCES users(id),
  review_id TEXT NOT NULL,
  last_start_ms INTEGER NOT NULL,
  ttl TEXT NOT NULL CHECK (ttl IN ('5m', '1h')),
  PRIMARY KEY (user_id, review_id)
) STRICT;
CREATE TRIGGER tutor_cache_stays_1h BEFORE UPDATE ON tutor_cache
WHEN OLD.ttl = '1h' AND NEW.ttl <> '1h'
BEGIN SELECT RAISE(ABORT, 'a review on the 1 hour tutor cache stays on it'); END;`,
};
