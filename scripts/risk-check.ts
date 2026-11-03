// Sizes a PR's review. Exit 0 = light (a Haiku verifier is enough), exit 1 = full
// (a Sonnet high verifier with the formal check where the flow models changed).
// Unknown paths count as full, so a new directory is never reviewed lightly by accident.
// Usage: bun run scripts/risk-check.ts [gitRange]   (default: origin/master...HEAD)
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIGHT = [/^docs\/(?!flows\/)/, /^README\.md$/, /^test\//, /^src\/app\/.*\.(css|html)$/];
const FORCE_FULL = [/^docs\/flows\//, /^test\/.*(rules|fakes)/];

export type Verdict = { tier: "light" | "full"; hits: string[] };

export function sizeReview(files: readonly string[]): Verdict {
  const hits = files.filter(
    (f) => FORCE_FULL.some((re) => re.test(f)) || !LIGHT.some((re) => re.test(f)),
  );
  return { tier: hits.length === 0 ? "light" : "full", hits };
}

async function changedFiles(range: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "diff", "--name-only", "--no-renames", range], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git diff ${range} failed`);
  return out.split("\n").filter(Boolean);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verdict = sizeReview(
    await changedFiles(process.argv[2] ?? "origin/master...HEAD").catch((e: Error) => {
      console.error(e.message);
      process.exit(2);
    }),
  );
  console.log(verdict.tier);
  for (const hit of verdict.hits) console.log(`  ${hit}`);
  process.exit(verdict.tier === "light" ? 0 : 1);
}
