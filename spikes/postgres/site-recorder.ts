/**
 * Test preload that records the source line of every bun:sqlite statement execution made from src/backend, so the
 * static count in count-callsites.ts can be checked against what the suite really executes.
 *   SPIKE_SITES_OUT=/some/file bun test --preload ./spikes/postgres/site-recorder.ts
 */
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";

const out = process.env.SPIKE_SITES_OUT;
if (out) {
  const seen = new Set<string>();
  const record = () => {
    for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
      const m = line.match(/(src\/backend\/(?!db\.ts)[^:)]+):(\d+):\d+/);
      if (m) {
        const site = `${m[1]}:${m[2]}`;
        if (!seen.has(site)) {
          seen.add(site);
          appendFileSync(out, `${site}\n`);
        }
        return;
      }
    }
  };
  const patched = new WeakSet<object>();
  const wrap = (stmt: Record<string, unknown>) => {
    if (patched.has(stmt)) return stmt;
    patched.add(stmt);
    for (const m of ["get", "all", "run", "values"]) {
      const orig = stmt[m] as (...a: unknown[]) => unknown;
      stmt[m] = (...args: unknown[]) => {
        record();
        return orig.apply(stmt, args);
      };
    }
    return stmt;
  };
  const query = Database.prototype.query;
  Database.prototype.query = function (this: Database, ...args: Parameters<Database["query"]>) {
    return wrap(query.apply(this, args) as never) as never;
  };
  const run = Database.prototype.run;
  Database.prototype.run = function (this: Database, ...args: Parameters<Database["run"]>) {
    record();
    return run.apply(this, args);
  };
}
