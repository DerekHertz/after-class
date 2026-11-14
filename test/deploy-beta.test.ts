import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeHost, stub } from "./beta-host";

const SCRIPT = resolve(import.meta.dir, "../scripts/deploy-beta.sh");
const COMMIT = "f".repeat(40);
const INSTANCE = "i-0123456789abcdef0";
const COMMAND = "11111111-2222-3333-4444-555555555555";
const TOKEN = "ghcr-pull-token-for-the-test";
const APPROVED = `sha256:${"1".repeat(64)}`;
const ATTACKER = `sha256:${"2".repeat(64)}`;
const RECORD = `commit ${COMMIT}\ndigest ${APPROVED}\n`;

interface Opts {
  readonly tag?: string;
  readonly onMaster?: boolean;
  readonly version?: string;
  readonly imageExists?: boolean;
  /** The release's image-digest.txt, or null for a release without one. */
  readonly record?: string | null;
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
 * Runs the real script with git, gh, aws, curl and sleep stubbed. The real check-release-tag.ts runs under bun and reads
 * the stubbed git. The stubbed gh serves `record` as the release's image-digest.txt. The stubbed GHCR serves the approved
 * digest, and its commit tag names the attacker's digest, as after a retag. The stubbed aws answers
 * get-command-invocation with `statuses` in order, the last one repeating.
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
  const served = opts.record === undefined ? RECORD : opts.record;
  if (served !== null) writeFileSync(join(host.root, "record"), served);
  stub(host.bin, "gh", `${record}\n[ -e ${host.root}/record ] || { echo 'no assets match the file pattern' >&2; exit 1; }\ncat ${host.root}/record`);
  stub(
    host.bin,
    "curl",
    `${record}
for arg; do
  case "$arg" in
    https://ghcr.io/token*) echo '{"token":"${TOKEN}","access_token":"${TOKEN}"}'; exit 0;;
    https://ghcr.io/v2/*/manifests/${APPROVED}) cat > ${host.root}/manifest-headers; exit ${opts.imageExists === false ? 22 : 0};;
    https://ghcr.io/v2/*/manifests/${COMMIT}) echo "Docker-Content-Digest: ${ATTACKER}"; exit 0;;
    https://ghcr.io/v2/*) exit 22;;
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
  test("sends the deploy document the tag's commit and the release's digest, on the instance named in Parameter Store, and waits for Success", () => {
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
        `{"tag":["${COMMIT}"],"digest":["${APPROVED}"]}`,
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

  test("reads the digest from the tag's GitHub Release in the pinned repository", () => {
    const run = deploy();
    expect(calledWith(run, "gh")).toEqual([["gh", "release", "download", "v0.1.0", "--repo", "DerekHertz/after-class", "--pattern", "image-digest.txt", "--output", "-"]]);
  });

  test("an attacker who moved the commit tag on GHCR to another image does not change the digest sent", () => {
    const run = deploy();
    expect(run.status).toBe(0);
    const sent = calledWith(run, "aws", "send-command")[0]!.join(" ");
    expect(sent).toContain(APPROVED);
    expect(sent).not.toContain(ATTACKER);
    expect(calledWith(run, "curl").some((call) => call.some((arg) => arg.endsWith(`/manifests/${COMMIT}`)))).toBe(false);
  });

  test("checks the image anonymously at the pinned GHCR repository, by digest, before it sends anything", () => {
    const run = deploy();
    const manifest = calledWith(run, "curl").find((call) => call.some((arg) => arg.startsWith("https://ghcr.io/v2/")));
    expect(manifest).toContain(`https://ghcr.io/v2/derekhertz/after-class/manifests/${APPROVED}`);
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
    test(`refuses ${name} before it asks GitHub, GHCR or AWS anything`, () => {
      const run = deploy(opts);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(reason);
      expect(calledWith(run, "gh")).toEqual([]);
      expect(calledWith(run, "curl")).toEqual([]);
      expect(calledWith(run, "aws")).toEqual([]);
    });
  }

  const badRecords: [string, string | null, string][] = [
    ["a release without image-digest.txt", null, "has no image-digest.txt"],
    ["an empty record", "", "is not a commit line and a digest line"],
    ["a record without a digest line", `commit ${COMMIT}\n`, "is not a commit line and a digest line"],
    ["a digest that is too short", `commit ${COMMIT}\ndigest sha256:${"1".repeat(63)}\n`, "is not a commit line and a digest line"],
    ["an uppercase digest", `commit ${COMMIT}\ndigest sha256:${"A".repeat(64)}\n`, "is not a commit line and a digest line"],
    ["a digest that is a tag", `commit ${COMMIT}\ndigest ${COMMIT}\n`, "is not a commit line and a digest line"],
    ["a digest with a registry in it", `commit ${COMMIT}\ndigest evil.example/x@${APPROVED}\n`, "is not a commit line and a digest line"],
    ["a record with a line after the digest", `${RECORD}digest ${ATTACKER}\n`, "is not a commit line and a digest line"],
    ["a record for another commit", `commit ${"0".repeat(40)}\ndigest ${APPROVED}\n`, "records commit 0000"],
  ];
  for (const [name, record, reason] of badRecords) {
    test(`refuses ${name}, and asks GHCR and AWS nothing`, () => {
      const run = deploy({ record });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(reason);
      expect(calledWith(run, "curl")).toEqual([]);
      expect(calledWith(run, "aws")).toEqual([]);
    });
  }

  test("refuses when GHCR has no public image for the digest, and sends nothing", () => {
    const run = deploy({ imageExists: false });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`ghcr.io/derekhertz/after-class@${APPROVED}`);
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

describe("the deploy document", () => {
  const document = readFileSync(resolve(import.meta.dir, "../infra/beta/deploy.tf"), "utf8");
  const allowed = (parameter: string): RegExp => {
    const match = new RegExp(`\\b${parameter} = \\{[^}]*allowedPattern\\s*=\\s*"([^"]+)"`).exec(document);
    expect(match).not.toBeNull();
    return new RegExp(match![1]!);
  };

  test("accepts only a sha256 digest, never a tag, a commit hash or a reference that names a registry", () => {
    const digest = allowed("digest");
    expect(digest.test(APPROVED)).toBe(true);
    for (const value of [COMMIT, `sha256:${"1".repeat(63)}`, `sha256:${"A".repeat(64)}`, `${APPROVED}0`, `ghcr.io/derekhertz/after-class@${APPROVED}`, `${APPROVED} ${ATTACKER}`, "1".repeat(64), ""]) {
      expect(digest.test(value)).toBe(false);
    }
  });

  test("accepts only a full lowercase commit hash as the tag", () => {
    const tag = allowed("tag");
    expect(tag.test(COMMIT)).toBe(true);
    for (const value of [APPROVED, COMMIT.toUpperCase(), `${COMMIT}0`, "v0.1.0", ""]) expect(tag.test(value)).toBe(false);
  });

  test("hands both to the server's deploy script", () => {
    expect(document).toContain('"/usr/local/sbin/afterclass-deploy {{ tag }} {{ digest }}"');
  });
});
