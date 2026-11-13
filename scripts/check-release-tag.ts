// A release tag is v<major>.<minor>.<patch> and names the version in package.json at the tagged commit.
// Usage: bun run scripts/check-release-tag.ts <tag>   Exit 1 with the reason when they disagree.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function releaseTagProblem(tag: string, version: unknown): string | null {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) return `tag "${tag}" is not v<major>.<minor>.<patch>`;
  if (tag !== `v${String(version)}`) return `tag "${tag}" does not match package.json version "${String(version)}"`;
  return null;
}

if (import.meta.main) {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { version?: unknown };
  const problem = releaseTagProblem(process.argv[2] ?? "", pkg.version);
  if (problem !== null) {
    console.error(`check-release-tag: ${problem}`);
    process.exit(1);
  }
  console.log(`check-release-tag: ${process.argv[2]} matches package.json`);
}
