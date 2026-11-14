import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseTagProblem } from "../scripts/check-release-tag";
import { tmpDir } from "./tmp";

const SCRIPT = resolve(import.meta.dir, "../scripts/check-release-tag.ts");
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commitVersion(work: string, version: string, extra: Record<string, string> = {}): string {
  writeFileSync(join(work, "package.json"), JSON.stringify({ version }));
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", version);
  return git(work, "rev-parse", "HEAD");
}

/**
 * An origin with master at v0.1.0, a tag v0.3.0 on master whose package.json says 0.2.9, and a tag v0.2.0 off master
 * whose own check-release-tag.ts would move the runner's origin/master onto itself and leave a marker. The runner is a
 * full clone checked out at master, as the deploy job's first checkout is.
 */
function releaseRepo(): { runner: string; marker: string; master: string; offMaster: string } {
  const root = tmpDir("afterclass-release-tag-test-");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const marker = join(root, "tag-code-ran");
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "master");
  commitVersion(work, "0.1.0");
  git(work, "tag", "v0.1.0");
  const master = commitVersion(work, "0.2.9");
  git(work, "tag", "v0.3.0");
  git(work, "push", "-q", "origin", "master", "v0.1.0", "v0.3.0");
  git(work, "checkout", "-q", "-b", "side", "v0.1.0");
  const offMaster = commitVersion(work, "0.2.0", {
    "scripts/check-release-tag.ts": `import { execFileSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "");\nexecFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"]);\n`,
  });
  git(work, "tag", "v0.2.0");
  git(work, "push", "-q", "origin", "v0.2.0");
  const runner = join(root, "runner");
  git(root, "clone", "-q", "--no-tags", origin, runner);
  return { runner, marker, master, offMaster };
}

function check(cwd: string, tag: string): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", SCRIPT, tag], { cwd, env: GIT_ENV });
  return { status: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
}

describe("check-release-tag", () => {
  test("a tag equal to v plus the package version passes", () => {
    expect(releaseTagProblem("v0.1.0", "0.1.0")).toBeNull();
    expect(releaseTagProblem("v1.20.3", "1.20.3")).toBeNull();
  });

  test("a tag for another version, or not shaped v<major>.<minor>.<patch>, fails", () => {
    for (const [tag, pkg] of [
      ["v0.1.1", "0.1.0"],
      ["v0.1.0", undefined],
      ["0.1.0", "0.1.0"],
      ["v0.1", "0.1"],
      ["v0.1.0-rc.1", "0.1.0-rc.1"],
      ["v01.1.0", "01.1.0"],
      ["v0.1.0;rm", "0.1.0;rm"],
    ] as const) {
      expect(releaseTagProblem(tag, pkg)).not.toBeNull();
    }
  });

  test("a tag on master whose package.json names its version prints the tag's commit", () => {
    const repo = releaseRepo();
    const run = check(repo.runner, "v0.1.0");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(git(repo.runner, "rev-parse", "v0.1.0^{commit}"));
  });

  test("a tag on master with another version in package.json fails", () => {
    const run = check(releaseRepo().runner, "v0.3.0");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('does not match package.json version "0.2.9"');
  });

  test("a tag off master fails without running any code from the tag, even after the local origin/master was moved onto it", () => {
    const repo = releaseRepo();
    git(repo.runner, "fetch", "-q", "origin", "+refs/tags/v0.2.0:refs/tags/v0.2.0");
    git(repo.runner, "update-ref", "refs/remotes/origin/master", repo.offMaster);
    const run = check(repo.runner, "v0.2.0");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`v0.2.0 points at ${repo.offMaster}, which is not on master`);
    expect(existsSync(repo.marker)).toBe(false);
    expect(git(repo.runner, "rev-parse", "refs/remotes/origin/master")).toBe(repo.master);
  });

  test("a malformed tag fails before anything is fetched", () => {
    const run = check(releaseRepo().runner, "v0.1.0:refs/heads/master");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is not v<major>.<minor>.<patch>");
  });
});

describe("deploy-beta", () => {
  test("checks the tag with master's code before it checks out the tag's commit", () => {
    const workflow = readFileSync(resolve(import.meta.dir, "../.github/workflows/deploy-beta.yml"), "utf8");
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@\S+[^]*?(?=\n {6}- )/g)].map((m) => ({ at: m.index, text: m[0] }));
    const gate = workflow.indexOf("bun scripts/check-release-tag.ts");
    expect(checkouts).toHaveLength(2);
    expect(checkouts[0]!.text).not.toContain("ref:");
    expect(checkouts[0]!.at).toBeLessThan(gate);
    expect(checkouts[1]!.at).toBeGreaterThan(gate);
    expect(checkouts[1]!.text).toContain("ref: ${{ steps.release.outputs.commit }}");
    expect(workflow.indexOf("configure-aws-credentials")).toBeGreaterThan(checkouts[1]!.at);
  });
});
