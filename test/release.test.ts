import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestOf, makeHost, offlineEnv, stub } from "./beta-host";

const SCRIPT = resolve(import.meta.dir, "../scripts/release.sh");
const LIVE_RELEASE = resolve(import.meta.dir, "../scripts/live-release.ts");
const COMMIT = "c".repeat(40);
const DIGEST = digestOf("b");

const OLD = digestOf("a");

interface Opts {
  readonly args?: string[];
  /** What `live-release.ts server` answers on each call, in order, the last one repeating. "FAIL <why>" fails. */
  readonly server?: string[];
  /** What `live-release.ts public` answers. "FAIL <why>" fails. */
  readonly public?: string;
  readonly tags?: string[];
  readonly record?: string;
  /** What the operator types, one line per prompt: the sign-in Enter when asked, the try's Enter, then the deploy answer. */
  readonly input?: string;
  /** How many sign-in checks fail before one passes. Infinity never signs in. */
  readonly signInAfter?: number;
  readonly tryFails?: boolean;
  readonly deployFails?: boolean;
}

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every stubbed call in order, as [command, ...args]. */
  readonly calls: string[][];
}

/**
 * Runs a copy of the real script in a temp clone whose scripts/try-release.sh and scripts/deploy-beta.sh are stubs that
 * record their arguments, with curl, git, gh, bun, aws and sleep stubbed too. The bun stub hands `live-release.ts record`
 * to the real script, which reads `record` through the gh stub. The release names DIGEST for COMMIT. The server runs
 * v0.1.4 until the deploy, then the deployed release.
 */
function release(opts: Opts = {}): Run {
  const host = makeHost("afterclass-release-");
  const calls = join(host.root, "calls");
  const log = `{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\n'; } >> ${calls}`;
  const scripts = join(host.root, "clone/scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(SCRIPT, join(scripts, "release.sh"));
  writeFileSync(join(host.root, "server"), (opts.server ?? [`v0.1.4 ${OLD}`, `v0.1.5 ${DIGEST}`]).join("\n") + "\n");
  writeFileSync(join(host.root, "public"), (opts.public ?? "v0.1.5") + "\n");
  writeFileSync(join(host.root, "tags"), (opts.tags ?? ["v0.1.3", "v0.1.4", "v0.1.5", "latest"]).join("\n") + "\n");
  writeFileSync(join(host.root, "record"), opts.record ?? `commit ${COMMIT}\ndigest ${DIGEST}\n`);
  writeFileSync(join(host.root, "sign-in-failures"), String(opts.signInAfter ?? 0));
  stub(scripts, "try-release.sh", `${log}\nread -r _ || true\nexit ${opts.tryFails ? 1 : 0}`);
  stub(scripts, "deploy-beta.sh", `${log}\nexit ${opts.deployFails ? 1 : 0}`);
  stub(host.bin, "curl", `${log}\nexit 60`);
  stub(host.bin, "git", `${log}\ncase "$1" in tag) cat ${host.root}/tags;; esac\nexit 0`);
  stub(host.bin, "gh", `${log}\ncat ${host.root}/record`);
  const answer = `case "$answer" in "FAIL "*) echo "live-release: \${answer#FAIL }" >&2; exit 1;; *) echo "$answer";; esac`;
  stub(
    host.bin,
    "bun",
    `${log}
case "$*" in
  "scripts/check-release-tag.ts "*) echo ${COMMIT};;
  "scripts/live-release.ts server")
    answer=$(head -n 1 ${host.root}/server)
    [ "$(wc -l < ${host.root}/server)" -gt 1 ] && sed -i 1d ${host.root}/server
    ${answer};;
  "scripts/live-release.ts public") answer=$(cat ${host.root}/public); ${answer};;
  "scripts/live-release.ts record "*) exec ${process.execPath} ${LIVE_RELEASE} record "$3";;
  "scripts/release-notes.ts --warnings "*) echo "WARNINGS $*";;
  "scripts/release-notes.ts "*) echo "NOTES $*";;
esac`,
  );
  stub(
    host.bin,
    "aws",
    `${log}
left=$(cat ${host.root}/sign-in-failures)
[ "$left" = Infinity ] && exit 255
[ "$left" -gt 0 ] && { echo $((left - 1)) > ${host.root}/sign-in-failures; exit 255; }
echo 123456789012`,
  );
  stub(host.bin, "sleep", "exit 0");
  const result = Bun.spawnSync(["bash", join(scripts, "release.sh"), ...(opts.args ?? [])], {
    env: offlineEnv(host.bin),
    stdin: Buffer.from(opts.input ?? "\ny\n"),
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
  };
}

const of = (run: Run, command: string): string[][] => run.calls.filter((c) => c[0] === command);
const deploys = (run: Run): string[][] => of(run, "deploy-beta.sh");
const serverReads = (run: Run): number => run.calls.filter((c) => c.join(" ") === "bun scripts/live-release.ts server").length;

describe("scripts/release.sh", () => {
  test("on y, deploys the newest release after the one the server runs with the exact digest and commit it showed and tried", () => {
    const run = release();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`release: useafterclass.com runs v0.1.4, image ${OLD}, read from the server.`);
    expect(run.stdout).toContain("release: release tags after it: v0.1.5");
    expect(run.stdout).toContain(`release: its image is ghcr.io/derekhertz/after-class@${DIGEST}`);
    expect(of(run, "try-release.sh")).toEqual([["try-release.sh", "v0.1.5", DIGEST, COMMIT]]);
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.5", DIGEST, COMMIT]]);
  });

  test("never reads the public /health for the base, so a filter's page cannot name the live release", () => {
    const run = release();
    expect(of(run, "curl")).toEqual([]);
    expect(run.calls.findIndex((c) => c.join(" ") === "bun scripts/live-release.ts server")).toBeLessThan(
      run.calls.findIndex((c) => c[1] === "scripts/release-notes.ts"),
    );
  });

  test("asks for an AWS sign-in before it reads anything from the server", () => {
    const run = release({ input: "\n\ny\n", signInAfter: 1 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Run `aws login` in another terminal, then press Enter here.");
    const order = run.calls.map((c) => c.join(" "));
    expect(order.findIndex((c) => c.startsWith("aws sts"))).toBeLessThan(order.indexOf("bun scripts/live-release.ts server"));
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.5", DIGEST, COMMIT]]);
  });

  test("without an AWS sign-in, says how to sign in and stops before it reads, tries or deploys anything", () => {
    const run = release({ input: "\n", signInAfter: Infinity });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("still no AWS sign-in. Run `aws login`, then scripts/release.sh again.");
    expect(serverReads(run)).toBe(0);
    expect(of(run, "try-release.sh")).toEqual([]);
    expect(deploys(run)).toEqual([]);
  });

  test("when the server's release cannot be read, stops before the notes, the try and the question", () => {
    const run = release({ server: ["FAIL the app on the server answered /health with something else"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("live-release: the app on the server answered /health with something else");
    expect(run.stderr).toContain("there is no base for the notes, so nothing was tried or deployed. If you know which release it runs, pass it: scripts/release.sh --live <tag>");
    expect(of(run, "bun").some((c) => c[1] === "scripts/release-notes.ts")).toBe(false);
    expect(of(run, "try-release.sh")).toEqual([]);
    expect(run.stdout).not.toContain("Deploy v0.1.5");
    expect(deploys(run)).toEqual([]);
  });

  test("with --live, an unreadable server uses the release you name, and says so at the start and at the question", () => {
    const run = release({ args: ["--live", "v0.1.3"], server: ["FAIL the app on the server did not answer its /health", `v0.1.5 ${DIGEST}`] });
    expect(run.status).toBe(0);
    const banner = "release: UNVERIFIED BASE. The server's release could not be read, and you passed --live v0.1.3.";
    expect(run.stdout.split(banner).length - 1).toBe(2);
    expect(run.stdout.lastIndexOf(banner)).toBeGreaterThan(run.stdout.indexOf("WARNINGS"));
    expect(run.stdout).toContain("release: release tags after it: v0.1.4 v0.1.5");
    expect(run.stdout).toContain(`NOTES scripts/release-notes.ts v0.1.5 ${COMMIT} v0.1.3`);
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.5", DIGEST, COMMIT]]);
  });

  test("with --live, a server that reads as another release stops before anything runs", () => {
    const run = release({ args: ["--live", "v0.1.3"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("the server runs v0.1.4, not the v0.1.3 you passed with --live. Run it without --live.");
    expect(of(run, "try-release.sh")).toEqual([]);
  });

  test("refuses a --live that names no release tag", () => {
    const run = release({ args: ["--live", "v0.1.9"], server: ["FAIL no answer"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--live v0.1.9 is not a release tag");
    expect(of(run, "try-release.sh")).toEqual([]);
  });

  test("prints the notes before the try and the warnings again right before the question", () => {
    const run = release();
    const order = run.calls.map((c) => c.join(" "));
    const notes = order.indexOf(`bun scripts/release-notes.ts v0.1.5 ${COMMIT} v0.1.4`);
    const tried = order.findIndex((c) => c.startsWith("try-release.sh"));
    const warnings = order.indexOf(`bun scripts/release-notes.ts --warnings v0.1.5 ${COMMIT} v0.1.4`);
    expect(notes).toBeGreaterThan(-1);
    expect(notes).toBeLessThan(tried);
    expect(warnings).toBeGreaterThan(tried);
    expect(warnings).toBeLessThan(order.findIndex((c) => c.startsWith("deploy-beta.sh")));
    expect(run.stdout).toContain(`NOTES scripts/release-notes.ts v0.1.5 ${COMMIT} v0.1.4`);
    expect(run.stdout).toContain(`WARNINGS scripts/release-notes.ts --warnings v0.1.5 ${COMMIT} v0.1.4`);
  });

  for (const answer of ["", "n", "N", "Y", "yes", "yy", "no y"]) {
    test(`the answer ${JSON.stringify(answer)} deploys nothing`, () => {
      const run = release({ input: `\n${answer}\n` });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("release: v0.1.5 was not deployed.");
      expect(deploys(run)).toEqual([]);
      expect(serverReads(run)).toBe(1);
    });
  }

  test("an input that ends before the answer deploys nothing", () => {
    const run = release({ input: "\n" });
    expect(deploys(run)).toEqual([]);
  });

  test("a try that fails deploys nothing and asks nothing", () => {
    const run = release({ tryFails: true });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("the local try of v0.1.5 did not finish, so nothing was deployed");
    expect(deploys(run)).toEqual([]);
  });

  test("a failed deploy fails the run and never says the server runs the release", () => {
    const run = release({ deployFails: true });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("the server runs v0.1.5");
  });

  test("after the deploy, confirms the release and digest on the server, then reports the public site from this machine", () => {
    const run = release();
    expect(run.status).toBe(0);
    expect(serverReads(run)).toBe(2);
    expect(run.stdout).toContain(`release: the server runs v0.1.5, image ${DIGEST}, and its /health answers.`);
    expect(run.stdout).toContain("release: useafterclass.com reports v0.1.5 to this machine too.");
  });

  test("a public site this machine cannot reach is a warning, not a failed deploy", () => {
    const run = release({ public: "FAIL https://useafterclass.com/health from this machine: cannot reach it (curl exited 60)" });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("cannot reach it (curl exited 60)");
    expect(run.stdout).toContain(`release: the server runs v0.1.5, image ${DIGEST}, and its /health answers.`);
    expect(run.stdout).toContain("release: WARNING this machine could not confirm useafterclass.com. The server runs v0.1.5, so the deploy stands.");
  });

  test("a server that reads back as another release after the deploy fails the run", () => {
    const run = release({ server: [`v0.1.4 ${OLD}`] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`after the deploy, the server runs v0.1.4, image ${OLD}, not v0.1.5, image ${DIGEST}.`);
  });

  test("a server that cannot be read back after the deploy fails the run as unconfirmed", () => {
    const run = release({ server: [`v0.1.4 ${OLD}`, "FAIL the app on the server did not answer its /health"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("the deploy of v0.1.5 reported healthy, but the server could not be read back, so it is unconfirmed.");
  });

  test("picks the newest tag by version, not by name", () => {
    const run = release({ tags: ["v0.1.4", "v0.1.9", "v0.1.10", "v0.1.11-rc1"], server: [`v0.1.4 ${OLD}`, `v0.1.10 ${DIGEST}`] });
    expect(run.stdout).toContain("release: release tags after it: v0.1.9 v0.1.10");
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.10", DIGEST, COMMIT]]);
  });

  test("takes a tag argument, such as an older one to roll back to", () => {
    const run = release({ args: ["v0.1.3"], server: [`v0.1.4 ${OLD}`, `v0.1.3 ${DIGEST}`], public: "v0.1.3" });
    expect(run.status).toBe(0);
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.3", DIGEST, COMMIT]]);
  });

  test("with nothing newer than the live release, prints the commands to cut the next one and runs nothing", () => {
    const run = release({ server: [`v0.1.5 ${DIGEST}`] });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('to cut v0.1.6, merge a pull request that sets "version": "0.1.6" in package.json');
    expect(run.stdout).toContain("git tag -a v0.1.6 -m v0.1.6\n  git push origin v0.1.6");
    expect(of(run, "gh")).toEqual([]);
    expect(of(run, "try-release.sh")).toEqual([]);
    expect(of(run, "git").every((c) => c[1] === "fetch" || c[1] === "tag")).toBe(true);
  });

  const records: [string, string, string][] = [
    ["a record for another commit", `commit ${"0".repeat(40)}\ndigest ${DIGEST}\n`, "records commit 0000"],
    ["a record without a digest", `commit ${COMMIT}\n`, "image-digest.txt is not in its format"],
    ["a second digest line", `commit ${COMMIT}\ndigest ${DIGEST}\ndigest ${digestOf("e")}\n`, "image-digest.txt is not in its format"],
    ["a NUL inside the digest, which a shell would drop", `commit ${COMMIT}\ndigest sha\u0000256:${"b".repeat(64)}\n`, "image-digest.txt is not in its format"],
  ];
  for (const [name, record, reason] of records) {
    test(`refuses ${name} before it tries or deploys anything`, () => {
      const run = release({ record });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(reason);
      expect(of(run, "try-release.sh")).toEqual([]);
      expect(deploys(run)).toEqual([]);
    });
  }

  for (const args of [["v0.1.5;rm"], ["--live", "latest"], ["--live"], ["v0.1.4", "v0.1.5"]]) {
    test(`refuses the arguments ${JSON.stringify(args)} before it reads anything`, () => {
      const run = release({ args });
      expect(run.status).toBe(2);
      expect(run.calls).toEqual([]);
    });
  }
});
