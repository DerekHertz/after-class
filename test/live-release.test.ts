import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestOf, makeHost, offlineEnv, probeOutput, stub } from "./beta-host";
import { PROBE } from "../scripts/release-input";
import type { ServerRead } from "../scripts/release-input";
import { resolveLive } from "../scripts/live-release";

const SCRIPT = resolve(import.meta.dir, "../scripts/live-release.ts");
const COMMIT = "c".repeat(40);
const RUNNING = digestOf("a");
const COMMAND = "11111111-2222-3333-4444-555555555555";

describe("resolveLive", () => {
  const tags = ["v0.1.3", "v0.1.4", "v0.1.5"];
  const records: Record<string, string> = { "v0.1.3": digestOf("3"), "v0.1.4": RUNNING, "v0.1.5": digestOf("5") };
  const digestOf_ = (tag: string) => records[tag] ?? null;
  const read = (health: ServerRead["health"], digest: string | null = RUNNING): ServerRead => ({ digest, health });

  test("is the tag of the version the server's /health reports", () => {
    expect(resolveLive(read({ kind: "valid", version: "0.1.5" }, digestOf("5")), tags, digestOf_)).toEqual({ ok: true, tag: "v0.1.5", digest: digestOf("5") });
  });

  test("without a version, as up to v0.1.4, is the release whose image-digest.txt names the recorded digest", () => {
    expect(resolveLive(read({ kind: "valid", version: null }), tags, digestOf_)).toEqual({ ok: true, tag: "v0.1.4", digest: RUNNING });
  });

  const failures: [string, ServerRead, string][] = [
    ["an app that does not answer", read({ kind: "unreachable", detail: "curl exited 7" }), "did not answer its /health (curl exited 7)"],
    ["an answer that is not the app's", read({ kind: "invalid", detail: "not JSON" }), "answered /health with something else (not JSON)"],
    ["no recorded digest", read({ kind: "valid", version: "0.1.5" }, null), "no image digest"],
    ["a version no tag names", read({ kind: "valid", version: "0.1.9" }), "reports version 0.1.9, which no release tag names"],
    ["a digest no release names", read({ kind: "valid", version: null }, digestOf("9")), `runs ${digestOf("9")}, which no release's image-digest.txt names`],
  ];
  for (const [name, server, reason] of failures) {
    test(`gives no answer, not a guess, for ${name}`, () => {
      const live = resolveLive(server, tags, digestOf_);
      expect(live.ok).toBe(false);
      expect(!live.ok && live.reason).toContain(reason);
    });
  }
});

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: string[][];
}

interface CliOpts {
  readonly probe?: string | Buffer;
  /** The bytes each tag's image-digest.txt holds. A tag not named here records RUNNING for v0.1.4 and another digest otherwise. */
  readonly records?: Record<string, string | Buffer>;
  readonly publicBody?: string | Buffer;
  readonly publicExit?: number;
  readonly awsStall?: boolean;
  readonly ghStall?: boolean;
  readonly deadlineMs?: number;
}

/** The real CLI with aws, gh, git and curl stubbed. Each stub serves its answer from a file, byte for byte. */
function cli(args: string[], opts: CliOpts = {}): Run {
  const host = makeHost("afterclass-live-release-");
  const calls = join(host.root, "calls");
  const log = `{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\n'; } >> ${calls}`;
  writeFileSync(join(host.root, "probe"), opts.probe ?? probeOutput(`${RUNNING}\n`, '{"ok":true}'));
  const records = join(host.root, "records");
  mkdirSync(records);
  const served: Record<string, string | Buffer> = { "v0.1.3": `commit ${COMMIT}\ndigest ${digestOf("0")}\n`, "v0.1.4": `commit ${COMMIT}\ndigest ${RUNNING}\n`, ...opts.records };
  for (const [tag, bytes] of Object.entries(served)) writeFileSync(join(records, tag), bytes);
  writeFileSync(join(host.root, "public"), opts.publicBody ?? '{"ok":true,"version":"0.1.4"}');
  stub(
    host.bin,
    "aws",
    `${log}
${opts.awsStall ? "exec sleep 30" : ""}
case "$1 $2" in
  "ssm get-parameter") echo i-0123456789abcdef0;;
  "ssm send-command") echo ${COMMAND};;
  "ssm wait") exit 0;;
  "ssm get-command-invocation") cat ${host.root}/probe;;
  *) exit 1;;
esac`,
  );
  stub(host.bin, "git", `${log}\nprintf '%s\\n' v0.1.3 v0.1.4 latest`);
  stub(host.bin, "gh", `${log}\n${opts.ghStall ? "exec sleep 30" : ""}\n[ -e ${records}/$3 ] || { echo 'no assets match the file pattern' >&2; exit 1; }\ncat ${records}/$3`);
  stub(host.bin, "curl", `${log}\ncat ${host.root}/public\nexit ${opts.publicExit ?? 0}`);
  const env = offlineEnv(host.bin, opts.deadlineMs === undefined ? {} : { LIVE_RELEASE_DEADLINE_MS: String(opts.deadlineMs) });
  const result = Bun.spawnSync(["bun", SCRIPT, ...args], { env });
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

describe("bun scripts/live-release.ts", () => {
  test("server prints the tag and digest the server runs, read through Systems Manager on the beta's instance", () => {
    const run = cli(["server"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`v0.1.4 ${RUNNING}\n`);
    const send = run.calls.find((c) => c[0] === "aws" && c[2] === "send-command")!;
    expect(send).toContain("AWS-RunShellScript");
    expect(send).toContain("i-0123456789abcdef0");
    expect(JSON.parse(send[send.indexOf("--parameters") + 1]!).commands).toEqual(PROBE);
    expect(run.calls.some((c) => c[0] === "curl")).toBe(false);
  });

  test("server fails, saying why, when the app on the server answers with something else", () => {
    const run = cli(["server"], { probe: probeOutput(`${RUNNING}\n`, "<html>blocked</html>") });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("cannot tell which release the server runs: the app on the server answered /health with something else");
  });

  test("public prints the version useafterclass.com reports to this machine", () => {
    const run = cli(["public"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("v0.1.4\n");
    expect(run.calls.filter((c) => c[0] === "curl").map((c) => c.at(-1))).toEqual(["https://useafterclass.com/health"]);
  });

  test("public tells a blocked site apart from a page that is not the app's", () => {
    const blocked = cli(["public"], { publicExit: 60, publicBody: "" });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("cannot reach it (curl exited 60");
    const page = cli(["public"], { publicBody: '<html>Blocked. Diagnostics: {"version":"0.1.2"}</html>' });
    expect(page.status).toBe(1);
    expect(page.stdout).toBe("");
    expect(page.stderr).toContain("it answered with something other than the app (the /health answer is not in its format");
  });

  test("server stops with 'could not read the server' when aws stalls past the one deadline, which the output states", () => {
    const start = Date.now();
    const run = cli(["server"], { awsStall: true, deadlineMs: 1500 });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("could not read the server");
    expect(run.stderr).toContain("120 s deadline");
  });

  test("the same deadline covers the digest-to-tag lookup", () => {
    const start = Date.now();
    const run = cli(["server"], { probe: probeOutput(`${RUNNING}\n`, '{"ok":true}'), ghStall: true, deadlineMs: 1500 });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("could not read the server");
  });

  test("server fails on a /health body with a NUL in it, which a shell would have dropped", () => {
    const run = cli(["server"], { probe: probeOutput(`${RUNNING}\n`, Buffer.from('{"ok":tru\u0000e,"version":"0.1.4"}')) });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("answered /health with something else");
  });
  const legacyRecords: [string, Buffer][] = [
    ["a byte order mark before it", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`commit ${COMMIT}\ndigest ${RUNNING}\n`)])],
    ["a vertical tab before it and a form feed after it", Buffer.from(`\vcommit ${COMMIT}\ndigest ${RUNNING}\n\f`)],
    ["a CR in place of its last LF", Buffer.from(`commit ${COMMIT}\ndigest ${RUNNING}\r`)],
  ];
  for (const [name, record] of legacyRecords) {
    test(`server gives no base when a /health without a version leads to a record with ${name}`, () => {
      const run = cli(["server"], { records: { "v0.1.4": record } });
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain(`cannot tell which release the server runs: the server runs ${RUNNING}, which no release's image-digest.txt names`);
    });
  }

  test("public refuses a /health wrapped in byte order marks", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const run = cli(["public"], { publicBody: Buffer.concat([bom, Buffer.from('{"ok":true,"version":"0.1.4"}'), bom]) });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("it answered with something other than the app");
  });

  test("record prints the commit and digest from a tag's image-digest.txt", () => {
    const run = cli(["record", "v0.1.4"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${COMMIT} ${RUNNING}\n`);
    expect(run.calls).toEqual([["gh", "release", "download", "v0.1.4", "--repo", "DerekHertz/after-class", "--pattern", "image-digest.txt", "--output", "-"]]);
  });

  test("record refuses a record with a NUL in it, which a shell's command substitution would have dropped", () => {
    const run = cli(["record", "v0.1.4"], { records: { "v0.1.4": Buffer.from(`commit ${COMMIT}\ndigest sha\u0000256:${"a".repeat(64)}\n`) } });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("the v0.1.4 release's image-digest.txt is not in its format");
    expect(run.stderr).toContain("sha\\x00256");
  });

  test("record says a release has no image-digest.txt when gh finds none", () => {
    const run = cli(["record", "v0.1.9"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("the v0.1.9 release has no image-digest.txt");
  });

});
