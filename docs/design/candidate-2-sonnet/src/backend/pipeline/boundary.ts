// pipeline/boundary.ts -- the per-capture boundary stage (flow B). THIN SHELL: all decisions are in core/{windowing,routing,invite}.
// Single writer of the capture's open chunk; runs under a per-capture serial queue (engine.ts), so there is no lock and no shared write.
import type { CaptureId } from "../../shared/domain/ids";
import type { Deps } from "../deps";

/**
 * pseudocode:
 *   await judgeFrameCandidates(d, captureId)                          // pipeline/frames.ts; kept frames exist before windows are cut
 *   loop:
 *     tl         = store.timeline.load(captureId)
 *     transcript = store.capture.transcriptAfter(captureId, tl.judgedThrough - contextSeqs)
 *     w          = nextWindow(captureId, transcript, keptFrames, tl.judgedThrough, cfg.window, flush)
 *     if !w: break
 *     stamp      = { questionSet: QUESTION_SET_VERSION, model: cfg.providers.jev.model }
 *     j          = store.timeline.cachedBoundary(w, stamp)             // "already-judged windows reuse cached judgment"
 *                  ?? toJudgment(await providers.jev.judgeBoundary(loadInput(w), ctx))   // errors already arrive as 'uncertain'
 *     t          = stepTimeline(tl, { tag:'window_judged', window:w, newConcept:j.newConcept, stoppingPoint:j.stoppingPoint, ... }, cfg.routing)
 *     closes     = t.commands.filter(close_chunk).map(toChunkRevision)         // ContentKey = contentKeyFor(evidence of that chunk)
 *     enqueue    = closes.filter(c => !store.jobs.isPrepared(c.contentKey)).map(interpretJob)   // cache hit => nothing queued
 *     invite     = closes.map(c => ({ tag:'chunk_closed', ... }))
 *     store.timeline.commit({ next: t.state, expectedJudgedThrough: tl.judgedThrough, judgment: j, closes, invite, enqueue })   // ONE tx
 *     wake job runner if enqueue.length > 0; push `prep_view` event
 *   on flush (session stop): stepTimeline(tl, { tag:'session_stopped' }) -> close with provenance 'session_end'
 *   boundary revision: after each commit, proposeBoundaryRevision(prevClosed, j) -> store.timeline.reviseBoundary -> cancel old-key jobs
 *     (store.jobs.cancel scope 'boundary_revision'), enqueue for the new key, notify an active review with a CorrectionNotice.
 */
export async function advanceBoundaries(d: Deps, captureId: CaptureId, opts: { readonly flush: boolean; readonly signal?: AbortSignal }): Promise<{ readonly closedChunks: number }> {
  throw new Error("not implemented");
}
