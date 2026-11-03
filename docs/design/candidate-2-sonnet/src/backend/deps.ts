// deps.ts -- the explicit dependency bundle every shell function takes. No globals, no singletons: tests build one with
// an in-memory dataDir, a FakeClock and replay/fake providers.
import type { AppConfig } from "./config";
import type { Clock } from "../shared/core/clock";
import type { Providers } from "./providers/ports";
import type { Store } from "./store/index";

export interface Deps {
  readonly store: Store;
  readonly providers: Providers;
  readonly clock: Clock;
  readonly cfg: AppConfig;
}
