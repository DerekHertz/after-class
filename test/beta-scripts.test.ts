import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, type Host, installScript, makeHost, readLog, runScript, stub } from "./beta-host";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OLDER = "c".repeat(40);
const OLDEST = "d".repeat(40);

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
  unmounted?: boolean;
  pullFails?: string[];
}): DeployRun {
  const host = makeHost("afterclass-deploy-test-");
  const state = join(host.root, "data/afterclass/current-tag");
  writeFileSync(state, `${opts.previous}\n`);
  const restartFails = (opts.restartFails ?? []).join(" ");
  const unhealthy = (opts.unhealthy ?? []).join(" ");

  stub(host.bin, "mountpoint", opts.unmounted ? "exit 1" : "exit 0");
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
  stub(host.root, "afterclass-pull", `echo "pull $1" >> ${host.log}\ncase " ${(opts.pullFails ?? []).join(" ")} " in *" $1 "*) exit 1;; esac`);
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

  test("an unmounted /data stops the deploy before it pulls, writes the tag or restarts anything", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unmounted: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("/data is not mounted");
    expect(run.tag).toBe(OLD);
    expect(run.log).toEqual([]);
  });

  test("a pull that fails leaves the running tag selected and restarts nothing", () => {
    const run = runDeploy({ previous: OLD, next: NEW, pullFails: [NEW] });
    expect(run.status).not.toBe(0);
    expect(run.tag).toBe(OLD);
    expect(run.log).toEqual([`pull ${NEW}`]);
  });

  test("anything but a full lowercase commit hash is refused before the pull", () => {
    for (const next of [`ghcr.io/derekhertz/after-class:${NEW}`, `evil.example/x:${NEW}`, NEW.toUpperCase(), "v0.1.0"]) {
      const run = runDeploy({ previous: OLD, next });
      expect(run.status).toBe(2);
      expect(run.tag).toBe(OLD);
      expect(run.log).toEqual([]);
    }
  });

  test("a failed save after a rollback is still reported, and the run still fails", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unhealthy: [NEW], saveFails: true });
    expect(run.status).toBe(1);
    expect(run.tag).toBe(OLD);
    expect(run.stdout).toContain(`WARNING ${OLD} is not saved on /data`);
  });
});
const REPOSITORY = "ghcr.io/derekhertz/after-class";
const imageName = (tag: string): string => `${REPOSITORY}:${tag}`;
const storeKey = (tag: string): string => imageName(tag).replace(/[/:]/g, "_");

/**
 * Writes an archive in the shape docker save produces: manifest.json naming a config file and a layer tarball, and both
 * of those files. The fake docker load below refuses an archive that is unreadable or misses a file its manifest names.
 */
const MAKE_ARCHIVE = String.raw`image=$1; out=$2
d=$(mktemp -d); mkdir "$d/l1" "$d/src"
echo "$image" > "$d/src/content"
tar -cf "$d/l1/layer.tar" -C "$d/src" content
printf '{"image":"%s"}' "$image" > "$d/cfg.json"
printf '[{"Config":"cfg.json","RepoTags":["%s"],"Layers":["l1/layer.tar"]}]' "$image" > "$d/manifest.json"
tar -cf "$out" -C "$d" manifest.json cfg.json l1/layer.tar; status=$?
rm -rf "$d"; exit $status`;

/**
 * A stand-in for the docker CLI. Its image store is a folder of marker files, so a save on one host followed by a load on
 * another behaves like the real round trip. `pullFails` stands for an image GHCR no longer holds. `saveFails` writes part
 * of an archive and exits 1, as docker save does when the disk fills. `size` is what `image inspect --format` reports.
 */
function fakeDocker(host: Host, opts: { store: string; pullFails?: boolean | undefined; saveFails?: boolean | undefined; size?: number }): void {
  mkdirSync(opts.store, { recursive: true });
  stub(host.bin, "make-image-archive", MAKE_ARCHIVE);
  stub(
    host.bin,
    "docker",
    `store=${opts.store}; log=${host.log}; size=${opts.size ?? 1000}; pull_fails=${opts.pullFails ? 1 : 0}; save_fails=${opts.saveFails ? 1 : 0}\n` +
      String.raw`echo "docker $*" >> "$log"
key() { echo "$1" | tr '/:' '__'; }
for last; do :; done
case "$1 $2" in
  "image inspect")
    [ -e "$store/$(key "$last")" ] || { echo "Error: No such image: $last" >&2; exit 1; }
    [ "$3" = --format ] && echo "$size"
    exit 0;;
  "save --output")
    if [ "$save_fails" = 1 ]; then head -c 700 /dev/urandom > "$3"; echo "write $3: no space left on device" >&2; exit 1; fi
    [ -e "$store/$(key "$4")" ] || exit 1
    make-image-archive "$4" "$3"; exit $?;;
  "load --input")
    members=$(tar -tf "$3" 2>/dev/null) || { echo "Error: unexpected EOF" >&2; exit 1; }
    manifest=$(tar -xOf "$3" manifest.json 2>/dev/null) || { echo "Error: no manifest.json" >&2; exit 1; }
    loaded=$(sed -n 's/.*"RepoTags":\["\([^"]*\)".*/\1/p' <<<"$manifest")
    [ -n "$loaded" ] || { echo "Error: no image name in manifest.json" >&2; exit 1; }
    for member in $(sed -n 's/.*"Config":"\([^"]*\)".*"Layers":\["\([^"]*\)".*/\1 \2/p' <<<"$manifest"); do
      grep -qxF "$member" <<<"$members" || { echo "Error: open $member: no such file" >&2; exit 1; }
    done
    touch "$store/$(key "$loaded")"; exit 0;;
  "pull "*)
    [ "$pull_fails" = 1 ] && { echo "manifest unknown" >&2; exit 1; }
    touch "$store/$(key "$2")"; exit 0;;
esac
exit 0`,
  );
  stub(host.bin, "aws", `echo "aws $*" >> ${host.log}`);
}

function addLocalImage(store: string, tag: string): void {
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, storeKey(tag)), "");
}

type TarballKind = "good" | "not-a-tar" | "truncated" | "wrong-image";

/** Writes a tarball the way docker save would for `tag`, or a damaged one. A wrong-image tarball holds the OLDEST image. */
function writeTarball(host: Host, path: string, tag: string, kind: TarballKind = "good"): void {
  if (kind === "not-a-tar") {
    writeFileSync(path, "corrupt\n");
    return;
  }
  stub(host.bin, "make-image-archive", MAKE_ARCHIVE);
  const listed = kind === "wrong-image" ? OLDEST : tag;
  expect(Bun.spawnSync(["bash", join(host.bin, "make-image-archive"), imageName(listed), path]).exitCode).toBe(0);
  if (kind === "truncated") writeFileSync(path, readFileSync(path).subarray(0, 1536));
}

/** Loads a tarball into an empty store with the fake docker and returns the images it holds afterwards. */
function loadedImages(path: string): string[] {
  const host = makeHost("afterclass-load-check-");
  const store = join(host.root, "store");
  fakeDocker(host, { store });
  const load = Bun.spawnSync(["bash", join(host.bin, "docker"), "load", "--input", path], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } });
  if (load.exitCode !== 0) return [];
  return readdirSync(store);
}

function runSave(opts: {
  keep: string[];
  have?: string[];
  tarballs?: string[];
  damaged?: Partial<Record<string, TarballKind>>;
  strays?: string[];
  freeBytes?: number;
  saveFails?: boolean;
}): { status: number; stderr: string; files: string[]; log: string[]; dir: string } {
  const host = makeHost("afterclass-save-test-");
  const store = join(host.root, "store");
  fakeDocker(host, { store, saveFails: opts.saveFails });
  for (const tag of opts.have ?? [opts.keep[0]!]) addLocalImage(store, tag);
  const dir = join(host.root, "data/afterclass/images");
  for (const tag of opts.tarballs ?? []) writeTarball(host, join(dir, `${tag}.tar`), tag);
  for (const [tag, kind] of Object.entries(opts.damaged ?? {})) writeTarball(host, join(dir, `${tag}.tar`), tag, kind);
  for (const name of opts.strays ?? []) writeFileSync(join(dir, name), "stray");
  stub(host.bin, "df", `printf 'Avail\\n%s\\n' ${opts.freeBytes ?? 10_000_000_000}`);

  const run = runScript(host, "afterclass-save-image", opts.keep);
  return { status: run.status, stderr: run.stderr, files: readdirSync(dir).sort(), log: readLog(host), dir };
}

describe("afterclass-save-image", () => {
  test("saves the running image as <tag>.tar that docker load accepts, and leaves no temporary file", () => {
    const run = runSave({ keep: [NEW] });
    expect(run.status).toBe(0);
    expect(run.files).toEqual([`${NEW}.tar`]);
    expect(loadedImages(join(run.dir, `${NEW}.tar`))).toEqual([storeKey(NEW)]);
  });

  test("keeps the two named tarballs and prunes every other one, a crashed save's temporary file included", () => {
    const run = runSave({ keep: [NEW, OLD], tarballs: [OLD, OLDER, OLDEST], strays: [`${OLDER}.tar.new`] });
    expect(run.status).toBe(0);
    expect(run.files).toEqual([`${NEW}.tar`, `${OLD}.tar`].sort());
  });

  test("an existing tarball is never trusted, the running image is saved over it every time", () => {
    for (const kind of ["good", "not-a-tar", "truncated", "wrong-image"] as const) {
      const run = runSave({ keep: [NEW], damaged: { [NEW]: kind } });
      expect(run.status).toBe(0);
      expect(run.log.filter((line) => line.startsWith("docker save"))).toHaveLength(1);
      expect(loadedImages(join(run.dir, `${NEW}.tar`))).toEqual([storeKey(NEW)]);
    }
  });

  test("a docker save that fails part way fails the run and leaves the previous tarball byte for byte", () => {
    const host = makeHost("afterclass-save-fails-");
    const store = join(host.root, "store");
    fakeDocker(host, { store, saveFails: true });
    addLocalImage(store, NEW);
    stub(host.bin, "df", "printf 'Avail\\n10000000000\\n'");
    const dir = join(host.root, "data/afterclass/images");
    writeTarball(host, join(dir, `${NEW}.tar`), NEW);
    const before = readFileSync(join(dir, `${NEW}.tar`));

    const run = runScript(host, "afterclass-save-image", [NEW]);
    expect(run.status).not.toBe(0);
    expect(readdirSync(dir)).toEqual([`${NEW}.tar`]);
    expect(readFileSync(join(dir, `${NEW}.tar`)).equals(before)).toBe(true);
  });

  test("a docker save that fails part way with no earlier tarball leaves no file at all", () => {
    const run = runSave({ keep: [NEW], saveFails: true });
    expect(run.status).not.toBe(0);
    expect(run.files).toEqual([]);
  });

  test("a disk with too little room is refused without writing anything, so the database keeps its space", () => {
    const run = runSave({ keep: [NEW, OLD], tarballs: [OLD], freeBytes: 500_000_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("bytes free on /data");
    expect(run.log.some((line) => line.startsWith("docker save"))).toBe(false);
    expect(run.files).toEqual([`${OLD}.tar`]);
  });

  test("an image that is not on the host is an error, and every tarball stays, since it may be the only copy", () => {
    const run = runSave({ keep: [NEW, OLD], have: [], tarballs: [NEW, OLDER] });
    expect(run.status).not.toBe(0);
    expect(run.files).toEqual([`${NEW}.tar`, `${OLDER}.tar`].sort());
  });

  test("anything but a full commit hash is refused, so a tag cannot name a path", () => {
    const run = runSave({ keep: ["../../etc/passwd"], have: [] });
    expect(run.status).toBe(2);
  });
});

function runPull(opts: { tag: string; have?: string[]; tarball?: TarballKind; pullFails?: boolean }): {
  status: number;
  log: string[];
  hasImage: boolean;
  stderr: string;
} {
  const host = makeHost("afterclass-pull-test-");
  const store = join(host.root, "store");
  fakeDocker(host, { store, pullFails: opts.pullFails });
  for (const tag of opts.have ?? []) addLocalImage(store, tag);
  if (opts.tarball) writeTarball(host, join(host.root, "data/afterclass/images", `${opts.tag}.tar`), opts.tag, opts.tarball);
  const run = runScript(host, "afterclass-pull", [opts.tag]);
  return { status: run.status, log: readLog(host), hasImage: existsSync(join(store, storeKey(opts.tag))), stderr: run.stderr };
}

describe("afterclass-pull", () => {
  test("an image already on the host is neither loaded nor pulled", () => {
    const run = runPull({ tag: NEW, have: [NEW], tarball: "good" });
    expect(run.status).toBe(0);
    expect(run.log.some((line) => line.startsWith("docker load") || line.startsWith("docker pull"))).toBe(false);
  });

  test("an image GHCR no longer holds starts from the tarball on the data volume", () => {
    const run = runPull({ tag: NEW, tarball: "good", pullFails: true });
    expect(run.status).toBe(0);
    expect(run.hasImage).toBe(true);
    expect(run.log.some((line) => line.startsWith("docker pull"))).toBe(false);
  });

  test("an image GHCR no longer holds, with no tarball, fails rather than starting something else", () => {
    const run = runPull({ tag: NEW, pullFails: true });
    expect(run.status).not.toBe(0);
    expect(run.hasImage).toBe(false);
  });

  for (const kind of ["not-a-tar", "truncated", "wrong-image"] as const) {
    test(`a ${kind} tarball is reported as an error and the image comes from GHCR`, () => {
      const run = runPull({ tag: NEW, tarball: kind });
      expect(run.status).toBe(0);
      expect(run.hasImage).toBe(true);
      expect(run.stderr).toContain("ERROR");
      expect(run.log.some((line) => line.startsWith("docker pull"))).toBe(true);
    });

    test(`a ${kind} tarball with the image gone from GHCR fails the pull`, () => {
      const run = runPull({ tag: NEW, tarball: kind, pullFails: true });
      expect(run.status).not.toBe(0);
      expect(run.hasImage).toBe(false);
    });
  }

  test("an image with no tarball is pulled anonymously from the pinned GHCR repository by its commit hash", () => {
    const run = runPull({ tag: NEW });
    expect(run.status).toBe(0);
    expect(run.log).toEqual([`docker image inspect ${REPOSITORY}:${NEW}`, `docker pull ${REPOSITORY}:${NEW}`]);
  });

  test("the settings and the environment cannot point the pull at another registry", () => {
    const host = makeHost("afterclass-pull-pinned-");
    fakeDocker(host, { store: join(host.root, "store") });
    writeFileSync(join(host.root, "settings.env"), "AWS_REGION=us-east-2\nECR_REGISTRY=evil.example\nECR_REPOSITORY=x\nIMAGE=evil.example/x\n");
    const run = Bun.spawnSync(["bash", installScript(host, "afterclass-pull"), NEW], {
      env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}`, ECR_REGISTRY: "evil.example", IMAGE: "evil.example/x", REGISTRY: "evil.example" },
    });
    expect(run.exitCode).toBe(0);
    expect(readLog(host)).toContain(`docker pull ${REPOSITORY}:${NEW}`);
    expect(readLog(host).some((line) => line.includes("evil.example"))).toBe(false);
  });

  test("only a full lowercase commit hash is accepted, never a reference that names a registry", () => {
    for (const arg of [`${REPOSITORY}:${NEW}`, `evil.example/after-class:${NEW}`, `${NEW}@sha256:${"0".repeat(64)}`, NEW.toUpperCase(), `${NEW}0`, "abc1234", "v0.1.0", ""]) {
      const host = makeHost("afterclass-pull-refuse-");
      fakeDocker(host, { store: join(host.root, "store") });
      const run = runScript(host, "afterclass-pull", [arg]);
      expect(run.status).toBe(2);
      expect(readLog(host)).toEqual([]);
    }
  });
});

describe("a replaced instance", () => {
  /** Moves the data volume of one host to a new host whose registry no longer holds the image. */
  function replaceHost(old: Host): Host {
    const fresh = makeHost("afterclass-replace-new-");
    rmSync(join(fresh.root, "data"), { recursive: true });
    renameSync(join(old.root, "data"), join(fresh.root, "data"));
    fakeDocker(fresh, { store: join(fresh.root, "store"), pullFails: true });
    return fresh;
  }

  test("starts the image the old instance saved to /data, after GHCR lost it", () => {
    const old = makeHost("afterclass-replace-old-");
    fakeDocker(old, { store: join(old.root, "store") });
    addLocalImage(join(old.root, "store"), NEW);
    stub(old.bin, "df", "printf 'Avail\\n10000000000\\n'");
    expect(runScript(old, "afterclass-save-image", [NEW, OLD]).status).toBe(0);

    const fresh = replaceHost(old);
    expect(runScript(fresh, "afterclass-pull", [NEW]).status).toBe(0);
    expect(existsSync(join(fresh.root, "store", storeKey(NEW)))).toBe(true);
  });

  test("a corrupt tarball does not stop a healthy deploy, the next save overwrites it, and a replacement survives the image leaving GHCR", () => {
    const host = makeHost("afterclass-repair-");
    const store = join(host.root, "store");
    const dir = join(host.root, "data/afterclass/images");
    fakeDocker(host, { store });
    stub(host.bin, "df", "printf 'Avail\\n10000000000\\n'");
    writeTarball(host, join(dir, `${NEW}.tar`), NEW, "truncated");

    expect(runScript(host, "afterclass-pull", [NEW]).status).toBe(0);
    expect(existsSync(join(store, storeKey(NEW)))).toBe(true);
    expect(runScript(host, "afterclass-save-image", [NEW]).status).toBe(0);

    const fresh = replaceHost(host);
    expect(runScript(fresh, "afterclass-pull", [NEW]).status).toBe(0);
    expect(existsSync(join(fresh.root, "store", storeKey(NEW)))).toBe(true);
  });
});

const VOLUME_ID = "vol-0123456789abcdef0";
const DEVICE = "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}";
const XFS_MAGIC = "XFSB";

/**
 * One server and its data volume. The volume is a 4 MiB file of zeros, as a new EBS volume reads. The stubbed mkfs.xfs
 * writes the xfs magic at its start, and the stubbed mount succeeds only on a file that starts with it. mountpoint reports
 * /data mounted after a mount of /data. head, tr, wc and flock are the real tools.
 */
class DataVolume {
  readonly host = makeHost("afterclass-volume-test-");
  readonly disk = join(this.host.root, "disk.img");
  private readonly mounted = join(this.host.root, "mounted");

  constructor(opts: { contents?: Buffer; mkfsSeconds?: number } = {}) {
    const { host, disk, mounted } = this;
    writeFileSync(disk, opts.contents ?? Buffer.alloc(4 * 1024 * 1024));
    writeFileSync(join(host.root, "settings.env"), `AWS_REGION=us-east-2\nDATA_VOLUME_ID=${VOLUME_ID}\n`);
    writeFileSync(join(host.root, "fstab"), "UUID=root / xfs defaults 0 1\n");
    stub(host.bin, "sleep", "exit 0");
    stub(host.bin, "wipefs", "exit 0");
    stub(
      host.bin,
      "mkfs.xfs",
      `echo "mkfs.xfs $*" >> ${host.log}\n/bin/sleep ${opts.mkfsSeconds ?? 0}\nprintf ${XFS_MAGIC} | dd of=${disk} conv=notrunc status=none`,
    );
    stub(
      host.bin,
      "mount",
      `echo "mount $*" >> ${host.log}
[ "$(head -c 4 ${disk})" = ${XFS_MAGIC} ] || { echo "mount: wrong fs type, bad option, bad superblock" >&2; exit 32; }
[ "$1" = ${join(host.root, "data")} ] && touch ${mounted}
exit 0`,
    );
    stub(host.bin, "umount", `echo "umount $*" >> ${host.log}`);
    stub(host.bin, "mountpoint", `[ -e ${mounted} ]`);
    stub(host.bin, "systemctl", `echo "systemctl $*" >> ${host.log}`);
    stub(host.bin, "docker", `echo "docker $*" >> ${host.log}`);
  }

  get log(): string[] {
    return readLog(this.host);
  }

  count(prefix: string): number {
    return this.log.filter((line) => line.startsWith(prefix)).length;
  }

  appStarted(): boolean {
    return this.log.some((line) => /^systemctl (start|restart|enable) afterclass-/.test(line));
  }

  markMounted(): void {
    writeFileSync(this.mounted, "");
  }

  /** The real script, with the device, the lock, fstab and /data pointed into the temp tree. */
  private install(name: string): string {
    return installScript(this.host, name, {
      [DEVICE]: this.disk,
      "[ -b ": "[ -e ",
      "[ ! -b ": "[ ! -e ",
      "/run/afterclass-format-data.lock": join(this.host.root, "format.lock"),
      "/etc/fstab": join(this.host.root, "fstab"),
      "/data": join(this.host.root, "data"),
    });
  }

  private env(): Record<string, string | undefined> {
    return { ...process.env, PATH: `${this.host.bin}:${process.env.PATH}` };
  }

  run(name: string, args: string[] = []): { status: number; output: string } {
    const result = Bun.spawnSync(["bash", this.install(name), ...args], { env: this.env() });
    return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }

  /** Starts the script without waiting, for runs that must overlap. */
  start(name: string, args: string[] = []): Promise<number> {
    return Bun.spawn(["bash", this.install(name), ...args], { env: this.env(), stdout: "ignore", stderr: "ignore" }).exited;
  }

  format(confirm: string = VOLUME_ID): { status: number; output: string } {
    return this.run("afterclass-format-data", [confirm]);
  }
}

describe("afterclass-bootstrap", () => {
  test("a blank volume is not formatted, bootstrap fails, and neither unit is started or enabled", () => {
    const volume = new DataVolume();
    const run = volume.run("afterclass-bootstrap");
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(`afterclass-format-data ${VOLUME_ID}`);
    expect(volume.count("mkfs.xfs")).toBe(0);
    expect(volume.appStarted()).toBe(false);
    expect(volume.count("mount ")).toBe(1);
  });

  test("a volume that holds a filesystem is mounted by its volume id and the units start", () => {
    const volume = new DataVolume({ contents: Buffer.from(XFS_MAGIC) });
    const run = volume.run("afterclass-bootstrap");
    expect(run.status).toBe(0);
    expect(volume.count("mkfs.xfs")).toBe(0);
    expect(volume.log).toContain("systemctl start afterclass-app.service");
    expect(readFileSync(join(volume.host.root, "fstab"), "utf8")).toContain(`${volume.disk} ${join(volume.host.root, "data")} xfs defaults,nofail`);
  });

  test("a rerun on a mounted volume does not mount again and still ends with the units up", () => {
    const volume = new DataVolume({ contents: Buffer.from(XFS_MAGIC) });
    expect(volume.run("afterclass-bootstrap").status).toBe(0);
    expect(volume.run("afterclass-bootstrap").status).toBe(0);
    expect(volume.count("mount ")).toBe(1);
    expect(readFileSync(join(volume.host.root, "fstab"), "utf8").match(/ xfs defaults,nofail/g)).toHaveLength(1);
  });

  test("waits while a format holds the lock, then mounts the filesystem the format wrote", async () => {
    const volume = new DataVolume();
    const holding = join(volume.host.root, "holding");
    const format = Bun.spawn([
      "flock",
      join(volume.host.root, "format.lock"),
      "bash",
      "-c",
      `touch ${holding}; /bin/sleep 1; printf ${XFS_MAGIC} | dd of=${volume.disk} conv=notrunc status=none`,
    ]);
    while (!existsSync(holding)) await Bun.sleep(10);
    const run = volume.run("afterclass-bootstrap");
    expect(await format.exited).toBe(0);
    expect(run.status).toBe(0);
    expect(volume.log).toContain("systemctl start afterclass-app.service");
  });

  test("a device that never appears fails without touching fstab", () => {
    const volume = new DataVolume();
    rmSync(volume.disk);
    const run = volume.run("afterclass-bootstrap");
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("did not appear");
    expect(volume.appStarted()).toBe(false);
  });
});

describe("afterclass-format-data", () => {
  test("formats a blank volume once, and bootstrap then mounts it and starts the app", () => {
    const volume = new DataVolume();
    const run = volume.format();
    expect(run.status).toBe(0);
    expect(volume.log).toContain(`mkfs.xfs -L afterclass-data ${volume.disk}`);
    expect(volume.run("afterclass-bootstrap").status).toBe(0);
    expect(volume.log).toContain("systemctl start afterclass-app.service");
  });

  test("without the matching volume id it formats nothing", () => {
    for (const confirm of ["", "vol-0000000000000000", `${VOLUME_ID} `, "yes"]) {
      const volume = new DataVolume();
      const run = volume.format(confirm);
      expect(run.status).toBe(2);
      expect(volume.count("mkfs.xfs")).toBe(0);
    }
  });

  test("a second format of the same volume is refused", () => {
    const volume = new DataVolume();
    expect(volume.format().status).toBe(0);
    const second = volume.format();
    expect(second.status).not.toBe(0);
    expect(volume.count("mkfs.xfs")).toBe(1);
  });

  test("two formats started together run mkfs once", async () => {
    const volume = new DataVolume({ mkfsSeconds: 1 });
    const statuses = await Promise.all([volume.start("afterclass-format-data", [VOLUME_ID]), volume.start("afterclass-format-data", [VOLUME_ID])]);
    expect(statuses.sort()).toEqual([0, 1]);
    expect(volume.count("mkfs.xfs")).toBe(1);
  });

  const refusals: [string, (volume: DataVolume) => void][] = [
    ["/data is mounted", (volume) => volume.markMounted()],
    ["the device cannot be read", (volume) => rmSync(volume.disk)],
    ["one nonzero byte sits in the first MiB, with every probe silent", (volume) => writeFileSync(volume.disk, Buffer.concat([Buffer.alloc(700_000), Buffer.from([1]), Buffer.alloc(3_000_000)]))],
    ["wipefs finds a signature past the first MiB", (volume) => stub(volume.host.bin, "wipefs", "echo gpt")],
    ["wipefs fails", (volume) => stub(volume.host.bin, "wipefs", "echo 'wipefs: Input/output error' >&2; exit 1")],
    ["mount finds a filesystem the other checks missed", (volume) => stub(volume.host.bin, "mount", "exit 0")],
  ];
  for (const [name, arrange] of refusals) {
    test(`refuses when ${name}`, () => {
      const volume = new DataVolume();
      arrange(volume);
      const run = volume.format();
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("nothing was formatted");
      expect(volume.count("mkfs.xfs")).toBe(0);
    });
  }

  const haveTools = Bun.which("wipefs") !== null && Bun.which("mkfs.ext4") !== null;
  test.skipIf(!haveTools)("the real wipefs and head refuse an ext4 image and pass a blank one", () => {
    const used = new DataVolume();
    expect(Bun.spawnSync(["mkfs.ext4", "-q", "-F", used.disk]).exitCode).toBe(0);
    rmSync(join(used.host.bin, "wipefs"));
    expect(used.format().status).not.toBe(0);
    expect(used.count("mkfs.xfs")).toBe(0);

    const blank = new DataVolume();
    rmSync(join(blank.host.bin, "wipefs"));
    expect(blank.format().status).toBe(0);
  });
});

/** The values of `key` in the [Unit] section of a systemd unit file, split on spaces as systemd lists them. */
function unitValues(unit: string, key: string): string[] {
  const section = unit.split(/^\[/m).find((part) => part.startsWith("Unit]")) ?? "";
  return section
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .flatMap((line) => line.slice(key.length + 1).trim().split(/\s+/));
}

describe("beta units", () => {
  for (const name of ["afterclass-app.service", "afterclass-caddy.service"]) {
    test(`${name} refuses to start without the /data mount`, () => {
      expect(unitValues(readFileSync(join(FILES, name), "utf8"), "RequiresMountsFor")).toContain("/data");
    });
  }
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
