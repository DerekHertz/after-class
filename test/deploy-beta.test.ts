import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeHost, stub } from "./beta-host";

const SCRIPT = resolve(import.meta.dir, "../scripts/deploy-beta.sh");
const COMMIT = "f".repeat(40);
const INSTANCE = "i-0123456789abcdef0";
const COMMAND = "11111111-2222-3333-4444-555555555555";
const TOKEN = "ghcr-pull-token-for-the-test";

interface Opts {
  readonly tag?: string;
  readonly onMaster?: boolean;
  readonly version?: string;
  readonly imageExists?: boolean;
  readonly statuses?: string[];
}

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every argument vector each stubbed command saw, as [command, ...args]. */
  readonly calls: string[][];
  /** What curl read on stdin when it asked GHCR for the manifest. */
  readonly manifestHeaders: string;
}

/**
 * Runs the real script with git, aws, curl and sleep stubbed. The real check-release-tag.ts runs under bun and reads the
 * stubbed git. The stubbed aws answers get-command-invocation with `statuses` in order, the last one repeating.
 */
function deploy(opts: Opts = {}): Run {
  const host = makeHost("afterclass-deploy-beta-");
  const calls = join(host.root, "calls");
  const record = `{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\n'; } >> ${calls}`;
  writeFileSync(join(host.root, "statuses"), (opts.statuses ?? ["InProgress", "Success"]).join("\n") + "\n");
  stub(
    host.bin,
    "git",
    `${record}
case "$1" in
  rev-parse) echo ${COMMIT};;
  merge-base) exit ${opts.onMaster === false ? 1 : 0};;
  show) echo '{"version":"${opts.version ?? "0.1.0"}"}';;
esac
exit 0`,
  );
  stub(
    host.bin,
    "curl",
    `${record}
for arg; do
  case "$arg" in
    https://ghcr.io/token*) echo '{"token":"${TOKEN}","access_token":"${TOKEN}"}'; exit 0;;
    https://ghcr.io/v2/*) cat > ${host.root}/manifest-headers; exit ${opts.imageExists === false ? 22 : 0};;
  esac
done
exit 2`,
  );
  stub(
    host.bin,
    "aws",
    `${record}
case "$2" in
  get-parameter) echo ${INSTANCE};;
  send-command) echo ${COMMAND};;
  get-command-invocation)
    case "$*" in
      *"--query Status"*)
        status=$(head -n 1 ${host.root}/statuses)
        [ "$(wc -l < ${host.root}/statuses)" -gt 1 ] && sed -i 1d ${host.root}/statuses
        echo "$status";;
      *) echo "afterclass-deploy: ${COMMIT} is healthy";;
    esac;;
esac
exit 0`,
  );
  stub(host.bin, "sleep", "exit 0");
  const result = Bun.spawnSync(["bash", SCRIPT, opts.tag ?? "v0.1.0"], {
    env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` },
  });
  const raw = existsSync(calls) ? readFileSync(calls, "utf8") : "";
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    calls: raw
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\0").filter(Boolean)),
    manifestHeaders: existsSync(join(host.root, "manifest-headers")) ? readFileSync(join(host.root, "manifest-headers"), "utf8") : "",
  };
}

const calledWith = (run: Run, command: string, sub?: string): string[][] => run.calls.filter((call) => call[0] === command && (sub === undefined || call[2] === sub));

describe("scripts/deploy-beta.sh", () => {
  test("sends the deploy document the tag's commit, on the instance named in Parameter Store, and waits for Success", () => {
    const run = deploy();
    expect(run.status).toBe(0);
    expect(calledWith(run, "aws", "send-command")).toEqual([
      [
        "aws",
        "ssm",
        "send-command",
        "--region",
        "us-east-2",
        "--instance-ids",
        INSTANCE,
        "--document-name",
        "afterclass-beta-deploy",
        "--parameters",
        `tag=${COMMIT}`,
        "--comment",
        `deploy v0.1.0 ${COMMIT}`,
        "--query",
        "Command.CommandId",
        "--output",
        "text",
      ],
    ]);
    expect(calledWith(run, "aws", "get-parameter")[0]).toContain("/afterclass-beta/instance_id");
    expect(run.stdout).toContain(`afterclass-deploy: ${COMMIT} is healthy`);
  });

  test("checks the image anonymously at the pinned GHCR repository, by commit, before it sends anything", () => {
    const run = deploy();
    const manifest = calledWith(run, "curl").find((call) => call.some((arg) => arg.startsWith("https://ghcr.io/v2/")));
    expect(manifest).toContain(`https://ghcr.io/v2/derekhertz/after-class/manifests/${COMMIT}`);
    expect(run.manifestHeaders).toContain(`Authorization: Bearer ${TOKEN}`);
    const order = run.calls.map((call) => call[0]);
    expect(order.lastIndexOf("curl")).toBeLessThan(order.indexOf("aws"));
  });

  test("no token appears in any command's arguments", () => {
    const run = deploy();
    expect(run.calls.length).toBeGreaterThan(0);
    for (const call of run.calls) for (const arg of call) expect(arg).not.toContain(TOKEN);
  });

  const refusals: [string, Opts, string][] = [
    ["a tag off master", { onMaster: false }, "which is not on master"],
    ["a tag whose package.json names another version", { version: "0.0.9" }, 'does not match package.json version "0.0.9"'],
    ["a tag that is not v<major>.<minor>.<patch>", { tag: "v0.1.0;rm" }, "is not v<major>.<minor>.<patch>"],
  ];
  for (const [name, opts, reason] of refusals) {
    test(`refuses ${name} before it asks GHCR or AWS anything`, () => {
      const run = deploy(opts);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(reason);
      expect(calledWith(run, "curl")).toEqual([]);
      expect(calledWith(run, "aws")).toEqual([]);
    });
  }

  test("refuses when GHCR has no public image for the commit, and sends nothing", () => {
    const run = deploy({ imageExists: false });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`ghcr.io/derekhertz/after-class:${COMMIT}`);
    expect(calledWith(run, "aws")).toEqual([]);
  });

  test("a deploy the server reports as failed fails the script and shows the server's output", () => {
    const run = deploy({ statuses: ["InProgress", "Failed"] });
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain("Failed");
    expect(run.stdout + run.stderr).toContain(`afterclass-deploy: ${COMMIT} is healthy`);
  });

  test("a deploy still running after 15 minutes fails the script", () => {
    const run = deploy({ statuses: ["InProgress"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("still running");
  });
});
