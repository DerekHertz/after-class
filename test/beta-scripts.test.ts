import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./tmp";

const FILES = resolve(import.meta.dir, "../infra/beta/files");

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OLDER = "c".repeat(40);
const OLDEST = "d".repeat(40);

function stub(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

interface Host {
  readonly root: string;
  readonly bin: string;
  readonly log: string;
}

/** A temp tree that stands in for one server's root: /data, /etc/afterclass and /usr/local/sbin. */
function makeHost(prefix: string): Host {
  const root = tmpDir(prefix);
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "data/afterclass/images"), { recursive: true });
  writeFileSync(join(root, "settings.env"), "APP_PORT=8080\nAWS_REGION=us-east-2\nECR_REGISTRY=registry.test\nECR_REPOSITORY=afterclass-api\n");
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  return { root, bin, log };
}

function readLog(host: Host): string[] {
  return readFileSync(host.log, "utf8").split("\n").filter(Boolean);
}

/** Copies a real script into the host with every absolute path of the real server pointed into the temp tree. */
function installScript(host: Host, name: string): string {
  const text = readFileSync(join(FILES, `${name}.sh`), "utf8")
    .replaceAll("/etc/afterclass/settings.env", join(host.root, "settings.env"))
    .replaceAll("/run/afterclass-deploy.lock", join(host.root, "lock"))
    .replaceAll("/data/afterclass", join(host.root, "data/afterclass"))
    .replace(/\/usr\/local\/sbin\/(afterclass-[a-z-]+)/g, join(host.root, "$1"));
  expect(text).not.toContain("/usr/local/sbin");
  const path = join(host.root, name);
  writeFileSync(path, text);
  return path;
}

function runScript(host: Host, name: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", installScript(host, name), ...args], {
    env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` },
  });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

interface DeployRun {
  readonly status: number;
  readonly tag: string;
  readonly log: string[];
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the real afterclass-deploy script against stubbed commands. `restartFails` and `unhealthy` name the tags that make
 * the stubbed systemctl restart fail and the stubbed /health answer 500. A stub reads the tag the script selected from the
 * state file, as the real unit would. The pull and save scripts it calls are stubs that log their arguments.
 */
function runDeploy(opts: {
  previous: string;
  next: string;
  restartFails?: string[];
  unhealthy?: string[];
  pruneFails?: boolean;
  saveFails?: boolean;
}): DeployRun {
  const host = makeHost("afterclass-deploy-test-");
  const state = join(host.root, "data/afterclass/current-tag");
  writeFileSync(state, `${opts.previous}\n`);
  const restartFails = (opts.restartFails ?? []).join(" ");
  const unhealthy = (opts.unhealthy ?? []).join(" ");

  stub(host.bin, "mountpoint", "exit 0");
  stub(host.bin, "sleep", "exit 0");
  stub(host.bin, "journalctl", "exit 0");
  stub(host.bin, "curl", `tag=$(cat ${state}); case " ${unhealthy} " in *" $tag "*) exit 22;; esac; exit 0`);
  stub(
    host.bin,
    "systemctl",
    `echo "systemctl $*" >> ${host.log}
tag=$(cat ${state})
case "$1" in
  restart) case " ${restartFails} " in *" $tag "*) exit 1;; esac;;
esac
exit 0`,
  );
  stub(host.bin, "docker", `echo "docker $*" >> ${host.log}\n${opts.pruneFails ? 'if [ "$2" = prune ]; then exit 1; fi' : ""}\nexit 0`);
  stub(host.root, "afterclass-pull", `echo "pull $1" >> ${host.log}`);
  stub(host.root, "afterclass-save-image", `echo "save $*" >> ${host.log}\n${opts.saveFails ? "echo 'no space left' >&2; exit 1" : "exit 0"}`);

  const run = runScript(host, "afterclass-deploy", [opts.next]);
  return { ...run, tag: readFileSync(state, "utf8").trim(), log: readLog(host) };
}

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

/** The named functions of afterclass-bootstrap, so a test can run them alone against stubbed disk tools. */
function bootstrapFunctions(names: string[]): string {
  const source = readFileSync(join(FILES, "afterclass-bootstrap.sh"), "utf8");
  return names
    .map((name) => {
      const match = new RegExp(`^${name}\\(\\) \\{(?: .*\\}\\n|\\n[\\s\\S]*?\\n\\}\\n)`, "m").exec(source);
      expect(match).not.toBeNull();
      return match![0];
    })
    .join("\n");
}

/** Stub bodies for the disk tools. `dd` receives the real dd arguments. */
interface DiskTools {
  readonly dd?: string;
  readonly wipefs?: string;
  readonly blockdev?: string;
}

function prepareDisk(tools: DiskTools): { status: number; formatted: boolean } {
  const host = makeHost("afterclass-bootstrap-test-");
  stub(host.bin, "blockdev", tools.blockdev ?? "echo 21474836480");
  stub(host.bin, "dd", tools.dd ?? "exit 0");
  stub(host.bin, "wipefs", tools.wipefs ?? "exit 0");
  stub(host.bin, "mkfs.xfs", `echo "mkfs.xfs $*" >> ${host.log}`);
  const script = `set -euo pipefail\n${bootstrapFunctions(["say", "disk_signature", "prepare_filesystem"])}\nprepare_filesystem /dev/test`;
  const result = Bun.spawnSync(["bash", "-c", script], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } });
  return { status: result.exitCode, formatted: readLog(host).some((line) => line.startsWith("mkfs.xfs")) };
}

describe("afterclass-bootstrap data volume", () => {
  test("a readable disk with no signature is formatted", () => {
    const run = prepareDisk({});
    expect(run.status).toBe(0);
    expect(run.formatted).toBe(true);
  });

  test("a read error that the probe reports with the exit status for nothing found is not an empty disk", () => {
    const run = prepareDisk({
      dd: "echo 'dd: error reading /dev/test: Input/output error' >&2; exit 1",
      wipefs: "echo 'wipefs: error: /dev/test: probing initialization failed: Input/output error' >&2; exit 2",
    });
    expect(run.status).not.toBe(0);
    expect(run.formatted).toBe(false);
  });

  test("a probe that prints an I/O error and exits 2 does not format, even when dd could read", () => {
    const run = prepareDisk({ wipefs: "echo 'Input/output error' >&2; exit 2" });
    expect(run.status).not.toBe(0);
    expect(run.formatted).toBe(false);
  });

  test("a probe that prints to stderr and still exits 0 does not format", () => {
    const run = prepareDisk({ wipefs: "echo 'warning: something' >&2; exit 0" });
    expect(run.status).not.toBe(0);
    expect(run.formatted).toBe(false);
  });

  test("a probe error of any exit status does not format", () => {
    for (const code of [1, 2, 4, 8, 127]) {
      const run = prepareDisk({ wipefs: `exit ${code}` });
      expect(run.status).not.toBe(0);
      expect(run.formatted).toBe(false);
    }
  });

  test("an unreadable last MiB does not format", () => {
    const run = prepareDisk({ dd: 'case "$*" in *skip=*) echo "dd: Input/output error" >&2; exit 1;; esac; exit 0' });
    expect(run.status).not.toBe(0);
    expect(run.formatted).toBe(false);
  });

  test("an unreadable first MiB does not format", () => {
    const run = prepareDisk({ dd: 'case "$*" in *skip=*) exit 0;; esac; echo "dd: Input/output error" >&2; exit 1' });
    expect(run.status).not.toBe(0);
    expect(run.formatted).toBe(false);
  });

  test("a device whose size cannot be read does not format", () => {
    for (const blockdev of ["exit 1", "echo 0", "echo notanumber"]) {
      const run = prepareDisk({ blockdev });
      expect(run.status).not.toBe(0);
      expect(run.formatted).toBe(false);
    }
  });

  test("an xfs filesystem is kept, not formatted", () => {
    const run = prepareDisk({ wipefs: "echo xfs" });
    expect(run.status).toBe(0);
    expect(run.formatted).toBe(false);
  });

  test("any other signature, a partition table included, is refused and not formatted", () => {
    for (const found of ["ext4", "gpt", "gpt\\nPMBR", "LVM2_member", "xfs\\next4"]) {
      const run = prepareDisk({ wipefs: `printf '${found}\\n'` });
      expect(run.status).not.toBe(0);
      expect(run.formatted).toBe(false);
    }
  });

  const haveTools = Bun.which("wipefs") !== null && Bun.which("mkfs.ext4") !== null && Bun.which("truncate") !== null;
  test.skipIf(!haveTools)("the real dd and wipefs tell a blank image from an ext4 one", () => {
    const host = makeHost("afterclass-bootstrap-real-");
    const image = join(host.root, "disk.img");
    expect(Bun.spawnSync(["truncate", "-s", "8M", image]).exitCode).toBe(0);
    stub(host.bin, "blockdev", "echo 8388608");
    stub(host.bin, "mkfs.xfs", `echo "mkfs.xfs $*" >> ${host.log}`);
    const script = `set -euo pipefail\n${bootstrapFunctions(["say", "disk_signature", "prepare_filesystem"])}\nprepare_filesystem ${image}`;
    const run = () => Bun.spawnSync(["bash", "-c", script], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } });

    expect(run().exitCode).toBe(0);
    expect(readLog(host).some((line) => line.startsWith("mkfs.xfs"))).toBe(true);

    writeFileSync(host.log, "");
    expect(Bun.spawnSync(["mkfs.ext4", "-q", image]).exitCode).toBe(0);
    expect(run().exitCode).not.toBe(0);
    expect(readLog(host).some((line) => line.startsWith("mkfs.xfs"))).toBe(false);
  });
});

describe("beta container wiring", () => {
  const caddyUnit = readFileSync(join(FILES, "afterclass-caddy.service"), "utf8");
  const appStart = readFileSync(join(FILES, "afterclass-app-start.sh"), "utf8");
  const caddyfile = readFileSync(join(FILES, "Caddyfile.tftpl"), "utf8");

  test("Caddy leaves the host network, so it cannot reach the metadata service, and drops every capability but port binding", () => {
    expect(caddyUnit).not.toContain("--network host");
    expect(caddyUnit).toContain("--network afterclass");
    expect(caddyUnit).toContain("-p 80:80 -p 443:443");
    expect(caddyUnit).toContain("--cap-drop ALL --cap-add NET_BIND_SERVICE");
    expect(caddyUnit).toContain("--security-opt no-new-privileges");
    expect(caddyUnit).toContain("--read-only");
  });

  test("Caddy proxies to the app container by the name and network the app starts with", () => {
    expect(appStart).toContain("--name afterclass-app");
    expect(appStart).toContain("--network afterclass");
    expect(caddyfile).toContain("reverse_proxy afterclass-app:${app_port}");
  });
});
