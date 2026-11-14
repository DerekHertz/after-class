import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf, fakeDocker, FILES, hasImage, type Host, imageId, installScript, makeHost, readLog, REPOSITORY, runScript, stub, writeArchive } from "./beta-host";

const COMMIT = "c".repeat(40);
const OLD = digestOf("a");
const NEW = digestOf("b");
const OLDER = digestOf("c");
const OLDEST = digestOf("d");
const hex = (digest: string): string => digest.slice(7);

interface DeployRun {
  readonly status: number;
  readonly image: string;
  readonly log: string[];
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the real afterclass-deploy script against stubbed commands. `restartFails` and `unhealthy` name the digests that
 * make the stubbed systemctl restart fail and the stubbed /health answer 500. A stub reads the digest the script selected
 * from the state file, as the real unit would. The pull and save scripts it calls are stubs that log their arguments.
 */
function runDeploy(opts: {
  previous: string;
  next: string;
  commit?: string;
  restartFails?: string[];
  unhealthy?: string[];
  pruneFails?: boolean;
  saveFails?: boolean;
  unmounted?: boolean;
  pullFails?: string[];
}): DeployRun {
  const host = makeHost("afterclass-deploy-test-");
  const state = join(host.root, "data/afterclass/current-image");
  writeFileSync(state, `${opts.previous}\n`);
  const restartFails = (opts.restartFails ?? []).join(" ");
  const unhealthy = (opts.unhealthy ?? []).join(" ");

  stub(host.bin, "mountpoint", opts.unmounted ? "exit 1" : "exit 0");
  stub(host.bin, "sleep", "exit 0");
  stub(host.bin, "journalctl", "exit 0");
  stub(host.bin, "curl", `image=$(cat ${state}); case " ${unhealthy} " in *" $image "*) exit 22;; esac; exit 0`);
  stub(
    host.bin,
    "systemctl",
    `echo "systemctl $*" >> ${host.log}
image=$(cat ${state})
case "$1" in
  restart) case " ${restartFails} " in *" $image "*) exit 1;; esac;;
esac
exit 0`,
  );
  stub(host.bin, "docker", `echo "docker $*" >> ${host.log}\n${opts.pruneFails ? 'if [ "$2" = prune ]; then exit 1; fi' : ""}\nexit 0`);
  stub(host.root, "afterclass-pull", `echo "pull $1" >> ${host.log}\ncase " ${(opts.pullFails ?? []).join(" ")} " in *" $1 "*) exit 1;; esac`);
  stub(host.root, "afterclass-save-image", `echo "save $*" >> ${host.log}\n${opts.saveFails ? "echo 'no space left' >&2; exit 1" : "exit 0"}`);

  const run = runScript(host, "afterclass-deploy", [opts.commit ?? COMMIT, opts.next]);
  return { ...run, image: readFileSync(state, "utf8").trim(), log: readLog(host) };
}

describe("afterclass-deploy", () => {
  test("a healthy deploy keeps the new digest", () => {
    const run = runDeploy({ previous: OLD, next: NEW });
    expect(run.status).toBe(0);
    expect(run.image).toBe(NEW);
    expect(run.stdout).toContain(`${COMMIT} (${NEW}) is healthy`);
  });

  test("a digest that never turns healthy is rolled back, and the run still fails", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unhealthy: [NEW] });
    expect(run.status).toBe(1);
    expect(run.image).toBe(OLD);
  });

  test("a failing systemctl restart is rolled back too, not left on the failed digest", () => {
    const run = runDeploy({ previous: OLD, next: NEW, restartFails: [NEW] });
    expect(run.status).toBe(1);
    expect(run.image).toBe(OLD);
    expect(run.log.filter((line) => line === "systemctl restart afterclass-app.service")).toHaveLength(2);
    expect(run.stderr).toContain("rolled back to " + OLD);
  });

  test("a rollback whose own restart fails still selects the previous digest and fails the run", () => {
    const run = runDeploy({ previous: OLD, next: NEW, restartFails: [NEW, OLD] });
    expect(run.status).toBe(1);
    expect(run.image).toBe(OLD);
  });

  test("a failed prune does not fail a healthy deploy", () => {
    const run = runDeploy({ previous: OLD, next: NEW, pruneFails: true });
    expect(run.status).toBe(0);
    expect(run.image).toBe(NEW);
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
    expect(run.image).toBe(NEW);
    expect(run.stdout).toContain(`WARNING ${NEW} is not saved on /data`);
    expect(run.log.some((line) => line.startsWith("docker image prune"))).toBe(true);
  });

  test("a rollback saves the image it restored, and a digest that failed is never saved", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unhealthy: [NEW] });
    expect(run.log).toContain(`save ${OLD}`);
    expect(run.log.some((line) => line.startsWith(`save ${NEW}`))).toBe(false);
  });

  test("an unmounted /data stops the deploy before it pulls, writes the digest or restarts anything", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unmounted: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("/data is not mounted");
    expect(run.image).toBe(OLD);
    expect(run.log).toEqual([]);
  });

  test("a pull that fails leaves the running digest selected and restarts nothing", () => {
    const run = runDeploy({ previous: OLD, next: NEW, pullFails: [NEW] });
    expect(run.status).not.toBe(0);
    expect(run.image).toBe(OLD);
    expect(run.log).toEqual([`pull ${NEW}`]);
  });

  test("anything but a full lowercase commit hash is refused before the pull", () => {
    for (const commit of [`${REPOSITORY}:${COMMIT}`, COMMIT.toUpperCase(), `${COMMIT}0`, "v0.1.0", ""]) {
      const run = runDeploy({ previous: OLD, next: NEW, commit });
      expect(run.status).toBe(2);
      expect(run.image).toBe(OLD);
      expect(run.log).toEqual([]);
    }
  });

  test("anything but a sha256 digest is refused before the pull, a tag or a commit hash included", () => {
    for (const next of [COMMIT, `${REPOSITORY}:${COMMIT}`, `${REPOSITORY}@${NEW}`, NEW.toUpperCase(), `${NEW}0`, hex(NEW), "sha256:abc", ""]) {
      const run = runDeploy({ previous: OLD, next });
      expect(run.status).toBe(2);
      expect(run.image).toBe(OLD);
      expect(run.log).toEqual([]);
    }
  });

  test("a failed save after a rollback is still reported, and the run still fails", () => {
    const run = runDeploy({ previous: OLD, next: NEW, unhealthy: [NEW], saveFails: true });
    expect(run.status).toBe(1);
    expect(run.image).toBe(OLD);
    expect(run.stdout).toContain(`WARNING ${OLD} is not saved on /data`);
  });
});

const imagesDir = (host: Host): string => join(host.root, "data/afterclass/images");

/** Puts an image on the host as a digest pull would, and the ID record afterclass-pull keeps for it. */
function addPulledImage(host: Host, store: string, digest: string): void {
  const id = imageId(digest);
  writeFileSync(join(store, "ids", hex(id)), "");
  writeFileSync(join(store, "refs", `${REPOSITORY}@${digest}`.replace(/[/:@]/g, "_")), `${id}\n`);
  writeFileSync(join(imagesDir(host), `${hex(digest)}.id`), `${id}\n`);
}

type TarballKind = "good" | "not-a-tar" | "truncated" | "wrong-image";

/** Writes a tarball the way docker save would for `digest`'s image, or a damaged one. A wrong-image tarball holds OLDEST's. */
function writeTarball(host: Host, digest: string, kind: TarballKind = "good"): void {
  const path = join(imagesDir(host), `${hex(digest)}.tar`);
  if (kind === "not-a-tar") {
    writeFileSync(path, "corrupt\n");
    return;
  }
  writeArchive(host, imageId(kind === "wrong-image" ? OLDEST : digest), path);
  if (kind === "truncated") writeFileSync(path, readFileSync(path).subarray(0, 1536));
}

/** Loads a tarball into an empty store with the fake docker and returns the image IDs it holds afterwards. */
function loadedImages(path: string): string[] {
  const host = makeHost("afterclass-load-check-");
  const store = join(host.root, "store");
  fakeDocker(host, { store });
  const load = Bun.spawnSync(["bash", join(host.bin, "docker"), "load", "--input", path], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } });
  if (load.exitCode !== 0) return [];
  return readdirSync(join(store, "ids")).map((name) => `sha256:${name}`);
}

function runSave(opts: {
  keep: string[];
  have?: string[];
  records?: string[];
  tarballs?: string[];
  damaged?: Partial<Record<string, TarballKind>>;
  strays?: string[];
  freeBytes?: number;
  saveFails?: boolean;
}): { status: number; stderr: string; files: string[]; log: string[]; dir: string } {
  const host = makeHost("afterclass-save-test-");
  const store = join(host.root, "store");
  fakeDocker(host, { store, saveFails: opts.saveFails });
  for (const digest of opts.have ?? [opts.keep[0]!]) addPulledImage(host, store, digest);
  for (const digest of opts.records ?? []) writeFileSync(join(imagesDir(host), `${hex(digest)}.id`), `${imageId(digest)}\n`);
  for (const digest of opts.tarballs ?? []) writeTarball(host, digest);
  for (const [digest, kind] of Object.entries(opts.damaged ?? {})) writeTarball(host, digest, kind);
  for (const name of opts.strays ?? []) writeFileSync(join(imagesDir(host), name), "stray");
  stub(host.bin, "df", `printf 'Avail\\n%s\\n' ${opts.freeBytes ?? 10_000_000_000}`);
  rmSync(host.log);
  writeFileSync(host.log, "");

  const run = runScript(host, "afterclass-save-image", opts.keep);
  return { status: run.status, stderr: run.stderr, files: readdirSync(imagesDir(host)).sort(), log: readLog(host), dir: imagesDir(host) };
}

describe("afterclass-save-image", () => {
  test("saves the running image by its recorded ID as <digest hex>.tar, which loads as that ID, and leaves no temporary file", () => {
    const run = runSave({ keep: [NEW] });
    expect(run.status).toBe(0);
    expect(run.files).toEqual([`${hex(NEW)}.id`, `${hex(NEW)}.tar`]);
    expect(run.log).toContain(`docker save --output ${join(run.dir, `${hex(NEW)}.tar.new`)} ${imageId(NEW)}`);
    expect(loadedImages(join(run.dir, `${hex(NEW)}.tar`))).toEqual([imageId(NEW)]);
  });

  test("keeps the two named images and prunes every other tarball and record, a crashed save's temporary files included", () => {
    const run = runSave({
      keep: [NEW, OLD],
      records: [OLD, OLDER, OLDEST],
      tarballs: [OLD, OLDER, OLDEST],
      strays: [`${hex(OLDER)}.tar.new`, `${hex(OLDER)}.id.new`],
    });
    expect(run.status).toBe(0);
    expect(run.files).toEqual([`${hex(NEW)}.id`, `${hex(NEW)}.tar`, `${hex(OLD)}.id`, `${hex(OLD)}.tar`].sort());
  });

  test("an existing tarball is never trusted, the running image is saved over it every time", () => {
    for (const kind of ["good", "not-a-tar", "truncated", "wrong-image"] as const) {
      const run = runSave({ keep: [NEW], damaged: { [NEW]: kind } });
      expect(run.status).toBe(0);
      expect(run.log.filter((line) => line.startsWith("docker save"))).toHaveLength(1);
      expect(loadedImages(join(run.dir, `${hex(NEW)}.tar`))).toEqual([imageId(NEW)]);
    }
  });

  test("a docker save that fails part way fails the run and leaves the previous tarball byte for byte", () => {
    const host = makeHost("afterclass-save-fails-");
    const store = join(host.root, "store");
    fakeDocker(host, { store, saveFails: true });
    addPulledImage(host, store, NEW);
    stub(host.bin, "df", "printf 'Avail\\n10000000000\\n'");
    writeTarball(host, NEW);
    const tarball = join(imagesDir(host), `${hex(NEW)}.tar`);
    const before = readFileSync(tarball);

    const run = runScript(host, "afterclass-save-image", [NEW]);
    expect(run.status).not.toBe(0);
    expect(readdirSync(imagesDir(host)).sort()).toEqual([`${hex(NEW)}.id`, `${hex(NEW)}.tar`]);
    expect(readFileSync(tarball).equals(before)).toBe(true);
  });

  test("a docker save that fails part way with no earlier tarball leaves no tarball at all", () => {
    const run = runSave({ keep: [NEW], saveFails: true });
    expect(run.status).not.toBe(0);
    expect(run.files).toEqual([`${hex(NEW)}.id`]);
  });

  test("a disk with too little room is refused without writing anything, so the database keeps its space", () => {
    const run = runSave({ keep: [NEW, OLD], records: [OLD], tarballs: [OLD], freeBytes: 500_000_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("bytes free on /data");
    expect(run.log.some((line) => line.startsWith("docker save"))).toBe(false);
    expect(run.files).toEqual([`${hex(NEW)}.id`, `${hex(OLD)}.id`, `${hex(OLD)}.tar`].sort());
  });

  test("an image that is not on the host is an error, and every tarball stays, since it may be the only copy", () => {
    const run = runSave({ keep: [NEW, OLD], have: [], records: [NEW], tarballs: [NEW, OLDER] });
    expect(run.status).not.toBe(0);
    expect(run.files).toEqual([`${hex(NEW)}.id`, `${hex(NEW)}.tar`, `${hex(OLDER)}.tar`].sort());
  });

  test("a digest with no recorded image ID is an error, and nothing is saved or deleted", () => {
    const run = runSave({ keep: [NEW], have: [], tarballs: [OLDER] });
    expect(run.status).not.toBe(0);
    expect(run.log.some((line) => line.startsWith("docker save"))).toBe(false);
    expect(run.files).toEqual([`${hex(OLDER)}.tar`]);
  });

  test("anything but a sha256 digest is refused, so an argument cannot name a path", () => {
    for (const keep of [["../../etc/passwd"], [COMMIT], [NEW, "../x"]]) {
      const run = runSave({ keep, have: [] });
      expect(run.status).toBe(2);
    }
  });
});

function runPull(opts: { digest: string; have?: string[]; record?: boolean; tarball?: TarballKind; pullFails?: boolean; tags?: Record<string, string> }): {
  status: number;
  stdout: string;
  stderr: string;
  log: string[];
  store: string;
  record: string;
} {
  const host = makeHost("afterclass-pull-test-");
  const store = join(host.root, "store");
  fakeDocker(host, { store, pullFails: opts.pullFails, tags: opts.tags ?? {} });
  for (const digest of opts.have ?? []) addPulledImage(host, store, digest);
  if (opts.record) writeFileSync(join(imagesDir(host), `${hex(opts.digest)}.id`), `${imageId(opts.digest)}\n`);
  if (opts.tarball) writeTarball(host, opts.digest, opts.tarball);
  rmSync(host.log);
  writeFileSync(host.log, "");
  const run = runScript(host, "afterclass-pull", [opts.digest]);
  const recordPath = join(imagesDir(host), `${hex(opts.digest)}.id`);
  return { ...run, log: readLog(host), store, record: existsSync(recordPath) ? readFileSync(recordPath, "utf8").trim() : "" };
}

describe("afterclass-pull", () => {
  test("pulls anonymously from the pinned GHCR repository by digest, records the image ID, and prints it", () => {
    const run = runPull({ digest: NEW });
    expect(run.status).toBe(0);
    expect(run.log).toEqual([`docker image inspect ${REPOSITORY}@${NEW}`, `docker pull ${REPOSITORY}@${NEW}`, `docker image inspect --format {{.Id}} ${REPOSITORY}@${NEW}`]);
    expect(run.stdout.trim()).toBe(imageId(NEW));
    expect(run.record).toBe(imageId(NEW));
  });

  test("never pulls by tag, so a commit tag moved to another image changes nothing", () => {
    const run = runPull({ digest: NEW, tags: { [COMMIT]: OLDEST } });
    expect(run.stdout.trim()).toBe(imageId(NEW));
    expect(run.log.some((line) => line.includes(`${REPOSITORY}:`))).toBe(false);
  });

  test("an image Docker has by digest is neither loaded nor pulled", () => {
    const run = runPull({ digest: NEW, have: [NEW], tarball: "good" });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(imageId(NEW));
    expect(run.log.some((line) => line.startsWith("docker load") || line.startsWith("docker pull"))).toBe(false);
  });

  test("an image loaded earlier, which Docker knows only by ID, is used by its recorded ID", () => {
    const host = makeHost("afterclass-pull-loaded-");
    const store = join(host.root, "store");
    fakeDocker(host, { store, pullFails: true });
    writeFileSync(join(imagesDir(host), `${hex(NEW)}.id`), `${imageId(NEW)}\n`);
    writeFileSync(join(store, "ids", hex(imageId(NEW))), "");
    const run = runScript(host, "afterclass-pull", [NEW]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(imageId(NEW));
    expect(readLog(host).some((line) => line.startsWith("docker load") || line.startsWith("docker pull"))).toBe(false);
  });

  test("an image GHCR no longer holds starts from the tarball on the data volume, by the recorded ID", () => {
    const run = runPull({ digest: NEW, record: true, tarball: "good", pullFails: true });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(imageId(NEW));
    expect(hasImage(run.store, imageId(NEW))).toBe(true);
    expect(run.log.some((line) => line.startsWith("docker pull"))).toBe(false);
  });

  test("an image GHCR no longer holds, with no tarball, fails rather than starting something else", () => {
    const run = runPull({ digest: NEW, record: true, pullFails: true });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
  });

  test("a tarball without a recorded image ID is not trusted, and the image comes from GHCR", () => {
    const run = runPull({ digest: NEW, tarball: "good" });
    expect(run.status).toBe(0);
    expect(run.log.some((line) => line.startsWith("docker load"))).toBe(false);
    expect(run.log).toContain(`docker pull ${REPOSITORY}@${NEW}`);
  });

  for (const kind of ["not-a-tar", "truncated", "wrong-image"] as const) {
    test(`a ${kind} tarball is reported as an error and the image comes from GHCR by digest`, () => {
      const run = runPull({ digest: NEW, record: true, tarball: kind });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(imageId(NEW));
      expect(run.stderr).toContain("ERROR");
      expect(run.log).toContain(`docker pull ${REPOSITORY}@${NEW}`);
    });

    test(`a ${kind} tarball with the image gone from GHCR fails the pull and names no image`, () => {
      const run = runPull({ digest: NEW, record: true, tarball: kind, pullFails: true });
      expect(run.status).not.toBe(0);
      expect(run.stdout).toBe("");
    });
  }

  test("the settings and the environment cannot point the pull at another registry", () => {
    const host = makeHost("afterclass-pull-pinned-");
    fakeDocker(host, { store: join(host.root, "store") });
    writeFileSync(join(host.root, "settings.env"), "AWS_REGION=us-east-2\nECR_REGISTRY=evil.example\nECR_REPOSITORY=x\nIMAGE=evil.example/x\n");
    const run = Bun.spawnSync(["bash", installScript(host, "afterclass-pull"), NEW], {
      env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}`, ECR_REGISTRY: "evil.example", IMAGE: "evil.example/x", REGISTRY: "evil.example" },
    });
    expect(run.exitCode).toBe(0);
    expect(readLog(host)).toContain(`docker pull ${REPOSITORY}@${NEW}`);
    expect(readLog(host).some((line) => line.includes("evil.example"))).toBe(false);
  });

  test("only a sha256 digest is accepted, never a commit hash, a tag or a reference that names a registry", () => {
    for (const arg of [COMMIT, `${REPOSITORY}:${COMMIT}`, `evil.example/after-class@${NEW}`, `${COMMIT}@${NEW}`, NEW.toUpperCase(), `${NEW}0`, hex(NEW), "v0.1.0", ""]) {
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

  test("starts the image the old instance pulled and saved to /data, after GHCR lost it", () => {
    const old = makeHost("afterclass-replace-old-");
    fakeDocker(old, { store: join(old.root, "store") });
    stub(old.bin, "df", "printf 'Avail\\n10000000000\\n'");
    expect(runScript(old, "afterclass-pull", [NEW]).status).toBe(0);
    expect(runScript(old, "afterclass-save-image", [NEW]).status).toBe(0);

    const fresh = replaceHost(old);
    const run = runScript(fresh, "afterclass-pull", [NEW]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(imageId(NEW));
    expect(hasImage(join(fresh.root, "store"), imageId(NEW))).toBe(true);
  });

  test("a corrupt tarball does not stop a healthy deploy, the next save overwrites it, and a replacement survives the image leaving GHCR", () => {
    const host = makeHost("afterclass-repair-");
    const store = join(host.root, "store");
    fakeDocker(host, { store });
    stub(host.bin, "df", "printf 'Avail\\n10000000000\\n'");
    writeFileSync(join(imagesDir(host), `${hex(NEW)}.id`), `${imageId(NEW)}\n`);
    writeTarball(host, NEW, "truncated");

    expect(runScript(host, "afterclass-pull", [NEW]).status).toBe(0);
    expect(hasImage(store, imageId(NEW))).toBe(true);
    expect(runScript(host, "afterclass-save-image", [NEW]).status).toBe(0);

    const fresh = replaceHost(host);
    expect(runScript(fresh, "afterclass-pull", [NEW]).stdout.trim()).toBe(imageId(NEW));
  });

  test("a tarball swapped for another image is refused, so a replacement with GHCR gone starts nothing", () => {
    const old = makeHost("afterclass-replace-swap-");
    fakeDocker(old, { store: join(old.root, "store") });
    stub(old.bin, "df", "printf 'Avail\\n10000000000\\n'");
    expect(runScript(old, "afterclass-pull", [NEW]).status).toBe(0);
    expect(runScript(old, "afterclass-save-image", [NEW]).status).toBe(0);
    writeTarball(old, NEW, "wrong-image");

    const fresh = replaceHost(old);
    const run = runScript(fresh, "afterclass-pull", [NEW]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("ERROR");
  });
});

/**
 * One server with the real deploy, pull, save and start scripts and the fake Docker. A restart runs the real start script,
 * whose final docker run is logged, so the log shows which image the app would run.
 */
function serverHost(opts: { tags: Record<string, string>; poisoned?: string }): { host: Host; store: string; deploy: (commit: string, digest: string) => { status: number; stderr: string } } {
  const host = makeHost("afterclass-digest-server-");
  const store = join(host.root, "store");
  writeFileSync(join(host.root, "settings.env"), "APP_PORT=8080\nAWS_REGION=us-east-2\nLOG_GROUP=/afterclass-beta\n");
  fakeDocker(host, { store, tags: opts.tags });
  if (opts.poisoned) {
    const id = imageId(opts.poisoned);
    writeFileSync(join(store, "ids", hex(id)), "");
    writeFileSync(join(store, "refs", `${REPOSITORY}:${COMMIT}`.replace(/[/:@]/g, "_")), `${id}\n`);
  }
  for (const name of ["afterclass-pull", "afterclass-save-image", "afterclass-app-start"]) chmodSync(installScript(host, name), 0o755);
  stub(host.root, "afterclass-fetch-keys", "exit 0");
  for (const name of ["mountpoint", "sleep", "journalctl", "chown", "curl"]) stub(host.bin, name, "exit 0");
  stub(host.bin, "df", "printf 'Avail\\n10000000000\\n'");
  stub(host.bin, "systemctl", `[ "$1" = restart ] && bash ${join(host.root, "afterclass-app-start")} >/dev/null; exit 0`);
  return {
    host,
    store,
    deploy: (commit, digest) => {
      const run = runScript(host, "afterclass-deploy", [commit, digest]);
      return { status: run.status, stderr: run.stderr };
    },
  };
}

const appRuns = (host: Host): string[] => readLog(host).filter((line) => line.startsWith("docker run --rm --init --name afterclass-app"));

describe("the approved digest", () => {
  const APPROVED = digestOf("1");
  const ATTACKER = digestOf("2");

  test("an attacker who moves the commit tag on GHCR after the release does not change what the server runs", () => {
    const server = serverHost({ tags: { [COMMIT]: ATTACKER } });
    expect(server.deploy(COMMIT, APPROVED).status).toBe(0);
    const runs = appRuns(server.host);
    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) expect(line).toEndWith(` ${imageId(APPROVED)}`);
    expect(hasImage(server.store, imageId(ATTACKER))).toBe(false);
    expect(readLog(server.host).some((line) => line.includes(`${REPOSITORY}:`))).toBe(false);
    expect(readFileSync(join(server.host.root, "data/afterclass/current-image"), "utf8").trim()).toBe(APPROVED);
  });

  test("a poisoned image already on the host under the commit tag is never run", () => {
    const server = serverHost({ tags: {}, poisoned: ATTACKER });
    expect(server.deploy(COMMIT, APPROVED).status).toBe(0);
    for (const line of appRuns(server.host)) expect(line).toEndWith(` ${imageId(APPROVED)}`);
  });

  test("the tarball saved after the deploy loads as the approved image", () => {
    const server = serverHost({ tags: { [COMMIT]: ATTACKER } });
    expect(server.deploy(COMMIT, APPROVED).status).toBe(0);
    expect(loadedImages(join(imagesDir(server.host), `${hex(APPROVED)}.tar`))).toEqual([imageId(APPROVED)]);
  });

  test("a rollback returns to the previous digest's image, not to whatever its commit tag names now", () => {
    const server = serverHost({ tags: { [COMMIT]: ATTACKER } });
    expect(server.deploy(COMMIT, APPROVED).status).toBe(0);
    const NEXT = digestOf("3");
    stub(server.host.bin, "curl", `[ "$(cat ${join(server.host.root, "data/afterclass/current-image")})" = ${NEXT} ] && exit 22; exit 0`);
    expect(server.deploy("e".repeat(40), NEXT).status).toBe(1);
    expect(appRuns(server.host).at(-1)).toEndWith(` ${imageId(APPROVED)}`);
  });
});

const VOLUME_ID = "vol-0123456789abcdef0";
const DEVICE = "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}";
const XFS_MAGIC = "XFSB";

/**
 * One server and its data volume. The volume is a 4 MiB file, zeros unless the test gives contents. The stubbed mkfs.xfs
 * refuses a label over 12 characters as the real one does, and writes the xfs magic at the start of the disk. The stubbed
 * mount succeeds only on a file that starts with that magic, and mountpoint reports /data mounted after a mount of /data.
 * The stubbed blkid exits 2 on a readable disk and 4 on a missing one, as blkid -p does for a disk with no signature.
 * flock is the real tool.
 */
const XFS_LABEL_MAX = 12;

/** Deterministic bytes that read as random: no zero run, no signature. */
function noise(length: number): Buffer {
  const out = Buffer.alloc(length);
  let state = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) | 1;
  }
  return out;
}

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
    stub(host.bin, "blkid", `[ -e ${disk} ] || exit 4\nexit 2`);
    stub(
      host.bin,
      "mkfs.xfs",
      `echo "mkfs.xfs $*" >> ${host.log}
while getopts L: opt; do [ "$opt" = L ] && [ "\${#OPTARG}" -gt ${XFS_LABEL_MAX} ] && { echo "Invalid value $OPTARG for -L option" >&2; exit 1; }; done\n/bin/sleep ${opts.mkfsSeconds ?? 0}\nprintf ${XFS_MAGIC} | dd of=${disk} conv=notrunc status=none`,
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
    expect(volume.log).toContain(`mkfs.xfs -L afterclass ${volume.disk}`);
    expect(volume.run("afterclass-bootstrap").status).toBe(0);
    expect(volume.log).toContain("systemctl start afterclass-app.service");
  });

  test("a new volume whose first MiB is random data with no signature is formatted, once, with a label XFS accepts and without -f", () => {
    const volume = new DataVolume({ contents: Buffer.concat([Buffer.alloc(4096), noise(1_044_480), Buffer.alloc(3 * 1024 * 1024)]) });
    const run = volume.format();
    expect(run.output).not.toContain("nothing was formatted");
    expect(run.status).toBe(0);
    const calls = volume.log.filter((line) => line.startsWith("mkfs.xfs"));
    expect(calls).toEqual([`mkfs.xfs -L afterclass ${volume.disk}`]);
    const label = calls[0]!.split(" ")[2]!;
    expect(label.length).toBeLessThanOrEqual(XFS_LABEL_MAX);
    expect(calls[0]).not.toMatch(/ -\w*f/);
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
    ["blkid finds a signature", (volume) => stub(volume.host.bin, "blkid", "echo 'TYPE=\"ext4\"'; exit 0")],
    ["blkid fails with a read error", (volume) => stub(volume.host.bin, "blkid", "echo 'blkid: error reading' >&2; exit 4")],
    ["blkid fails without a status of its own", (volume) => stub(volume.host.bin, "blkid", "exit 1")],
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

  const haveTools = Bun.which("wipefs") !== null && Bun.which("blkid") !== null && Bun.which("mkfs.ext4") !== null;
  test.skipIf(!haveTools)("the real blkid and wipefs refuse an ext4 image and pass a blank one and one of random data", () => {
    const used = new DataVolume();
    expect(Bun.spawnSync(["mkfs.ext4", "-q", "-F", used.disk]).exitCode).toBe(0);
    rmSync(join(used.host.bin, "wipefs"));
    rmSync(join(used.host.bin, "blkid"));
    expect(used.format().status).not.toBe(0);
    expect(used.count("mkfs.xfs")).toBe(0);

    const blank = new DataVolume();
    rmSync(join(blank.host.bin, "wipefs"));
    rmSync(join(blank.host.bin, "blkid"));
    expect(blank.format().status).toBe(0);

    const random = new DataVolume({ contents: Buffer.concat([Buffer.alloc(4096), noise(1_044_480), Buffer.alloc(3 * 1024 * 1024)]) });
    rmSync(join(random.host.bin, "wipefs"));
    rmSync(join(random.host.bin, "blkid"));
    expect(random.format().status).toBe(0);
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

  test("Caddy compresses the app's text types with zstd and gzip, and lists them so the NDJSON tutor stream and the images stay untouched", () => {
    const block = /encode zstd gzip \{\s*match \{([^}]*)\}\s*\}/.exec(caddyfile)?.[1];
    expect(block).toBeDefined();
    const types = [...block!.matchAll(/header Content-Type (\S+)/g)].map((m) => m[1]);
    expect(types).toEqual(["text/*", "application/javascript*", "application/json*", "image/svg+xml*", "font/*"]);
    expect(caddyfile).toMatch(/reverse_proxy afterclass-app:\$\{app_port\} \{\s*flush_interval -1/);
  });
});
