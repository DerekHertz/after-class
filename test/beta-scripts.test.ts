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

  test("a healthy deploy saves the new image and keeps the one it replaced", () => {
    const run = runDeploy({ previous: OLD, next: NEW });
    expect(run.log).toContain(`save ${NEW} ${OLD}`);
    expect(run.stdout).not.toContain("WARNING");
  });

  test("the first deploy saves only the new image", () => {
    const run = runDeploy({ previous: "", next: NEW });
    expect(run.status).toBe(0);
    expect(run.log).toContain(`save ${NEW}`);
  });

  test("a failed save does not break a healthy deploy and is reported as a warning on stdout", () => {
    const run = runDeploy({ previous: OLD, next: NEW, saveFails: true });
    expect(run.status).toBe(0);
    expect(run.tag).toBe(NEW);
    expect(run.stdout).toContain(`WARNING ${NEW} is not saved on /data`);
    expect(run.log.some((line) => line.startsWith("docker image prune"))).toBe(true);
  });

  test("a rollback saves the image it restored, and a tag that failed is never saved", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unhealthy: [NEW] });
    expect(run.log).toContain(`save ${OLD}`);
    expect(run.log.some((line) => line.startsWith(`save ${NEW}`))).toBe(false);
  });

  test("a failed save after a rollback is still reported, and the run still fails", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unhealthy: [NEW], saveFails: true });
    expect(run.status).toBe(1);
    expect(run.tag).toBe(OLD);
    expect(run.stdout).toContain(`WARNING ${OLD} is not saved on /data`);
  });
});

const imageName = (tag: string): string => `registry.test/afterclass-api:${tag}`;
const storeKey = (tag: string): string => imageName(tag).replace(/[/:]/g, "_");

/**
 * A stand-in for the docker CLI. Its image store is a folder of marker files, so a save on one host followed by a load on
 * another behaves like the real round trip. `pullFails` stands for an image ECR no longer holds, `saveFails` leaves a half
 * file and exits 1, and `size` is what `image inspect --format` reports.
 */
function fakeDocker(host: Host, opts: { store: string; pullFails?: boolean | undefined; saveFails?: boolean | undefined; size?: number }): void {
  mkdirSync(opts.store, { recursive: true });
  stub(
    host.bin,
    "docker",
    `echo "docker $*" >> ${host.log}
key() { echo "$1" | tr '/:' '__'; }
case "$1 $2" in
  "image inspect")
    image="\${@: -1}"
    [ -e "${opts.store}/$(key "$image")" ] || exit 1
    [ "$3" = --format ] && echo ${opts.size ?? 1000}
    exit 0;;
  "save --output")
    echo partial > "$3"
    ${opts.saveFails ? "exit 1" : ""}
    [ -e "${opts.store}/$(key "$4")" ] || exit 1
    echo "$4" > "$3"; exit 0;;
  "load --input")
    grep -q corrupt "$3" && exit 1
    touch "${opts.store}/$(key "$(cat "$3")")"; exit 0;;
  "pull "*)
    ${opts.pullFails ? "exit 1" : ""}
    touch "${opts.store}/$(key "$2")"; exit 0;;
  "login "*) cat >/dev/null; exit 0;;
esac
exit 0`,
  );
  stub(host.bin, "aws", "echo token");
}

function addLocalImage(store: string, tag: string): void {
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, storeKey(tag)), "");
}

function runSave(opts: {
  keep: string[];
  have?: string[];
  tarballs?: string[];
  strays?: string[];
  freeBytes?: number;
  saveFails?: boolean;
}): { status: number; stderr: string; files: string[]; log: string[] } {
  const host = makeHost("afterclass-save-test-");
  const store = join(host.root, "store");
  fakeDocker(host, { store, saveFails: opts.saveFails });
  for (const tag of opts.have ?? [opts.keep[0]!]) addLocalImage(store, tag);
  const dir = join(host.root, "data/afterclass/images");
  for (const tag of opts.tarballs ?? []) writeFileSync(join(dir, `${tag}.tar`), `${imageName(tag)}\n`);
  for (const name of opts.strays ?? []) writeFileSync(join(dir, name), "stray");
  stub(host.bin, "df", `printf 'Avail\\n%s\\n' ${opts.freeBytes ?? 10_000_000_000}`);

  const run = runScript(host, "afterclass-save-image", opts.keep);
  return { status: run.status, stderr: run.stderr, files: readdirSync(dir).sort(), log: readLog(host) };
}

describe("afterclass-save-image", () => {
  test("saves the running image as <tag>.tar and leaves no temporary file", () => {
    const run = runSave({ keep: [NEW] });
    expect(run.status).toBe(0);
    expect(run.files).toEqual([`${NEW}.tar`]);
  });

  test("keeps the two named tarballs and prunes every other one, a crashed save's temporary file included", () => {
    const run = runSave({ keep: [NEW, OLD], tarballs: [OLD, OLDER, OLDEST], strays: [`${OLDER}.tar.new`] });
    expect(run.status).toBe(0);
    expect(run.files).toEqual([`${NEW}.tar`, `${OLD}.tar`].sort());
  });

  test("a save that fails part way leaves the kept tarball, no half file, and a nonzero status", () => {
    const run = runSave({ keep: [NEW, OLD], tarballs: [OLD, OLDER], saveFails: true });
    expect(run.status).not.toBe(0);
    expect(run.files).toEqual([`${OLD}.tar`]);
  });

  test("a disk with too little room is refused without writing anything, so the database keeps its space", () => {
    const run = runSave({ keep: [NEW, OLD], tarballs: [OLD], freeBytes: 500_000_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("bytes free on /data");
    expect(run.log.some((line) => line.startsWith("docker save"))).toBe(false);
    expect(run.files).toEqual([`${OLD}.tar`]);
  });

  test("a tarball that already exists is not written again", () => {
    const run = runSave({ keep: [NEW], tarballs: [NEW] });
    expect(run.status).toBe(0);
    expect(run.log.some((line) => line.startsWith("docker save"))).toBe(false);
  });

  test("an image that is not on the host is an error, not an empty tarball", () => {
    const run = runSave({ keep: [NEW], have: [] });
    expect(run.status).not.toBe(0);
    expect(run.files).toEqual([]);
  });

  test("anything but a full commit hash is refused, so a tag cannot name a path", () => {
    const run = runSave({ keep: ["../../etc/passwd"], have: [] });
    expect(run.status).toBe(2);
  });
});

function runPull(opts: { tag: string; have?: string[]; tarball?: { content?: string }; pullFails?: boolean }): {
  status: number;
  log: string[];
  hasImage: boolean;
} {
  const host = makeHost("afterclass-pull-test-");
  const store = join(host.root, "store");
  fakeDocker(host, { store, pullFails: opts.pullFails });
  for (const tag of opts.have ?? []) addLocalImage(store, tag);
  if (opts.tarball) {
    writeFileSync(join(host.root, "data/afterclass/images", `${opts.tag}.tar`), opts.tarball.content ?? `${imageName(opts.tag)}\n`);
  }
  const run = runScript(host, "afterclass-pull", [opts.tag]);
  return { status: run.status, log: readLog(host), hasImage: existsSync(join(store, storeKey(opts.tag))) };
}

describe("afterclass-pull", () => {
  test("an image already on the host is neither loaded nor pulled", () => {
    const run = runPull({ tag: NEW, have: [NEW], tarball: {} });
    expect(run.status).toBe(0);
    expect(run.log.some((line) => line.startsWith("docker load") || line.startsWith("docker pull"))).toBe(false);
  });

  test("an image ECR has expired starts from the tarball on the data volume", () => {
    const run = runPull({ tag: NEW, tarball: {}, pullFails: true });
    expect(run.status).toBe(0);
    expect(run.hasImage).toBe(true);
    expect(run.log.some((line) => line.startsWith("docker pull"))).toBe(false);
  });

  test("an expired image with no tarball fails, rather than starting something else", () => {
    const run = runPull({ tag: NEW, pullFails: true });
    expect(run.status).not.toBe(0);
    expect(run.hasImage).toBe(false);
  });

  test("a tarball that does not load falls back to ECR", () => {
    const run = runPull({ tag: NEW, tarball: { content: "corrupt" } });
    expect(run.status).toBe(0);
    expect(run.hasImage).toBe(true);
    expect(run.log.some((line) => line.startsWith("docker pull"))).toBe(true);
  });

  test("an image with no tarball is pulled from ECR", () => {
    const run = runPull({ tag: NEW });
    expect(run.status).toBe(0);
    expect(run.log.some((line) => line.startsWith("docker pull"))).toBe(true);
  });
});

describe("a replaced instance", () => {
  test("starts the image the old instance saved to /data, after ECR expired it", () => {
    const old = makeHost("afterclass-replace-old-");
    fakeDocker(old, { store: join(old.root, "store") });
    addLocalImage(join(old.root, "store"), NEW);
    stub(old.bin, "df", "printf 'Avail\\n10000000000\\n'");
    expect(runScript(old, "afterclass-save-image", [NEW, OLD]).status).toBe(0);

    const fresh = makeHost("afterclass-replace-new-");
    rmSync(join(fresh.root, "data"), { recursive: true });
    renameSync(join(old.root, "data"), join(fresh.root, "data"));
    fakeDocker(fresh, { store: join(fresh.root, "store"), pullFails: true });
    expect(runScript(fresh, "afterclass-pull", [NEW]).status).toBe(0);
    expect(existsSync(join(fresh.root, "store", storeKey(NEW)))).toBe(true);
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

type Filesystem = "empty" | "xfs" | "ext4";

interface BootOptions {
  /** Replacement stub bodies for the disk tools. `dd` receives the real dd arguments. */
  readonly dd?: string;
  readonly wipefs?: string;
  readonly blockdev?: string;
  /** Leaves dd and wipefs unstubbed and points the script at this image file instead of /dev/test. */
  readonly realProbesOn?: string;
  /** Every EC2 API read of the tag fails, as when the role lacks the permission or the network is down. */
  readonly describeFails?: boolean;
  /** Every CreateTags call fails. */
  readonly tagWriteFails?: boolean;
}

/**
 * One data volume and the instance it is attached to, across reboots. The disk, the volume tag and the root volume's
 * marker directory persist between boots. The stub tools work from them. wipefs and blkid report the disk's real
 * filesystem unless a test replaces wipefs, mkfs.xfs writes xfs, mount succeeds only for xfs, and the stubbed aws reads and
 * writes the tag.
 */
class VolumeHost {
  readonly host = makeHost("afterclass-bootstrap-test-");
  private readonly disk = join(this.host.root, "disk-fs");
  private readonly tagFile = join(this.host.root, "volume-tag");

  constructor(opts: { filesystem: Filesystem; tag: string | null }) {
    writeFileSync(this.disk, opts.filesystem === "empty" ? "" : opts.filesystem);
    if (opts.tag !== null) writeFileSync(this.tagFile, opts.tag);
  }

  get filesystem(): string {
    return readFileSync(this.disk, "utf8");
  }

  get tag(): string | null {
    return existsSync(this.tagFile) ? readFileSync(this.tagFile, "utf8") : null;
  }

  get log(): string[] {
    return readLog(this.host);
  }

  count(prefix: string): number {
    return this.log.filter((line) => line.startsWith(prefix)).length;
  }

  formatted(): boolean {
    return this.count("mkfs.xfs") > 0;
  }

  /** Boots the instance once and runs provision_data_volume the way afterclass-bootstrap does. */
  boot(opts: BootOptions = {}): { status: number; output: string } {
    const { host, disk, tagFile } = this;
    const mounted = join(host.root, "mounted");
    rmSync(mounted, { force: true });
    writeFileSync(join(host.root, "fstab"), "UUID=root / xfs defaults 0 1\n");
    stub(host.bin, "sleep", "exit 0");
    stub(host.bin, "blockdev", opts.blockdev ?? "echo 21474836480");
    if (!opts.realProbesOn) {
      stub(host.bin, "dd", opts.dd ?? "exit 0");
      stub(host.bin, "wipefs", opts.wipefs ?? `cat ${disk}`);
    }
    stub(host.bin, "mkfs.xfs", `echo "mkfs.xfs $*" >> ${host.log}\nprintf xfs > ${disk}`);
    stub(host.bin, "blkid", `case "$*" in *LABEL*) [ "$(cat ${disk})" = xfs ] && echo afterclass-data;; *TYPE*) cat ${disk};; esac; exit 0`);
    stub(host.bin, "xfs_admin", `echo "xfs_admin $*" >> ${host.log}`);
    stub(host.bin, "systemctl", "exit 0");
    stub(host.bin, "mountpoint", `[ -e ${mounted} ]`);
    stub(
      host.bin,
      "mount",
      `if [ "$(cat ${disk})" = xfs ]; then echo "mount $*" >> ${host.log}; touch ${mounted}; exit 0; fi
echo "mount: wrong fs type, bad option, bad superblock" >&2; exit 32`,
    );
    stub(
      host.bin,
      "aws",
      `echo "aws $*" >> ${host.log}
case "$2" in
  describe-volumes)
    ${opts.describeFails ? "echo 'UnauthorizedOperation' >&2; exit 254" : ""}
    if [ -e ${tagFile} ]; then cat ${tagFile}; echo; else echo None; fi;;
  create-tags)
    ${opts.tagWriteFails ? "echo 'UnauthorizedOperation' >&2; exit 254" : ""}
    echo "$*" | sed -n 's/.*Value=\\([a-z]*\\).*/\\1/p' | tr -d '\\n' > ${tagFile};;
esac`,
    );

    const functions = bootstrapFunctions(["say", "retry", "disk_signature", "format_tag", "record_formatted", "provision_data_volume"])
      .replaceAll("/etc/fstab", join(host.root, "fstab"))
      .replaceAll("/var/lib/afterclass", join(host.root, "var"))
      .replaceAll("/data", join(host.root, "data"));
    const script = `set -euo pipefail\nAWS_REGION=us-east-2\nDATA_VOLUME_ID=vol-0123456789abcdef0\n${functions}\nprovision_data_volume ${opts.realProbesOn ?? "/dev/test"}`;
    const result = Bun.spawnSync(["bash", "-c", script], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } });
    return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }
}

describe("afterclass-bootstrap data volume", () => {
  test("an empty volume tagged allowed is formatted and mounted, and only then tagged done", () => {
    const volume = new VolumeHost({ filesystem: "empty", tag: "allowed" });
    const run = volume.boot();
    expect(run.status).toBe(0);
    expect(volume.tag).toBe("done");
    const at = (prefix: string): number => volume.log.findIndex((line) => line.startsWith(prefix));
    expect(at("mkfs.xfs")).toBeGreaterThan(-1);
    expect(at("mount ")).toBeGreaterThan(at("mkfs.xfs"));
    expect(at("aws ec2 create-tags")).toBeGreaterThan(at("mount "));
    expect(volume.log[at("aws ec2 create-tags")]).toContain("--resources vol-0123456789abcdef0 --tags Key=afterclass-format,Value=done");
  });

  test("a volume tagged done is never formatted, even when the probe reports its ext4 or xfs disk empty", () => {
    for (const filesystem of ["xfs", "ext4"] as const) {
      const volume = new VolumeHost({ filesystem, tag: "done" });
      const run = volume.boot({ wipefs: "exit 0" });
      expect(volume.formatted()).toBe(false);
      expect(volume.filesystem).toBe(filesystem);
      expect(run.status).toBe(filesystem === "xfs" ? 0 : 1);
      expect(volume.tag).toBe("done");
    }
  });

  test("a used xfs volume tagged done mounts without a probe or a tag write", () => {
    const volume = new VolumeHost({ filesystem: "xfs", tag: "done" });
    const run = volume.boot({ wipefs: "echo probe ran >&2; exit 2", dd: "echo probe ran >&2; exit 1" });
    expect(run.status).toBe(0);
    expect(volume.count("aws ec2 create-tags")).toBe(0);
    expect(run.output).not.toContain("probe ran");
  });

  test("a blank volume tagged done stops with an error that names the tag, and formats nothing", () => {
    const volume = new VolumeHost({ filesystem: "empty", tag: "done" });
    const run = volume.boot();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("afterclass-format tag is 'done'");
    expect(volume.formatted()).toBe(false);
  });

  test("any tag value but allowed, or no tag, formats nothing", () => {
    for (const tag of ["Allowed", "allowed ", "yes", "true", "", null]) {
      const volume = new VolumeHost({ filesystem: "empty", tag });
      const run = volume.boot();
      expect(run.status).not.toBe(0);
      expect(volume.formatted()).toBe(false);
    }
  });

  test("a failed tag read formats nothing, and a blank volume stops the run", () => {
    const volume = new VolumeHost({ filesystem: "empty", tag: "allowed" });
    const run = volume.boot({ describeFails: true });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("cannot read the afterclass-format tag");
    expect(volume.formatted()).toBe(false);
    expect(volume.tag).toBe("allowed");
  });

  test("a failed tag read still mounts a volume that already holds xfs", () => {
    const volume = new VolumeHost({ filesystem: "xfs", tag: "done" });
    const run = volume.boot({ describeFails: true });
    expect(run.status).toBe(0);
    expect(volume.formatted()).toBe(false);
  });

  test("a tag that cannot be written after the format fails the run, and the next boot mounts the xfs without formatting", () => {
    const volume = new VolumeHost({ filesystem: "empty", tag: "allowed" });
    const first = volume.boot({ tagWriteFails: true });
    expect(first.status).not.toBe(0);
    expect(first.output).toContain("could not set afterclass-format=done");
    expect(volume.filesystem).toBe("xfs");
    expect(volume.tag).toBe("allowed");

    const second = volume.boot();
    expect(second.status).toBe(0);
    expect(volume.count("mkfs.xfs")).toBe(1);
    expect(volume.tag).toBe("done");
  });

  test("a tag still allowed after a format never reaches a second mkfs, even when the next probe reports the disk empty", () => {
    const volume = new VolumeHost({ filesystem: "empty", tag: "allowed" });
    expect(volume.boot({ tagWriteFails: true }).status).not.toBe(0);

    const second = volume.boot({ wipefs: "exit 0", tagWriteFails: true });
    expect(second.status).not.toBe(0);
    expect(volume.count("mkfs.xfs")).toBe(1);
    expect(volume.filesystem).toBe("xfs");
  });

  test("a rerun of bootstrap on a mounted, tagged volume changes nothing", () => {
    const volume = new VolumeHost({ filesystem: "empty", tag: "allowed" });
    expect(volume.boot().status).toBe(0);
    expect(volume.boot().status).toBe(0);
    expect(volume.count("mkfs.xfs")).toBe(1);
    expect(volume.count("aws ec2 create-tags")).toBe(1);
  });

  test("xfs on a volume still tagged allowed is kept and the tag is closed", () => {
    const volume = new VolumeHost({ filesystem: "xfs", tag: "allowed" });
    const run = volume.boot();
    expect(run.status).toBe(0);
    expect(volume.formatted()).toBe(false);
    expect(volume.tag).toBe("done");
  });

  test("any other signature on a volume tagged allowed, a partition table included, is refused and not formatted", () => {
    for (const found of ["ext4", "gpt", "gpt\\nPMBR", "LVM2_member", "xfs\\next4"]) {
      const volume = new VolumeHost({ filesystem: "ext4", tag: "allowed" });
      const run = volume.boot({ wipefs: `printf '${found}\\n'` });
      expect(run.status).not.toBe(0);
      expect(volume.formatted()).toBe(false);
      expect(volume.tag).toBe("allowed");
    }
  });

  describe("the probes stay a second guard while the tag says allowed", () => {
    const cases: [string, BootOptions][] = [
      [
        "a read error that the probe reports with the exit status for nothing found",
        {
          dd: "echo 'dd: error reading /dev/test: Input/output error' >&2; exit 1",
          wipefs: "echo 'wipefs: error: /dev/test: probing initialization failed: Input/output error' >&2; exit 2",
        },
      ],
      ["a probe that prints an I/O error and exits 2, with dd able to read", { wipefs: "echo 'Input/output error' >&2; exit 2" }],
      ["a probe that prints to stderr and exits 0", { wipefs: "echo 'warning: something' >&2; exit 0" }],
      ["an unreadable last MiB", { dd: 'case "$*" in *skip=*) echo "dd: Input/output error" >&2; exit 1;; esac; exit 0' }],
      ["an unreadable first MiB", { dd: 'case "$*" in *skip=*) exit 0;; esac; echo "dd: Input/output error" >&2; exit 1' }],
      ...[1, 2, 4, 8, 127].map((code): [string, BootOptions] => [`a probe that exits ${code}`, { wipefs: `exit ${code}` }]),
      ...["exit 1", "echo 0", "echo notanumber"].map((blockdev): [string, BootOptions] => [`a size of '${blockdev}'`, { blockdev }]),
    ];
    for (const [name, tools] of cases) {
      test(`${name} does not format`, () => {
        const volume = new VolumeHost({ filesystem: "empty", tag: "allowed" });
        const run = volume.boot(tools);
        expect(run.status).not.toBe(0);
        expect(volume.formatted()).toBe(false);
        expect(volume.tag).toBe("allowed");
      });
    }
  });

  const haveTools = Bun.which("wipefs") !== null && Bun.which("mkfs.ext4") !== null && Bun.which("truncate") !== null;
  test.skipIf(!haveTools)("the real dd and wipefs tell a blank image from an ext4 one, with the volume tagged allowed", () => {
    const blank = new VolumeHost({ filesystem: "empty", tag: "allowed" });
    const blankImage = join(blank.host.root, "disk.img");
    expect(Bun.spawnSync(["truncate", "-s", "8M", blankImage]).exitCode).toBe(0);
    expect(blank.boot({ realProbesOn: blankImage, blockdev: "echo 8388608" }).status).toBe(0);
    expect(blank.formatted()).toBe(true);

    const used = new VolumeHost({ filesystem: "empty", tag: "allowed" });
    const usedImage = join(used.host.root, "disk.img");
    expect(Bun.spawnSync(["truncate", "-s", "8M", usedImage]).exitCode).toBe(0);
    expect(Bun.spawnSync(["mkfs.ext4", "-q", usedImage]).exitCode).toBe(0);
    expect(used.boot({ realProbesOn: usedImage, blockdev: "echo 8388608" }).status).not.toBe(0);
    expect(used.formatted()).toBe(false);
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
