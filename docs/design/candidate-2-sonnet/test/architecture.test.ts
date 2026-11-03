// test/architecture.test.ts -- the module graph and ownership rules, enforced as a test (no lint dependency allowed by the stack).
// ONE table of rules, ONE loop: adding a rule is adding a row; nothing is hand-synced. Each row says which files it applies to and what
// is forbidden. This is what turns "importable internals", "split ownership" and "two ways to do one task" into build failures.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { dirname, normalize, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const files = [...new Glob("**/*.{ts,tsx}").scanSync(SRC)].map((f) => ({
  rel: f,
  text: readFileSync(SRC + f, "utf8"),
}));

/** module specifiers, resolved to src-relative paths when relative, kept as-is when bare */
function specs(rel: string, text: string): { spec: string; resolved: string; typeOnly: boolean }[] {
  const out: { spec: string; resolved: string; typeOnly: boolean }[] = [];
  for (const m of text.matchAll(/(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g)) {
    const spec = (m[3] ?? m[4])!;
    const resolved = spec.startsWith(".") ? normalize(dirname(rel) + "/" + spec) : spec;
    out.push({ spec, resolved, typeOnly: m[2] !== undefined || /^import\s+type\b/.test(m[0]) });
  }
  return out;
}
/** code with comments removed, for rules about identifiers (R6) */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

interface Rule {
  readonly name: string;
  readonly applies: (rel: string) => boolean;
  /** return a violation message or null */
  readonly check: (f: { rel: string; text: string }) => string | null;
}

const imp = (f: { rel: string; text: string }) => specs(f.rel, f.text);
const inDir = (d: string) => (rel: string) => rel.startsWith(d);

const RULES: readonly Rule[] = [
  {
    name: "bun:sqlite is imported only inside backend/store (one writer of persistence)",
    applies: (r) => !inDir("backend/store/")(r),
    check: (f) => imp(f).find((i) => i.spec === "bun:sqlite") ? "imports bun:sqlite" : null,
  },
  {
    name: "shared/ and extension/ and app/ are runtime-neutral: no node:/bun: imports, no backend/ imports",
    applies: (r) => inDir("shared/")(r) || inDir("extension/")(r) || inDir("app/")(r),
    check: (f) => {
      const bad = imp(f).find((i) => /^(node:|bun)/.test(i.spec) || i.resolved.startsWith("backend/"));
      return bad ? `imports ${bad.spec}` : null;
    },
  },
  {
    name: "app/ does not import extension/ and extension/ does not import app/",
    applies: (r) => inDir("app/")(r) || inDir("extension/")(r),
    check: (f) => {
      const other = f.rel.startsWith("app/") ? "extension/" : "app/";
      const bad = imp(f).find((i) => i.resolved.startsWith(other));
      return bad ? `imports ${bad.spec}` : null;
    },
  },
  {
    name: "provider internals (providers/jev/*, providers/claude/*) are importable only from inside backend/providers",
    applies: (r) => !inDir("backend/providers/")(r),
    check: (f) => {
      const bad = imp(f).find((i) => /^backend\/providers\/(jev|claude)\//.test(i.resolved));
      return bad ? `imports provider internal ${bad.spec}` : null;
    },
  },
  {
    name: "claude is spawned only by providers/claude/cli.ts; Jev HTTP only by providers/jev/",
    applies: (r) => r !== "backend/providers/claude/cli.ts" && !inDir("backend/providers/jev/")(r) && !r.startsWith("../test"),
    check: (f) => {
      const t = code(f.text);
      if (/Bun\.spawn|child_process/.test(t)) return "spawns a process outside providers/claude/cli.ts";
      if (/systemone/.test(t)) return "references the Jev endpoint outside providers/jev/";
      return null;
    },
  },
  {
    name: "R9: review/clamp/claim logic cannot import capture-side modules",
    applies: (r) => ["shared/core/review.ts", "shared/core/clamp.ts", "shared/core/claimMachine.ts"].includes(r),
    check: (f) => {
      const bad = imp(f).find((i) => /(core\/(coverage|routing|windowing)|domain\/capture|^extension\/)/.test(i.resolved));
      return bad ? `imports capture-side ${bad.spec}` : null;
    },
  },
  {
    name: "R6: readiness code has no notion of resource searches",
    applies: (r) => ["shared/core/prep.ts", "shared/core/review.ts"].includes(r),
    check: (f) => (/resource/i.test(code(f.text)) ? "mentions resources in code" : null),
  },
  {
    name: "R17: cost and usd are never optional numbers (unknown is a variant, not undefined)",
    applies: () => true,
    check: (f) => (/\b(usd|costUsd|cost)\?\s*:/.test(code(f.text)) ? "optional cost/usd field" : null),
  },
  {
    name: "brand minting: SupportedClaim(Id) only in claimMachine, DetourConsent only in core/review",
    applies: () => true,
    check: (f) => {
      const t = code(f.text);
      if (/\bas\s+SupportedClaim(Id)?\b/.test(t) && f.rel !== "shared/core/claimMachine.ts") return "casts to SupportedClaim outside claimMachine";
      if (/\bas\s+DetourConsent\b/.test(t) && f.rel !== "shared/core/review.ts") return "casts to DetourConsent outside core/review";
      return null;
    },
  },
  {
    name: "store repos never value-import each other (only index.ts composes them); cross-repo use is by type",
    applies: (r) => inDir("backend/store/")(r) && r !== "backend/store/index.ts",
    check: (f) => {
      const bad = imp(f).find((i) => !i.typeOnly && /^backend\/store\/(capture|timeline|jobs|review|usage)$/.test(i.resolved));
      return bad ? `value-imports sibling repo ${bad.spec}` : null;
    },
  },
  {
    name: "single writer per table: INSERT/UPDATE/DELETE on a table appears only in its owning repo file",
    applies: (r) => inDir("backend/")(r),
    check: (f) => {
      const OWNER: Record<string, string> = {
        evidence: "capture", watched_spans: "capture", capture_events: "capture", citations: "capture", transcript_tracks: "capture", sources: "capture",
        open_chunk: "timeline", chunk_revisions: "timeline", invite_log: "timeline", judgments: "timeline",
        jobs: "jobs", claims: "jobs", claim_evidence: "jobs", stale_results: "jobs",
        reviews: "review", review_turns: "review", observations: "review", notes: "review", graph_links: "review", pending_saves: "review",
        usage_events: "usage",
      };
      const t = code(f.text);
      for (const [table, owner] of Object.entries(OWNER)) {
        const re = new RegExp(`(INSERT\\s+(OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, "i");
        if (re.test(t) && f.rel !== `backend/store/${owner}.ts`) return `writes ${table} outside backend/store/${owner}.ts`;
      }
      return null;
    },
  },
  {
    name: "no any",
    applies: () => true,
    check: (f) => (/(:\s*any\b|\bas\s+any\b|<any>)/.test(code(f.text)) ? "uses any" : null),
  },
];

for (const rule of RULES) {
  test(rule.name, () => {
    const violations = files
      .filter((f) => rule.applies(f.rel))
      .flatMap((f) => {
        const v = rule.check(f);
        return v ? [`${relative("", f.rel)}: ${v}`] : [];
      });
    expect(violations).toEqual([]);
  });
}
