import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeHost, readLog, stub } from "./beta-host";

const WORKFLOWS = resolve(import.meta.dir, "../.github/workflows");
const REPOSITORY = "ghcr.io/derekhertz/after-class";
const COMMIT = "e".repeat(40);
const TOKEN = "ghs_registry-token-for-the-test";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, string | boolean | number>;
  readonly env?: Record<string, string>;
}

interface Job {
  readonly needs?: string | string[];
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly steps: Step[];
}

interface Workflow {
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

const workflow = (name: string): Workflow => Bun.YAML.parse(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;

/** Runs the image job's push step against a stubbed docker that logs its arguments and what it read on stdin. */
function runPushStep(opts: { imageExists: boolean }): { status: number; log: string[]; stdin: string; argv: string } {
  const host = makeHost("afterclass-release-push-");
  const step = workflow("release.yml").jobs.image!.steps.find((s) => s.run?.includes("docker push"));
  expect(step).toBeDefined();
  stub(
    host.bin,
    "docker",
    `printf '%s\\0' "$@" >> ${host.root}/argv
echo "docker $*" >> ${host.log}
case "$1 $2" in
  "login "*) cat >> ${host.root}/stdin;;
  "manifest inspect") exit ${opts.imageExists ? 0 : 1};;
esac
exit 0`,
  );
  const expressions: Record<string, string> = {
    "${{ github.token }}": TOKEN,
    "${{ github.actor }}": "DerekHertz",
    "${{ github.ref_name }}": "v0.1.0",
    "${{ needs.release.outputs.commit }}": COMMIT,
  };
  const env = Object.fromEntries(Object.entries(step!.env ?? {}).map(([key, expression]) => [key, expressions[expression]]));
  const result = Bun.spawnSync(["bash", "-c", step!.run!], {
    env: { ...process.env, ...env, GITHUB_REPOSITORY: "DerekHertz/after-class", PATH: `${host.bin}:${process.env.PATH}` },
  });
  const read = (name: string): string => (existsSync(join(host.root, name)) ? readFileSync(join(host.root, name), "utf8") : "");
  return { status: result.exitCode, log: readLog(host), stdin: read("stdin"), argv: read("argv") };
}

describe("release workflow", () => {
  const release = workflow("release.yml");

  test("the image job may read the code and write packages, and nothing else", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(release.jobs.image!.permissions).toEqual({ contents: "read", packages: "write" });
    expect(release.jobs.release!.permissions).toEqual({ contents: "write" });
  });

  test("the image job builds the commit the release check resolved, after the check passed", () => {
    const check = release.jobs.release!.steps.find((s) => s.run?.includes("scripts/check-release-tag.ts"));
    expect(check?.id).toBeDefined();
    expect(release.jobs.release!.outputs?.commit).toBe(`\${{ steps.${check!.id}.outputs.commit }}`);
    expect(release.jobs.image!.needs).toBe("release");
    const checkouts = release.jobs.image!.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with?.ref).toBe("${{ needs.release.outputs.commit }}");
    expect(checkouts[0]!.with?.["persist-credentials"]).toBe(false);
  });

  test("pushes the arm64 image to the pinned GHCR repository by commit and by release tag, with the token on stdin only", () => {
    const run = runPushStep({ imageExists: false });
    expect(run.status).toBe(0);
    expect(run.log).toContain("docker login ghcr.io --username DerekHertz --password-stdin");
    expect(run.stdin).toBe(TOKEN);
    expect(run.argv).not.toContain(TOKEN);
    const build = run.log.find((line) => line.startsWith("docker build "));
    expect(build).toContain("--platform linux/arm64");
    expect(build).toContain(`--tag ${REPOSITORY}:${COMMIT}`);
    expect(run.log).toContain(`docker push ${REPOSITORY}:${COMMIT}`);
    expect(run.log).toContain(`docker buildx imagetools create --tag ${REPOSITORY}:v0.1.0 ${REPOSITORY}:${COMMIT}`);
  });

  test("a rerun for a commit already on GHCR does not rebuild it, so the image the server saved keeps its digest", () => {
    const run = runPushStep({ imageExists: true });
    expect(run.status).toBe(0);
    expect(run.log.some((line) => line.startsWith("docker build ") || line.startsWith("docker push "))).toBe(false);
    expect(run.log).toContain(`docker buildx imagetools create --tag ${REPOSITORY}:v0.1.0 ${REPOSITORY}:${COMMIT}`);
  });
});

describe("workflows", () => {
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));

  test("every action is pinned by a full commit hash", () => {
    const uses = files.flatMap((name) => Object.values(workflow(name).jobs).flatMap((job) => job.steps.flatMap((s) => (s.uses ? [s.uses] : []))));
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});
