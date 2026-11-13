import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readKeys } from "../src/backend/main";
import { type Host, installScript, makeHost, readLog, stub } from "./beta-host";

const PREFIX = "/afterclass/beta";
const JEV = "jev-live-0123456789-secret";
const ANTHROPIC = "sk-ant-api03-abcdefghij-secret";
const uid = process.getuid!();
const gid = process.getgid!();

interface KeysHost extends Host {
  readonly runtime: string;
  readonly script: string;
}

/**
 * One server with a stubbed `aws` that answers `ssm get-parameter --name <name>` from `parameters`, the way the CLI
 * does: the value on stdout, or ParameterNotFound on stderr and exit 254. `findmnt` reports `fstype` for the runtime folder.
 */
function keysHost(parameters: Record<string, string>, fstype = "tmpfs"): KeysHost {
  const host = makeHost("afterclass-keys-test-");
  const store = join(host.root, "parameters");
  mkdirSync(store);
  for (const [name, value] of Object.entries(parameters)) writeFileSync(join(store, name.replaceAll("/", "_")), value);
  writeFileSync(join(host.root, "settings.env"), `AWS_REGION=us-east-2\nKEY_PARAMETER_PREFIX=${PREFIX}\n`);
  stub(
    host.bin,
    "aws",
    `echo "aws $*" >> ${host.log}
for arg; do [ "$prev" = --name ] && name=$arg; prev=$arg; done
file="${store}/$(echo "$name" | tr / _)"
[ -f "$file" ] || { echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: " >&2; exit 254; }
cat "$file"; echo`,
  );
  stub(host.bin, "findmnt", `echo ${fstype}`);
  const runtime = join(host.root, "run/afterclass-app");
  const script = installScript(host, "afterclass-fetch-keys", { "/run/afterclass-app": runtime });
  return { ...host, runtime, script };
}

const both = { [`${PREFIX}/TYPESAFE_API_KEY`]: JEV, [`${PREFIX}/AFTERCLASS_ANTHROPIC_API_KEY`]: ANTHROPIC };

function fetchKeys(host: KeysHost, shell: string[] = ["bash"], owner: [number, number] = [uid, gid]): { status: number; output: string } {
  const result = Bun.spawnSync([...shell, host.script, String(owner[0]), String(owner[1])], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } });
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

describe("afterclass-fetch-keys", () => {
  test("writes both keys to keys.env, mode 0600 and owned by the app's user, in a 0700 folder the app reads", () => {
    const host = keysHost(both);
    const run = fetchKeys(host);
    expect(run.status).toBe(0);
    const file = join(host.runtime, "keys.env");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(file).uid).toBe(uid);
    expect(statSync(host.runtime).mode & 0o777).toBe(0o700);
    expect(readdirSync(host.runtime)).toEqual(["keys.env"]);
    expect(readKeys(file)).toEqual({ TYPESAFE_API_KEY: JEV, AFTERCLASS_ANTHROPIC_API_KEY: ANTHROPIC });
    expect(readLog(host).every((line) => line.includes("--with-decryption"))).toBe(true);
  });

  test("hands the folder and keys.env to the uid and gid it is given, the container's user", () => {
    const host = keysHost(both);
    stub(host.bin, "chown", `echo "chown $*" >> ${host.log}`);
    expect(fetchKeys(host, ["bash"], [4321, 8765]).status).toBe(0);
    const chowns = readLog(host).filter((line) => line.startsWith("chown 4321:8765 "));
    expect(chowns.flatMap((line) => line.split(" ").slice(2))).toContain(host.runtime);
    expect(chowns.join(" ")).toContain(join(host.runtime, "keys.env."));
  });

  test("prints no value, even when run under bash -x", () => {
    for (const shell of [["bash"], ["bash", "-x"]]) {
      const run = fetchKeys(keysHost(both), shell);
      expect(run.status).toBe(0);
      expect(run.output).not.toContain(JEV);
      expect(run.output).not.toContain(ANTHROPIC);
    }
  });

  test("a missing parameter fails closed: no keys.env, no partial file, the parameter named, no value printed", () => {
    const host = keysHost({ [`${PREFIX}/TYPESAFE_API_KEY`]: JEV });
    const run = fetchKeys(host);
    expect(run.status).toBe(1);
    expect(run.output).toContain(`cannot read ${PREFIX}/AFTERCLASS_ANTHROPIC_API_KEY`);
    expect(run.output).not.toContain(JEV);
    expect(readdirSync(host.runtime)).toEqual([]);
  });

  test("an empty value fails closed rather than starting the app without a key", () => {
    const host = keysHost({ ...both, [`${PREFIX}/TYPESAFE_API_KEY`]: "" });
    expect(fetchKeys(host).status).toBe(1);
    expect(existsSync(join(host.runtime, "keys.env"))).toBe(false);
  });

  test("a runtime folder that is not on tmpfs is refused before any key is read", () => {
    const host = keysHost(both, "xfs");
    const run = fetchKeys(host);
    expect(run.status).toBe(1);
    expect(run.output).toContain("not tmpfs");
    expect(readLog(host).some((line) => line.startsWith("aws "))).toBe(false);
    expect(existsSync(join(host.runtime, "keys.env"))).toBe(false);
  });

  test("each start reads the parameters again, so a rotated key reaches the next start", () => {
    const host = keysHost(both);
    expect(fetchKeys(host).status).toBe(0);
    writeFileSync(join(host.root, "parameters", `${PREFIX}/TYPESAFE_API_KEY`.replaceAll("/", "_")), "jev-rotated");
    expect(fetchKeys(host).status).toBe(0);
    expect(readFileSync(join(host.runtime, "keys.env"), "utf8")).toContain("TYPESAFE_API_KEY=jev-rotated\n");
  });
});

describe("afterclass-app-start", () => {
  function start(fetchFails: boolean): { status: number; log: string[] } {
    const host = makeHost("afterclass-start-test-");
    writeFileSync(join(host.root, "settings.env"), "APP_PORT=8080\nAWS_REGION=us-east-2\nECR_REGISTRY=registry.test\nECR_REPOSITORY=afterclass-api\nLOG_GROUP=/afterclass-beta\n");
    writeFileSync(join(host.root, "data/afterclass/current-tag"), `${"b".repeat(40)}\n`);
    stub(host.bin, "docker", `echo "docker $*" >> ${host.log}\n[ "$3" = --entrypoint ] && echo 1000\nexit 0`);
    stub(host.bin, "chown", "exit 0");
    stub(host.root, "afterclass-pull", "exit 0");
    stub(host.root, "afterclass-fetch-keys", `echo "fetch-keys $*" >> ${host.log}\nexit ${fetchFails ? 1 : 0}`);
    const result = Bun.spawnSync(["bash", installScript(host, "afterclass-app-start")], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } });
    return { status: result.exitCode, log: readLog(host) };
  }

  const appRun = (log: string[]) => log.find((line) => line.startsWith("docker run") && line.includes("--name afterclass-app"));

  test("fetches the keys for the image's user, then mounts them read-only where the app reads its config", () => {
    const run = start(false);
    expect(run.status).toBe(0);
    expect(run.log).toContain("fetch-keys 1000 1000");
    expect(run.log.indexOf("fetch-keys 1000 1000")).toBeLessThan(run.log.indexOf(appRun(run.log)!));
    expect(appRun(run.log)).toContain("-v /run/afterclass-app:/data/config:ro");
    expect(appRun(run.log)).not.toContain("-v /data/config");
  });

  test("a failed key fetch never starts the container", () => {
    const run = start(true);
    expect(run.status).not.toBe(0);
    expect(appRun(run.log)).toBeUndefined();
  });
});
