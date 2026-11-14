/**
 * The providers module's latest migrations, kept beside migrations.ts because that file is at the lint line limit.
 * They are the last entries of the `providers` array there, in this order.
 */
import type { Migration } from "./migrations";

export const BUDGET_HOLDS: Migration = {
  id: "005-budget-holds",
  sql: `
-- One row per paid request, written by providers/budget.ts (plan phase 7). A row reserves an estimate before the request is sent,
-- is priced once when its response is read and its cost is known, and is settled once in the transaction of its usage event.
-- A month's spend is the sum of each row's settled amount, else its price, else its reservation: a request still running, or one
-- whose process ended mid-call and so may have been billed, counts at its price once known and at its reservation until then.
-- Amounts are whole micro-dollars so a cap comparison is exact. period is the calendar month in UTC, 'YYYY-MM'.
CREATE TABLE budget_holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  purpose TEXT NOT NULL,
  memo_key TEXT NOT NULL,
  reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),
  reserved_ms INTEGER NOT NULL,
  priced_micros INTEGER CHECK (priced_micros IS NULL OR priced_micros >= 0),
  settled_micros INTEGER CHECK (settled_micros IS NULL OR settled_micros >= 0),
  settled_ms INTEGER,
  CHECK ((settled_micros IS NULL) = (settled_ms IS NULL))
) STRICT;
CREATE INDEX budget_holds_by_period ON budget_holds (period, user_id);
CREATE TRIGGER budget_holds_settle_once BEFORE UPDATE ON budget_holds
WHEN OLD.settled_micros IS NOT NULL OR (NEW.settled_micros IS NULL AND NEW.priced_micros IS NULL)
  OR (OLD.priced_micros IS NOT NULL AND NEW.priced_micros IS NOT OLD.priced_micros) OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.period IS NOT OLD.period OR NEW.purpose IS NOT OLD.purpose OR NEW.memo_key IS NOT OLD.memo_key
  OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.reserved_ms IS NOT OLD.reserved_ms
BEGIN SELECT RAISE(ABORT, 'a budget hold is priced at most once, settled once, and is otherwise never changed'); END;
CREATE TRIGGER budget_holds_no_delete BEFORE DELETE ON budget_holds
BEGIN SELECT RAISE(ABORT, 'budget holds are never deleted'); END;`,
};

/** Every purpose, with "cache_keepalive" last. Each earlier list is frozen in the migration text that used it. */
const PURPOSES_WITH_KEEPALIVE = `'boundary','frame_change','claim_check','interpretation','claim_revision','resource_search','tutor_turn','wrap_up','diagram_summary','cache_keepalive'`;

export const KEEPALIVE_PURPOSE: Migration = {
  id: "006-keepalive-purpose",
  sql: `
-- The purpose CHECKs of memo_inputs and usage_events are frozen text, so adding "cache_keepalive" (a request that keeps a
-- review's cached prompt warm) rebuilds both tables, as 003-diagram-purpose did, with every row, CHECK, index and trigger
-- of 004-user-id put back. memo and memo_failures point at memo_inputs, so the foreign key check waits until the
-- transaction ends; the rows are back in the new memo_inputs before it does.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE memo_inputs_save AS SELECT user_id, key, provider, purpose, version, model, input_json, first_seen_ms FROM memo_inputs;
CREATE TABLE usage_events_save AS SELECT id, user_id, memo_key, capture_id, attempt_no, provider, model, purpose, outcome, input_tokens,
  output_tokens, cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms FROM usage_events;
DROP TABLE usage_events;
DROP TABLE memo_inputs;

CREATE TABLE memo_inputs (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('jev','claude')),
  purpose TEXT NOT NULL CHECK (purpose IN (${PURPOSES_WITH_KEEPALIVE})),
  version TEXT NOT NULL,
  model TEXT NOT NULL,
  input_json TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
) STRICT;
INSERT INTO memo_inputs (user_id, key, provider, purpose, version, model, input_json, first_seen_ms)
SELECT user_id, key, provider, purpose, version, model, input_json, first_seen_ms FROM memo_inputs_save;

-- R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  memo_key TEXT NOT NULL,
  capture_id TEXT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  provider TEXT NOT NULL CHECK (provider IN ('jev','claude')),
  model TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (${PURPOSES_WITH_KEEPALIVE})),
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
SELECT id, user_id, memo_key, capture_id, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens,
  cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms FROM usage_events_save;
CREATE INDEX usage_events_by_purpose ON usage_events (user_id, purpose, started_ms);
CREATE TRIGGER usage_events_no_update BEFORE UPDATE ON usage_events
BEGIN SELECT RAISE(ABORT, 'R17: usage_events is append-only'); END;
CREATE TRIGGER usage_events_no_delete BEFORE DELETE ON usage_events
BEGIN SELECT RAISE(ABORT, 'R17: usage events are never deleted'); END;

DROP TABLE usage_events_save;
DROP TABLE memo_inputs_save;`,
};
