import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Host, makeHost, readLog, REPOSITORY, stub } from "./beta-host";

const WORKFLOWS = resolve(import.meta.dir, "../.github/workflows");
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

const PUSHED = `sha256:${"1".repeat(64)}`;
const ATTACKER = `sha256:${"2".repeat(64)}`;

interface StepRun {
  readonly status: number;
  readonly log: string[];
  readonly stdin: string;
  readonly argv: string;
  /** What the step wrote to $GITHUB_OUTPUT. */
  readonly output: string;
  readonly files: Record<string, string>;
}

/** Runs one step's script with the stubs in `bin`, its env expressions filled in, and $GITHUB_OUTPUT and $RUNNER_TEMP set. */
function runStep(job: string, match: (step: Step) => boolean, stubs: (host: Host) => void, extra: Record<string, string> = {}): StepRun {
  const host = makeHost("afterclass-release-step-");
  const step = workflow("release.yml").jobs[job]!.steps.find(match);
  expect(step).toBeDefined();
  stubs(host);
  const expressions: Record<string, string> = {
    "${{ github.token }}": TOKEN,
    "${{ github.actor }}": "DerekHertz",
    "${{ github.ref_name }}": "v0.1.0",
    "${{ needs.check.outputs.commit }}": COMMIT,
    "${{ needs.image.outputs.digest }}": PUSHED,
    ...extra,
  };
  const env = Object.fromEntries(Object.entries(step!.env ?? {}).map(([key, expression]) => [key, expressions[expression] ?? ""]));
  const output = join(host.root, "github-output");
  const temp = join(host.root, "runner-temp");
  mkdirSync(temp);
  const result = Bun.spawnSync(["bash", "-c", step!.run!], {
    env: { ...process.env, ...env, GITHUB_REPOSITORY: "DerekHertz/after-class", GITHUB_OUTPUT: output, RUNNER_TEMP: temp, PATH: `${host.bin}:${process.env.PATH}` },
  });
  const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
  const files = Object.fromEntries(readdirSync(temp).map((name) => [name, read(join(temp, name))]));
  return { status: result.exitCode, log: readLog(host), stdin: read(join(host.root, "stdin")), argv: read(join(host.root, "argv")), output: read(output), files };
}

interface Registry {
  /** What docker push prints after the layers. */
  readonly pushed?: string;
  readonly pushFails?: boolean;
  /** The digest imagetools inspect reports for each reference after the push. Unlisted references report PUSHED. */
  readonly now?: Record<string, string>;
  readonly inspectFails?: boolean;
}

/** Runs the image job's push step against a stubbed docker whose registry already holds an image under the commit tag. */
function runPushStep(registry: Registry = {}): StepRun {
  return runStep(
    "image",
    (s) => s.id === "push",
    (host) => {
      const now = Object.entries(registry.now ?? {})
        .map(([ref, digest]) => `  ${ref}) echo -n ${digest};;`)
        .join("\n");
      stub(
        host.bin,
        "docker",
        `printf '%s\\0' "$@" >> ${host.root}/argv
echo "docker $*" >> ${host.log}
for last; do :; done
case "$1 $2" in
  "login "*) cat >> ${host.root}/stdin;;
  "manifest inspect") exit 0;;
  "push "*)
    ${registry.pushFails ? "echo 'denied: permission_denied' >&2; exit 1" : ""}
    echo "The push refers to repository [${REPOSITORY}]"
    echo "5f70bf18a086: Pushed"
    printf '%s\\n' "${registry.pushed ?? `${COMMIT}: digest: ${PUSHED} size: 1234`}";;
  "buildx imagetools")
    if [ "$3" = inspect ]; then
      ${registry.inspectFails ? "echo 'unexpected status: 502 Bad Gateway' >&2; exit 1" : ""}
      case "$last" in
${now}
        *) echo -n ${PUSHED};;
      esac
    fi;;
esac
exit 0`,
      );
    },
  );
}

const createdFrom = (run: StepRun): string[] => run.log.filter((line) => line.startsWith("docker buildx imagetools create"));

describe("release workflow", () => {
  const release = workflow("release.yml");

  test("only the image job may write packages, and only the last job may write the release", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(release.jobs.check!.permissions).toEqual({ contents: "read" });
    expect(release.jobs.image!.permissions).toEqual({ contents: "read", packages: "write" });
    expect(release.jobs.release!.permissions).toEqual({ contents: "write" });
  });

  test("the image job builds the commit the release check resolved, after the check passed", () => {
    const check = release.jobs.check!.steps.find((s) => s.run?.includes("scripts/check-release-tag.ts"));
    expect(check?.id).toBeDefined();
    expect(release.jobs.check!.outputs?.commit).toBe(`\${{ steps.${check!.id}.outputs.commit }}`);
    expect(release.jobs.image!.needs).toBe("check");
    const checkouts = release.jobs.image!.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with?.ref).toBe("${{ needs.check.outputs.commit }}");
    expect(checkouts[0]!.with?.["persist-credentials"]).toBe(false);
  });

  test("builds and pushes the arm64 image by commit, tags the release from the pushed digest, and outputs that digest", () => {
    const run = runPushStep();
    expect(run.status).toBe(0);
    expect(run.log).toContain("docker login ghcr.io --username DerekHertz --password-stdin");
    expect(run.stdin).toBe(TOKEN);
    expect(run.argv).not.toContain(TOKEN);
    const build = run.log.find((line) => line.startsWith("docker build "));
    expect(build).toContain("--platform linux/arm64");
    expect(build).toContain(`--tag ${REPOSITORY}:${COMMIT}`);
    expect(run.log).toContain(`docker push ${REPOSITORY}:${COMMIT}`);
    expect(createdFrom(run)).toEqual([`docker buildx imagetools create --tag ${REPOSITORY}:v0.1.0 ${REPOSITORY}@${PUSHED}`]);
    expect(run.output).toBe(`digest=${PUSHED}\n`);
    expect(release.jobs.image!.outputs?.digest).toBe("${{ steps.push.outputs.digest }}");
  });

  test("a poisoned image already under the commit tag is replaced by a fresh build, never promoted", () => {
    const run = runPushStep();
    expect(run.status).toBe(0);
    expect(run.log.some((line) => line.startsWith("docker manifest inspect"))).toBe(false);
    expect(run.log.some((line) => line.startsWith("docker build "))).toBe(true);
    expect(run.log).toContain(`docker push ${REPOSITORY}:${COMMIT}`);
    for (const line of createdFrom(run)) {
      expect(line).toEndWith(`${REPOSITORY}@${PUSHED}`);
      expect(line).not.toContain(ATTACKER);
    }
  });

  test("a commit tag moved to another image during the run fails the step and outputs no digest", () => {
    const run = runPushStep({ now: { [`${REPOSITORY}:${COMMIT}`]: ATTACKER } });
    expect(run.status).not.toBe(0);
    expect(run.output).toBe("");
  });

  const failures: [string, Registry][] = [
    ["a push the registry refuses", { pushFails: true }],
    ["a push that prints no digest", { pushed: `${COMMIT}: pushed` }],
    ["a push that prints the digest of another tag", { pushed: `${"0".repeat(40)}: digest: ${PUSHED} size: 1234` }],
    ["a push whose digest is malformed", { pushed: `${COMMIT}: digest: sha256:${"1".repeat(63)} size: 1234` }],
    ["a registry error while checking the tags", { inspectFails: true }],
  ];
  for (const [name, registry] of failures) {
    test(`${name} fails the step closed, with no digest output`, () => {
      const run = runPushStep(registry);
      expect(run.status).not.toBe(0);
      expect(run.output).toBe("");
    });
  }

  test("the release record is written last: only the release job writes it, after the image job, and the image job never touches a release", () => {
    expect(release.jobs.release!.needs).toEqual(["check", "image"]);
    const writers = Object.entries(release.jobs).filter(([, job]) => job.steps.some((s) => s.run?.includes("gh release")));
    expect(writers.map(([name]) => name)).toEqual(["release"]);
    const contentWriters = Object.entries(release.jobs).filter(([, job]) => job.permissions?.contents === "write");
    expect(contentWriters.map(([name]) => name)).toEqual(["release"]);
  });

  /** Runs the release job's record step with a stubbed gh. */
  function runRecordStep(opts: { exists: boolean; digest?: string }): StepRun {
    return runStep(
      "release",
      (s) => s.run?.includes("gh release") === true,
      (host) =>
        stub(
          host.bin,
          "gh",
          `echo "gh $*" >> ${host.log}
case "$1 $2" in
  "release view") exit ${opts.exists ? 0 : 1};;
esac
exit 0`,
        ),
      opts.digest === undefined ? {} : { "${{ needs.image.outputs.digest }}": opts.digest },
    );
  }

  test("a first run creates the release with image-digest.txt holding the commit and the pushed digest", () => {
    const run = runRecordStep({ exists: false });
    expect(run.status).toBe(0);
    expect(run.files["image-digest.txt"]).toBe(`commit ${COMMIT}\ndigest ${PUSHED}\n`);
    const create = run.log.find((line) => line.startsWith("gh release create"));
    expect(create).toContain("v0.1.0 --repo DerekHertz/after-class --verify-tag");
    expect(create).toEndWith("/image-digest.txt");
  });

  test("a rerun replaces image-digest.txt on the existing release", () => {
    const run = runRecordStep({ exists: true });
    expect(run.status).toBe(0);
    expect(run.log.find((line) => line.startsWith("gh release upload"))).toMatch(/^gh release upload v0\.1\.0 --repo DerekHertz\/after-class --clobber .*\/image-digest\.txt$/);
    expect(run.log.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  test("a missing or malformed digest from the image job writes no release", () => {
    for (const digest of ["", "sha256:abc", ATTACKER.toUpperCase()]) {
      const run = runRecordStep({ exists: false, digest });
      expect(run.status).not.toBe(0);
      expect(run.log).toEqual([]);
    }
  });
});

describe("workflows", () => {
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));

  test("only release.yml's image job requests packages: write, and every workflow sets its token's permissions", () => {
    const writers: string[] = [];
    for (const name of files) {
      const parsed = workflow(name);
      expect(typeof parsed.permissions).toBe("object");
      if (parsed.permissions?.packages === "write") writers.push(name);
      for (const [job, { permissions }] of Object.entries(parsed.jobs)) {
        expect(permissions === undefined || typeof permissions === "object").toBe(true);
        if (permissions?.packages === "write") writers.push(`${name} ${job}`);
      }
    }
    expect(writers).toEqual(["release.yml image"]);
  });

  test("every action is pinned by a full commit hash", () => {
    const uses = files.flatMap((name) => Object.values(workflow(name).jobs).flatMap((job) => job.steps.flatMap((s) => (s.uses ? [s.uses] : []))));
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});
