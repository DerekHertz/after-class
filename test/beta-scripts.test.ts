import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./tmp";

const FILES = resolve(import.meta.dir, "../infra/beta/files");

function stub(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

interface DeployRun {
  readonly status: number;
  readonly tag: string;
  readonly log: string[];
  readonly stderr: string;
}

/**
 * Runs the real afterclass-deploy script with its absolute paths rewritten into a temp tree and every command it calls
 * replaced by a stub. `restartFails` and `unhealthy` name the tags that make the stubbed systemctl restart fail and the
 * stubbed /health answer 500. A stub reads the tag the script selected from the state file, as the real unit would.
 */
function runDeploy(opts: { previous: string; next: string; restartFails?: string[]; unhealthy?: string[]; pruneFails?: boolean }): DeployRun {
  const root = tmpDir("afterclass-deploy-test-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "data/afterclass"), { recursive: true });
  writeFileSync(join(root, "data/afterclass/current-tag"), `${opts.previous}\n`);
  writeFileSync(join(root, "settings.env"), "APP_PORT=8080\n");
  const state = join(root, "data/afterclass/current-tag");
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  const restartFails = (opts.restartFails ?? []).join(" ");
  const unhealthy = (opts.unhealthy ?? []).join(" ");

  stub(bin, "mountpoint", "exit 0");
  stub(bin, "sleep", "exit 0");
  stub(bin, "journalctl", "exit 0");
  stub(bin, "curl", `tag=$(cat ${state}); case " ${unhealthy} " in *" $tag "*) exit 22;; esac; exit 0`);
  stub(
    bin,
    "systemctl",
    `echo "systemctl $*" >> ${log}
tag=$(cat ${state})
case "$1" in
  restart) case " ${restartFails} " in *" $tag "*) exit 1;; esac;;
esac
exit 0`,
  );
  stub(bin, "docker", `echo "docker $*" >> ${log}\n${opts.pruneFails ? 'if [ "$2" = prune ]; then exit 1; fi' : ""}\nexit 0`);
  stub(root, "pull", `echo "pull $1" >> ${log}`);

  const script = readFileSync(join(FILES, "afterclass-deploy.sh"), "utf8")
    .replaceAll("/etc/afterclass/settings.env", join(root, "settings.env"))
    .replaceAll("/run/afterclass-deploy.lock", join(root, "lock"))
    .replaceAll("/data/afterclass", join(root, "data/afterclass"))
    .replaceAll("/usr/local/sbin/afterclass-pull", join(root, "pull"));
  expect(script).not.toContain("/usr/local/sbin");
  writeFileSync(join(root, "deploy.sh"), script);

  const result = Bun.spawnSync(["bash", join(root, "deploy.sh"), opts.next], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return {
    status: result.exitCode,
    tag: readFileSync(state, "utf8").trim(),
    log: readFileSync(log, "utf8").split("\n").filter(Boolean),
    stderr: result.stderr.toString(),
  };
}

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

describe("afterclass-deploy", () => {
  test("a healthy deploy keeps the new tag", () => {
    const run = runDeploy({ previous: OLD, next: NEW });
    expect(run.status).toBe(0);
    expect(run.tag).toBe(NEW);
  });

  test("a tag that never turns healthy is rolled back, and the run still fails", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unhealthy: [NEW] });
    expect(run.status).toBe(1);
    expect(run.tag).toBe(OLD);
  });

  test("a failing systemctl restart is rolled back too, not left on the failed tag", () => {
    const run = runDeploy({ previous: OLD, next: NEW, restartFails: [NEW] });
    expect(run.status).toBe(1);
    expect(run.tag).toBe(OLD);
    expect(run.log.filter((line) => line === "systemctl restart afterclass-app.service")).toHaveLength(2);
    expect(run.stderr).toContain("rolled back to " + OLD);
  });

  test("a rollback whose own restart fails still selects the previous tag and fails the run", () => {
    const run = runDeploy({ previous: OLD, next: NEW, restartFails: [NEW, OLD] });
    expect(run.status).toBe(1);
    expect(run.tag).toBe(OLD);
  });

  test("a failed prune does not fail a healthy deploy", () => {
    const run = runDeploy({ previous: OLD, next: NEW, pruneFails: true });
    expect(run.status).toBe(0);
    expect(run.tag).toBe(NEW);
    expect(run.log.some((line) => line.startsWith("docker image prune"))).toBe(true);
  });
});

/** The bootstrap script's disk_signature function, run alone against a stubbed blkid. */
function diskSignature(blkidBody: string): { status: number; stdout: string } {
  const root = tmpDir("afterclass-bootstrap-test-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  stub(bin, "blkid", blkidBody);
  const source = readFileSync(join(FILES, "afterclass-bootstrap.sh"), "utf8");
  const match = /^disk_signature\(\) \{\n[\s\S]*?\n\}\n/m.exec(source);
  expect(match).not.toBeNull();
  const result = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${match![0]}\ndisk_signature /dev/test`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { status: result.exitCode, stdout: result.stdout.toString().trim() };
}

describe("afterclass-bootstrap disk_signature", () => {
  test("blkid exit 2, nothing found, is an empty disk", () => {
    expect(diskSignature("exit 2")).toEqual({ status: 0, stdout: "empty" });
  });

  test("a blkid error is not an empty disk", () => {
    for (const code of [1, 4, 8, 127]) {
      const result = diskSignature(`echo 'blkid: error' >&2; exit ${code}`);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toBe("empty");
    }
  });

  test("an xfs filesystem is named", () => {
    expect(diskSignature("printf 'DEVNAME=/dev/test\\nTYPE=xfs\\nLABEL=afterclass-data\\n'")).toEqual({ status: 0, stdout: "xfs" });
  });

  test("a partition table is a signature, so the disk is not empty", () => {
    const result = diskSignature("printf 'DEVNAME=/dev/test\\nPTTYPE=gpt\\n'");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe("empty");
    expect(result.stdout).not.toBe("xfs");
  });
});
