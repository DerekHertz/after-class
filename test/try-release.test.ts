import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestOf, makeHost, REPOSITORY, stub } from "./beta-host";

const SCRIPT = resolve(import.meta.dir, "../scripts/try-release.sh");
const COMMIT = "c".repeat(40);
const DIGEST = digestOf("b");
const BASE = `oven/bun:1.4.3-slim@sha256:${"1".repeat(64)}`;
const SUMMARY = "## Changes since v0.1.4\n\n### Fixes\n- Keep drafts (#301)";
const KEY = "sk-live-key-from-the-shell";

interface Opts {
  readonly tag?: string;
  readonly record?: string;
  readonly arm64?: boolean;
  readonly healthy?: boolean;
}

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Each docker, gh and aws call as its argument vector. */
  readonly calls: string[][];
  readonly built: string;
}

/** Runs the real script with gh, docker, curl, sleep and aws stubbed. The draft release names DIGEST for COMMIT. */
function tryRelease(opts: Opts = {}): Run {
  const host = makeHost("afterclass-try-release-");
  const calls = join(host.root, "calls");
  const log = `{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\n'; } >> ${calls}`;
  writeFileSync(join(host.root, "record"), opts.record ?? `commit ${COMMIT}\ndigest ${DIGEST}\n`);
  writeFileSync(join(host.root, "summary"), SUMMARY);
  writeFileSync(join(host.root, "Dockerfile"), `# comment\nARG BUN_IMAGE=${BASE}\nFROM \${BUN_IMAGE}\n`);
  stub(
    host.bin,
    "gh",
    `${log}
case "$1 $2" in
  "release view") case "$*" in *isDraft*) echo draft;; *) cat ${host.root}/summary;; esac;;
  "release download") cat ${host.root}/record;;
  "api -H") case "$*" in *contents/Dockerfile?ref=${COMMIT}*) cat ${host.root}/Dockerfile;; *) exit 1;; esac;;
esac`,
  );
  stub(
    host.bin,
    "docker",
    `${log}
case "$1" in
  run) case "$*" in *"--entrypoint true"*) exit ${opts.arm64 ? 0 : 1};; esac;;
  image) case "$*" in
    *"{{range .Config.Env}}"*) printf '%s\\n' PATH=/usr/bin BUN_INSTALL=/x AFTERCLASS_MODE=replay AFTERCLASS_PORT=8080 AFTERCLASS_DATA=/data/db;;
    *"{{.Config.WorkingDir}}"*) echo /app;;
    *"{{.Config.User}}"*) echo bun;;
    *"{{json .Config.Cmd}}"*) echo '["bun","run","src/backend/main.ts"]';;
  esac;;
  build) for last; do :; done; cp "$last/Dockerfile" ${host.root}/built;;
esac
exit 0`,
  );
  stub(host.bin, "curl", opts.healthy === false ? "exit 7" : "exit 0");
  stub(host.bin, "sleep", "exit 0");
  stub(host.bin, "aws", log);
  const result = Bun.spawnSync(["bash", SCRIPT, opts.tag ?? "v0.1.5"], {
    env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: KEY, TYPESAFE_API_KEY: KEY },
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
    built: existsSync(join(host.root, "built")) ? readFileSync(join(host.root, "built"), "utf8") : "",
  };
}

const of = (run: Run, command: string, sub?: string): string[][] => run.calls.filter((c) => c[0] === command && (sub === undefined || c[1] === sub));
const appRun = (run: Run): string[] | undefined => of(run, "docker", "run").find((c) => c.includes("--detach"));

describe("scripts/try-release.sh", () => {
  test("runs the release's exact digest in replay mode on 127.0.0.1, prints the summary and the URL, and never calls AWS", () => {
    const run = tryRelease({ arm64: true });
    expect(run.status).toBe(0);
    expect(of(run, "docker", "pull")).toEqual([["docker", "pull", "--quiet", "--platform", "linux/arm64", `${REPOSITORY}@${DIGEST}`]]);
    const app = appRun(run)!;
    expect(app.at(-1)).toBe(`${REPOSITORY}@${DIGEST}`);
    expect(app).toContain("AFTERCLASS_MODE=replay");
    expect(app.join(" ")).toContain("--publish 127.0.0.1:8790:8790");
    expect(run.stdout).toContain("v0.1.5, draft, commit " + COMMIT);
    expect(run.stdout).toContain(SUMMARY);
    expect(run.stdout).toContain("http://127.0.0.1:8790/app/");
    expect(of(run, "aws")).toEqual([]);
  });

  test("passes no keys, key file or host folder into the container", () => {
    const app = appRun(tryRelease({ arm64: true }))!.join(" ");
    expect(app).not.toContain(KEY);
    for (const flag of ["--env-file", "--volume", "-v ", "--mount", "--network host"]) expect(app).not.toContain(flag);
  });

  test("stops the container when it exits", () => {
    const run = tryRelease({ arm64: true });
    expect(of(run, "docker", "stop")).toEqual([["docker", "stop", "--time", "5", "afterclass-try-v0-1-5"]]);
    expect(run.calls.findIndex((c) => c[1] === "stop")).toBeGreaterThan(run.calls.findIndex((c) => c[1] === "logs"));
  });

  test("on a machine that cannot run arm64, runs the release's own files on the Bun base its Dockerfile pins, says so, and removes the image after", () => {
    const run = tryRelease({ arm64: false });
    expect(run.status).toBe(0);
    expect(run.built).toBe(
      [
        `FROM --platform=linux/arm64 ${REPOSITORY}@${DIGEST} AS release`,
        `FROM ${BASE}`,
        "COPY --from=release /app /app",
        "COPY --from=release /data /data",
        'ENV AFTERCLASS_MODE="replay"',
        'ENV AFTERCLASS_PORT="8080"',
        'ENV AFTERCLASS_DATA="/data/db"',
        "WORKDIR /app",
        "USER bun",
        'CMD ["bun","run","src/backend/main.ts"]',
        "",
      ].join("\n"),
    );
    expect(appRun(run)!.at(-1)).toBe("afterclass-try:v0.1.5");
    expect(appRun(run)).toContain("AFTERCLASS_MODE=replay");
    expect(run.stdout).toContain(`the release's /app and /data on the amd64 build of ${BASE}`);
    expect(of(run, "docker", "image").some((c) => c[2] === "rm" && c[3] === "afterclass-try:v0.1.5")).toBe(true);
  });

  const records: [string, string][] = [
    ["a short digest", `commit ${COMMIT}\ndigest sha256:${"b".repeat(63)}\n`],
    ["a tag instead of a digest", `commit ${COMMIT}\ndigest v0.1.5\n`],
    ["a digest that names another registry", `commit ${COMMIT}\ndigest evil.example/x@${DIGEST}\n`],
    ["a second digest line", `commit ${COMMIT}\ndigest ${DIGEST}\ndigest ${digestOf("e")}\n`],
  ];
  for (const [name, record] of records) {
    test(`refuses a record with ${name} and pulls nothing`, () => {
      const run = tryRelease({ record, arm64: true });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("is not a commit line and a digest line");
      expect(of(run, "docker")).toEqual([]);
    });
  }

  test("refuses a tag that is not v<major>.<minor>.<patch> before asking GitHub anything", () => {
    const run = tryRelease({ tag: "v0.1.5;rm" });
    expect(run.status).toBe(2);
    expect(run.calls).toEqual([]);
  });

  test("an app that never answers /health fails, shows its logs and is stopped", () => {
    const run = tryRelease({ arm64: true, healthy: false });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("did not answer /health");
    expect(of(run, "docker", "stop")).toHaveLength(1);
  });
});
