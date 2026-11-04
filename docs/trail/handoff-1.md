# Handoff 1 (2026-11-03): where the MVP stands and how to continue

Read this first in a new session, then `CLAUDE.md`, `docs/flows/after-class.md` (the approved flow, Derek's rules R1 to R17 verbatim, the pass bars), `docs/plans/mvp-completion.md` (M0 to M15) and `docs/trail/mvp.md` (decisions and retros 1 to 4).

## The goal
After Class MVP for Derek: a Chrome MV3 extension captures YouTube lectures in Windows Chrome, a Bun backend in WSL prepares them with Jev (narrow typed judgments) and Claude (`claude -p`), and a React review app runs source-grounded Socratic reviews with a faithful learning record. Repo: https://github.com/DerekHertz/after-class (public, default branch `master`). Code lives only in `/home/dhertzell/AfterClass`, never in Derek's Obsidian vault.

## State at the end of this session
- Master was `a63a576` (retro 4 docs) plus this handoff. Typecheck clean. `bun test`: 926 pass, 4 todo, 0 fail (930 tests, 28 files) at the last full run on this head. No open PRs besides this one.
- Built and merged: CI (M0), route table (M1), small fixes (M2), interval helper (M2b), HTTP server (M3), ingest (M4), scheduler (M5), composition root (M6), review routes (M7a), record and evidence routes (M7b), review app follow-ups (M8, Derek approved screenshots), replay end-to-end test (M10), capture probe tooling (M11 tooling), plus fixes: detour answers no longer credit the main thread (R12, R13), a retry of a saved review is answered from the first save (R15), a code-written disclosure when the model fails twice, one bad claim no longer sinks a whole interpretation.
- Dropped by Derek: M9 (the `verify-afterclass` skill; PR #29 failed two verifier rounds on `cleanup.sh`'s `rm -rf` guard). Verifiers boot the backend by hand: `HOME=<scratch> AFTERCLASS_MODE=replay AFTERCLASS_PORT=0 AFTERCLASS_EXTENSION_ID=<dummy> AFTERCLASS_DATA=<scratch> bun run src/backend/main.ts`, then read the port and token from its log.
- Nothing has run in real Chrome yet. Not verified: `getVideoData().video_id` timing, YouTube navigation event order, the popup "Review now" button opening a tab, the real 5-minute stream deadline, the M11 wizard end to end, any live Jev or Claude call.

## The next thing: Derek runs the capture probe (M11)
```bash
cd ~/AfterClass && scripts/wizards/capture-probe.sh
```
Nine stages, about 15 to 20 minutes, Windows Chrome, free (replay mode, no Jev, no Claude). Derek supplies a lecture URL (MIT 18.06 Lecture 1 for chalkboard; do not guess a video id) and pastes the final `data/probe/probe-report.md` back unedited. Protocol and bar text: `docs/experiments/01-capture-probe.md`. If an ad does not play, the zero-ads bar reports NOT MEASURED, never PASS. If the wizard breaks, ask which stage and what it printed; the first real run is the first test of it. Do not tune any bar after seeing results. Record the result in `docs/experiments/01-capture-probe.md` (a results section) through a small docs PR.

## After M11 (all need Derek's go; paid or subscription calls only inside the five approved experiments)
- M12 Jev boundary and frame lab (about 800 Jev calls, `TYPESAFE_API_KEY`, max 3 tuning rounds, tune on first halves, score once on held-out second halves).
- M13 interpretation audit (about 8 Opus calls, at most 80 Jev checks) and the Sonnet vs Opus blind comparison.
- M14 two live reviews (R12, R13, R14 checks; time to first spoken word reported with no target).
- M15 replay sample (MIT 18.06 is CC BY-NC-SA, so it can be the sample) and README. The README is 15 lines today; drafting it needs no live data.
- Keys live in `~/.config/afterclass/keys.env` (mode 0600), read by the backend only. Never ask for a key in chat.

## Decisions waiting on Derek
1. R3 vs R14: should a claim that fails its recheck (not assessable) outrank "it was my gap"? The code follows R3 first today.
2. Branch protection on `master` requiring the `ci` check (not enabled).
3. Voice provider (parked): gpt-4o-mini-tts, ElevenLabs or Cartesia by blind listening test; Chrome speechSynthesis only as fallback.
4. Whether a pending delta's R3 window (claims judged while a delta is pending) is acceptable (a judgment call from PR #10).

## Standing rules (Derek's, keep in effect)
- Merge each PR once an independent verifier (one that did not write it) returns `VERDICT: PASS` at the exact head SHA. Report each merge.
- Never claim capture feasibility, model accuracy, cost savings, formal verification of code, or learning effectiveness without evidence; label mock, replay and live data. The TLA+ models verify the flow, not the code.
- Quote R1 to R17 verbatim; never invent or reword them.
- New dependencies: propose name, version and reason, then stop. Exact pins, `minimumReleaseAge = 604800`, no `trustedDependencies`.
- `claude -p` never uses `--bare`; strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` from the child env.
- Commit as `Derek Hertzell <97211702+DerekHertz@users.noreply.github.com>` (repo local config), never the gmail address. Commit trailer: `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- No deploy or publish without explicit authorization. Planning files go to the vault only after asking.
- derek-mode: show before changing, terse, show costs, one question per message; CI, dependency, key and agent-config proposals stop for approval (this is why the M9 skill needed his OK).

## How the work was run (copy this)
- One small PR per feature, branch from `origin/master`, `gh pr create --base master`. A worker builds on its own branch and does not push; the orchestrator pushes, opens the PR and sizes the review with `bun run scripts/risk-check.ts origin/master...origin/<branch>` (exit 0 light, 1 full). Light gets a Haiku verifier, full gets Sonnet high. At most 3 agents at once.
- Briefs: `docs/trail/briefs/worker-brief.md` and `docs/trail/briefs/verifier-brief.md`. The verifier builds its own failing input before reading the PR's tests.
- Converging review: findings tagged Important, Nit or Pre-existing; only Important fails. A fix round's verifier reads only the fix. A second failed round stops and asks Derek (M9 ended this way).
- After every push, check `git rev-parse HEAD` equals `git rev-parse origin/<branch>`. A detached HEAD once made a fix push silently not land and a verifier read the old head.
- Verifiers must use their own `git worktree add`, never another agent's worktree; one was switched to another branch mid-run.
- `gh pr merge` fails while the `ci` check is pending; wait for it. Use the `mcp__ccd_pr` tools, not `gh pr checks` polling. Never enable auto-merge unless Derek asks.
- Retro every 3 merged worker PRs (tally repeated failure classes, fix the cause in code before wording). Retro 5 is due after three worker PRs merged after #37. Known classes so far: non-idempotent retry; state checked then used later; half-open interval off by one; stale id or snapshot; a guard on an unnormalized path; a rule assumed but not enforced; a check that passes on silence.
- `.claude/worktrees/` holds dozens of stale agent worktrees (gitignored). Clean them when Derek agrees.

## Follow-up backlog (none blocks M11 to M14; small PRs when convenient)
Correctness-adjacent:
- Probe report (#36): conflicting duplicate `adChecks` entries (last wins; make any `isAd` win or NOT MEASURED); the frame ad question defaults to "no ad" on Enter or EOF while passage and span default to ad; a frame with missing bytes can be answered "no ad" unseen; extra out-of-range `adChecks` accepted silently.
- Evidence: a record write re-snapshot filter may drop evidence deleted but cited through a link (`src/backend/record/index.ts` about line 170; unverified); a resent duplicate `clientSeq` with different content silently drops the new content; `clientSeq` 1e15 is accepted and stalls the ack; frame files are written before the DB transaction (orphan on failure).
- Preparation: confusions, links or supersedes with unseen ids still fail the whole interpretation; a dropped claim is visible only in the stored memo output; attempt counting depends on the memo reusing the same input object within a run (`memo.ts` is frozen).
- Review: the stale tutor sentence can be spoken before an R3 repair; when the only claim is withdrawn the next turn still allows `ask_main` with zero usable claims; the disclosure fallback line does not read out evidence ids; `foldInvites` answered set per invite (wait, later, wait ignored); Review now is unavailable while a chunk is still preparing (narrower than the flow); dispute only after an answer, not after a skip.
- No server-side deadline on a model call beyond provider timeouts.
Minor:
- Scheduler: no priority aging; estimate samples include no-op runs; `stop()` hangs on a job that ignores abort.
- Popup fallback URL hardcodes port 4317; `discardUnsent` wording assumes the backend never stored the turn.
- `statSync` follows symlinks in the keys and token file checks (`lstat` is stricter); evidence lacks `allCaptures()`.
- A threadless dispute during a detour with no open thread sets no `openDispute`; no test for a skip during an active detour; unused imports in `review/tutor.ts`.
- Four `test.todo` placeholders remain in `test/rules.test.ts` (R3, R6, R8, R15); check whether other tests already cover them and replace each with a real test or delete it. R15 is now covered by the end-to-end and record tests.
- `src/MODULES.md` has no row owning `test/e2e-replay.test.ts`; the e2e `spyJev` and `spyClaude` providers are unreachable.
