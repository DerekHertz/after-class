import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf, FILES, type Host, installScript, makeHost, readLog, stub } from "./beta-host";

const OLD = digestOf("a");
const NEW = digestOf("b");
const COMMIT = "c".repeat(40);
const record = (digest: string, commit = COMMIT): string => `commit ${commit}\ndigest ${digest}\n`;

interface Release {
  readonly tag_name: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
}

interface GitHub {
  /** The release list. A string is served as the raw body. */
  releases?: Release[] | string;
  /** The status of the release list. 200 answers 304 when the request's If-None-Match is the current ETag. */
  listStatus?: number;
  /** The list cannot be reached at all, as when DNS or the network fails. */
  down?: boolean;
  etag?: string;
  /** Each tag's image-digest.txt. A tag without one answers 404. */
  records?: Record<string, string>;
  /** What the compare API says of the record's commit against master, or null for an error. */
  compare?: string | null;
}

/**
 * One beta server: the real afterclass-autodeploy and the real afterclass-deploy, with GitHub, the health check,
 * systemctl, docker and aws stubbed. afterclass-pull and afterclass-save-image are stubs that log. `unhealthy` names the
 * digests whose /health fails, read from the state file the real deploy writes.
 */
class Server {
  readonly host: Host = makeHost("afterclass-autodeploy-test-");
  private readonly gh = join(this.host.root, "gh");
  private readonly state = join(this.host.root, "data/afterclass/current-image");
  private readonly aws = join(this.host.root, "aws-calls");

  private readonly clock = join(this.host.root, "clock");
  private readonly lockBusy = join(this.host.root, "deploy-lock-busy");

  constructor(opts: { running?: string; unhealthy?: string[]; pullFails?: boolean; mounted?: boolean } = {}) {
    const { host, gh, state } = this;
    this.now = 1_000_000;
    stub(host.bin, "date", `if [ "$*" = +%s ]; then cat ${this.clock}; else exec /usr/bin/date "$@"; fi`);
    stub(host.bin, "flock", `if [ "$1" = -w ] && [ -e ${this.lockBusy} ]; then echo "flock -w $2 timed out" >> ${host.log}; exit 1; fi\nexec /usr/bin/flock "$@"`);
    mkdirSync(join(gh, "records"), { recursive: true });
    writeFileSync(join(host.root, "settings.env"), "APP_PORT=8080\nAWS_REGION=us-east-2\nLOG_GROUP=/afterclass-beta\n");
    if (opts.running) writeFileSync(state, `${opts.running}\n`);
    this.github({});
    stub(host.bin, "mountpoint", opts.mounted === false ? "exit 1" : "exit 0");
    stub(host.bin, "sleep", "exit 0");
    stub(host.bin, "journalctl", "exit 0");
    stub(host.bin, "docker", `echo "docker $*" >> ${host.log}`);
    stub(host.bin, "systemctl", `echo "systemctl $*" >> ${host.log}`);
    stub(host.bin, "aws", `{ printf '%s\\0' "$@"; printf '\\n'; } >> ${this.aws}`);
    stub(
      host.bin,
      "curl",
      String.raw`out=""; hdr=""; url=""; inm=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift;;
    -D) hdr=$2; shift;;
    -H) case "$2" in If-None-Match:*) inm=${"${2#If-None-Match: }"};; esac; shift;;
    -w|--max-time|--max-filesize) shift;;
    http*) url=$1;;
  esac
  shift
done
echo "curl $url $inm" >> ${host.log}
gh=${gh}
case "$url" in
  https://api.github.com/repos/DerekHertz/after-class/releases\?per_page=100)
    [ -e $gh/down ] && exit 6
    code=$(cat $gh/status)
    [ "$code" = 200 ] && [ -n "$inm" ] && [ "$inm" = "$(cat $gh/etag)" ] && code=304
    printf 'HTTP/2 %s\r\netag: %s\r\n\r\n' "$code" "$(cat $gh/etag)" > "$hdr"
    if [ "$code" = 200 ]; then cat $gh/releases > "$out"; else : > "$out"; fi
    printf '%s' "$code";;
  https://github.com/DerekHertz/after-class/releases/download/*/image-digest.txt)
    tag=$(echo "$url" | sed 's|.*/download/\([^/]*\)/.*|\1|')
    [ -e "$gh/records/$tag" ] || exit 22
    cat "$gh/records/$tag";;
  https://api.github.com/repos/DerekHertz/after-class/compare/master...*)
    [ -e $gh/compare ] || exit 22
    printf '{"status":"%s","ahead_by":0}' "$(cat $gh/compare)";;
  http://127.0.0.1:8080/health)
    case " ${(opts.unhealthy ?? []).join(" ")} " in *" $(cat ${state}) "*) exit 22;; esac;;
  *) exit 2;;
esac`,
    );
    const outside = `/usr/bin/flock -n ${join(host.root, "lock")} true && echo "pull $1 outside the deploy lock" >> ${host.log}`;
    stub(host.root, "afterclass-pull", `${outside} || echo "pull $1" >> ${host.log}\n${opts.pullFails ? "exit 1" : "exit 0"}`);
    stub(host.root, "afterclass-save-image", `echo "save $*" >> ${host.log}`);
    chmodSync(installScript(host, "afterclass-deploy"), 0o755);
  }

  /** The time, in seconds since the epoch, that the scripts read from date +%s. */
  set now(seconds: number) {
    writeFileSync(this.clock, `${seconds}\n`);
  }

  /** Whether another deploy holds the deploy lock for longer than afterclass-deploy waits. */
  set deployLockBusy(busy: boolean) {
    if (busy) writeFileSync(this.lockBusy, "");
    else Bun.spawnSync(["rm", "-f", this.lockBusy]);
  }

  /** Sets what GitHub serves from now on. Unset fields keep their defaults, not their earlier values. */
  github(g: GitHub): void {
    const { gh } = this;
    const releases = g.releases ?? [];
    writeFileSync(join(gh, "releases"), typeof releases === "string" ? releases : JSON.stringify(releases.map((r) => ({ draft: false, prerelease: false, ...r }))));
    writeFileSync(join(gh, "status"), String(g.listStatus ?? 200));
    writeFileSync(join(gh, "etag"), g.etag ?? `W/"${Bun.hash(JSON.stringify(releases)).toString(16)}"`);
    for (const [tag, text] of Object.entries(g.records ?? {})) writeFileSync(join(gh, "records", tag), text);
    if (g.compare === null) Bun.spawnSync(["rm", "-f", join(gh, "compare")]);
    else writeFileSync(join(gh, "compare"), g.compare ?? "behind");
    if (g.down) writeFileSync(join(gh, "down"), "");
    else Bun.spawnSync(["rm", "-f", join(gh, "down")]);
  }

  run(): { status: number; output: string } {
    const path = installScript(this.host, "afterclass-autodeploy", { "/run/afterclass-autodeploy.lock": join(this.host.root, "autodeploy.lock") });
    const result = Bun.spawnSync(["bash", path], { env: { ...process.env, PATH: `${this.host.bin}:${process.env.PATH}` } });
    return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }

  get running(): string {
    return existsSync(this.state) ? readFileSync(this.state, "utf8").trim() : "";
  }

  get log(): string[] {
    return readLog(this.host);
  }

  deploys(): string[] {
    return this.log.filter((line) => line.startsWith("pull ") || line === "systemctl restart afterclass-app.service");
  }

  /** The messages sent to CloudWatch, with the group and stream each went to. */
  shipped(): { group: string; stream: string; message: string }[] {
    if (!existsSync(this.aws)) return [];
    return readFileSync(this.aws, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\0"))
      .filter((args) => args[1] === "put-log-events")
      .flatMap((args) => {
        const at = (flag: string) => args[args.indexOf(flag) + 1]!;
        return (JSON.parse(at("--log-events")) as { message: string }[]).map(({ message }) => ({ group: at("--log-group-name"), stream: at("--log-stream-name"), message }));
      });
  }
}

const v015 = { releases: [{ tag_name: "v0.1.4" }, { tag_name: "v0.1.5" }], records: { "v0.1.4": record(OLD), "v0.1.5": record(NEW) } };

describe("afterclass-autodeploy", () => {
  test("deploys the newly published release by its recorded digest and logs the decision to CloudWatch", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    const run = server.run();
    expect(run.status).toBe(0);
    expect(server.running).toBe(NEW);
    expect(server.log).toContain(`pull ${NEW}`);
    const shipped = server.shipped();
    expect(shipped.every(({ group, stream }) => group === "/afterclass-beta" && stream === "autodeploy")).toBe(true);
    expect(shipped.map(({ message }) => message)).toContain(`afterclass-autodeploy: deploying v0.1.5 (${COMMIT}, ${NEW}) over ${OLD}`);
    expect(shipped.map(({ message }) => message)).toContain(`afterclass-deploy: ${COMMIT} (${NEW}) is healthy`);
  });

  test("picks the highest version, not the list order, and never a draft or a pre-release", () => {
    const server = new Server({ running: OLD });
    server.github({
      releases: [{ tag_name: "v0.1.10", draft: true }, { tag_name: "v0.1.9", prerelease: true }, { tag_name: "v0.1.5" }, { tag_name: "v0.1.4" }, { tag_name: "nightly" }],
      records: { "v0.1.10": record(digestOf("d")), "v0.1.9": record(digestOf("e")), "v0.1.5": record(NEW) },
    });
    expect(server.run().status).toBe(0);
    expect(server.running).toBe(NEW);
    expect(server.log.filter((line) => line.includes("/releases/download/"))).toEqual(["curl https://github.com/DerekHertz/after-class/releases/download/v0.1.5/image-digest.txt "]);
  });

  test("a list of nothing but drafts deploys nothing", () => {
    const server = new Server({ running: OLD });
    server.github({ releases: [{ tag_name: "v0.1.5", draft: true }], records: { "v0.1.5": record(NEW) } });
    const run = server.run();
    expect(run.status).toBe(0);
    expect(run.output).toContain("no release is published");
    expect(server.running).toBe(OLD);
    expect(server.deploys()).toEqual([]);
  });

  const outages: [string, GitHub, string][] = [
    ["a rate limit", { ...v015, listStatus: 403 }, "GitHub answered 403"],
    ["a secondary rate limit", { ...v015, listStatus: 429 }, "GitHub answered 429"],
    ["a server error", { ...v015, listStatus: 502 }, "GitHub answered 502"],
    ["no network", { ...v015, down: true }, "GitHub answered 000"],
    ["a body that is not a list", { ...v015, releases: '{"message":"API rate limit exceeded"}' }, "is not a list of releases"],
    ["a body that is not JSON", { ...v015, releases: "<html>unicorn</html>" }, "is not a list of releases"],
    ["a missing image-digest.txt", { releases: v015.releases, records: { "v0.1.4": record(OLD) } }, "cannot read v0.1.5's image-digest.txt"],
    ["a compare API error", { ...v015, compare: null }, "cannot ask GitHub whether"],
  ];
  for (const [name, github, reason] of outages) {
    test(`${name} deploys nothing, logs why, and the next check asks again`, () => {
      const server = new Server({ running: OLD });
      server.github(github);
      const run = server.run();
      expect(run.status).toBe(0);
      expect(run.output).toContain(reason);
      expect(server.running).toBe(OLD);
      expect(server.log).not.toContain("systemctl restart afterclass-app.service");
      expect(server.shipped().some(({ message }) => message.includes(reason))).toBe(true);
      server.github(v015);
      server.now = 1_000_000 + 120;
      expect(server.run().status).toBe(0);
      expect(server.running).toBe(NEW);
    });
  }

  const malformed: [string, string][] = [
    ["a short digest", `commit ${COMMIT}\ndigest sha256:${"b".repeat(63)}\n`],
    ["an uppercase digest", `commit ${COMMIT}\ndigest sha256:${"B".repeat(64)}\n`],
    ["a tag instead of a digest", `commit ${COMMIT}\ndigest v0.1.5\n`],
    ["a digest that names a registry", `commit ${COMMIT}\ndigest evil.example/x@${NEW}\n`],
    ["a second digest line", `${record(NEW)}digest ${digestOf("e")}\n`],
    ["no commit line", `digest ${NEW}\n`],
  ];
  for (const [name, text] of malformed) {
    test(`refuses a record with ${name}, pulls and restarts nothing`, () => {
      const server = new Server({ running: OLD });
      server.github({ releases: v015.releases, records: { "v0.1.5": text } });
      const run = server.run();
      expect(run.output).toContain("refused v0.1.5: its image-digest.txt is not a commit line and a digest line");
      expect(server.running).toBe(OLD);
      expect(server.deploys()).toEqual([]);
    });
  }

  test("refuses a release whose commit is not on master", () => {
    const server = new Server({ running: OLD });
    server.github({ ...v015, compare: "diverged" });
    const run = server.run();
    expect(run.output).toContain(`refused v0.1.5: its commit ${COMMIT} is diverged master`);
    expect(server.running).toBe(OLD);
    expect(server.log).not.toContain("systemctl restart afterclass-app.service");
  });

  test("a release that fails its health check is rolled back to the previous image, fails the run, and is not tried again", () => {
    const server = new Server({ running: OLD, unhealthy: [NEW] });
    server.github(v015);
    const run = server.run();
    expect(run.status).toBe(1);
    expect(server.running).toBe(OLD);
    expect(run.output).toContain(`rolled back to ${OLD}`);
    expect(server.shipped().some(({ message }) => message.includes("v0.1.5 failed and is not tried again"))).toBe(true);
    const restarts = server.log.filter((line) => line === "systemctl restart afterclass-app.service").length;
    expect(server.run().status).toBe(0);
    server.github({ ...v015, etag: '"changed"' });
    expect(server.run().output).toContain("v0.1.5 (" + NEW + ") is already handled");
    expect(server.log.filter((line) => line === "systemctl restart afterclass-app.service").length).toBe(restarts);
  });

  test("a changed image under a handled tag is refused loudly at every check and never deployed", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    server.run();
    const restarts = server.deploys().length;
    const rebuilt = digestOf("e");
    server.github({ ...v015, records: { ...v015.records, "v0.1.5": record(rebuilt) }, etag: '"rerun"' });
    for (let check = 0; check < 2; check++) {
      const run = server.run();
      expect(run.status).toBe(1);
      expect(run.output).toContain(`REFUSED v0.1.5: its image-digest.txt now names ${rebuilt}, but v0.1.5 was handled as ${NEW}`);
    }
    expect(server.shipped().filter(({ message }) => message.includes("REFUSED v0.1.5"))).toHaveLength(2);
    expect(server.running).toBe(NEW);
    expect(server.deploys()).toHaveLength(restarts);
  });

  test("a changed image under a tag that failed and was rolled back is never deployed either", () => {
    const server = new Server({ running: OLD, unhealthy: [NEW] });
    server.github(v015);
    server.run();
    const restarts = server.deploys().length;
    server.github({ ...v015, records: { ...v015.records, "v0.1.5": record(digestOf("e")) }, etag: '"rerun"' });
    expect(server.run().output).toContain("REFUSED v0.1.5");
    expect(server.running).toBe(OLD);
    expect(server.deploys()).toHaveLength(restarts);
  });

  test("a deploy that times out on its lock is not handled, and the release deploys once the lock is free", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    server.deployLockBusy = true;
    const run = server.run();
    expect(run.status).toBe(0);
    expect(run.output).toContain("v0.1.5 did not start its rollout");
    expect(server.running).toBe(OLD);
    expect(server.log).not.toContain("systemctl restart afterclass-app.service");
    server.deployLockBusy = false;
    server.now = 1_000_000 + 121;
    expect(server.run().status).toBe(0);
    expect(server.running).toBe(NEW);
  });

  test("a release that keeps failing before its rollout is retried after 2, 4, 8 minutes, then at most every 30", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    server.deployLockBusy = true;
    const attempts = () => server.log.filter((line) => line.startsWith("flock -w")).length;
    let t = 1_000_000;
    server.run();
    for (const [tried, wait] of [120, 240, 480, 960, 1800, 1800].entries()) {
      server.now = t + wait - 1;
      expect(server.run().output).toContain(`v0.1.5 is retried at ${t + wait}`);
      expect(attempts()).toBe(tried + 1);
      t += wait;
      server.now = t;
      expect(server.run().output).toContain("v0.1.5 did not start its rollout");
    }
  });

  test("a newly published release is tried at once, even while an older one waits to be retried", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    server.deployLockBusy = true;
    server.run();
    server.deployLockBusy = false;
    const v016 = digestOf("6");
    server.github({ releases: [...v015.releases, { tag_name: "v0.1.6" }], records: { ...v015.records, "v0.1.6": record(v016) } });
    expect(server.run().status).toBe(0);
    expect(server.running).toBe(v016);
  });

  test("every pull runs inside afterclass-deploy's lock, so it never races a manual deploy's save of the image cache", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    expect(server.run().status).toBe(0);
    expect(server.log.filter((line) => line.startsWith("pull "))).toEqual([`pull ${NEW}`]);
  });

  test("an unchanged list is asked for with its ETag, answers 304, and reads no record", () => {
    const server = new Server({ running: OLD });
    server.github({ ...v015, etag: '"v15"' });
    expect(server.run().status).toBe(0);
    const before = server.log.length;
    const run = server.run();
    expect(run.output).toContain("no release changed since the last check");
    expect(server.log.slice(before)).toEqual(['curl https://api.github.com/repos/DerekHertz/after-class/releases?per_page=100 "v15"']);
  });

  test("publishing an older version deploys nothing", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    server.run();
    server.github({ releases: [...v015.releases, { tag_name: "v0.1.3" }], records: { ...v015.records, "v0.1.3": record(digestOf("d")) } });
    expect(server.run().output).toContain("v0.1.5 (" + NEW + ") is already handled");
    expect(server.running).toBe(NEW);
  });

  test("marking the newest release as a pre-release rolls back to the next highest published one", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    server.run();
    server.github({ releases: [{ tag_name: "v0.1.4" }, { tag_name: "v0.1.5", prerelease: true }], records: v015.records });
    expect(server.run().status).toBe(0);
    expect(server.running).toBe(OLD);
  });

  test("a manual deploy stays until another release is published", () => {
    const server = new Server({ running: OLD });
    server.github(v015);
    server.run();
    writeFileSync(join(server.host.root, "data/afterclass/current-image"), `${digestOf("d")}\n`);
    server.github({ ...v015, etag: '"touched"' });
    server.run();
    expect(server.running).toBe(digestOf("d"));
  });

  test("a release already running is recorded without a restart", () => {
    const server = new Server({ running: NEW });
    server.github(v015);
    expect(server.run().output).toContain(`v0.1.5 (${NEW}) is already running`);
    expect(server.deploys()).toEqual([]);
  });

  test("a failed pull leaves the app alone, is not handled, and is tried again after the wait", () => {
    const server = new Server({ running: OLD, pullFails: true });
    server.github(v015);
    expect(server.run().output).toContain("v0.1.5 is retried at 1000120");
    expect(server.log).not.toContain("systemctl restart afterclass-app.service");
    server.now = 1_000_000 + 120;
    expect(server.run().output).toContain("v0.1.5 did not start its rollout, afterclass-deploy exited 1. v0.1.5 is retried at 1000360");
    expect(server.running).toBe(OLD);
  });

  test("an unmounted /data asks GitHub nothing", () => {
    const server = new Server({ running: OLD, mounted: false });
    server.github(v015);
    expect(server.run().output).toContain("/data is not mounted");
    expect(server.log).toEqual([]);
  });
});

describe("the autodeploy units", () => {
  const read = (name: string) => readFileSync(join(FILES, name), "utf8");

  test("the timer runs the check 75 seconds after the last one ends, so checks never overlap and stay under GitHub's 60 an hour", () => {
    const timer = read("afterclass-autodeploy.timer");
    expect(timer).toContain("OnUnitInactiveSec=75s");
    expect(timer).toContain("WantedBy=timers.target");
  });

  test("the service runs the script once per tick and needs /data", () => {
    const service = read("afterclass-autodeploy.service");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/sbin/afterclass-autodeploy");
    expect(service).toContain("RequiresMountsFor=/data");
  });

  test("the instance installs the script and both units, and bootstrap starts the timer", () => {
    const instance = readFileSync(join(FILES, "../instance.tf"), "utf8");
    for (const name of ["afterclass-autodeploy.sh", "afterclass-autodeploy.service", "afterclass-autodeploy.timer"]) expect(instance).toContain(`files/${name}`);
    expect(read("afterclass-bootstrap.sh")).toContain("systemctl enable --now afterclass-autodeploy.timer");
  });
});
