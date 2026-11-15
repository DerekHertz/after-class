import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestOf, makeHost, stub } from "./beta-host";

const SCRIPT = resolve(import.meta.dir, "../scripts/release.sh");
const COMMIT = "c".repeat(40);
const DIGEST = digestOf("b");

interface Opts {
  readonly tag?: string;
  /** What the site's /health answers on each read, in order, the last one repeating. */
  readonly health?: string[];
  readonly tags?: string[];
  readonly record?: string;
  /** What the operator types, one line per prompt: the try's Enter, the deploy answer, then the sign-in Enter. */
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

const health = (version: string) => `{"ok":true,"version":"${version}"}`;

/**
 * Runs a copy of the real script in a temp clone whose scripts/try-release.sh and scripts/deploy-beta.sh are stubs that
 * record their arguments, with curl, git, gh, bun, aws and sleep stubbed too. The release names DIGEST for COMMIT.
 */
function release(opts: Opts = {}): Run {
  const host = makeHost("afterclass-release-");
  const calls = join(host.root, "calls");
  const log = `{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\n'; } >> ${calls}`;
  const scripts = join(host.root, "clone/scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(SCRIPT, join(scripts, "release.sh"));
  writeFileSync(join(host.root, "health"), (opts.health ?? [health("0.1.4"), health("0.1.5")]).join("\n") + "\n");
  writeFileSync(join(host.root, "tags"), (opts.tags ?? ["v0.1.3", "v0.1.4", "v0.1.5", "latest"]).join("\n") + "\n");
  writeFileSync(join(host.root, "record"), opts.record ?? `commit ${COMMIT}\ndigest ${DIGEST}\n`);
  writeFileSync(join(host.root, "sign-in-failures"), String(opts.signInAfter ?? 0));
  stub(scripts, "try-release.sh", `${log}\nread -r _ || true\nexit ${opts.tryFails ? 1 : 0}`);
  stub(scripts, "deploy-beta.sh", `${log}\nexit ${opts.deployFails ? 1 : 0}`);
  stub(
    host.bin,
    "curl",
    `${log}
answer=$(head -n 1 ${host.root}/health)
[ "$(wc -l < ${host.root}/health)" -gt 1 ] && sed -i 1d ${host.root}/health
printf '%s' "$answer"`,
  );
  stub(host.bin, "git", `${log}\ncase "$1" in tag) cat ${host.root}/tags;; esac\nexit 0`);
  stub(host.bin, "gh", `${log}\ncat ${host.root}/record`);
  stub(
    host.bin,
    "bun",
    `${log}
case "$*" in
  "scripts/check-release-tag.ts "*) echo ${COMMIT};;
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
  const result = Bun.spawnSync(["bash", join(scripts, "release.sh"), ...(opts.tag === undefined ? [] : [opts.tag])], {
    env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` },
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

describe("scripts/release.sh", () => {
  test("on y, deploys the newest release after the live one with the exact digest it showed and tried, and reports the new version", () => {
    const run = release();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("release: useafterclass.com runs v0.1.4.");
    expect(run.stdout).toContain("release: release tags after it: v0.1.5");
    expect(run.stdout).toContain(`release: its image is ghcr.io/derekhertz/after-class@${DIGEST}`);
    expect(of(run, "try-release.sh")).toEqual([["try-release.sh", "v0.1.5", DIGEST, COMMIT]]);
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.5", DIGEST, COMMIT]]);
    expect(run.stdout).toContain("release: useafterclass.com now runs v0.1.5.");
  });

  test("prints the notes before the try and the warnings again right before the question", () => {
    const run = release();
    const order = run.calls.map((c) => c.join(" "));
    const notes = order.indexOf(`bun scripts/release-notes.ts v0.1.5 ${COMMIT} 0.1.4`);
    const tried = order.findIndex((c) => c.startsWith("try-release.sh"));
    const warnings = order.indexOf(`bun scripts/release-notes.ts --warnings v0.1.5 ${COMMIT} 0.1.4`);
    expect(notes).toBeGreaterThan(-1);
    expect(notes).toBeLessThan(tried);
    expect(warnings).toBeGreaterThan(tried);
    expect(warnings).toBeLessThan(order.findIndex((c) => c.startsWith("deploy-beta.sh")));
    expect(run.stdout).toContain(`NOTES scripts/release-notes.ts v0.1.5 ${COMMIT} 0.1.4`);
    expect(run.stdout).toContain(`WARNINGS scripts/release-notes.ts --warnings v0.1.5 ${COMMIT} 0.1.4`);
  });

  for (const answer of ["", "n", "N", "Y", "yes", "yy", "no y"]) {
    test(`the answer ${JSON.stringify(answer)} deploys nothing and never asks AWS`, () => {
      const run = release({ input: `\n${answer}\n` });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("release: v0.1.5 was not deployed.");
      expect(deploys(run)).toEqual([]);
      expect(of(run, "aws")).toEqual([]);
    });
  }

  test("an input that ends before the answer deploys nothing", () => {
    const run = release({ input: "\n" });
    expect(deploys(run)).toEqual([]);
  });

  test("without an AWS sign-in, says how to sign in and stops before the deploy", () => {
    const run = release({ input: "\ny\n\n", signInAfter: Infinity });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain("Run `aws login` in another terminal, then press Enter here.");
    expect(run.stderr).toContain("still no AWS sign-in, so v0.1.5 was not deployed");
    expect(deploys(run)).toEqual([]);
  });

  test("a sign-in made while it waits lets the deploy go on", () => {
    const run = release({ input: "\ny\n\n", signInAfter: 1 });
    expect(run.status).toBe(0);
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.5", DIGEST, COMMIT]]);
  });

  test("a try that fails deploys nothing and asks nothing", () => {
    const run = release({ tryFails: true });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("the local try of v0.1.5 did not finish, so nothing was deployed");
    expect(deploys(run)).toEqual([]);
    expect(of(run, "aws")).toEqual([]);
  });

  test("a failed deploy fails the run and never says the site runs the release", () => {
    const run = release({ deployFails: true });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("now runs");
  });

  test("fails when /health never reports the new version", () => {
    const run = release({ health: [health("0.1.4")] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("does not report 0.1.5 after 2 minutes. It reports '0.1.4'.");
  });

  test("picks the newest tag by version, not by name", () => {
    const run = release({ tags: ["v0.1.4", "v0.1.9", "v0.1.10", "v0.1.11-rc1"], health: [health("0.1.4"), health("0.1.10")] });
    expect(run.stdout).toContain("release: release tags after it: v0.1.9 v0.1.10");
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.10", DIGEST, COMMIT]]);
  });

  test("takes a tag argument, such as an older one to roll back to", () => {
    const run = release({ tag: "v0.1.3", health: [health("0.1.4"), health("0.1.3")] });
    expect(run.status).toBe(0);
    expect(deploys(run)).toEqual([["deploy-beta.sh", "v0.1.3", DIGEST, COMMIT]]);
  });

  test("lists every tag and passes no live version when /health names none", () => {
    const run = release({ health: ['{"ok":true}', health("0.1.5")] });
    expect(run.stdout).toContain("release: release tags: v0.1.3 v0.1.4 v0.1.5");
    expect(of(run, "bun")).toContainEqual(["bun", "scripts/release-notes.ts", "v0.1.5", COMMIT]);
  });

  test("with nothing newer than the live release, prints the commands to cut the next one and runs nothing", () => {
    const run = release({ health: [health("0.1.5")] });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('to cut v0.1.6, merge a pull request that sets "version": "0.1.6" in package.json');
    expect(run.stdout).toContain("git tag -a v0.1.6 -m v0.1.6\n  git push origin v0.1.6");
    expect(of(run, "gh")).toEqual([]);
    expect(of(run, "try-release.sh")).toEqual([]);
    expect(of(run, "git").every((c) => c[1] === "fetch" || c[1] === "tag")).toBe(true);
  });

  const records: [string, string, string][] = [
    ["a record for another commit", `commit ${"0".repeat(40)}\ndigest ${DIGEST}\n`, "records commit 0000"],
    ["a record without a digest", `commit ${COMMIT}\n`, "is not a commit line and a digest line"],
    ["a second digest line", `commit ${COMMIT}\ndigest ${DIGEST}\ndigest ${digestOf("e")}\n`, "is not a commit line and a digest line"],
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

  test("refuses a tag that is not v<major>.<minor>.<patch> before it reads anything", () => {
    const run = release({ tag: "v0.1.5;rm" });
    expect(run.status).toBe(2);
    expect(run.calls).toEqual([]);
  });
});
