import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestOf, makeHost, stub } from "./beta-host";
import { parseHealth, parseProbe, PROBE, resolveLive } from "../scripts/live-release";
import type { ServerRead } from "../scripts/live-release";

const SCRIPT = resolve(import.meta.dir, "../scripts/live-release.ts");
const COMMIT = "c".repeat(40);
const RUNNING = digestOf("a");
const COMMAND = "11111111-2222-3333-4444-555555555555";

describe("parseHealth", () => {
  test("is valid for the app's answer, with or without a version", () => {
    expect(parseHealth('{"ok":true,"version":"0.1.5"}')).toEqual({ kind: "valid", version: "0.1.5" });
    expect(parseHealth('{"ok":true}')).toEqual({ kind: "valid", version: null });
  });

  const invalid: [string, string][] = [
    ["a filter's HTML page", "<html>Access blocked by network policy</html>"],
    ["a filter's page that quotes a version", '<html>Blocked. Diagnostics: {"version":"0.1.2"}</html>'],
    ["ok false", '{"ok":false,"version":"0.1.5"}'],
    ["no ok", '{"version":"0.1.5"}'],
    ["an array", '[{"ok":true}]'],
    ["a version that is not a release", '{"ok":true,"version":"0.1.5-rc1"}'],
    ["a version with a v", '{"ok":true,"version":"v0.1.5"}'],
    ["a number version", '{"ok":true,"version":5}'],
    ["another field", '{"ok":true,"version":"0.1.5","error":"x"}'],
    ["nothing", ""],
  ];
  for (const [name, body] of invalid) {
    test(`is invalid for ${name}`, () => {
      expect(parseHealth(body).kind).toBe("invalid");
    });
  }

  test("quotes the answer, so a page cannot write control characters to the terminal", () => {
    const health = parseHealth("<html>\u001b[2J</html>");
    expect(health.kind === "invalid" && health.detail).toContain("\\u001b[2J");
  });
});

describe("parseProbe", () => {
  test("reads the recorded digest and the health body", () => {
    expect(parseProbe(`image ${RUNNING}\nhealth {"ok":true,"version":"0.1.5"}`)).toEqual({
      digest: RUNNING,
      health: { kind: "valid", version: "0.1.5" },
    });
  });

  test("tells an app that did not answer apart from one that answered something else", () => {
    expect(parseProbe(`image ${RUNNING}\nunreachable curl exited 7`).health).toEqual({ kind: "unreachable", detail: "curl exited 7" });
    expect(parseProbe(`image ${RUNNING}\nhealth <html>\nblocked</html>`).health.kind).toBe("invalid");
  });

  test("has no digest when the file is missing or holds something else, and is invalid when the output is not the probe's", () => {
    expect(parseProbe('image \nhealth {"ok":true}').digest).toBeNull();
    expect(parseProbe('image ghcr.io/x:latest\nhealth {"ok":true}').digest).toBeNull();
    expect(parseProbe("something else").health.kind).toBe("invalid");
  });

  test("the probe's own commands print what parseProbe reads, on a server's paths", () => {
    const host = makeHost("afterclass-live-probe-");
    writeFileSync(join(host.root, "data/afterclass/current-image"), `${RUNNING}\n`);
    stub(host.bin, "curl", `case "$*" in *"http://127.0.0.1:8080/health"*) printf '{"ok":true,"version":"0.1.5"}';; *) exit 7;; esac`);
    const script = PROBE.join("\n")
      .replaceAll("/etc/afterclass/settings.env", join(host.root, "settings.env"))
      .replaceAll("/data/afterclass", join(host.root, "data/afterclass"));
    const sh = (path: string) => Bun.spawnSync(["sh", "-c", script], { env: { ...process.env, PATH: path } }).stdout.toString();
    expect(parseProbe(sh(`${host.bin}:${process.env.PATH}`))).toEqual({ digest: RUNNING, health: { kind: "valid", version: "0.1.5" } });
    stub(host.bin, "curl", "exit 7");
    expect(parseProbe(sh(`${host.bin}:${process.env.PATH}`)).health).toEqual({ kind: "unreachable", detail: "curl exited 7" });
  });
});

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

/** The real CLI with aws, gh, git and curl stubbed. The stubbed server answers `probe`, and every release names RUNNING. */
function cli(mode: string, opts: { probe?: string; publicBody?: string; publicExit?: number } = {}): Run {
  const host = makeHost("afterclass-live-release-");
  const calls = join(host.root, "calls");
  const log = `{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\n'; } >> ${calls}`;
  writeFileSync(join(host.root, "probe"), opts.probe ?? `image ${RUNNING}\nhealth {"ok":true}\n`);
  stub(
    host.bin,
    "aws",
    `${log}
case "$1 $2" in
  "ssm get-parameter") echo i-0123456789abcdef0;;
  "ssm send-command") echo ${COMMAND};;
  "ssm wait") exit 0;;
  "ssm get-command-invocation") cat ${host.root}/probe;;
  *) exit 1;;
esac`,
  );
  stub(host.bin, "git", `${log}\nprintf '%s\\n' v0.1.3 v0.1.4 latest`);
  stub(host.bin, "gh", `${log}\ncase "$3" in v0.1.4) printf 'commit ${COMMIT}\\ndigest ${RUNNING}\\n';; *) printf 'commit ${COMMIT}\\ndigest ${digestOf("0")}\\n';; esac`);
  stub(host.bin, "curl", `${log}\nprintf '%s' '${opts.publicBody ?? '{"ok":true,"version":"0.1.4"}'}'\nexit ${opts.publicExit ?? 0}`);
  const result = Bun.spawnSync(["bun", SCRIPT, mode], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } });
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
    const run = cli("server");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`v0.1.4 ${RUNNING}\n`);
    const send = run.calls.find((c) => c[0] === "aws" && c[2] === "send-command")!;
    expect(send).toContain("AWS-RunShellScript");
    expect(send).toContain("i-0123456789abcdef0");
    expect(JSON.parse(send[send.indexOf("--parameters") + 1]!).commands).toEqual(PROBE);
    expect(run.calls.some((c) => c[0] === "curl")).toBe(false);
  });

  test("server fails, saying why, when the app on the server answers with something else", () => {
    const run = cli("server", { probe: `image ${RUNNING}\nhealth <html>blocked</html>\n` });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("cannot tell which release the server runs: the app on the server answered /health with something else");
  });

  test("public prints the version useafterclass.com reports to this machine", () => {
    const run = cli("public");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("v0.1.4\n");
    expect(run.calls.filter((c) => c[0] === "curl").map((c) => c.at(-1))).toEqual(["https://useafterclass.com/health"]);
  });

  test("public tells a blocked site apart from a page that is not the app's", () => {
    const blocked = cli("public", { publicExit: 60, publicBody: "" });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("cannot reach it (curl exited 60");
    const page = cli("public", { publicBody: '<html>Blocked. Diagnostics: {"version":"0.1.2"}</html>' });
    expect(page.status).toBe(1);
    expect(page.stdout).toBe("");
    expect(page.stderr).toContain("it answered with something other than the app (not JSON");
  });
});
