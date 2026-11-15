import { statfsSync } from "node:fs";

const MIB = 1024 * 1024;

/**
 * What one ingest may add. The quota counts a user's stored bytes (frame files and fact rows). The floor keeps free space on the
 * data volume for the database, its write-ahead log and Caddy's certificates, which share the volume with the frames.
 */
export type IngestLimits = {
  readonly maxUserBytes: number;
  readonly minFreeBytes: number;
  /** Free bytes on the volume that holds the data directory. Injected so a test need not fill a disk. */
  freeBytes(): number;
};

/**
 * 512 MiB per user is about 21 lecture-hours at the 24 MB an hour measured on 2026-11-14, so a friend can review a term of
 * lectures but 20 friends cannot take more than 10 GB of the 20 GB volume. The 2 GiB floor is a tenth of that volume.
 */
export const DEFAULT_USER_QUOTA_BYTES = 512 * MIB;
export const DEFAULT_MIN_FREE_BYTES = 2048 * MIB;

export const volumeFreeBytes = (dir: string) => (): number => {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

export const defaultIngestLimits = (dataDir: string): IngestLimits => ({
  maxUserBytes: DEFAULT_USER_QUOTA_BYTES, minFreeBytes: DEFAULT_MIN_FREE_BYTES, freeBytes: volumeFreeBytes(dataDir),
});

/** A refusal that is the server's or the account's limit, not a malformed batch. `quota` will not clear by retrying. `disk` will once space is freed. */
export class IngestRefused extends Error {
  constructor(readonly reason: "quota" | "disk", message: string) {
    super(message);
    this.name = "IngestRefused";
  }
}

function megabytes(name: string, text: string | undefined): number | undefined {
  if (text === undefined || text === "") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of mebibytes, 0 or more, got "${text}"`);
  return Math.floor(n * MIB);
}

/** AFTERCLASS_USER_QUOTA_MB and AFTERCLASS_MIN_FREE_MB, in mebibytes. 0 turns that limit off. */
export function resolveIngestLimits(env: Readonly<Record<string, string | undefined>>, dataDir: string): IngestLimits {
  const base = defaultIngestLimits(dataDir);
  const quota = megabytes("AFTERCLASS_USER_QUOTA_MB", env.AFTERCLASS_USER_QUOTA_MB);
  const floor = megabytes("AFTERCLASS_MIN_FREE_MB", env.AFTERCLASS_MIN_FREE_MB);
  return { ...base, maxUserBytes: quota ?? base.maxUserBytes, minFreeBytes: floor ?? base.minFreeBytes };
}
