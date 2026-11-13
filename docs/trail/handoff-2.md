# Handoff 2 (2026-11-13): where things stand and how to continue

Read this first in a new session, then `CLAUDE.md`, `docs/flows/after-class.md` and `docs/trail/handoff-1.md` (its standing rules still hold). This file is untracked in the main checkout; commit it through a small docs PR when convenient.

## Goal now

Derek wants After Class shippable as a real product ("10 users tomorrow, 100 next week"), built with scalability in mind and a stack tech professionals recognise, for a resume project. It stays a Chrome extension plus a web app. A friend studying marketing and psychology on YouTube is the first outside user.

## State

- Master is `476d2a4`. Typecheck, lint, about 1,610 unit tests and the Playwright browser suite pass.
- Merged this session: #154, #156 to #172 (all but #169), including:
  - #156 to #159: four finish-and-save bugs found by the TLA+ model.
  - #160: opt-in Messages API backend. Experiment 8 spent $1.92 of a $5 cap; Derek approved `@anthropic-ai/sdk` 1.5.0.
  - #161 to #165: test suite cleanup (about 60 s to 20 s).
  - #155: flow amendment for cluster screening, trace questions and topic importance (code not built yet: #147 to #149).
  - #166: a retried tutor call no longer leaks its JSON header into the live reply (adds `say_reset` to the wire, `onRetry` to memo.ts).
  - #167: capture and diagram polling resume after a failed read (#99 partly; `useReviewDiagrams` in `src/app/record.tsx` has the same one-shot poll, not fixed).
  - #168: `docs/flows/model/ReviewEnd.tla` models the code path from Finish to saved; `.claude/skills/verify-review-end/` says how to rerun it (`docs/flows/model/check-review-end.sh`, sync commit `920064e`).
  - #170: every offered Retry resends the failed live turn.
  - #171: the board scrolls to the tutor's question on open.
  - #172: `AFTERCLASS_CLAUDE_BACKEND=api` runs every Claude task on the Messages API (images, web search capped at 5 uses, pause_turn continuation, honest R17 costs). Never run live.

## Open work

1. **PR #173, rooms built from layers** (branch `feat/rooms-v2`, head `d3725ed`). Derek approved the art and asked for the canal fixes, which are in. Round 1 review PASS at `f70cfce`; fix round FAIL at `d3725ed`: a long topic label can run under Show diagram (harbor's absolutely positioned button; also phones).
   - Fix in progress, uncommitted, in worktree `/tmp/claude-1000/-home-dhertzell-AfterClass/1b6258b4-8d3e-4695-97ec-c79a545656cb/scratchpad/wt-173` on branch `fix/rooms-heading` (from `origin/feat/rooms-v2`):
     - `src/app/front-row.css`: the centred heading row is a 3-column grid (`minmax(0,1fr) minmax(0,max-content) minmax(max-content,1fr)`), the label wraps with `overflow-wrap: anywhere`, Show diagram sits in column 3. Harbor passes.
     - `e2e/front-row-layers.spec.ts`: new test sets two long labels (one unbroken word) in every room at 1440x900, 1470x1270, 1920x1080, 390x844, 320x700 and asserts the text never overlaps Show diagram or leaves the heading.
     - Still failing: rail (`last-desk`) and canal (`projection-booth`), the start-aligned rooms, at all sizes. Likely fix: `.front-row-scene .front-row-eyebrow { min-width: 0; overflow-wrap: anywhere; }` so the label's text can shrink and wrap beside the button. Then run typecheck, lint, `bun test`, `bun run test:browser`, commit, push onto `feat/rooms-v2`, and run a fix-round verifier.
   - Merge only after a PASS and Derek's OK on the look (he signs off on screenshots). Follow-ups after merge: room picker thumbnails and non-review pages still use the old plates; `preview.html` and `tools/rooms.json` in `docs/design/front-row/rooms-v2/` are stale.
2. **Architecture decision: written, waiting on Derek.** Local branch `docs/architecture`, commit `5bc6af0`, worktree `.claude/worktrees/agent-aeff2fd1f9434d3d5`, not pushed. Recommendation: Bun REST API and workers on AWS ECS Fargate behind an ALB, PostgreSQL on RDS with `user_id` and row-level security, S3 plus CloudFront, pg-boss jobs, Clerk, memo as the model gateway, Terraform, GitHub Actions. Closest calls: Postgres vs SQLite per user (the async rewrite of about 86 SQL call sites is the biggest cost), Fargate vs Cloud Run, pg-boss vs SQS. Needs Derek: a flow amendment for live calls outside experiments, who pays for model calls, each new dependency, and the copyright and privacy question of storing lecture content. Original brief below. Brief: weigh client, server, compute, database (Derek doubts Supabase), storage, jobs, caching, load balancing, auth, model gateway, observability, CI/CD and security; recommend a recognisable stack. Output on local branch `docs/architecture`: `docs/architecture/decision.md` and `docs/architecture/plan.md`, not pushed. If the session ended, check that branch in `.claude/worktrees/`. Bring the result to Derek before any code.
   - Context already given to Derek: the server is single-user today (one pairing token, one SQLite, in-process scheduler and memo, frames on disk, localhost-only host checks). The target discussed is a shared multi-user service: stateless API, Postgres with a user id per row, object storage for frames, a job queue with workers, accounts with extension sign-in, a model gateway with quotas and a shared content-addressed lecture cache.
3. **Draft PR #169, experiment 9 topic grouping with Jev** (issue #150). Waits for Derek to approve or edit the protocol, the draft bars and the draft flow lines. Paid; needs his OK to run.

## Decisions waiting on Derek

- The architecture recommendation, once written.
- Merging #173 after its review.
- PR #169's protocol.
- For shipping: hosting and database accounts, domain, Chrome Web Store developer account, licence, privacy note, a Console spend limit, and OK for the first deploy and the first live API run (the #172 paths have never made a live call).
- Older items from handoff-1 still open.

## Known gaps

- Nothing beyond a replay-mode browser check has run in real Chrome this session. The scratch backend recipe: `HOME=<scratch> AFTERCLASS_MODE=replay AFTERCLASS_PORT=4399 AFTERCLASS_EXTENSION_ID=<32 letters> AFTERCLASS_DATA=<scratch copy of the DB and frames> bun run src/backend/main.ts`, then open `http://localhost:4399/app/` with a same-origin navigation (the Host and Sec-Fetch checks refuse a direct automated navigation). Headless Playwright from the repo's node_modules works for screenshots.
- Voice narration is parked by Derek ("i didn't love the voice narration"); #100 left alone. Voice is off by default.
- Not fixed: extension control/outbox split and no stop fact on browser restart; source/transcript mislabelling on fast navigation; #151 font, #153 Narrator.
- The main checkout `/home/dhertzell/AfterClass` sits on old branch `fix/completion-unreached-topics` with untracked `prototypes/` and `docs/design/front-row/rooms-v2-brief.md` (the brief is also committed on `feat/rooms-v2`). Many old worktrees under `.claude/worktrees/` and the scratchpad `verify/` folder.

## How the work is run

- Derek's mode for now: `/pstack:poteto-mode`. Sonnet agents (`pstack:poteto-agent`, model sonnet, worktree isolation) implement; Fable sessions do art and judgment-heavy writing; the orchestrator pushes, opens PRs and merges.
- Independent verification: Codex `gpt-6.1-sol`, high effort, in its own detached `git worktree` under the scratchpad `verify/` folder after `bun install --frozen-lockfile`: `codex exec -m gpt-6.1-sol -c model_reasoning_effort='"high"' -s workspace-write --color never -o <verdict.md> - < <prompt.md>`. Its sandbox blocks listeners and Chromium, so HTTP and browser tests run only in CI or locally. A fix round's verifier reads only the fix.
- Merge on PASS at the exact head with CI green (`gh pr merge --squash --match-head-commit`), and report each merge. UI changes also need Derek's look.
- A force-push to an existing PR branch was blocked by the permission classifier; add commits or push a fast-forward instead.
- Art: Codex's built-in image tool (`codex exec ... -i <reference>`), Pillow only for mechanical steps, provenance recorded in the repo.
- PR and commit prose follows `docs/pr-writing.md`; commits as `Derek Hertzell <97211702+DerekHertz@users.noreply.github.com>` with a `Co-Authored-By: Claude <model>` trailer.
