// test/rules.test.ts -- one entry per Derek rule. [TLC] rules are enforced STRUCTURALLY (types / SQL / single decision point) and
// re-checked here by property tests over the same pure reducers the TLA+ model abstracts, so the model and the code cannot drift silently.
// Each todo names the enforcement site. Workers replace test.todo with real tests as they fill the sketch bodies.
import { describe, test } from "bun:test";

describe("R1 evidence only from watched intervals", () => {
  test.todo("property: for any CaptureEvent stream, every materialized evidence interval is within the union of plausible watched_span intervals  [core/coverage.selectCoveredSegments, store.capture.append]");
  test.todo("transcript track arriving AFTER the watching still yields evidence only for watched time (late-track materialization)");
});
describe("R2 ad time never becomes evidence", () => {
  test.todo("spanTracker: no watched_span is opened or extended between ad(showing=true) and ad(false); ticks with contentLikely=false are ignored  [extension spanTracker]");
  test.todo("ingest: a span whose growth exceeds rate*wall elapsed, or end > duration, is quarantined and adds no coverage  [core/coverage.spanPlausible]");
});
describe("R3 only checked claims judge answers", () => {
  test.todo("type test: acceptTutorMove's claim and ReviewState.claims are SupportedClaim; tsc fails if a Claim is passed  [@ts-expect-error]");
  test.todo("acceptTutorMove rejects a claimId that is unverified/dropped/outside scope: claim_not_askable  [core/review]");
});
describe("R4 at most one revision", () => {
  test.todo("property: any event sequence through claimStep yields versions.length <= 2 and at most one 'revising' entry  [core/claimMachine]");
});
describe("R5 Later never cancels preparation", () => {
  test.todo("type test: chooseLater/chooseWait return Transition<_, never>; only chooseStopEarly can emit cancel_pending  [core/invite]");
  test.todo("e2e (fake providers): choose Later, settle(): every queued claim reaches a finished status");
});
describe("R6 pending resource search never blocks review", () => {
  test.todo("reviewReadiness result is identical with and without a running resource_search job (function has no such input)  [core/prep]; architecture rule 'R6'");
});
describe("R7 scope never grows", () => {
  test.todo("property: applyCorrection preserves scope reference; askableClaims(state).every(c => c.evidence ⊆ scope.evidence)  [core/review]");
});
describe("R8 cancelled or outdated results never overwrite", () => {
  test.todo("jobs.applyResult after cancel(): returns applied:false, claims unchanged, stale_results has a row  [store/jobs]");
  test.todo("boundary revision changes ContentKey; result of the old-key job is stale_results only; notes table untouched  [store/jobs, store/review]");
});
describe("R9 capture and review are independent", () => {
  test.todo("architecture rule 'R9' (core/review imports no capture modules); e2e: stop capture mid-review, review continues; begin review, capture continues");
});
describe("R10 never starts with zero supported claims", () => {
  test.todo("type: ReviewStart.started.claims is NonEmpty; startReview with no supported claims returns nothing_to_review  [core/review]");
});
describe("R11 detour needs a yes", () => {
  test.todo("acceptTutorMove(detour_proposal) only ever produces DetourState.proposed; start_detour is emitted only by onLearnerTurn(accept_detour)  [core/review]");
});
describe("R12 help before the answer cannot be independent", () => {
  test.todo("property: for any turn log, if isHelp(t) precedes the cited answer then clampObservation status is never independent|partial  [core/clamp]");
});
describe("R13 skipped or unanswered is never understood", () => {
  test.todo("property: a question with no learner 'answer' turn clamps every proposal to not_assessed  [core/clamp]");
});
describe("R14 disputed is not a gap unless I resolve it so", () => {
  test.todo("countsAsGap is false for dispute open|unsettled; true only for resolved(learner_gap) with status unresolved|after_help  [core/clamp]");
});
describe("R15 retrying a save never duplicates", () => {
  test.todo("commitRecord(draft) twice: row counts unchanged, learner userText preserved  [store/review, backend/ids natural ids]");
});
describe("R16 cited evidence is never deleted by expiry", () => {
  test.todo("expireUncited with a live citation: row survives; raw DELETE of a cited row is aborted by the trigger  [store/capture]");
  test.todo("deleteByUser flips citation to deleted (tombstone) before delete; note shows 'evidence deleted'");
});
describe("R17 every paid call records usage; unknown is not zero", () => {
  test.todo("metered(): ok, provider_error, timeout, parse_error and abort each append exactly one usage event; Jev rows have cost_kind 'unknown'  [providers/metered]");
  test.todo("schema CHECK rejects cost_kind='unknown' with a cost_usd, and a known kind with NULL  [store/usage]");
});
