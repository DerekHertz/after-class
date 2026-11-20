/**
 * Mechanical SQLite to PostgreSQL translation of the migration text in src/backend/db.ts.
 * Only rules that need no judgment live here. A migration that still fails after them is listed in HAND_WRITTEN
 * with its replacement, and the spike report counts those as "needed real thought".
 */
import { MIGRATIONS, OWNERS } from "../../src/backend/db";
import type { Migration, Owner } from "../../src/backend/db";

const TRIGGER = /CREATE TRIGGER (\w+) BEFORE (UPDATE|DELETE) ON (\w+)\s*\n(?:WHEN ([\s\S]*?)\n)?BEGIN SELECT RAISE\(ABORT, '([^']*)'\); END;/g;

export function triggerToPlpgsql(sql: string): string {
  return sql.replace(TRIGGER, (_m, name: string, op: string, table: string, when: string | undefined, msg: string) => {
    const raise = `RAISE EXCEPTION '%', '${msg}';`;
    const body = when ? `IF ${when} THEN ${raise} END IF;` : raise;
    return `CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  ${body}
  RETURN ${op === "UPDATE" ? "NEW" : "OLD"};
END $fn$;
CREATE TRIGGER ${name} BEFORE ${op} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}_fn();`;
  });
}

export function toPg(sql: string): string {
  return triggerToPlpgsql(sql)
    .replace(/\)\s*STRICT\b/g, ")")
    .replace(/^PRAGMA .*$/gm, "")
    .replace(/\bINTEGER\b/g, "BIGINT")
    .replace(/\bREAL\b/g, "DOUBLE PRECISION");
}

export type PgMigration = Migration & { readonly translation: "mechanical" | "hand" };

const PURPOSES_WITH_DIAGRAM = `'boundary','frame_change','claim_check','interpretation','claim_revision','resource_search','tutor_turn','wrap_up','diagram_summary'`;

/**
 * providers/003-diagram-purpose rebuilds two tables with PRAGMA defer_foreign_keys. Postgres has no deferred DROP of a
 * referenced table, and DROP ... CASCADE would silently remove the foreign keys on memo and memo_failures. The intent
 * (widen two CHECK lists) is one ALTER per table.
 */
export const HAND_WRITTEN: Readonly<Record<string, string>> = {
  "providers/003-diagram-purpose": `
ALTER TABLE memo_inputs DROP CONSTRAINT memo_inputs_purpose_check,
  ADD CONSTRAINT memo_inputs_purpose_check CHECK (purpose IN (${PURPOSES_WITH_DIAGRAM}));
ALTER TABLE usage_events DROP CONSTRAINT usage_events_purpose_check,
  ADD CONSTRAINT usage_events_purpose_check CHECK (purpose IN (${PURPOSES_WITH_DIAGRAM}));`,
};

export function pgMigrations(useHand: boolean): { readonly [O in Owner]: readonly PgMigration[] } {
  const out = {} as { [O in Owner]: readonly PgMigration[] };
  for (const owner of OWNERS) {
    out[owner] = MIGRATIONS[owner].map((m) => {
      const hand = useHand ? HAND_WRITTEN[`${owner}/${m.id}`] : undefined;
      return hand ? { id: m.id, sql: hand, translation: "hand" as const } : { id: m.id, sql: toPg(m.sql), translation: "mechanical" as const };
    });
  }
  return out;
}
