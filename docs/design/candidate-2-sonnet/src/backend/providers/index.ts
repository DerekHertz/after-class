// providers/index.ts -- the single composition point: transports -> adapters -> metered -> ports.
// Real, replay and recording variants all satisfy `Providers`; the pipeline cannot tell them apart.
import type { Clock } from "../../shared/core/clock";
import type { Providers } from "./ports";
import type { Ledger } from "./metered";

export interface ProviderConfig {
  readonly jev: { readonly model: string; readonly baseUrl: string; readonly apiKey: string; readonly timeoutMs: number };
  readonly claude: {
    readonly bin: string; // "claude"
    /** per stage: interpretation and tutor default to Opus 5.5; Sonnet 5.5 is the lab-test comparison arm */
    readonly choice: Readonly<Record<string, { readonly model: string; readonly effort: "low" | "medium" | "high" | "xhigh" | "max" }>>;
    readonly timeoutMs: number;
    readonly maxConcurrent: number;
  };
}

export function createProviders(cfg: ProviderConfig, ledger: Ledger, clock: Clock): Providers {
  throw new Error("not implemented");
}

/** ~/.config/afterclass/keys.env: refuses to start unless mode is 0600; keys never leave the backend process. */
export function loadKeys(path: string): { readonly TYPESAFE_API_KEY: string } {
  throw new Error("not implemented");
}
