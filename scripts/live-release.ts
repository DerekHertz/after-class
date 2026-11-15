// Which release the beta runs, read from the server itself, because a network filter between this machine and
// useafterclass.com can block or rewrite the public /health. scripts/release.sh runs it after `aws login` and after
// fetching the release tags.
// Usage: bun scripts/live-release.ts server   prints "<tag> <digest>" for the release the server runs, or fails saying why.
//        bun scripts/live-release.ts public   prints the tag the public /health reports from this machine, or fails saying why.
//
// The server read is one Systems Manager command on the instance deploy-beta.sh deploys to. It prints the digest
// afterclass-deploy recorded in /data/afterclass/current-image and what the app's own /health answers on 127.0.0.1, each
// as its byte length and its base64, so no shell step can drop or cut a byte. Every subprocess and the digest lookups
// share one 120 s deadline.
// A /health that names a version gives the tag. One that names none, as up to v0.1.4, gives the release whose
// image-digest.txt names the recorded digest.

import { compareTags } from "./release-notes";

const REGION = "us-east-2";
const INSTANCE_PARAMETER = "/afterclass-beta/instance_id";
const GITHUB_REPOSITORY = "DerekHertz/after-class";
const SITE = "https://useafterclass.com";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RECORD = /^commit [0-9a-f]{40}\ndigest (sha256:[0-9a-f]{64})\n?$/;

export type Health =
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "valid"; readonly version: string | null };

/** A short, printable excerpt of an answer, so a filter's HTML page cannot write control characters to the terminal. */
const printable = (text: string): string =>
  JSON.stringify(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const excerpt = (text: string): string => printable(text.length > 80 ? `${text.slice(0, 80)}...` : text);

/** Valid means exactly the app's answer: a JSON object with ok true and, from v0.1.5 on, a release version. */
export function parseHealth(body: string): Health {
  const invalid = (why: string): Health => ({ kind: "invalid", detail: `${why}: ${excerpt(body)}` });
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return invalid("not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("not a JSON object");
  const { ok, version, ...rest } = value as Record<string, unknown>;
  if (ok !== true) return invalid("ok is not true");
  if (Object.keys(rest).length > 0) return invalid(`unexpected field ${printable(Object.keys(rest)[0]!)}`);
  if (version === undefined) return { kind: "valid", version: null };
  if (typeof version !== "string" || !VERSION.test(version)) return invalid("version is not <major>.<minor>.<patch>");
  return { kind: "valid", version };
}

export interface ServerRead {
  /** The digest in /data/afterclass/current-image, or null when the file is missing or holds something else. */
  readonly digest: string | null;
  readonly health: Health;
}

/** The most bytes read from a server file or /health body. Anything longer is rejected, never cut. */
export const MAX_BYTES = 4096;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The commands the server runs. They print `image missing` or `image <bytes> <base64>`, then `health <bytes> <base64>` or
 * `unreachable curl exited <code>`. Base64 carries NUL and every other byte through the shell, and one more byte than the
 * cap is sent, so an over-long file shows as one.
 */
export const PROBE = [
  ". /etc/afterclass/settings.env",
  `if [ -f /data/afterclass/current-image ]; then printf 'image %s %s\\n' "$(wc -c < /data/afterclass/current-image)" "$(head -c ${MAX_BYTES + 1} /data/afterclass/current-image | base64 -w0)"; else printf 'image missing\\n'; fi`,
  `tmp=$(mktemp) && if curl -sS --max-time 5 --max-filesize ${MAX_BYTES} -o "$tmp" "http://127.0.0.1:\${APP_PORT}/health" 2>/dev/null; then printf 'health %s %s\\n' "$(wc -c < "$tmp")" "$(head -c ${MAX_BYTES + 1} "$tmp" | base64 -w0)"; else printf 'unreachable curl exited %s\\n' "$?"; fi; rm -f "$tmp"`,
];

/** The text in the base64 of `length` bytes, or why it is not: wrong length, over the cap, bad base64, a control byte or bad UTF-8. */
function decode(length: string, base64: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string } {
  const expected = Number(length);
  if (!Number.isSafeInteger(expected) || expected > MAX_BYTES) return { ok: false, why: `is longer than ${MAX_BYTES} bytes` };
  if (!BASE64.test(base64)) return { ok: false, why: "is not base64" };
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== expected) return { ok: false, why: `has ${bytes.length} bytes, not the ${expected} the server counted` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, why: "is not UTF-8" };
  }
  if (/[\p{Cc}\p{Cf}]/u.test(text.replace(/\n$/, ""))) return { ok: false, why: "holds a control byte" };
  return { ok: true, text: text.replace(/\n$/, "") };
}

export function parseProbe(output: string): ServerRead {
  const match = /^image (?:missing|(\d+) ([A-Za-z0-9+/=]*))\n(?:health (\d+) ([A-Za-z0-9+/=]*)|unreachable curl exited (\d+))\n?$/.exec(output);
  if (!match) return { digest: null, health: { kind: "invalid", detail: `the server's answer is not the probe's: ${excerpt(output)}` } };
  const file = match[1] === undefined ? null : decode(match[1], match[2]!);
  const digest = file?.ok && DIGEST.test(file.text) ? file.text : null;
  if (match[5] !== undefined) return { digest, health: { kind: "unreachable", detail: `curl exited ${match[5]}` } };
  const body = decode(match[3]!, match[4]!);
  if (!body.ok) return { digest, health: { kind: "invalid", detail: `the health answer ${body.why}` } };
  return { digest, health: parseHealth(body.text) };
}

export type Live = { readonly ok: true; readonly tag: string; readonly digest: string } | { readonly ok: false; readonly reason: string };

/**
 * The release the server runs. `tags` are the release tags, and `digestOf` reads a tag's image-digest.txt. Anything short
 * of a running app, a recorded digest and a release that names one of them is no answer, never a guess.
 */
export function resolveLive(read: ServerRead, tags: readonly string[], digestOf: (tag: string) => string | null): Live {
  const { health, digest } = read;
  if (health.kind === "unreachable") return { ok: false, reason: `the app on the server did not answer its /health (${health.detail})` };
  if (health.kind === "invalid") return { ok: false, reason: `the app on the server answered /health with something else (${health.detail})` };
  if (digest === null) return { ok: false, reason: "the server has no image digest in /data/afterclass/current-image" };
  if (health.version !== null) {
    const tag = `v${health.version}`;
    if (!tags.includes(tag)) return { ok: false, reason: `the server reports version ${health.version}, which no release tag names` };
    return { ok: true, tag, digest };
  }
  const releases = tags.filter((t) => RELEASE_TAG.test(t)).sort(compareTags).reverse();
  const tag = releases.find((t) => digestOf(t) === digest);
  if (tag === undefined) return { ok: false, reason: `the server runs ${digest}, which no release's image-digest.txt names` };
  return { ok: true, tag, digest };
}

/** Every subprocess and the digest lookups share this budget, so a stalled aws or gh cannot hold the release forever. */
export const DEADLINE_SECONDS = 120;
const deadlineAt = Date.now() + Number(process.env.LIVE_RELEASE_DEADLINE_MS ?? DEADLINE_SECONDS * 1000);

class DeadlineError extends Error {}

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function run(...command: string[]): Ran {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new DeadlineError(command[0]!);
  const result = Bun.spawnSync(command, { stdin: "ignore", timeout: remaining, killSignal: "SIGKILL" });
  if (result.exitedDueToTimeout || Date.now() >= deadlineAt) throw new DeadlineError(command[0]!);
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

function aws(...args: string[]): string {
  const result = run("aws", ...args, "--region", REGION);
  if (result.code !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${result.err || `exit ${result.code}`}`);
  return result.out;
}

/** Bounded by the deadline: the waiter polls every 5 seconds, 20 times, and the command itself times out after 30. */
function readServer(): ServerRead {
  const instance = aws("ssm", "get-parameter", "--name", INSTANCE_PARAMETER, "--query", "Parameter.Value", "--output", "text");
  if (!/^i-[0-9a-f]{8,17}$/.test(instance)) throw new Error(`${INSTANCE_PARAMETER} is not an instance id: ${excerpt(instance)}`);
  const command = aws(
    "ssm", "send-command", "--instance-ids", instance, "--document-name", "AWS-RunShellScript",
    "--comment", "read the running release", "--parameters", JSON.stringify({ commands: PROBE, executionTimeout: ["30"] }),
    "--query", "Command.CommandId", "--output", "text",
  );
  if (!/^[0-9a-f-]{36}$/.test(command)) throw new Error(`send-command returned no command id: ${excerpt(command)}`);
  const ids = ["--command-id", command, "--instance-id", instance];
  aws("ssm", "wait", "command-executed", ...ids);
  return parseProbe(aws("ssm", "get-command-invocation", ...ids, "--query", "StandardOutputContent", "--output", "text"));
}

function recordedDigest(tag: string): string | null {
  const result = run("gh", "release", "download", tag, "--repo", GITHUB_REPOSITORY, "--pattern", "image-digest.txt", "--output", "-");
  return result.code === 0 ? (RECORD.exec(`${result.out}\n`)?.[1] ?? null) : null;
}

/** What useafterclass.com/health answers this machine. A filter can block it or answer with its own page. */
export function readPublic(): Health {
  const result = run("curl", "-sS", "--max-time", "10", "--max-filesize", "4096", `${SITE}/health`);
  if (result.code !== 0) return { kind: "unreachable", detail: `curl exited ${result.code}: ${result.err.split("\n")[0]}` };
  return parseHealth(result.out);
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "server") {
    let live: Live;
    try {
      const tags = run("git", "tag", "--list", "v*").out.split("\n").filter((t) => RELEASE_TAG.test(t));
      live = resolveLive(readServer(), tags, recordedDigest);
    } catch (error) {
      if (error instanceof DeadlineError) {
        console.error(`live-release: could not read the server: ${error.message} did not finish within the ${DEADLINE_SECONDS} s deadline`);
        process.exit(1);
      }
      live = { ok: false, reason: (error as Error).message };
    }
    if (!live.ok) {
      console.error(`live-release: cannot tell which release the server runs: ${live.reason}`);
      process.exit(1);
    }
    console.log(`${live.tag} ${live.digest}`);
  } else if (mode === "public") {
    let health: Health;
    try {
      health = readPublic();
    } catch (error) {
      console.error(`live-release: ${SITE}/health from this machine: ${(error as Error).message} did not finish within the ${DEADLINE_SECONDS} s deadline`);
      process.exit(1);
    }
    if (health.kind === "valid" && health.version !== null) {
      console.log(`v${health.version}`);
    } else {
      const why = health.kind === "unreachable" ? `cannot reach it (${health.detail})` : health.kind === "invalid" ? `it answered with something other than the app (${health.detail})` : "it names no version";
      console.error(`live-release: ${SITE}/health from this machine: ${why}`);
      process.exit(1);
    }
  } else {
    console.error("usage: bun scripts/live-release.ts server|public");
    process.exit(2);
  }
}
