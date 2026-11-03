// config.ts -- every tunable number in one place, each marked PROPOSAL (flow: "starting values to tune on held-out clips").
// Policies are passed into pure core functions as arguments; core never reads config itself.
import type { WindowPolicy } from "../shared/core/windowing";
import type { RoutingPolicy } from "../shared/core/routing";
import type { InvitePolicy } from "../shared/core/invite";
import type { ReviewConfig } from "../shared/core/review";
import type { ProviderConfig } from "./providers/index";

export interface AppConfig {
  readonly dataDir: string;
  readonly host: "127.0.0.1" | "0.0.0.0"; // WSL: Chrome on Windows reaches 127.0.0.1 via WSL localhost forwarding; fallback 0.0.0.0 + token
  readonly port: number;
  readonly window: WindowPolicy;
  readonly routing: RoutingPolicy;
  readonly invite: InvitePolicy;
  readonly review: ReviewConfig;
  readonly providers: ProviderConfig;
  readonly retention: { readonly uncitedTtlMs: number }; // 30 days
  readonly jobs: { readonly maxAttempts: number; readonly jevConcurrency: number; readonly claudeConcurrency: number; readonly leaseMs: number };
}

export function defaultConfig(env: Record<string, string | undefined>): AppConfig {
  throw new Error("not implemented");
}
