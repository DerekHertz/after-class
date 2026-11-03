// domain/time.ts -- media time is the only time evidence knows (R1, flow A "never wall-clock").
//
// MediaMs and WallMs are different brands. A function that wants a position in the
// video cannot be handed Date.now(); the compiler rejects it. Wall time exists only as
// metadata (audit, retention, invites) and is typed WallMs.
import { z } from "zod";

export const MediaMs = z.number().int().nonnegative().brand<"MediaMs">();
export type MediaMs = z.infer<typeof MediaMs>;
export const WallMs = z.number().int().nonnegative().brand<"WallMs">();
export type WallMs = z.infer<typeof WallMs>;

/** Half-open [start, end) in media time. start < end is enforced by the parser. */
export const Interval = z
  .object({ start: MediaMs, end: MediaMs })
  .refine((i) => i.start < i.end, "empty or inverted interval");
export type Interval = z.infer<typeof Interval>;

/**
 * Canonical form: sorted, disjoint, and non-adjacent (touching intervals merged).
 * Only `normalize` and the set operators in core/intervals.ts construct one, so two
 * equal coverages are always structurally equal (hashable for cache keys).
 */
export type IntervalSet = readonly Interval[] & { readonly __normalized: true };
