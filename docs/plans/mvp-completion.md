# After Class MVP completion plan

This plan finishes the After Class MVP for Derek. Every module is built or in a fix round. What remains is composition (server, scheduler, wiring), a project verification skill, and the five approved experiments with their reports. The program enforces one rule. Nothing merges without an independent `VERDICT: PASS` at the exact head SHA. PRs are small and stacked where one builds on another, and land bottom-up. Order: M0, M1 and M2 first, then M3 to M8, then M9 and M10, then M11 to M15.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `playbooks/autopilot-stack.md` for building and stacking, and `playbooks/shipping.md` for landing. Derek authorized merging on an independent PASS, so the root lands the contiguous verified run from the stack root. M0 (CI) and every PR that spends subscription or Jev calls are Derek's items. They stop at merge-ready, or at run-ready for experiments, until he says go.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

Lane budget (Derek, 2026-11-03: lean). Three lanes per PR, run in sequence by one verifier agent that also runs the gates and the audit. Haiku for doc or one-file PRs, Sonnet high for logic. At most 3 agents run at once. Each PR section names its lanes.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to Derek, then stop. Start execution only on his explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:` is not available here. The pstack copies at `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/` stand in. Read `poteto-mode/playbooks/autopilot-stack.md`, `poteto-mode/playbooks/shipping.md`, `poteto-mode/playbooks/opening-a-pr.md`, `swarm/SKILL.md`, `show-me-your-work/SKILL.md`.
  - [ ] Read the project files `CLAUDE.md`, `src/MODULES.md`, `docs/flows/after-class.md` from `origin/master`.
- [ ] On Derek's go, arm the audit tick as `/loop 1h` with the tick prompt below.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On Derek's hold, send every owner a zero-writes order at once.
- [ ] Keep at most 10 agents running at once (Derek's swarm cap).

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle. Owners are `pstack:poteto-agent` on Sonnet 5.5 high, and Opus 5.5 high for M5, M6 and M7.
- [ ] Follow this dependency graph.
  - [ ] M0, M1 and M2 are independent and first. All branch from `master`.
  - [ ] M3 stacks on M1. M4 stacks on M3. M5 stacks on M1.
  - [ ] M6 stacks on M4 and M5 (rebased onto whichever lands second).
  - [ ] M7 stacks on M6. M8 stacks on M7.
  - [ ] M9 and M10 stack on M8.
  - [ ] M11 stacks on M9. M12 after M11's data exists. M13 after M12. M14 after M13. M15 after M14.
- [ ] Hold the file boundaries named in each PR's **Files.** block.
- [ ] Hold the review gate. M8 and M9 change an interaction. They wait for Derek's review with screenshots before merge.

### PR mechanics, for every PR

- [ ] Use `gh`. Origin is not installed. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**, with `gh pr create --base <parent-branch>`. A stack child targets its parent branch.
- [ ] Run `bun run typecheck` and `bun test` before the PR-facing push.
- [ ] Run the `no-comments` skill before review. `deslop` is not available in Claude Code, so the audit lane covers slop.
- [ ] Commit as Derek's GitHub noreply author (repo config). Never use his gmail.
- [ ] Rebase onto the parent branch before the code-ready report. Rebase again only at merge prep or on a conflict.

### Verdict and merge, for every PR

- [ ] One gates lane re-runs typecheck, tests and, where touched, `bun run build:ext` and the TLC `check.sh`.
- [ ] Live lanes per the PR's block drive the real surface through the `verify-afterclass` skill once M9 lands, and through `bun test` harnesses plus the Claude in Chrome tools before then.
- [ ] One audit lane reads the diff and receipts and distrusts the PR body.
- [ ] A rebase or minor fix gets a single verifier at the new head. A wording-only change gets none.
- [ ] Block only for a problem shown by a failing run at the head or a doc line the PR made wrong. Everything else is a follow-up.
- [ ] Land the contiguous verified run from the stack root bottom-up with `gh pr merge --merge`, retargeting each child to `master` after its parent lands.

### Boot recipe, for every live lane

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>` in a fresh worktree.
- [ ] `bun install --frozen-lockfile`, then start the backend with an empty data dir per the PR's lane. After M6 that is `AFTERCLASS_DATA=$(mktemp -d) bun run dev`. Wait for the `listening on 127.0.0.1:4317` log line.
- [ ] Drive only through HTTP with the pairing token, the review app in Chrome, or the extension in Chrome. No internal setters.
- [ ] Save every artifact to `/tmp/swarm-<pr-id>/worker-<n>/<slug>` and return the paths.

## Add CI for typecheck and tests (M0)

**Depends on.** None.

**Files.**

- [ ] Create `.github/workflows/ci.yml`.

**Build.**

- [ ] One job on `ubuntu-latest` that installs Bun 1.4.3, runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run build:ext`.

**You see.**

- [ ] A green `ci` check on the PR.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The workflow run log shows all four steps passing.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Trunk has no CI, so record that and gate a deliberately failing test commit on a scratch branch turning the check red. Save `ci-red.txt`. Pass when the check fails on the scratch branch and passes on the head.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. CI wall time.
- [ ] Probe. The workflow run duration.
- [ ] Baseline. Trunk has none. Record the head value.
- [ ] Rule. Fail above 5 minutes.

**Review gate.** Derek approves adding CI (derek-mode lists CI as propose-and-stop).

- [ ] Derek says go in chat.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Freeze the HTTP route table and wire encodings (M1)

**Depends on.** None.

**Files.**

- [ ] Edit `src/shared/wire.ts`.
- [ ] Edit `src/MODULES.md`.

**Build.**

- [ ] One `ROUTES` table naming every route the extension (W2) and app (W9) call, with request and response schemas, reconciled from both clients.
- [ ] `encodeMaterial` and `decodeMaterial` via `Material.canonical`.
- [ ] State in the contract that `clientSeq` starts at 0 per capture.

**You see.**

- [ ] `bun test test/wire.test.ts` lists one round-trip case per route.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/wire.test.ts` gains a round-trip per route and a Material encode and decode case. Run `bun test test/wire.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Trunk lacks a route table, so record that and gate every route W2's worker and W9's `createApi` call appearing in `ROUTES`. Save `routes.txt`. Pass when the grep of both clients finds no route missing from `ROUTES`.
- [ ] Lane 2. Feed each app fixture response through the `ROUTES` response schema. Save `fixtures.txt`. Pass when all parse.
- [ ] Lane 3. Encode a two-source Material, JSON round trip, decode. Save `material.txt`. Pass when equal.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. None user-visible. Test suite wall time.
- [ ] Probe. `bun test` at trunk and head.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Fail above 1.5x trunk.

**Review gate.** None. M1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Fix three verifier follow-ups in merged modules (M2)

**Depends on.** None.

**Files.**

- [ ] Edit `src/backend/providers/ledger.ts`, `src/backend/providers/claude.ts`, `src/backend/evidence/core.ts` and their tests.

**Build.**

- [ ] `ledger.summary()` reports null USD for a kind with no calls (R17).
- [ ] `claude.ts` clears the timeout timer right after `proc.exited`.
- [ ] `deriveGaps` treats a late failure at a span's start as inside it (`start <= at`).

**You see.**

- [ ] Three new failing-then-passing tests.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] One test per fix. Run `bun test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Run the three repro tests at trunk and head. Save `repro.txt`. Pass when all three fail at trunk and pass at head.
- [ ] Lane 2. A real `/bin/sh` child that exits slowly after its result. Save `timer.txt`. Pass when no late kill is sent.
- [ ] Lane 3. A usage summary with only unknown-cost Jev calls. Save `summary.txt`. Pass when no kind reports 0 USD without calls.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Test suite wall time.
- [ ] Probe. `bun test` at trunk and head.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Fail above 1.5x trunk.

**Review gate.** None. M2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Serve the backend with auth and the review app (M3)

**Depends on.** M1.

**Files.**

- [ ] Edit `src/backend/http.ts`.
- [ ] Create `test/http.test.ts`.

**Build.**

- [ ] `Bun.serve` on `127.0.0.1:4317`. `authorize` checks Host, Origin (the extension id and the app origin) and the pairing token.
- [ ] `GET /health`, `GET /usage`, and `/app/*` serving the bundled review app with the token in `<meta name="afterclass-token">`, SPA fallback.

**You see.**

- [ ] `curl -s 127.0.0.1:4317/health` returns `{"ok":true}`. A request with a wrong Host gets 403.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/http.test.ts` covers Host, Origin and token rejection, the meta injection and SPA fallback. Run `bun test test/http.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Trunk has no server, so record that and gate the server starting and `/health` answering. Save `health.txt`. Pass when 200.
- [ ] Lane 2. DNS-rebinding style request with `Host: evil.test` and a page Origin. Save `rebind.txt`. Pass when 403 for both.
- [ ] Lane 3. Load `/app/usage` in Chrome through the Claude in Chrome tools. Save `usage.png`. Pass when the page renders with no console error.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Cold start to `/health` 200.
- [ ] Probe. Time from launch to first 200, five runs.
- [ ] Baseline. Trunk has no server. Record head.
- [ ] Rule. Fail above 2 s median.

**Review gate.** None. M3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Accept capture facts from the extension (M4)

**Depends on.** M3.

**Files.**

- [ ] Edit `src/backend/http.ts`.
- [ ] Edit `test/http.test.ts`.

**Build.**

- [ ] `POST /ingest` calls `evidence.ingest`, returns `ackedThroughSeq`, capture view and invite. An empty `facts` array is a heartbeat. `GET /captures/:id` returns the evidence bundle with Material encoded.

**You see.**

- [ ] Posting a fixture fact stream returns `ackedThroughSeq` equal to its last contiguous seq.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Ingest, resend and heartbeat cases. Run `bun test test/http.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Trunk lacks ingest, so record that and gate a fixture capture posted twice. Save `ingest.json`. Pass when the bundle is identical after the resend.
- [ ] Lane 2. Build the extension, load it unpacked in Windows Chrome through the Claude in Chrome tools, pair it, open the popup. Save `popup.png`. Pass when the popup shows the backend connected.
- [ ] Lane 3. A batch with a fact for another capture. Save `reject.txt`. Pass when 400 and nothing stored.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Ingest latency for a 500-fact batch.
- [ ] Probe. Ten posts, median.
- [ ] Baseline. Trunk has none. Record head.
- [ ] Rule. Fail above 250 ms median.

**Review gate.** None. M4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Run background work with bounded concurrency (M5)

**Depends on.** M1.

**Files.**

- [ ] Edit `src/backend/scheduler.ts`.
- [ ] Create `test/scheduler.test.ts`.

**Build.**

- [ ] `pump()` collects demand from segmentation, frame judging and preparation, runs it through `memo.run` with per-provider limits and priority (boundaries before interpretation before resources), aborts work no longer demanded, skips frame judging when there is no previous frame, and runs `evidence.sweepExpired` daily.

**You see.**

- [ ] With fake tasks, a capture's demand drains to empty and no provider exceeds its limit.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Drain, limit, priority, abort-undemanded and crash-repump cases. Run `bun test test/scheduler.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Trunk lacks a scheduler, so record that and gate a fixture capture draining to prepared claims with fake tasks. Save `drain.txt`. Pass when demand is empty and claims are `supported_by_check`.
- [ ] Lane 2. Kill the process mid-drain and restart. Save `repump.txt`. Pass when it converges to the same state with no duplicate usage beyond the in-flight call.
- [ ] Lane 3. Stop early mid-drain. Save `stop.txt`. Pass when late results are logged and not applied (R8).

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Pump overhead per tick on a 4-hour fixture capture.
- [ ] Probe. Time `pump()` with all lookups cached.
- [ ] Baseline. Trunk has none. Record head.
- [ ] Rule. Fail above 200 ms per tick.

**Review gate.** None. M5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Compose the backend from its modules (M6)

**Depends on.** M4 and M5.

**Files.**

- [ ] Edit `src/backend/main.ts`.
- [ ] Create `test/main.test.ts`.

**Build.**

- [ ] Wire every module with real deps (`frameBytes` to evidence, `linkSuggestions` to record, Jev and `claude -p` providers, `SEGMENTATION_DEFAULTS`), read keys from `~/.config/afterclass/keys.env`, data dir from `AFTERCLASS_DATA`, print the pairing token once, and a replay mode that refuses live calls.

**You see.**

- [ ] `bun run dev` logs `listening on 127.0.0.1:4317` and the token.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] A test boots `main` in replay mode on a temp dir and drives one capture to prepared claims. Run `bun test test/main.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Trunk's `main.ts` is a sketch, so record that and gate boot from an empty data dir. Save `boot.txt`. Pass when ready within 2 s and `/health` is 200.
- [ ] Lane 2. Replay mode with a missing cassette entry. Save `replay.txt`. Pass when the call fails loudly and no network request is made.
- [ ] Lane 3. Start with no keys file. Save `nokeys.txt`. Pass when it starts, reports Jev unavailable, and never prints a key.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Boot to ready.
- [ ] Probe. Five boots, median.
- [ ] Baseline. M3 boot time.
- [ ] Rule. Fail above 2 s median.

**Review gate.** None. M6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Expose review, record and evidence routes (M7)

**Depends on.** M6.

**Files.**

- [ ] Edit `src/backend/http.ts`.
- [ ] Edit `test/http.test.ts`.

**Build.**

- [ ] Routes from `ROUTES` for invites, review options, start, NDJSON turns, record view and edits, evidence lookup, usage, and a retry-preparation route calling `preparation.retry`.
- [ ] `ReviewView.saved` reads the record's save state.

**You see.**

- [ ] A scripted review through HTTP saves a record with correct attribution.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] One test per route plus an end-to-end replay review. Run `bun test test/http.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks the routes, so record that and gate a replay review from start to saved record in Chrome. Save `review.png`. Pass when the record screen shows learner and tutor turns attributed.
- [ ] Lane 2. Nothing to review. Save `nothing.png`. Pass when gaps, unverified claims with evidence, rewatch links and Retry appear.
- [ ] Lane 3. Processing then Stop early. Save `partial.png`. Pass when the review is labeled partial.
- [ ] Lane 4. Resend a turn id after a dropped stream. Save `resend.txt`. Pass when one learner turn and one tutor turn exist.
- [ ] Lane 5. Dispute then settle as not a gap. Save `dispute.png`. Pass when the saved status is not a gap (R14).
- [ ] Lane 6. Skip a question. Save `skip.png`. Pass when it saves as not assessed (R13).
- [ ] Lane 7. Hint then answer. Save `hint.png`. Pass when capped at after help (R12).
- [ ] Lane 8. Detour proposed and declined. Save `detour.png`. Pass when no detour step occurs (R11).
- [ ] Lane 9. Save fails (read-only data dir) then Retry. Save `save.png`. Pass when one record exists (R15).
- [ ] Lane 10. Usage screen after the review. Save `usage.png`. Pass when unknown cost reads unknown, never $0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to first tutor sentence on a replay turn.
- [ ] Probe. Ten replay turns, median.
- [ ] Baseline. Trunk has none. Record head.
- [ ] Rule. Fail above 300 ms in replay (live latency is measured in M14).

**Review gate.** None. M7 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Close the review app's verifier follow-ups (M8)

**Depends on.** M7.

**Files.**

- [ ] Edit `src/app/*` and `test/app.test.ts`.
- [ ] Edit `src/extension/popup/popup.ts`.

**Build.**

- [ ] A discard or end escape for a permanently rejected unsent turn. The save banner tells the truth when local storage is degraded. IndexedDB writes resolve on transaction complete with an open timeout. Retry calls the retry-preparation route. The popup links to `/app/capture/<captureId>`.

**You see.**

- [ ] A rejected unsent turn shows Discard, and End works after it.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] One test per change. Run `bun test test/app.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Run a 409 on an unsent turn at trunk and head. Save `locked.png`. Pass when trunk soft-locks and head offers Discard and End.
- [ ] Lane 2. Retry on nothing to review. Save `retry.png`. Pass when preparation reruns.
- [ ] Lane 3. Open the popup's review link. Save `link.png`. Pass when it lands on the capture screen.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. App bundle size.
- [ ] Probe. `bun build src/app/index.html` at trunk and head.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Fail above 1.2x trunk.

**Review gate.** Derek reviews before merge.

- [ ] Post lane 1 and lane 2 screenshots in chat. Wait for Derek.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Create the verify-afterclass skill (M9)

**Depends on.** M8.

**Files.**

- [ ] Create `.claude/skills/verify-afterclass/SKILL.md` and `features/*.md` (and un-ignore that path in `.gitignore`).

**Build.**

- [ ] Run the `create-verification-skill` skill. Launch, doctor, drive (HTTP with token, review app and extension through the Claude in Chrome tools), evidence and cleanup. Feature map for capture, preparation, review, record and usage.

**You see.**

- [ ] A cold agent following the skill reaches a saved replay record.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Every helper script in the skill runs. Run each shown command.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks the skill, so record that and gate a cold agent proving one feature from the map. Save `cold.txt`. Pass when it reaches the end state with evidence.
- [ ] Lanes 2 to 10. One per feature-map journey (launch and doctor, capture ingest, segmentation trace, preparation, nothing to review, review now, dispute, save retry, usage). Save `<journey>.png`. Pass when each journey's end state holds.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time for a cold agent to reach a ready instance.
- [ ] Probe. Three cold runs.
- [ ] Baseline. Trunk has none. Record head.
- [ ] Rule. Fail above 5 minutes.

**Review gate.** Derek reviews the skill before merge.

- [ ] Post the skill path and lane 1 evidence in chat. Wait for Derek.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Add a replay end-to-end test (M10)

**Depends on.** M8.

**Files.**

- [ ] Create `test/e2e.test.ts` and `test/fixtures/capture-*.json`.

**Build.**

- [ ] A recorded fact log and memo cassette driven through the composed backend from ingest to saved record, run in `bun test`.

**You see.**

- [ ] `bun test test/e2e.test.ts` passes offline.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The e2e case. Run `bun test test/e2e.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Trunk lacks the test, so record that and gate it failing when a rule clamp is removed. Save `mutant.txt`. Pass when the mutant fails the test.
- [ ] Lane 2. Run with the network disabled. Save `offline.txt`. Pass when it passes.
- [ ] Lane 3. Replay the fixture twice. Save `idem.txt`. Pass when the record is identical.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. e2e test wall time.
- [ ] Probe. Five runs.
- [ ] Baseline. Trunk has none. Record head.
- [ ] Rule. Fail above 10 s.

**Review gate.** None. M10 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Run the capture probe with Derek (M11, experiment 1)

**Depends on.** M9.

**Files.**

- [ ] Create `scripts/probe-report.ts` and `docs/experiments/01-capture-probe.md`.

**Build.**

- [ ] A report script that checks pass bar 1 from a capture bundle. A step-by-step script for Derek built with the `mattpocock-skills:wizard` skill.

**You see.**

- [ ] The report prints each bar with its measured value and pass or fail.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The report script on fixture bundles that pass and fail each bar. Run `bun test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet high` at the PR head, per the boot recipe (budgeted to one, Derek runs the real capture).

- [ ] Lane 1. Regression lane against trunk. Run the report on Derek's real bundles. Save `probe-report.md`. Pass when every bar is reported with evidence, pass or fail, and nothing is tuned after the fact.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Capture overhead on playback (dropped video frames).
- [ ] Probe. Chrome media stats with capture on and off, same clip.
- [ ] Baseline. Capture off first.
- [ ] Rule. Fail above 1 percent more dropped frames.

**Review gate.** Derek runs the capture and reviews the report.

- [ ] Derek's go in chat.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Measure Jev boundaries and frames (M12, experiment 2)

**Depends on.** M11.

**Files.**

- [ ] Create `scripts/jev-lab.ts`, `docs/experiments/02-jev-lab.md`, `docs/experiments/labels/*.json`.

**Build.**

- [ ] Draft labels for Derek's correction, the tune and held-out split, at most 3 tuning rounds, the scored run, and a report against pass bar 2 with measured Jev usage.

**You see.**

- [ ] The report prints held-out recall, false closes per 15 minutes, visual steps lost and duplicates dropped.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Scoring functions on hand-made label sets. Run `bun test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Re-score the held-out run from stored judgments. Save `rescore.txt`. Pass when it reproduces the report's numbers exactly.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Jev call latency per window, read under the `benchmark-checklist` skill.
- [ ] Probe. All calls of the scored run.
- [ ] Baseline. None. Record p50 and p95.
- [ ] Rule. Report only. No target was approved.

**Review gate.** Derek corrects the labels before scoring and reads the report.

- [ ] Derek's label sign-off in chat.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Audit interpretation and compare models (M13, experiments 3 and 4)

**Depends on.** M12.

**Files.**

- [ ] Create `scripts/interp-audit.ts` and `docs/experiments/03-04-interpretation.md`.

**Build.**

- [ ] Interpret the held-out chunks with Opus 5.5 and Sonnet 5.5, blind the outputs, audit every claim against source, and report against pass bars 3 and 4.

**You see.**

- [ ] The report lists every claim Jev supported that the audit found wrong, with its evidence.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Blinding and tally functions. Run `bun test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Re-tally from the stored audit. Save `retally.txt`. Pass when it reproduces the report.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Interpretation latency and tokens per chunk per model.
- [ ] Probe. All calls.
- [ ] Baseline. Opus first.
- [ ] Rule. Report only.

**Review gate.** Derek spot-checks 10 claims and makes the model call if Sonnet matches Opus.

- [ ] Derek's verdict in chat.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Run two live reviews and measure them (M14, experiment 5)

**Depends on.** M13.

**Files.**

- [ ] Create `docs/experiments/05-live-reviews.md`.

**Build.**

- [ ] A checklist for Derek's two reviews (wrong answer, dispute, skip, detour offer) and a report from the saved records and usage ledger.

**You see.**

- [ ] The report shows the R12, R13 and R14 checks and the time to first spoken word.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Report generation on a fixture record. Run `bun test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Re-derive the report from Derek's saved records. Save `review-report.md`. Pass when each check matches the record.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to first spoken word per tutor turn.
- [ ] Probe. Every turn in both reviews.
- [ ] Baseline. None. Record p50 and p95.
- [ ] Rule. Report only, no target yet.

**Review gate.** Derek runs both reviews.

- [ ] Derek's go in chat.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Publish the labeled replay sample and runbook (M15)

**Depends on.** M14.

**Files.**

- [ ] Create `samples/strang-18.06-l1/` and edit `README.md`.

**Build.**

- [ ] A replay sample from the MIT capture with attribution (CC BY-NC-SA), labeled as replay, plus a runbook written under the `technical-writing` and `unslop` skills.

**You see.**

- [ ] `AFTERCLASS_MODE=replay bun run dev` serves the sample with a visible replay label.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The e2e test runs on the sample. Run `bun test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Lanes per the boot recipe, run in sequence by one verifier (lean budget).

- [ ] Lane 1. Regression lane against trunk. Follow the README from a fresh clone. Save `fresh.png`. Pass when the replay review opens.
- [ ] Lane 2. Replay with network disabled. Save `offline.png`. Pass when it works and makes no call.
- [ ] Lane 3. Check every screen shows the replay label. Save `labels.png`. Pass when no screen implies live capture.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Sample size on disk.
- [ ] Probe. `du -sh samples/`.
- [ ] Baseline. None.
- [ ] Rule. Fail above 50 MB.

**Review gate.** Derek approves publishing the sample.

- [ ] Derek's go in chat.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to Derek per the `ketchup` skill, then run the `reflect` skill on the run.

## Appendix A. Prototype evidence

No prototype ran for this plan. The open empirical questions (caption access, canvas readback, subscription login under `--restricted`, Jev image accuracy) are answered by M11 to M13, not assumed.

## Appendix B. Alternatives rejected

- Ten live lanes on every PR. Rejected as the default because most PRs are small backend units with no UI. Kept for M7 and M9.
- One large composition PR. Rejected because it can't be reviewed in one sitting.

## Appendix C. Risks

- YouTube DOM selectors and event order are unverified until M11. The W2 videoId source is a known blocker condition.
- `claude -p` login under `--restricted` is unverified until the first M13 call.
- Subscription usage is shared with this development session.

## Appendix D. Links and reading list

- `docs/flows/after-class.md`, `docs/design/SYNTHESIS.md`, `src/MODULES.md`, `docs/research/jev-api.md`.
- `how` before M5 and M6. `interrogate` on the M1 route table and the M5 scheduler design.
- Decision trail per the `show-me-your-work` skill at `docs/trail/mvp.md`.
