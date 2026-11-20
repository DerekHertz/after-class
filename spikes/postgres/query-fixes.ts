/**
 * The rewrites that take the SQLite statements in src/backend to PostgreSQL, one rule per dialect difference.
 * Applied in order after `?` to `$n`. A statement that no rule touches is the same text on both engines.
 */
export type Rule = { readonly name: string; readonly why: string; readonly find: RegExp; readonly replace: string | ((m: string, ...g: string[]) => string) };

export const RULES: readonly Rule[] = [
  {
    name: "insert-or-ignore",
    why: "INSERT OR IGNORE becomes ON CONFLICT DO NOTHING. Not equivalent: SQLite also ignores CHECK and NOT NULL violations.",
    find: /INSERT OR IGNORE INTO([\s\S]*?)\s*$/,
    replace: (_m, rest) => `INSERT INTO${rest}\n ON CONFLICT DO NOTHING`,
  },
  {
    name: "json_extract",
    why: "json_extract(col, '$.k') becomes col::jsonb ->> 'k' (no cast once the column is jsonb).",
    find: /json_extract\((\w+), '\$\.(\w+)'\)/g,
    replace: (_m, col, key) => `(${col}::jsonb ->> '${key}')`,
  },
  {
    name: "sum-of-boolean",
    why: "SUM(cond) counts rows in SQLite. Postgres has no SUM(boolean). Use COUNT(*) FILTER, which also returns 0 instead of NULL on no rows.",
    find: /SUM\((\w+) = '(\w+)'\)/g,
    replace: (_m, col, val) => `COUNT(*) FILTER (WHERE ${col} = '${val}')`,
  },
  {
    name: "ambiguous-upsert-column",
    why: "In ON CONFLICT DO UPDATE, a bare column name is ambiguous between the table and EXCLUDED.",
    find: /SET attempts = attempts \+ 1/,
    replace: "SET attempts = memo_failures.attempts + 1",
  },
  {
    name: "rowid",
    why: "No rowid in Postgres. ORDER BY rowid needs an explicit insertion-order column (`ord`, identity).",
    find: /\b(\w)\.rowid\b/g,
    replace: (_m, alias) => `${alias}.ord`,
  },
  {
    name: "json_each-in-list",
    why: "IN (SELECT value FROM json_each(?)) becomes = ANY of a jsonb array, or pass a text[] and use = ANY($1).",
    find: /IN \(SELECT value FROM json_each\(\$(\d+)\)\)/g,
    replace: (_m, n) => `IN (SELECT jsonb_array_elements_text($${n}::jsonb))`,
  },
  {
    name: "json_each-exists",
    why: "json_each(col) becomes jsonb_array_elements_text(col::jsonb) with an alias that supplies `value`.",
    find: /json_each\((\w+\.\w+)\) WHERE value = /g,
    replace: (_m, col) => `jsonb_array_elements_text(${col}::jsonb) AS e(value) WHERE e.value = `,
  },
  {
    name: "untyped-null-filter",
    why: "A parameter whose first use is `$n IS NULL` has no inferable type in Postgres. Cast it: `$n::text IS NULL`.",
    find: /\$(\d+) IS NULL/g,
    replace: (_m, n) => `$${n}::text IS NULL`,
  },
];

export function fixQuery(text: string): { pg: string; applied: string[] } {
  let pg = text;
  const applied: string[] = [];
  for (const r of RULES) {
    const next = pg.replace(r.find, r.replace as never);
    if (next !== pg) applied.push(r.name);
    pg = next;
  }
  return { pg, applied };
}

/** Insertion order for the three tables whose queries use ORDER BY rowid. */
export const ORD_DDL = [
  "ALTER TABLE notes ADD COLUMN ord BIGINT GENERATED ALWAYS AS IDENTITY",
  "ALTER TABLE observations ADD COLUMN ord BIGINT GENERATED ALWAYS AS IDENTITY",
  "ALTER TABLE link_suggestions ADD COLUMN ord BIGINT GENERATED ALWAYS AS IDENTITY",
];
