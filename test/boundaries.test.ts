/**
 * Module boundaries as a test: one table of rules over a static scan of src/.
 * Adding a rule is adding a row.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { tableOwners } from "../src/backend/db";
import type { Owner } from "../src/backend/db";

const ROOT = join(import.meta.dir, "..");

type Import = { readonly spec: string; readonly target: string; readonly typeOnly: boolean };
type SourceFile = { readonly path: string; readonly code: string; readonly imports: readonly Import[] };

/** Comments removed, so prose and usage examples in doc comments are never read as code. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function resolveTarget(from: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  const base = normalize(join(dirname(from), spec));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(join(ROOT, candidate)) && !candidate.endsWith("/") && candidate.match(/\.(ts|tsx|json)$/)) return candidate;
  }
  throw new Error(`${from}: cannot resolve import "${spec}"`);
}

function scan(path: string): SourceFile {
  const code = stripComments(readFileSync(join(ROOT, path), "utf8"));
  const imports: Import[] = [];
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?(?:[^"';]*?\bfrom\s+)?["']([^"']+)["']/g)) {
    imports.push({ spec: m[3]!, target: resolveTarget(path, m[3]!), typeOnly: m[2] !== undefined });
  }
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push({ spec: m[1]!, target: resolveTarget(path, m[1]!), typeOnly: false });
  }
  return { path, code, imports };
}

const SRC: readonly SourceFile[] = [...new Glob("src/**/*.{ts,tsx}").scanSync(ROOT)].sort().map(scan);

const under = (dir: string) => (p: string) => p.startsWith(dir);
const MODULES = ["evidence", "segmentation", "preparation", "review", "record"] as const;
const DOMAIN_MODULE_DIRS = [...MODULES.map((m) => `src/backend/${m}/`), "src/backend/providers/"];
const TRANSPORT = ["src/backend/providers/jev.ts", "src/backend/providers/claude.ts", "src/backend/providers/claude-api.ts"];

type Rule = { readonly name: string; readonly check: (f: SourceFile) => string | null };

const firstImport = (f: SourceFile, bad: (i: Import) => boolean): string | null => {
  const i = f.imports.find(bad);
  return i ? `imports ${i.spec}` : null;
};

const RULES: readonly Rule[] = [
  {
    name: "a module's core.ts is importable only by its own module and test/",
    check: (f) =>
      firstImport(f, (i) => {
        const m = i.target.match(/^src\/backend\/(\w+)\/core\.ts$/);
        return m !== null && !f.path.startsWith(`src/backend/${m[1]}/`);
      }),
  },
  {
    name: "provider transport (jev.ts, claude.ts) is value-imported only inside providers/ and by main.ts",
    check: (f) =>
      under("src/backend/providers/")(f.path) || f.path === "src/backend/main.ts"
        ? null
        : firstImport(f, (i) => TRANSPORT.includes(i.target) && !i.typeOnly),
  },
  {
    name: "Jev HTTP and process spawning live only in the transport files",
    check: (f) => {
      if (TRANSPORT.includes(f.path)) return null;
      if (/\bBun\.spawn|child_process/.test(f.code)) return "spawns a process";
      if (/systemone|api\.typesafe\.ai/.test(f.code)) return "references the Jev endpoint";
      return null;
    },
  },
  {
    name: "R17: only memo.ts calls Task.attempt (no unledgered provider call)",
    check: (f) => (f.path !== "src/backend/providers/memo.ts" && /\.attempt\(/.test(f.code) ? "calls .attempt(" : null),
  },
  {
    name: "wire.ts is not imported by domain modules or the shared domain",
    check: (f) =>
      DOMAIN_MODULE_DIRS.some((d) => f.path.startsWith(d)) || ["src/shared/domain.ts", "src/shared/ids.ts", "src/shared/time.ts", "src/backend/scheduler.ts"].includes(f.path)
        ? firstImport(f, (i) => i.target === "src/shared/wire.ts")
        : null,
  },
  {
    name: "R5: preparation demand never sees review/ (preparation, scheduler, segmentation, evidence)",
    check: (f) =>
      ["src/backend/preparation/", "src/backend/segmentation/", "src/backend/evidence/", "src/backend/scheduler.ts"].some((d) => f.path.startsWith(d))
        ? firstImport(f, (i) => i.target.startsWith("src/backend/review/"))
        : null,
  },
  {
    name: "R9: review/ and evidence/ never import each other",
    check: (f) => {
      if (under("src/backend/review/")(f.path)) return firstImport(f, (i) => i.target.startsWith("src/backend/evidence/"));
      if (under("src/backend/evidence/")(f.path)) return firstImport(f, (i) => i.target.startsWith("src/backend/review/"));
      return null;
    },
  },
  {
    name: "extension/ and app/ import only shared/ and their own tree, never bun: or node:",
    check: (f) => {
      const own = f.path.startsWith("src/extension/") ? "src/extension/" : f.path.startsWith("src/app/") ? "src/app/" : null;
      if (!own) return null;
      return firstImport(f, (i) => !(i.target.startsWith("src/shared/") || i.target.startsWith(own) || ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "zod"].includes(i.target)));
    },
  },
  {
    name: "extension/ and app/ never call stableId (backend-only hashing)",
    check: (f) => ((under("src/extension/")(f.path) || under("src/app/")(f.path)) && /\bstableId\b/.test(f.code) ? "uses stableId" : null),
  },
  {
    name: "bun:sqlite is imported only by db.ts",
    check: (f) => (f.path === "src/backend/db.ts" ? null : firstImport(f, (i) => i.target === "bun:sqlite")),
  },
];

const OWNERS = tableOwners();

/** migrations.ts providers migrations 003-diagram-purpose and 004-user-id copy these providers tables into rebuilt ones (a CHECK cannot be altered, and a NOT NULL reference cannot be added); no other write is allowed there. */
const REBUILT_BY_MIGRATION = new Set(["memo_inputs", "memo", "memo_failures", "usage_events", "voice_usage_events"]);

/** evidence/003-user-id rebuilds its four tables to add user_id, so migrations.ts copies rows into them. 004 backfills capture_owners. */
for (const table of ["capture_facts", "frames", "evidence_snapshots", "evidence_deletions", "capture_owners"]) REBUILT_BY_MIGRATION.add(table);
/** segmentation/002-user-id and preparation/003-user-id rebuild their tables to add user_id, so migrations.ts copies rows into them. */
for (const table of ["chunk_revisions", "claim_index", "concept_index", "prep_controls", "prep_inputs"]) REBUILT_BY_MIGRATION.add(table);

/** review/002-user-id rebuilds its three tables to add user_id, so migrations.ts copies rows into them. */
for (const table of ["invite_answers", "reviews", "review_turns"]) REBUILT_BY_MIGRATION.add(table);

/** record/004-user-id rebuilds its ten tables to add user_id, so its migration copies rows into them. */
for (const table of ["notes", "note_edits", "note_deletions", "note_evidence", "observations", "observation_decisions", "link_suggestions", "link_decisions", "saved_reviews", "save_failures"]) REBUILT_BY_MIGRATION.add(table);

/** The kernel files that hold schema text; migrations-record.ts holds the record's last migration because migrations.ts is at the line limit. Only these may copy rows into a rebuilt table. */
const MIGRATION_FILES = new Set(["src/backend/db.ts", "src/backend/migrations.ts", "src/backend/migrations-record.ts"]);
/** Kernel files that write kernel tables only: db-async.ts bumps `seq_counter`. They have no migration exemption. */
const KERNEL_FILES = new Set([...MIGRATION_FILES, "src/backend/db-async.ts"]);

function ownerOfFile(path: string): Owner | "none" {
  if (KERNEL_FILES.has(path)) return "kernel";
  const dir = path.match(/^src\/backend\/(\w+)\//)?.[1];
  return dir !== undefined && ((MODULES as readonly string[]).includes(dir) || dir === "providers") ? (dir as Owner) : "none";
}

/** Tables a file's SQL writes. `DO UPDATE SET` belongs to an INSERT and `BEFORE DELETE ON` names a trigger event, not a write. */
function writtenTables(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\b(DO\s+|BEFORE\s+|AFTER\s+)?(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?)\s+(\w+)/g)) {
    if (m[1] === undefined) out.push(m[2]!);
  }
  return out;
}

describe("module boundaries", () => {
  test("the scanner sees real imports and real writes (rules are not vacuous)", () => {
    const memo = SRC.find((f) => f.path === "src/backend/providers/memo.ts")!;
    expect(memo.imports.map((i) => i.target)).toContain("src/backend/db.ts");
    expect(memo.imports.find((i) => i.target === "src/backend/db.ts" && i.typeOnly)).toBeDefined();
    expect(writtenTables(memo.code)).toEqual(expect.arrayContaining(["memo_inputs", "memo", "memo_failures", "usage_events"]));
    const seg = SRC.find((f) => f.path === "src/backend/segmentation/core.ts")!;
    expect(seg.imports.map((i) => i.target)).toContain("src/backend/segmentation/index.ts");
    expect(SRC.length).toBeGreaterThan(30);
  });

  test.each(RULES.map((r) => [r.name, r] as const))("%s", (_, rule) => {
    const violations = SRC.flatMap((f) => {
      const v = rule.check(f);
      return v ? [`${f.path}: ${v}`] : [];
    });
    expect(violations).toEqual([]);
  });

  const writeViolations = (f: SourceFile): string[] =>
    writtenTables(f.code).flatMap((table) => {
      const owner = OWNERS.get(table);
      const writer = ownerOfFile(f.path);
      if (MIGRATION_FILES.has(f.path) && REBUILT_BY_MIGRATION.has(table)) return [];
      return owner !== undefined && owner === writer ? [] : [`${f.path} writes ${table} (owner ${owner ?? "unknown"})`];
    });

  test("each module's SQL writes only tables it owns; http, main and scheduler write none", () => {
    expect(SRC.flatMap(writeViolations)).toEqual([]);
  });

  test("db-async.ts may write kernel tables but has no migration exemption", () => {
    const asyncDb = (code: string): SourceFile => ({ path: "src/backend/db-async.ts", code, imports: [] });
    expect(writeViolations(asyncDb(`UPDATE seq_counter SET value = 1`))).toEqual([]);
    expect(writeViolations(asyncDb(`DELETE FROM notes`))).toEqual(["src/backend/db-async.ts writes notes (owner record)"]);
    expect(writeViolations({ path: "src/backend/migrations.ts", code: `INSERT INTO notes SELECT 1`, imports: [] })).toEqual([]);
  });

  test("the rules catch a violation when one is present", () => {
    const fake: SourceFile = {
      path: "src/backend/preparation/index.ts",
      code: `import { x } from "../review"; db.sql.run("INSERT INTO review_turns VALUES (1)")`,
      imports: [{ spec: "../review", target: "src/backend/review/index.ts", typeOnly: false }],
    };
    expect(RULES.find((r) => r.name.startsWith("R5"))!.check(fake)).toBe("imports ../review");
    expect(writtenTables(fake.code)).toEqual(["review_turns"]);
    expect(OWNERS.get("review_turns")).not.toBe(ownerOfFile(fake.path));
  });
});
