# MVP decision trail

Short entries: what was decided, by whom, why.

- 2026-11-03, Derek: stacked small PRs, merge when an independent verifier returns PASS. Plan: `docs/plans/mvp-completion.md`.
- 2026-11-03, Derek: lean agent budget. At most 3 agents at once; one verifier per PR running its 3 lanes; Haiku for light PRs, Sonnet high for full ones (`scripts/risk-check.ts`). Reports 300 words or fewer.
- 2026-11-03, Derek: adopted from Dim Sum Dev: runner leaves, risk-sized review, converging review (Important / Nit / Pre-existing; a second failed round asks Derek), a retro every 3 merged PRs. Skipped: usage gate, context-limit stop, 2-worker cap.
- 2026-11-03, retro 1 (counts come from the verifier reports in the orchestrator session; the reports are not kept in the repo) (merged #6, #14, #2 since the lean setup; nine worker PRs before). Repeated verifier failures, by class:
  1. Retry or resend not idempotent: #7, #2 (three findings), #6 outbox.
  2. State checked at one point and used at a later one (races): #2 R3 at commit, #6 pause/resume, #10 delta race.
  3. Half-open interval off by one: #5, #12 R7, evidence `<=`.
  4. Stale id or snapshot: #3 encodes, #6 video id, #2 correction ids.
  Fixes in code, before wording: (3) one interval helper in `src/shared/time.ts` with a property test, used by every module (plan section M2b). (2) a shared test helper that interleaves two events at a chosen point, used by M5 (scheduler) and M7. (1, 4) the M10 replay test resends every request and checks nothing duplicates.
- 2026-11-03, retro 2 (counts from the verifier reports in the orchestrator session, not kept in the repo) (merged #15, #16, #17, #19, #20, #21, #22, #23, #24; 3 of 9 failed their first review). Failures: #21 an accepted limit left undocumented (the token is readable by any local process); #22 a registration-order bug, class 2 above; #15 plan and trail disagreed. No new class, and far fewer repeats than retro 1. Speed note: workers wrote code before tests in M5; briefs now say test-first.
- 2026-11-03, Derek: M10 merged (#28). It found one product bug, recorded as a failing test: re-saving after an evidence delete runs a second paid wrap-up call.
- 2026-11-03, Derek: dropped M9 (the verify-afterclass skill). PR #29 failed two rounds: `cleanup.sh`'s `rm -rf` guard was bypassed by `..`, then by a trailing slash. Verifier lanes boot the backend by hand (plan, PR mechanics).
