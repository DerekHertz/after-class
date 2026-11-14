/**
 * Pulls every SQL statement out of src/backend (outside db.ts), rewrites only the placeholders, and asks PostgreSQL to
 * PREPARE it against the migrated schema. PREPARE parses and analyses without running, so it finds syntax errors,
 * unknown functions, bad column types and uninferable parameters. Then the same list is run again with QUERY_FIXES.
 *   bun run spikes/postgres/queries-check.ts
 */
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { freshDatabase, placeholders } from "./pg";
import { openPgDb } from "./kernel-pg";
import { pgMigrations } from "./translate";
import { ORD_DDL, fixQuery } from "./query-fixes";

const ROOT = join(import.meta.dir, "../..");
const STATEMENT = /^\s*(SELECT|INSERT|DELETE|UPDATE|WITH)\b/i;

export type Found = { file: string; line: number; sql: string };

export function extractQueries(): Found[] {
  const found: Found[] = [];
  for (const rel of [...new Glob("src/backend/**/*.ts").scanSync(ROOT)].sort()) {
    if (rel === "src/backend/db.ts") continue;
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const m of text.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"/g)) {
      const raw = (m[1] ?? m[2])!.replace(/\$\{[^}]*\}/g, "");
      if (!STATEMENT.test(raw)) continue;
      if (!/\b(FROM|INTO|SET)\b/i.test(raw)) continue;
      found.push({ file: rel, line: text.slice(0, m.index).split("\n").length, sql: raw });
    }
  }
  return found;
}

const db = await freshDatabase("spike_queries");
const pg = await openPgDb(db.url, pgMigrations(true), { max: 1 });
const sql: SQL = pg.sql;
for (const ddl of ORD_DDL) await sql.unsafe(ddl);

async function tryPrepare(text: string): Promise<string | null> {
  try {
    await sql.begin(async (t) => {
      await t.unsafe(`PREPARE spike_q AS ${text}`);
      await t.unsafe("DEALLOCATE spike_q");
    });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const queries = extractQueries();
let rawOk = 0;
let fixedOk = 0;
const rows: string[] = [];
for (const q of queries) {
  const converted = placeholders(q.sql);
  const rawErr = await tryPrepare(converted);
  const fix = fixQuery(converted);
  let fixedErr: string | null = rawErr;
  if (rawErr !== null) fixedErr = await tryPrepare(fix.pg);
  if (rawErr === null) rawOk++;
  if (fixedErr === null) fixedOk++;
  if (rawErr !== null) {
    rows.push(`${fixedErr === null ? "fixed " : "STILL FAILS"} ${q.file}:${q.line}\n   raw error: ${rawErr}\n   rules: ${fix.applied.join(", ") || "none"}${fixedErr ? `\n   after fix: ${fixedErr}` : ""}`);
  }
}
console.log(`${queries.length} statements found in src/backend`);
console.log(`${rawOk} prepare as they are after only \`?\` to \`$n\``);
console.log(`${queries.length - rawOk} fail raw, ${fixedOk - rawOk} of those pass with the listed fixes`);
console.log(rows.join("\n"));
await pg.close();
await db.drop();
