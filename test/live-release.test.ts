import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestOf, makeHost, stub } from "./beta-host";
import { MAX_BYTES, parseHealth, parseProbe, PROBE, resolveLive } from "../scripts/live-release";
import type { ServerRead } from "../scripts/live-release";

const SCRIPT = resolve(import.meta.dir, "../scripts/live-release.ts");
const COMMIT = "c".repeat(40);
const RUNNING = digestOf("a");
const COMMAND = "11111111-2222-3333-4444-555555555555";

const b64 = (data: string | Buffer): string => Buffer.from(data).toString("base64");
/** What the server's PROBE prints for a recorded digest file and a /health body, byte for byte. */
const probeOutput = (image: string | Buffer | null, health: string | Buffer | { unreachable: number }): string => {
  const file = image === null ? "image missing" : `image ${Buffer.from(image).length} ${b64(image)}`;
  if (typeof health === "object" && !Buffer.isBuffer(health)) return `${file}\nunreachable curl exited ${health.unreachable}\n`;
  return `${file}\nhealth ${Buffer.from(health as string | Buffer).length} ${b64(health as string | Buffer)}\n`;
};

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

  test("quotes an unexpected field's name too", () => {
    const health = parseHealth('{"ok":true,"\\u001b[2J":1}');
    expect(health.kind).toBe("invalid");
    const detail = health.kind === "invalid" ? health.detail : "";
    expect(detail).toContain("unexpected field");
    expect(detail).toContain("\\u001b[2J");
    expect([...detail].some((c) => c.charCodeAt(0) < 32)).toBe(false);
  });
});

describe("parseProbe", () => {
  test("reads the recorded digest and the health body", () => {
    expect(parseProbe(probeOutput(`${RUNNING}\n`, '{"ok":true,"version":"0.1.5"}'))).toEqual({
      digest: RUNNING,
      health: { kind: "valid", version: "0.1.5" },
    });
  });

  test("tells an app that did not answer apart from one that answered something else", () => {
    expect(parseProbe(probeOutput(RUNNING, { unreachable: 7 })).health).toEqual({ kind: "unreachable", detail: "curl exited 7" });
    expect(parseProbe(probeOutput(RUNNING, "<html>\nblocked</html>")).health.kind).toBe("invalid");
  });

  test("has no digest when the file is missing or holds something else, and is invalid when the output is not the probe's", () => {
    expect(parseProbe(probeOutput(null, '{"ok":true}')).digest).toBeNull();
    expect(parseProbe(probeOutput("", '{"ok":true}')).digest).toBeNull();
    expect(parseProbe(probeOutput("ghcr.io/x:latest", '{"ok":true}')).digest).toBeNull();
    expect(parseProbe("something else").health.kind).toBe("invalid");
  });

  test("rejects content that is not exactly what the server counted, instead of reading what is left", () => {
    const body = b64('{"ok":true}');
    expect(parseProbe(`image missing\nhealth 5 ${body}\n`).health.kind).toBe("invalid");
    expect(parseProbe(`image missing\nhealth 11 ${body.slice(0, -4)}\n`).health.kind).toBe("invalid");
    expect(parseProbe(`image missing\nhealth 11 ${body}!\n`).health.kind).toBe("invalid");
    expect(parseProbe(`image 71 ${b64(RUNNING.slice(0, 40))}\nhealth 11 ${body}\n`).digest).toBeNull();
  });

  test("rejects a NUL or another control byte in the health body or the digest file", () => {
    expect(parseProbe(probeOutput(RUNNING, Buffer.from('{"ok":tru\u0000e,"version":"0.1.0"}'))).health.kind).toBe("invalid");
    expect(parseProbe(probeOutput(RUNNING, '{"ok":true}\u001b[2J')).health).toEqual({ kind: "invalid", detail: "the health answer holds a control byte" });
    expect(parseProbe(probeOutput(RUNNING, Buffer.from('{"ok":tru\u0000e}'))).health).toEqual({ kind: "invalid", detail: "the health answer holds a control byte" });
    expect(parseProbe(probeOutput(`${RUNNING}\u0000`, '{"ok":true}')).digest).toBeNull();
    expect(parseProbe(probeOutput(`${RUNNING}\n${"x".repeat(200)}`, '{"ok":true}')).digest).toBeNull();
  });

  test("rejects a body or file over the size cap before parsing it", () => {
    const big = `{"ok":true,"pad":"${"x".repeat(MAX_BYTES)}"}`;
    expect(parseProbe(probeOutput(RUNNING, big)).health).toEqual({ kind: "invalid", detail: `the health answer is longer than ${MAX_BYTES} bytes` });
    expect(parseProbe(probeOutput("a".repeat(MAX_BYTES + 1), '{"ok":true}')).digest).toBeNull();
  });

  /** The probe's own commands on a server's paths, with files and a curl body of exactly these bytes. */
  function onServer(files: { image?: string | Buffer; health: string | Buffer | number }): string {
    const host = makeHost("afterclass-live-probe-");
    if (files.image !== undefined) writeFileSync(join(host.root, "data/afterclass/current-image"), files.image);
    const body = join(host.root, "body");
    if (typeof files.health !== "number") writeFileSync(body, files.health);
    const answer = typeof files.health === "number" ? `exit ${files.health}` : `cat ${body} > "$out"`;
    stub(host.bin, "curl", `out=; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n${answer}`);
    const script = PROBE.join("\n")
      .replaceAll("/etc/afterclass/settings.env", join(host.root, "settings.env"))
      .replaceAll("/data/afterclass", join(host.root, "data/afterclass"));
    return Bun.spawnSync(["sh", "-c", script], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } }).stdout.toString();
  }

  test("the probe's own commands print what parseProbe reads, on a server's paths", () => {
    expect(parseProbe(onServer({ image: `${RUNNING}\n`, health: '{"ok":true,"version":"0.1.5"}' }))).toEqual({ digest: RUNNING, health: { kind: "valid", version: "0.1.5" } });
    expect(parseProbe(onServer({ image: `${RUNNING}\n`, health: 7 })).health).toEqual({ kind: "unreachable", detail: "curl exited 7" });
    expect(parseProbe(onServer({ health: '{"ok":true}' })).digest).toBeNull();
  });

  test("the probe's own commands carry a NUL, trailing garbage and an oversize body to parseProbe intact", () => {
    const nul = parseProbe(onServer({ image: `${RUNNING}\n`, health: Buffer.from('{"ok":tru\u0000e,"version":"0.1.0"}') }));
    expect(nul.health.kind).toBe("invalid");
    expect(parseProbe(onServer({ image: Buffer.from(`${RUNNING}\u0000`), health: '{"ok":true}' })).digest).toBeNull();
    expect(parseProbe(onServer({ image: `${RUNNING}\n${"x".repeat(200)}`, health: '{"ok":true}' })).digest).toBeNull();
    expect(parseProbe(onServer({ image: `${RUNNING}\n`, health: `{"ok":true,"pad":"${"x".repeat(MAX_BYTES)}"}` })).health.kind).toBe("invalid");
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
function cli(
  mode: string,
  opts: { probe?: string; publicBody?: string; publicExit?: number; awsStall?: boolean; ghStall?: boolean; deadlineMs?: number } = {},
): Run {
  const host = makeHost("afterclass-live-release-");
  const calls = join(host.root, "calls");
  const log = `{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\n'; } >> ${calls}`;
  writeFileSync(join(host.root, "probe"), opts.probe ?? probeOutput(`${RUNNING}\n`, '{"ok":true}'));
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
  stub(host.bin, "gh", `${log}\n${opts.ghStall ? "exec sleep 30" : ""}\ncase "$3" in v0.1.4) printf 'commit ${COMMIT}\\ndigest ${RUNNING}\\n';; *) printf 'commit ${COMMIT}\\ndigest ${digestOf("0")}\\n';; esac`);
  stub(host.bin, "curl", `${log}\nprintf '%s' '${opts.publicBody ?? '{"ok":true,"version":"0.1.4"}'}'\nexit ${opts.publicExit ?? 0}`);
  const env = { ...process.env, PATH: `${host.bin}:${process.env.PATH}`, ...(opts.deadlineMs === undefined ? {} : { LIVE_RELEASE_DEADLINE_MS: String(opts.deadlineMs) }) };
  const result = Bun.spawnSync(["bun", SCRIPT, mode], { env });
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
    const run = cli("server", { probe: probeOutput(`${RUNNING}\n`, "<html>blocked</html>") });
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

  test("server stops with 'could not read the server' when aws stalls past the one deadline, which the output states", () => {
    const start = Date.now();
    const run = cli("server", { awsStall: true, deadlineMs: 1500 });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("could not read the server");
    expect(run.stderr).toContain("120 s deadline");
  });

  test("the same deadline covers the digest-to-tag lookup", () => {
    const start = Date.now();
    const run = cli("server", { probe: probeOutput(`${RUNNING}\n`, '{"ok":true}'), ghStall: true, deadlineMs: 1500 });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("could not read the server");
  });

  test("server fails on a /health body with a NUL in it, which a shell would have dropped", () => {
    const run = cli("server", { probe: probeOutput(`${RUNNING}\n`, Buffer.from('{"ok":tru\u0000e,"version":"0.1.4"}')) });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("answered /health with something else");
  });
});
