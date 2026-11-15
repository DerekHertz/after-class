import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { digestOf, makeHost, probeOutput, stub } from "./beta-host";
import { COMMAND_ID, CURRENT_IMAGE, HEALTH, INSTANCE_ID, MAX_BYTES, parseHealth, parseProbe, PROBE, PROBE_OUTPUT, RECORD, validate } from "../scripts/release-input";
import type { Format } from "../scripts/release-input";

const COMMIT = "c".repeat(40);
const RUNNING = digestOf("a");
const bytes = (text: string): Buffer => Buffer.from(text);

interface Case {
  readonly format: Format<unknown>;
  /** A valid answer with no trailing LF. */
  readonly sample: string;
  readonly trailingLf: boolean;
}

const CASES: Case[] = [
  { format: RECORD, sample: `commit ${COMMIT}\ndigest ${RUNNING}`, trailingLf: true },
  { format: CURRENT_IMAGE, sample: RUNNING, trailingLf: true },
  { format: HEALTH, sample: '{"ok":true,"version":"0.1.5"}', trailingLf: false },
  { format: HEALTH, sample: '{"ok":true}', trailingLf: false },
  { format: INSTANCE_ID, sample: "i-0123456789abcdef0", trailingLf: true },
  { format: COMMAND_ID, sample: "11111111-2222-3333-4444-555555555555", trailingLf: true },
  { format: PROBE_OUTPUT, sample: probeOutput(`${RUNNING}\n`, '{"ok":true}').toString().slice(0, -1), trailingLf: true },
];

/** Each turns a valid answer into one that must be refused. */
const HOSTILE: [string, (sample: Buffer) => Buffer][] = [
  ["a NUL inside", (s) => Buffer.concat([s.subarray(0, 4), Buffer.from([0]), s.subarray(4)])],
  ["a NUL at the end", (s) => Buffer.concat([s, Buffer.from([0])])],
  ["a byte order mark before it", (s) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), s])],
  ["a byte order mark after it", (s) => Buffer.concat([s, Buffer.from([0xef, 0xbb, 0xbf])])],
  ["a CR at the end", (s) => Buffer.concat([s, bytes("\r")])],
  ["CRLF at the end", (s) => Buffer.concat([s, bytes("\r\n")])],
  ["CRLF for every LF", (s) => bytes(`${s.toString("latin1").replaceAll("\n", "\r\n")}\r\n`)],
  ["two LFs at the end", (s) => Buffer.concat([s, bytes("\n\n")])],
  ["U+2028 at the end", (s) => Buffer.concat([s, bytes(" ")])],
  ["U+2029 after an LF", (s) => Buffer.concat([s, bytes("\n ")])],
  ["a C1 control as UTF-8", (s) => Buffer.concat([s, Buffer.from([0xc2, 0x85])])],
  ["a raw C1 byte", (s) => Buffer.concat([s, Buffer.from([0x9b])])],
  ["an escape sequence", (s) => Buffer.concat([s, bytes("\u001b[2J")])],
  ["a vertical tab before it", (s) => Buffer.concat([bytes("\v"), s])],
  ["a form feed after it", (s) => Buffer.concat([s, bytes("\f")])],
  ["a tab after it", (s) => Buffer.concat([s, bytes("\t")])],
  ["trailing garbage", (s) => Buffer.concat([s, bytes("\nx")])],
  ["trailing garbage with no LF", (s) => Buffer.concat([s, bytes("x")])],
  ["a leading space", (s) => Buffer.concat([bytes(" "), s])],
  ["a trailing space", (s) => Buffer.concat([s, bytes(" ")])],
  ["a trailing space before the LF", (s) => Buffer.concat([s, bytes(" \n")])],
  ["oversize", (s) => Buffer.concat([s, Buffer.alloc(MAX_BYTES, "a")])],
  ["invalid UTF-8", (s) => Buffer.concat([s, Buffer.from([0xff])])],
  ["only its first half", (s) => s.subarray(0, Math.floor(s.length / 2))],
  ["nothing", () => Buffer.alloc(0)],
];

describe("validate", () => {
  for (const { format, sample, trailingLf } of CASES) {
    test(`accepts ${format.name} as ${JSON.stringify(sample.slice(0, 30))}${trailingLf ? ", with or without one LF" : ", and nothing after it"}`, () => {
      expect(validate(format, bytes(sample)).ok).toBe(true);
      expect(validate(format, bytes(`${sample}\n`)).ok).toBe(trailingLf);
    });
    for (const [name, mutate] of HOSTILE) {
      test(`refuses ${format.name} with ${name}`, () => {
        const result = validate(format, mutate(bytes(sample)));
        expect(result.ok).toBe(false);
        expect(!result.ok && result.why).toMatch(/^[\x20-\x7e]*$/);
      });
    }
  }

  test("yields only the fields it names", () => {
    expect(validate(RECORD, bytes(`commit ${COMMIT}\ndigest ${RUNNING}\n`))).toEqual({ ok: true, value: { commit: COMMIT, digest: RUNNING } });
    expect(validate(CURRENT_IMAGE, bytes(`${RUNNING}\n`))).toEqual({ ok: true, value: RUNNING });
    expect(validate(HEALTH, bytes('{"ok":true,"version":"0.1.5"}'))).toEqual({ ok: true, value: { version: "0.1.5" } });
    expect(validate(HEALTH, bytes('{"ok":true}'))).toEqual({ ok: true, value: { version: null } });
  });

  test("shows a refused answer as printable ASCII, every other byte as \\xNN", () => {
    const result = validate(RECORD, Buffer.from([0xef, 0xbb, 0xbf, 0x63, 0x00, 0x1b, 0x5c, 0xc2, 0x9b]));
    expect(!result.ok && result.why).toBe('image-digest.txt is not in its format: "\\xef\\xbb\\xbfc\\x00\\x1b\\x5c\\xc2\\x9b"');
  });
});

describe("parseHealth", () => {
  const refused: [string, string][] = [
    ["a filter's HTML page", "<html>Access blocked by network policy</html>"],
    ["a filter's page that quotes a version", '<html>Blocked. Diagnostics: {"version":"0.1.2"}</html>'],
    ["ok false", '{"ok":false,"version":"0.1.5"}'],
    ["no ok", '{"version":"0.1.5"}'],
    ["an array", '[{"ok":true}]'],
    ["a version that is not a release", '{"ok":true,"version":"0.1.5-rc1"}'],
    ["a version with a v", '{"ok":true,"version":"v0.1.5"}'],
    ["a version with a leading zero", '{"ok":true,"version":"0.01.5"}'],
    ["a number version", '{"ok":true,"version":5}'],
    ["another field", '{"ok":true,"version":"0.1.5","error":"x"}'],
    ["the fields in another order", '{"version":"0.1.5","ok":true}'],
    ["whitespace JSON allows", '{"ok": true}'],
    ["an escaped key", '{"ok":true,"\\u009b2J\\u202e":1}'],
  ];
  for (const [name, body] of refused) {
    test(`is invalid for ${name}`, () => {
      expect(parseHealth(bytes(body)).kind).toBe("invalid");
    });
  }
});

describe("parseProbe", () => {
  test("reads the recorded digest and the health body", () => {
    expect(parseProbe(probeOutput(`${RUNNING}\n`, '{"ok":true,"version":"0.1.5"}'))).toEqual({ digest: RUNNING, health: { kind: "valid", version: "0.1.5" } });
  });

  test("tells an app that did not answer apart from one that answered something else", () => {
    expect(parseProbe(probeOutput(RUNNING, { unreachable: 7 })).health).toEqual({ kind: "unreachable", detail: "curl exited 7" });
    expect(parseProbe(probeOutput(RUNNING, "<html>\nblocked</html>")).health.kind).toBe("invalid");
  });

  test("has no digest when the file is missing or holds something else", () => {
    expect(parseProbe(probeOutput(null, '{"ok":true}')).digest).toBeNull();
    expect(parseProbe(probeOutput("", '{"ok":true}')).digest).toBeNull();
    expect(parseProbe(probeOutput("ghcr.io/x:latest", '{"ok":true}')).digest).toBeNull();
    expect(parseProbe(probeOutput(Buffer.from(`${RUNNING}\u0000`), '{"ok":true}')).digest).toBeNull();
    expect(parseProbe(probeOutput(`﻿${RUNNING}`, '{"ok":true}')).digest).toBeNull();
    expect(parseProbe(probeOutput("a".repeat(MAX_BYTES + 1), '{"ok":true}')).digest).toBeNull();
  });

  test("refuses content that is not exactly what the server counted, or base64 that is not canonical", () => {
    const body = Buffer.from('{"ok":true}').toString("base64");
    expect(parseProbe(bytes(`image missing\nhealth 5 ${body}\n`)).health.kind).toBe("invalid");
    expect(parseProbe(bytes(`image missing\nhealth 11 ${body.slice(0, -4)}\n`)).health.kind).toBe("invalid");
    expect(parseProbe(bytes(`image missing\nhealth 11 ${body}!\n`)).health.kind).toBe("invalid");
    expect(parseProbe(bytes("image missing\nhealth 1 QR==\n")).health).toEqual({ kind: "invalid", detail: "the /health answer is not canonical base64" });
    expect(parseProbe(bytes("something else")).health.kind).toBe("invalid");
  });

  test("refuses a NUL, a byte order mark or a control byte in the health body", () => {
    for (const body of [Buffer.from('{"ok":tru\u0000e}'), `﻿{"ok":true}`, '{"ok":true}\u001b[2J']) {
      expect(parseProbe(probeOutput(RUNNING, body)).health.kind).toBe("invalid");
    }
  });

  /** The probe's own commands on a server's paths, with files and a curl body of exactly these bytes, and the LF aws adds. */
  function onServer(files: { image?: string | Buffer; health: string | Buffer | number }): Buffer {
    const host = makeHost("afterclass-live-probe-");
    if (files.image !== undefined) writeFileSync(join(host.root, "data/afterclass/current-image"), files.image);
    const body = join(host.root, "body");
    if (typeof files.health !== "number") writeFileSync(body, files.health);
    const answer = typeof files.health === "number" ? `exit ${files.health}` : `cat ${body} > "$out"`;
    stub(host.bin, "curl", `out=; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n${answer}`);
    const script = PROBE.join("\n")
      .replaceAll("/etc/afterclass/settings.env", join(host.root, "settings.env"))
      .replaceAll("/data/afterclass", join(host.root, "data/afterclass"));
    const out = Bun.spawnSync(["sh", "-c", script], { env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` } }).stdout;
    return Buffer.concat([out, bytes("\n")]);
  }

  test("the probe's own commands print what parseProbe reads, on a server's paths", () => {
    expect(parseProbe(onServer({ image: `${RUNNING}\n`, health: '{"ok":true,"version":"0.1.5"}' }))).toEqual({ digest: RUNNING, health: { kind: "valid", version: "0.1.5" } });
    expect(parseProbe(onServer({ image: `${RUNNING}\n`, health: 7 })).health).toEqual({ kind: "unreachable", detail: "curl exited 7" });
    expect(parseProbe(onServer({ health: '{"ok":true}' })).digest).toBeNull();
  });

  test("the probe's own commands carry a NUL, a byte order mark, trailing garbage and an oversize body to parseProbe intact", () => {
    expect(parseProbe(onServer({ image: `${RUNNING}\n`, health: Buffer.from('{"ok":tru\u0000e,"version":"0.1.0"}') })).health.kind).toBe("invalid");
    expect(parseProbe(onServer({ image: `${RUNNING}\n`, health: `﻿{"ok":true}` })).health.kind).toBe("invalid");
    expect(parseProbe(onServer({ image: Buffer.from(`${RUNNING}\u0000`), health: '{"ok":true}' })).digest).toBeNull();
    expect(parseProbe(onServer({ image: `${RUNNING}\n${"x".repeat(200)}`, health: '{"ok":true}' })).digest).toBeNull();
    expect(parseProbe(onServer({ image: `${RUNNING}\n`, health: `{"ok":true,"pad":"${"x".repeat(MAX_BYTES)}"}` })).health.kind).toBe("invalid");
  });
});
