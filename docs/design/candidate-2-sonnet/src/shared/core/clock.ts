// core/clock.ts -- injected everywhere time is needed; tests and the replay sample use a fake.
import type { WallMs } from "../domain/time";

export interface Clock {
  wall(): WallMs;
  /** monotonic ms for latency measurement; never persisted as a timestamp */
  mono(): number;
}
export const systemClock: Clock = {
  wall: () => { throw new Error("not implemented"); },
  mono: () => { throw new Error("not implemented"); },
};
