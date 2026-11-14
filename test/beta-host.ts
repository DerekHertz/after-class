import { expect } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(root, "settings.env"), "APP_PORT=8080\nAWS_REGION=us-east-2\nECR_REGISTRY=registry.test\nECR_REPOSITORY=afterclass-api\n");
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

export function runScript(host: Host, name: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", installScript(host, name), ...args], {
    env: { ...process.env, PATH: `${host.bin}:${process.env.PATH}` },
  });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
