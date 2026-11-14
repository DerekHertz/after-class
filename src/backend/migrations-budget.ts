/**
 * The providers module's budget table, kept beside migrations.ts because that file is at the lint line limit.
 * It is the last entry of the `providers` array there.
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
