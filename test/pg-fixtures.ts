/**
 * PostgreSQL for tests. AFTERCLASS_TEST_PG_URL names a server (scripts/dev/pg.sh start, or the pg service in CI);
 * unset, a PostgreSQL test file skips its suite and prints one line saying so. Each file migrates its own template
 * database and clones a fresh database from it per test, all under a random prefix, so parallel runs and agents can
 * share one server. Every database a file made is dropped in its afterAll.
 */
import { afterAll, afterEach } from "bun:test";
import { SQL } from "bun";
import { basename } from "node:path";
import { openPgDb } from "../src/backend/pg";
import type { PgDb, PgOptions } from "../src/backend/pg";

export const PG_URL = process.env.AFTERCLASS_TEST_PG_URL;

/** Call once at the top of a PostgreSQL test file; true when its suites must skip. */
export function skipWithoutPg(file: string): boolean {
  if (PG_URL) return false;
  console.warn(`${basename(file)}: PostgreSQL tests skipped; run scripts/dev/pg.sh start and set AFTERCLASS_TEST_PG_URL="$(scripts/dev/pg.sh url)"`);
  return true;
}

function urlOf(database: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${database}`;
  return u.toString();
}

async function admin<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL({ url: PG_URL!, max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

export type PgDatabases = {
  /** A new, migrated, empty database's URL. */
  freshUrl(): Promise<string>;
  /** A new, migrated, empty database, closed after the test. Its pool holds 4 connections unless `max` says otherwise. */
  fresh(opts?: Omit<PgOptions, "migrations">): Promise<PgDb>;
  /** An empty database with no schema at all. */
  blankUrl(): Promise<string>;
};

/** Databases for one test file. */
export function pgDatabases(): PgDatabases {
  const prefix = `ac_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const template = `${prefix}_tpl`;
  const made: string[] = [];
  const opened: PgDb[] = [];
  let n = 0;
  let ready: Promise<void> | null = null;

  const create = (name: string, from?: string) =>
    admin(async (sql) => {
      await sql.unsafe(`CREATE DATABASE ${name}${from ? ` TEMPLATE ${from}` : ""}`);
      made.push(name);
    });

  const freshUrl = async () => {
    ready ??= (async () => {
      await create(template);
      await (await openPgDb(urlOf(template), { max: 1 })).close();
    })();
    await ready;
    const name = `${prefix}_${++n}`;
    await create(name, template);
    return urlOf(name);
  };

  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close();
  });

  afterAll(async () => {
    if (made.length === 0) return;
    await admin(async (sql) => {
      for (const name of made.reverse()) await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    });
  });

  return {
    freshUrl,
    fresh: async (opts) => {
      const db = await openPgDb(await freshUrl(), { max: 4, ...opts });
      opened.push(db);
      return db;
    },
    blankUrl: async () => {
      const name = `${prefix}_${++n}`;
      await create(name);
      return urlOf(name);
    },
  };
}
