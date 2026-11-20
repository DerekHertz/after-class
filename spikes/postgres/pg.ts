/**
 * Shared helpers for the Postgres spike: a throwaway database per caller and the `?` to `$n` placeholder rewrite.
 * Connects only to the local container named in SPIKE_PG_URL. Nothing here touches data/ or ~/afterclass-data.
 */
import { SQL } from "bun";

export const ADMIN_URL = process.env.SPIKE_PG_URL ?? "postgres://postgres:spike@127.0.0.1:55432/postgres";

export function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function freshDatabase(name: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = new SQL({ url: ADMIN_URL, max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.close();
  return {
    url: urlFor(name),
    drop: async () => {
      const a = new SQL({ url: ADMIN_URL, max: 1 });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.close();
    },
  };
}

/** SQLite `?` and `?N` placeholders to Postgres `$n`. Mixed styles in one statement are not used by this codebase. */
export function placeholders(sql: string): string {
  let k = 0;
  return sql.replace(/\?(\d+)?/g, (_m, n: string | undefined) => (n ? `$${n}` : `$${++k}`));
}
