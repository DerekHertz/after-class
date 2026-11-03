// store/index.ts -- the persistence boundary. THE public surface of persistence; nothing outside src/store imports bun:sqlite
// (test/architecture.test.ts). Repos are not constructible from outside: only `openStore` builds them, sharing one Db.
import type { Clock } from "../../shared/core/clock";
import { migrate, openDb } from "./db";
import type { CaptureRepo, RetentionRepo } from "./capture";
import type { TimelineRepo } from "./timeline";
import type { JobRepo } from "./jobs";
import type { ReviewRepo } from "./review";
import type { UsageRepo } from "./usage";

export interface Store {
  readonly capture: CaptureRepo;
  readonly retention: RetentionRepo;
  readonly timeline: TimelineRepo;
  readonly jobs: JobRepo;
  readonly review: ReviewRepo;
  readonly usage: UsageRepo;
  /** one transaction across repos (SAVEPOINT-nested). Pure functions run inside; no awaits inside (SQLite tx is sync). */
  tx<T>(fn: () => T): T;
  close(): void;
}

export interface StoreOptions {
  readonly dataDir: string; // <dataDir>/afterclass.sqlite, <dataDir>/frames/, <dataDir>/pending/
  readonly clock: Clock;
}

/** Migrations are discovered from each repo module's exported `migrations` const (one per repo file; ownership = file). */
export function openStore(opts: StoreOptions): Store {
  throw new Error("not implemented");
}
