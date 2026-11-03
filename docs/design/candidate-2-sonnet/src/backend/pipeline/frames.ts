// pipeline/frames.ts -- frame candidates -> kept | dropped (flow B bottom half). Runs inside the boundary stage.
import type { CaptureId } from "../../shared/domain/ids";
import type { Deps } from "../deps";

/**
 * pseudocode, in viewSeq order per source:
 *   for each candidate c (covered by watched coverage; uncovered ones wait):
 *     before = last kept frame of the same source
 *     if !before:                         setDisposition(c, kept 'first_frame'); continue
 *     elig   = jevImageEligible(...) for both; if either ineligible:  keep 'uncertain' (flow: uncertain visual => keep)
 *     j      = cachedFrameChange(hash(before.sha, c.sha, nearbyCaptionsHash), stamp) ?? await jev.judgeFrameChange(...)
 *     yes -> kept 'jev_yes' ; no -> dropped ; uncertain|error -> kept 'uncertain'
 * Dropped frames keep their bytes until retention sweeps them (uncited only): "measure important steps lost by selection" needs them.
 */
export async function judgeFrameCandidates(d: Deps, captureId: CaptureId, signal?: AbortSignal): Promise<{ readonly judged: number }> {
  throw new Error("not implemented");
}
