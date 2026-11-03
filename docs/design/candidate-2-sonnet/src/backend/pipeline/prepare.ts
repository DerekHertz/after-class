// pipeline/prepare.ts -- handlers for interpret / claim_check / claim_revise / resource_search. Each is: load inputs -> call a port -> return JobResult.
// They never write claims; applyResult does (and fences). They hold no state.
import type { Deps } from "../deps";
import type { JobHandlers } from "./jobs";

/**
 * interpret(job):  chunk = store.timeline.byContentKey(job.target.contentKey); evidence = store.capture.get(chunk.evidenceIds)
 *     (tombstones skipped); drafts = await claude.interpret(...); each draft -> validateDraft(...) => {version, invalid}
 * claim_check(job): claim = store.jobs.claims(key).find(id); version = claim.versions[job.target.version - 1];
 *     passages = cited transcript evidence; frames = cited kept frames (packFrames); r = await jev.checkClaim(...)
 *     check = { verdict: r.supported.verdict, probability, judgmentId }       // error arrives as 'uncertain' => goes to the one revision
 * claim_revise(job): await claude.revise({ claim: versions[0], checkVerdict, evidence }) -> validateDraft -> version 2
 *     (the claim may revise ONLY once: the job target is `version: 2`, and applyResult refuses claimStep(revised) outside 'revising')
 * resource_search(job): for SUPPORTED claims only; stores citations + relevance via a resources table; failure => result 'failed', nothing else.
 *     Never read by reviewReadiness (R6).
 */
export function prepHandlers(d: Deps): JobHandlers {
  throw new Error("not implemented");
}
