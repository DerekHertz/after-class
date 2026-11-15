import { statfsSync } from "node:fs";

const MIB = 1024 * 1024;

/** What the data volume holds right now. `usedBytes` is the volume's, not only the app's: the database, frames, Caddy's certificates and the saved images share it. */
export type DiskReading = { readonly totalBytes: number; readonly freeBytes: number };

export const readVolume = (dir: string) => (): DiskReading => {
  const s = statfsSync(dir);
  const size = Number(s.bsize);
  return { totalBytes: Number(s.blocks) * size, freeBytes: Number(s.bavail) * size };
};

/**
 * The line the app logs about the data volume, one JSON object so a CloudWatch metric filter reads `freeMib` without parsing
 * text (infra/beta/disk-alarm.tf). `level` is "floor" once free space is under the ingest floor, which is when every ingest
 * is refused with 503, and "ok" otherwise. The alarm fires earlier than that, on `freeMib` alone.
 */
export function diskLine(r: DiskReading, minFreeBytes: number): string {
  const mib = (bytes: number) => Math.floor(bytes / MIB);
  return JSON.stringify({
    event: "disk",
    level: r.freeBytes < minFreeBytes ? "floor" : "ok",
    freeMib: mib(r.freeBytes),
    usedMib: mib(r.totalBytes - r.freeBytes),
    totalMib: mib(r.totalBytes),
    floorMib: mib(minFreeBytes),
  });
}

/** Default gap between readings. A lecture-hour adds about 24 MB, so a quarter hour is far finer than the trend. */
export const DISK_WATCH_EVERY_MS = 15 * 60 * 1000;

/**
 * Logs `diskLine` once now and then every `everyMs`, until the returned function is called. A volume that cannot be read
 * logs that instead of throwing, because a monitor that stops the app is worse than none.
 */
export function startDiskWatch(opts: {
  read(): DiskReading;
  minFreeBytes: number;
  log(text: string): void;
  logError(text: string): void;
  everyMs?: number;
  /** Defaults to setInterval. Injected so a test need not wait. */
  every?(ms: number, fn: () => void): () => void;
}): () => void {
  const tick = () => {
    try {
      opts.log(diskLine(opts.read(), opts.minFreeBytes));
    } catch (e) {
      opts.logError(`disk watch: could not read the data volume: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  tick();
  const every =
    opts.every ??
    ((ms, fn) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return () => clearInterval(t);
    });
  return every(opts.everyMs ?? DISK_WATCH_EVERY_MS, tick);
}
