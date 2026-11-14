// A release tag is v<major>.<minor>.<patch>, points at a commit on master, and names the version in package.json at
// that commit. Usage, inside a clone whose origin is the repository: bun scripts/check-release-tag.ts <tag>
// It fetches master and the tag afresh and reads the tagged commit only through git, so no code from the tag runs
// before the check passes. Prints the tag's commit, or exits 1 with the reason.

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releaseTagProblem(tag: string, version: unknown): string | null {
  if (!RELEASE_TAG.test(tag)) return `tag "${tag}" is not v<major>.<minor>.<patch>`;
  if (tag !== `v${String(version)}`) return `tag "${tag}" does not match package.json version "${String(version)}"`;
  return null;
}

function git(...args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args], { stderr: "inherit" });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
}

function releaseCommit(tag: string): { commit: string } | { problem: string } {
  if (!RELEASE_TAG.test(tag)) return { problem: releaseTagProblem(tag, null)! };
  if (!git("fetch", "--quiet", "--no-tags", "origin", "+refs/heads/master:refs/remotes/origin/master", `+refs/tags/${tag}:refs/tags/${tag}`).ok) {
    return { problem: `cannot fetch master and ${tag} from origin` };
  }
  const commit = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`).out;
  if (!git("merge-base", "--is-ancestor", commit, "refs/remotes/origin/master").ok) return { problem: `${tag} points at ${commit}, which is not on master` };
  const pkg = git("show", `${commit}:package.json`);
  if (!pkg.ok) return { problem: `${tag} has no package.json` };
  const problem = releaseTagProblem(tag, (JSON.parse(pkg.out) as { version?: unknown }).version);
  return problem === null ? { commit } : { problem };
}

if (import.meta.main) {
  const tag = process.argv[2] ?? "";
  const result = releaseCommit(tag);
  if ("problem" in result) {
    console.error(`check-release-tag: ${result.problem}`);
    process.exit(1);
  }
  console.error(`check-release-tag: ${tag} is ${result.commit} on master and matches its package.json`);
  console.log(result.commit);
}
