// Reads the outside answers the release tool acts on, as raw bytes, and passes each through scripts/release-input.ts
// before anything uses it. The shell scripts call this and use only what it prints.
// Usage: bun scripts/live-release.ts server       prints "<tag> <digest>" for the release the server runs, or fails saying why.
//        bun scripts/live-release.ts public       prints the tag the public /health reports from this machine, or fails saying why.
//        bun scripts/live-release.ts record <tag> prints "<commit> <digest>" from the tag's image-digest.txt, or fails saying why.
//
// The server is read through Systems Manager, because a network filter between this machine and useafterclass.com can
// block or rewrite the public /health. One command on the instance deploy-beta.sh deploys to prints the digest
// afterclass-deploy recorded in /data/afterclass/current-image and what the app's own /health answers on 127.0.0.1.
// Every subprocess and the digest lookups share one 120 s deadline.
// A /health that names a version gives the tag. One that names none, as up to v0.1.4, gives the release whose
// image-digest.txt names the recorded digest.

import { compareTags } from "./release-notes";
import { COMMAND_ID, excerpt, INSTANCE_ID, parseHealth, parseProbe, PROBE, RECORD, validate } from "./release-input";
import type { Checked, Health, ServerRead } from "./release-input";

const REGION = "us-east-2";
const INSTANCE_PARAMETER = "/afterclass-beta/instance_id";
const GITHUB_REPOSITORY = "DerekHertz/after-class";
const SITE = "https://useafterclass.com";

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
  /** stdout exactly as the process wrote it. */
  readonly out: Buffer;
  /** The first line of stderr, made printable, or empty. */
  readonly err: string;
}

function run(...command: string[]): Ran {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new DeadlineError(command[0]!);
  const result = Bun.spawnSync(command, { stdin: "ignore", timeout: remaining, killSignal: "SIGKILL" });
  if (result.exitedDueToTimeout || Date.now() >= deadlineAt) throw new DeadlineError(command[0]!);
  const newline = result.stderr.indexOf(0x0a);
  const firstLine = newline === -1 ? result.stderr : result.stderr.subarray(0, newline);
  return { code: result.exitCode, out: result.stdout, err: firstLine.length > 0 ? excerpt(firstLine) : "" };
}

function aws(...args: string[]): Buffer {
  const result = run("aws", ...args, "--region", REGION);
  if (result.code !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${result.err || `exit ${result.code}`}`);
  return result.out;
}

function valueOf<T>(result: Checked<T>): T {
  if (!result.ok) throw new Error(result.why);
  return result.value;
}

/** Bounded by the deadline: the waiter polls every 5 seconds, 20 times, and the command itself times out after 30. */
function readServer(): ServerRead {
  const instance = valueOf(validate(INSTANCE_ID, aws("ssm", "get-parameter", "--name", INSTANCE_PARAMETER, "--query", "Parameter.Value", "--output", "text")));
  const parameters = JSON.stringify({ commands: PROBE, executionTimeout: ["30"] });
  const send = aws(
    "ssm", "send-command", "--instance-ids", instance, "--document-name", "AWS-RunShellScript",
    "--comment", "read the running release", "--parameters", parameters, "--query", "Command.CommandId", "--output", "text",
  );
  const command = valueOf(validate(COMMAND_ID, send));
  const ids = ["--command-id", command, "--instance-id", instance];
  aws("ssm", "wait", "command-executed", ...ids);
  return parseProbe(aws("ssm", "get-command-invocation", ...ids, "--query", "StandardOutputContent", "--output", "text"));
}

/** The tag's image-digest.txt, checked byte for byte as gh downloaded it. */
function readRecord(tag: string): Checked<{ readonly commit: string; readonly digest: string }> {
  const result = run("gh", "release", "download", tag, "--repo", GITHUB_REPOSITORY, "--pattern", "image-digest.txt", "--output", "-");
  if (result.code !== 0) return { ok: false, why: `the ${tag} release has no image-digest.txt (gh exited ${result.code}${result.err ? `: ${result.err}` : ""})` };
  const record = validate(RECORD, result.out);
  return record.ok ? record : { ok: false, why: `the ${tag} release's ${record.why}` };
}

/** What useafterclass.com/health answers this machine. A filter can block it or answer with its own page. */
export function readPublic(): Health {
  const result = run("curl", "-sS", "--max-time", "10", "--max-filesize", "4096", `${SITE}/health`);
  if (result.code !== 0) return { kind: "unreachable", detail: `curl exited ${result.code}${result.err ? `: ${result.err}` : ""}` };
  return parseHealth(result.out);
}

function stopAtDeadline(what: string, error: unknown): never {
  if (!(error instanceof DeadlineError)) throw error;
  console.error(`live-release: ${what}: ${error.message} did not finish within the ${DEADLINE_SECONDS} s deadline`);
  process.exit(1);
}

if (import.meta.main) {
  const [mode, tag, ...extra] = process.argv.slice(2);
  if (mode === "server" && tag === undefined) {
    let live: Live;
    try {
      const tags = run("git", "tag", "--list", "v*").out.toString().split("\n").filter((t) => RELEASE_TAG.test(t));
      live = resolveLive(readServer(), tags, (t) => {
        const record = readRecord(t);
        return record.ok ? record.value.digest : null;
      });
    } catch (error) {
      if (error instanceof DeadlineError) stopAtDeadline("could not read the server", error);
      live = { ok: false, reason: (error as Error).message };
    }
    if (!live.ok) {
      console.error(`live-release: cannot tell which release the server runs: ${live.reason}`);
      process.exit(1);
    }
    console.log(`${live.tag} ${live.digest}`);
  } else if (mode === "public" && tag === undefined) {
    let health: Health;
    try {
      health = readPublic();
    } catch (error) {
      stopAtDeadline(`${SITE}/health from this machine`, error);
    }
    if (health.kind === "valid" && health.version !== null) {
      console.log(`v${health.version}`);
    } else {
      const why = health.kind === "unreachable" ? `cannot reach it (${health.detail})` : health.kind === "invalid" ? `it answered with something other than the app (${health.detail})` : "it names no version";
      console.error(`live-release: ${SITE}/health from this machine: ${why}`);
      process.exit(1);
    }
  } else if (mode === "record" && tag !== undefined && RELEASE_TAG.test(tag) && extra.length === 0) {
    let record: ReturnType<typeof readRecord>;
    try {
      record = readRecord(tag);
    } catch (error) {
      stopAtDeadline(`the ${tag} release's image-digest.txt`, error);
    }
    if (!record.ok) {
      console.error(`live-release: ${record.why}`);
      process.exit(1);
    }
    console.log(`${record.value.commit} ${record.value.digest}`);
  } else {
    console.error("usage: bun scripts/live-release.ts server|public|record v<major>.<minor>.<patch>");
    process.exit(2);
  }
}
