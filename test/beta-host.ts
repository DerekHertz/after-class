import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./tmp";

export const FILES = resolve(import.meta.dir, "../infra/beta/files");

export function stub(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

export interface Host {
  readonly root: string;
  readonly bin: string;
  readonly log: string;
}

/** A temp tree that stands in for one server's root: /data, /etc/afterclass and /usr/local/sbin. */
export function makeHost(prefix: string): Host {
  const root = tmpDir(prefix);
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "data/afterclass/images"), { recursive: true });
  writeFileSync(join(root, "settings.env"), "APP_PORT=8080\nAWS_REGION=us-east-2\n");
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  return { root, bin, log };
}

export function readLog(host: Host): string[] {
  return readFileSync(host.log, "utf8").split("\n").filter(Boolean);
}

/**
 * Copies a real script into the host with every absolute path of the real server pointed into the temp tree. One pass
 * replaces every key, longest first, so a replacement is never rewritten by a later key.
 */
export function installScript(host: Host, name: string, extra: Record<string, string> = {}): string {
  const paths: Record<string, string> = {
    "/etc/afterclass/settings.env": join(host.root, "settings.env"),
    "/run/afterclass-deploy.lock": join(host.root, "lock"),
    "/data/afterclass": join(host.root, "data/afterclass"),
    ...extra,
  };
  const keys = Object.keys(paths).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const text = readFileSync(join(FILES, `${name}.sh`), "utf8")
    .replace(/\/usr\/local\/sbin\/(afterclass-[a-z-]+)/g, join(host.root, "$1"))
    .replace(pattern, (key) => paths[key]!);
  expect(text).not.toContain("/usr/local/sbin");
  const path = join(host.root, name);
  writeFileSync(path, text);
  return path;
}

export const REPOSITORY = "ghcr.io/derekhertz/after-class";

/** A registry digest made of one repeated hex character. */
export const digestOf = (char: string): string => `sha256:${char.repeat(64)}`;

/** The local image ID Docker reports for the image the fake registry serves under `digest`. */
export const imageId = (digest: string): string => `sha256:${"f".repeat(32)}${digest.slice(7, 39)}`;

/**
 * Writes an archive in the shape docker save produces: manifest.json naming a config file and a layer tarball, and both
 * of those files. The config file is named by the image ID, as in a real archive.
 */
const MAKE_ARCHIVE = String.raw`id=$1; out=$2; hexid=$(echo "$id" | cut -c8-)
d=$(mktemp -d); mkdir "$d/l1" "$d/src"
echo "$id" > "$d/src/content"
tar -cf "$d/l1/layer.tar" -C "$d/src" content
printf '{"id":"%s"}' "$id" > "$d/$hexid.json"
printf '[{"Config":"%s.json","RepoTags":[],"Layers":["l1/layer.tar"]}]' "$hexid" > "$d/manifest.json"
tar -cf "$out" -C "$d" manifest.json "$hexid.json" l1/layer.tar; status=$?
rm -rf "$d"; exit $status`;

export interface FakeDocker {
  readonly store: string;
  /** GHCR answers a pull of `<repository>:<tag>` with the image under this digest, as a mutable tag would. */
  readonly tags?: Record<string, string>;
  /** GHCR holds nothing, as when it lost the image. */
  readonly pullFails?: boolean | undefined;
  /** docker save writes part of an archive and exits 1, as it does when the disk fills. */
  readonly saveFails?: boolean | undefined;
  /** What `image inspect --format {{.Size}}` reports. */
  readonly size?: number;
}

/**
 * A stand-in for the docker CLI with the identity rules the real one showed on both image stores. An image is known by
 * its ID. A pull also makes the reference it pulled resolve. save and load keep the ID and drop every reference, so after
 * a load only the ID resolves. The store is a folder of files, so a save on one host and a load on another behave like
 * the real round trip.
 */
export function fakeDocker(host: Host, opts: FakeDocker): void {
  mkdirSync(join(opts.store, "ids"), { recursive: true });
  mkdirSync(join(opts.store, "refs"), { recursive: true });
  mkdirSync(join(opts.store, "tags"), { recursive: true });
  for (const [tag, digest] of Object.entries(opts.tags ?? {})) writeFileSync(join(opts.store, "tags", `${REPOSITORY}:${tag}`.replace(/[/:@]/g, "_")), digest);
  stub(host.bin, "make-image-archive", MAKE_ARCHIVE);
  stub(
    host.bin,
    "docker",
    `store=${opts.store}; log=${host.log}; size=${opts.size ?? 1000}; pull_fails=${opts.pullFails ? 1 : 0}; save_fails=${opts.saveFails ? 1 : 0}\n` +
      String.raw`echo "docker $*" >> "$log"
key() { echo "$1" | tr '/:@' '___'; }
hex() { echo "$1" | cut -c8-; }
id_of() { printf 'sha256:%s%s' ffffffffffffffffffffffffffffffff "$(echo "$1" | cut -c8-39)"; }
for last; do :; done
case "$1 $2" in
  "image inspect")
    case "$last" in
      sha256:*) [ -e "$store/ids/$(hex "$last")" ] || { echo "Error: No such image: $last" >&2; exit 1; }; id=$last;;
      *) [ -e "$store/refs/$(key "$last")" ] || { echo "Error: No such image: $last" >&2; exit 1; }; id=$(cat "$store/refs/$(key "$last")");;
    esac
    case "$*" in
      *'{{.Id}}'*) echo "$id";;
      *'{{.Size}}'*) echo "$size";;
    esac
    exit 0;;
  "save --output")
    if [ "$save_fails" = 1 ]; then head -c 700 /dev/urandom > "$3"; echo "write $3: no space left on device" >&2; exit 1; fi
    [ -e "$store/ids/$(hex "$4")" ] || { echo "Error: No such image: $4" >&2; exit 1; }
    make-image-archive "$4" "$3"; exit $?;;
  "load --input")
    members=$(tar -tf "$3" 2>/dev/null) || { echo "Error: unexpected EOF" >&2; exit 1; }
    manifest=$(tar -xOf "$3" manifest.json 2>/dev/null) || { echo "Error: no manifest.json" >&2; exit 1; }
    config=$(sed -n 's/.*"Config":"\([^"]*\)".*/\1/p' <<<"$manifest")
    layer=$(sed -n 's/.*"Layers":\["\([^"]*\)".*/\1/p' <<<"$manifest")
    for member in "$config" "$layer"; do
      grep -qxF "$member" <<<"$members" || { echo "Error: open $member: no such file" >&2; exit 1; }
    done
    touch "$store/ids/$(basename "$config" .json)"; echo "Loaded image ID: sha256:$(basename "$config" .json)"; exit 0;;
  "pull "*)
    [ "$pull_fails" = 1 ] && { echo "manifest unknown" >&2; exit 1; }
    case "$2" in
      *@sha256:*) digest=$(echo "$2" | sed 's/.*@//');;
      *) digest=$(cat "$store/tags/$(key "$2")" 2>/dev/null) || { echo "manifest unknown" >&2; exit 1; };;
    esac
    id=$(id_of "$digest"); touch "$store/ids/$(hex "$id")"; echo "$id" > "$store/refs/$(key "$2")"; exit 0;;
esac
exit 0`,
  );
}

/** Whether the fake Docker store holds an image with this ID. */
export const hasImage = (store: string, id: string): boolean => existsSync(join(store, "ids", id.slice(7)));

/** Writes a docker save archive of the image with this ID. */
export function writeArchive(host: Host, id: string, path: string): void {
  stub(host.bin, "make-image-archive", MAKE_ARCHIVE);
  expect(Bun.spawnSync(["bash", join(host.bin, "make-image-archive"), id, path]).exitCode).toBe(0);
}

export function runScript(host: Host, name: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", installScript(host, name), ...args], {
    env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` },
  });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
