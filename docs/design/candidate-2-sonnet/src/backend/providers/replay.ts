// providers/replay.ts -- the labelled replayable sample (PRD: "label replayed data; distinguish from live capture").
//
// A cassette maps hash(port method + canonical input) -> recorded output + recorded usage. Replay providers look inputs up,
// write a ledger event with provenance 'replay' (cost unknown, tokens from the cassette) and never touch the network.
// A miss throws ReplayMiss (tests fail loudly; the sample never silently calls a paid API).
import type { Providers } from "./ports";
import type { Ledger } from "./metered";
import type { Clock } from "../../shared/core/clock";

export interface Cassette { readonly version: 1; readonly label: string; readonly entries: Readonly<Record<string, unknown>> }

export class ReplayMiss extends Error {}

export function replayProviders(cassette: Cassette, ledger: Ledger, clock: Clock): Providers {
  throw new Error("not implemented");
}

/** wraps real providers; appends every (input, output, usage) to the cassette file. Used once to author the sample. */
export function recordingProviders(real: Providers, cassettePath: string): Providers {
  throw new Error("not implemented");
}
