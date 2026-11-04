# Common brief for After Class workers W1-W9

Derek's goal: a working After Class MVP. A local Chrome MV3 extension captures YouTube lectures in Windows Chrome, a Bun backend in WSL prepares them with Jev (narrow typed judgments) and Claude (interpretation and tutoring via `claude -p`), and a React review view runs source-grounded Socratic reviews with a faithful local learning record. The first milestone is a real capture-to-review path on two lectures.

Before any work, read in full:
- poteto-mode: /home/dhertzell/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/poteto-mode/SKILL.md (and the Claude Code adapter at .../pstack/0.15.36/docs/harness/claude-code.md).
- In the repo: CLAUDE.md, src/MODULES.md (your exact files, tables and frozen exports; its working rules are binding), docs/design/SYNTHESIS.md, docs/design/candidate-1-opus/DESIGN.md (the base design), docs/flows/after-class.md (approved flow, Derek's rules R1-R17 verbatim, pass bars), and the sketch files you own (their TODO pseudocode is your spec).
- As needed: src/shared/domain.ts, src/shared/time.ts, src/shared/wire.ts, src/backend/db.ts, src/backend/providers/memo.ts, test/fakes.ts, docs/research/jev-api.md.

Rules:
- You work in your own git worktree. First `git checkout -b <your branch>` from master. Commit there in small verified units; never merge, never push, never touch master.
- Edit only the files your MODULES.md row owns, plus: your own `test/<module>.test.ts`, your own array inside `MIGRATIONS` in src/backend/db.ts, and deleting the `test.todo` lines in test/rules.test.ts for rules you now test for real. If a frozen contract (anything in shared/, memo.ts, another module's exports) blocks you, do not edit it: work around it minimally if safe, and report the exact change you need.
- No new dependencies. No live Jev or Claude calls; use `fakeTask` and fixtures. No network calls of any kind except where your brief says so.
- Quote Derek's rules verbatim as `Rn: "<exact text>"` where code enforces one. Never reword them.
- Comments only for a non-obvious why. Test behavior, not implementation.
- Before reporting: `bun run typecheck` and `bun test` both pass in your worktree.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commit with `git commit (repo config already sets the author)`.

Report back: branch name, commit list, what you built, test and typecheck output (counts), every deviation from the sketch and why, any frozen-contract change you need, and what remains unverified (e.g. needs real Chrome or a live call).

## Report shape (Derek, 2026-11-03)
Final report 300 words or fewer: branch, commit list, test counts, deviations and frozen-contract changes, what is unverified. Hand test runs and log reading to a Haiku runner when you can. Stop and report if a second fix round on the same PR is needed.
