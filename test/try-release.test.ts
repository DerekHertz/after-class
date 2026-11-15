import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestOf, makeHost, offlineEnv, REPOSITORY, stub } from "./beta-host";

const SCRIPT = resolve(import.meta.dir, "../scripts/try-release.sh");
const COMMIT = "c".repeat(40);
const DIGEST = digestOf("b");
const BASE = `oven/bun:1.4.3-slim@sha256:${"1".repeat(64)}`;
const KEY = "sk-live-key-from-the-shell";

interface Opts {
  readonly tag?: string;
  readonly record?: string;
  readonly arm64?: boolean;
  readonly healthy?: boolean;
  /** docker run --detach fails, as it does when the container name is taken. */
  readonly runFails?: boolean;
  /** The digest scripts/release.sh showed and passes as the second argument. */
  readonly expected?: string;
  /** The commit scripts/release.sh showed and passes as the third argument. */
  readonly expectedCommit?: string;
  /** What docker image inspect answers for the release image's Config.WorkingDir, Config.User and Config.Env lines. */
  readonly workdir?: string;
  readonly user?: string;
  readonly env?: readonly string[];
}

const CONTAINER = "0123456789ab".repeat(4);

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Each docker, gh and aws call as its argument vector. */
  readonly calls: string[][];
  readonly built: string;
  /** The --env-file the app container was given, read while docker run stood in for the container. */
  readonly envFile: string;
}

/** A run of the real script with gh, docker, curl, sleep and aws stubbed. The release names DIGEST for COMMIT. */
function setUp(opts: Opts) {
  const host = makeHost("afterclass-try-release-");
  const calls = join(host.root, "calls");
  const log = `{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\n'; } >> ${calls}`;
  writeFileSync(join(host.root, "record"), opts.record ?? `commit ${COMMIT}\ndigest ${DIGEST}\n`);
  writeFileSync(join(host.root, "inspect-env"), (opts.env ?? ["PATH=/usr/bin", "BUN_INSTALL=/x", "AFTERCLASS_MODE=replay", "AFTERCLASS_PORT=8080", "AFTERCLASS_DATA=/data/db"]).join("\n") + "\n");
  writeFileSync(join(host.root, "Dockerfile"), `# comment\nARG BUN_IMAGE=${BASE}\nFROM \${BUN_IMAGE}\n`);
  stub(
    host.bin,
    "gh",
    `${log}
case "$1 $2" in
  "release download") cat ${host.root}/record;;
  "api -H") case "$*" in *contents/Dockerfile?ref=${COMMIT}*) cat ${host.root}/Dockerfile;; *) exit 1;; esac;;
esac`,
  );
  stub(
    host.bin,
    "docker",
    `${log}
case "$1" in
  run) case "$*" in
    *"--entrypoint true"*) exit ${opts.arm64 ? 0 : 1};;
    *--detach*) for a in "$@"; do if [ "$prev" = --env-file ]; then cp "$a" ${host.root}/env-file; fi; prev=$a; done
      ${opts.runFails ? 'echo "Conflict. The container name is already in use" >&2; exit 125' : `echo ${CONTAINER}`};;
  esac;;
  image) case "$*" in
    *"{{range .Config.Env}}"*) cat ${host.root}/inspect-env;;
    *"{{.Config.WorkingDir}}"*) printf '%s\\n' ${JSON.stringify(opts.workdir ?? "/app")};;
    *"{{.Config.User}}"*) printf '%s\\n' ${JSON.stringify(opts.user ?? "bun")};;
    *"{{range .Config.Cmd}}"*) printf 'bun\\0run\\0src/backend/main.ts\\0';;
  esac;;
  build) for last; do :; done; cp "$last/Dockerfile" ${host.root}/built;;
esac
exit 0`,
  );
  stub(host.bin, "curl", opts.healthy === false ? "exit 7" : "exit 0");
  stub(host.bin, "sleep", "exit 0");
  stub(host.bin, "aws", log);
  const command = ["bash", SCRIPT, opts.tag ?? "v0.1.5", ...(opts.expected === undefined ? [] : [opts.expected]), ...(opts.expectedCommit === undefined ? [] : [opts.expectedCommit])];
  const env = offlineEnv(host.bin, { ANTHROPIC_API_KEY: KEY, TYPESAFE_API_KEY: KEY });
  const finish = (status: number, stdout: string, stderr: string): Run => ({
    status,
    stdout,
    stderr,
    calls: readCalls(calls),
    built: existsSync(join(host.root, "built")) ? readFileSync(join(host.root, "built"), "utf8") : "",
    envFile: existsSync(join(host.root, "env-file")) ? readFileSync(join(host.root, "env-file"), "utf8") : "",
  });
  return { command, env, calls, finish };
}

function readCalls(path: string): string[][] {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0").filter(Boolean));
}

function tryRelease(opts: Opts = {}): Run {
  const { command, env, finish } = setUp(opts);
  const result = Bun.spawnSync(command, { env });
  return finish(result.exitCode, result.stdout.toString(), result.stderr.toString());
}

const of = (run: Run, command: string, sub?: string): string[][] => run.calls.filter((c) => c[0] === command && (sub === undefined || c[1] === sub));
const appRun = (run: Run): string[] | undefined => of(run, "docker", "run").find((c) => c.includes("--detach"));

describe("scripts/try-release.sh", () => {
  test("runs the release's exact digest in replay mode on 127.0.0.1, prints the URL, and never calls AWS", () => {
    const run = tryRelease({ arm64: true });
    expect(run.status).toBe(0);
    expect(of(run, "docker", "pull")).toEqual([["docker", "pull", "--quiet", "--platform", "linux/arm64", `${REPOSITORY}@${DIGEST}`]]);
    const app = appRun(run)!;
    expect(app.at(-1)).toBe(`${REPOSITORY}@${DIGEST}`);
    expect(app).toContain("AFTERCLASS_MODE=replay");
    expect(app.join(" ")).toContain("--publish 127.0.0.1:8790:8790");
    expect(run.stdout).toContain(`v0.1.5, commit ${COMMIT}`);
    expect(run.stdout).toContain("http://127.0.0.1:8790/app/");
    expect(of(run, "aws")).toEqual([]);
  });

  test("runs the digest it was given when the release still names it", () => {
    const run = tryRelease({ arm64: true, expected: DIGEST });
    expect(run.status).toBe(0);
    expect(appRun(run)!.at(-1)).toBe(`${REPOSITORY}@${DIGEST}`);
  });

  test("refuses, and pulls and runs nothing, when the release now names another digest than the one it was given", () => {
    const run = tryRelease({ arm64: true, expected: digestOf("a") });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`now names ${DIGEST}, not the ${digestOf("a")} shown before`);
    expect(of(run, "docker")).toEqual([]);
  });

  test("refuses, and pulls and runs nothing, when the release now records another commit with the same digest", () => {
    const shown = "e".repeat(40);
    const run = tryRelease({ arm64: true, expected: DIGEST, expectedCommit: shown });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`the v0.1.5 release now records commit ${COMMIT}, not the ${shown} shown before. Nothing ran.`);
    expect(of(run, "docker")).toEqual([]);
  });

  test("passes no keys, key file or host folder into the container", () => {
    const app = appRun(tryRelease({ arm64: true }))!.join(" ");
    expect(app).not.toContain(KEY);
    for (const flag of ["--env-file", "--volume", "-v ", "--mount", "--network host"]) expect(app).not.toContain(flag);
  });

  test("stops the container it started, by the ID docker run printed, when it exits", () => {
    const run = tryRelease({ arm64: true });
    expect(of(run, "docker", "stop")).toEqual([["docker", "stop", "--time", "5", CONTAINER]]);
  });

  test("keeps the container running until Enter, then stops it", async () => {
    const { command, env, calls } = setUp({ arm64: true });
    const child = Bun.spawn(command, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("/app/")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("http://127.0.0.1:8790/app/");
    await Bun.sleep(200);
    expect(child.exitCode).toBeNull();
    expect(readCalls(calls).filter((c) => c[1] === "stop")).toEqual([]);
    child.stdin.write("\n");
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(readCalls(calls).filter((c) => c[1] === "stop")).toEqual([["docker", "stop", "--time", "5", CONTAINER]]);
  });

  test("names each run's container uniquely, so a second run of the same tag never collides with the first", () => {
    const name = (run: Run) => appRun(run)![appRun(run)!.indexOf("--name") + 1]!;
    const [first, second] = [name(tryRelease({ arm64: true })), name(tryRelease({ arm64: true }))];
    expect(first).toMatch(/^afterclass-try-v0-1-5-[0-9a-f]{8}$/);
    expect(second).not.toBe(first);
  });

  test("a docker run that fails stops no container and removes only the image this run built", () => {
    const run = tryRelease({ arm64: false, runFails: true });
    expect(run.status).not.toBe(0);
    expect(of(run, "docker", "stop")).toEqual([]);
    const built = of(run, "docker", "build")[0]!;
    const tag = built[built.indexOf("--tag") + 1]!;
    expect(of(run, "docker", "image").filter((c) => c[2] === "rm")).toEqual([["docker", "image", "rm", tag]]);
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
        "",
      ].join("\n"),
    );
    const app = appRun(run)!;
    const image = app.at(-4)!;
    expect(image).toMatch(/^afterclass-try:v0\.1\.5-[0-9a-f]{8}$/);
    expect(app).toContain("AFTERCLASS_MODE=replay");
    expect(app).toContain("--workdir=/app");
    expect(app).toContain("--user=bun");
    expect(app.slice(-3)).toEqual(["bun", "run", "src/backend/main.ts"]);
    expect(run.stdout).toContain(`the release's /app and /data on the amd64 build of ${BASE}`);
    expect(run.stderr).toContain("WARNING this machine cannot run arm64 images");
    expect(of(run, "docker", "image").some((c) => c[2] === "rm" && c[3] === image)).toBe(true);
  });

  const records: [string, string][] = [
    ["a short digest", `commit ${COMMIT}\ndigest sha256:${"b".repeat(63)}\n`],
    ["a tag instead of a digest", `commit ${COMMIT}\ndigest v0.1.5\n`],
    ["a digest that names another registry", `commit ${COMMIT}\ndigest evil.example/x@${DIGEST}\n`],
    ["a second digest line", `commit ${COMMIT}\ndigest ${DIGEST}\ndigest ${digestOf("e")}\n`],
    ["a NUL inside the digest, which a shell would drop", `commit ${COMMIT}\ndigest sha\u0000256:${"b".repeat(64)}\n`],
  ];
  for (const [name, record] of records) {
    test(`refuses a record with ${name} and pulls nothing`, () => {
      const run = tryRelease({ record, arm64: true });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("image-digest.txt is not in its format");
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

  describe("release image metadata on an amd64 machine", () => {
    const refusal = (run: Run): void => {
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("refusing");
      expect(run.stdout).not.toContain("only the Bun binary differs");
      expect(run.built).toBe("");
      expect(appRun(run)).toBeUndefined();
    };

    test("a working directory that carries a newline and a RUN instruction is refused, and nothing is built or run", () => {
      refusal(tryRelease({ workdir: "/app\nRUN touch /pwned" }));
    });

    test("a user that carries a newline and a RUN instruction is refused, and nothing is built or run", () => {
      refusal(tryRelease({ user: "bun\nRUN touch /pwned" }));
    });

    test("an AFTERCLASS_ value with a quote, a dollar sign and a backslash cannot add an ENV instruction, and its bytes reach the container unchanged", () => {
      const run = tryRelease({ env: ["AFTERCLASS_MODE=replay", 'AFTERCLASS_NOTE=a"b $HOME \\ c'] });
      expect(run.status).toBe(0);
      expect(run.built).toBe(
        [`FROM --platform=linux/arm64 ${REPOSITORY}@${DIGEST} AS release`, `FROM ${BASE}`, "COPY --from=release /app /app", "COPY --from=release /data /data", ""].join("\n"),
      );
      expect(run.envFile).toBe('AFTERCLASS_MODE=replay\nAFTERCLASS_NOTE=a"b $HOME \\ c\n');
    });

    test("an AFTERCLASS_ value with a control character is refused", () => {
      refusal(tryRelease({ env: ["AFTERCLASS_NOTE=x\ty"] }));
    });
  });
});
