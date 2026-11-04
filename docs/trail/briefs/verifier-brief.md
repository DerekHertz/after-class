# Lean PR verifier brief

You did not write this change. Read only CLAUDE.md, the rules your task names (quote them from docs/flows/after-class.md), and `git diff origin/master...origin/<branch>`. Open other files only when the diff calls into them.

1. `git fetch origin && git checkout -q origin/<branch>`, `bun install --frozen-lockfile`, `bun run typecheck`, then run only the test files the diff touches. Run the full `bun test` once, at the end.
2. Run the lanes your task lists, in order. Add one or two adversarial scratch tests (do not commit them) only for edge cases the PR misses.
3. Confirm the PR edits only files its src/MODULES.md row owns.

Keep it short: do not re-prove work the PR's tests already show. Do not push, commit or comment on GitHub. Put `VERDICT: PASS` or `VERDICT: FAIL` on the first line, then each finding with file:line, then what you could not verify. Use 15 lines or fewer.

## Review rules (Derek adopted 2026-11-03, from Dim Sum Dev)
- Tag every finding Important (a rule or correctness break), Nit, or Pre-existing. Only Important makes the verdict FAIL.
- A fix-round review reads only the fix commit and the findings it answers. Never repeat an earlier finding; name the bug class so one round fixes every instance.
- A second failed round stops the PR: report to the orchestrator, who asks Derek.
- Send long test or log runs to a Haiku runner if you can start one; otherwise run only the touched tests, and the full suite once.
- Final report 300 words or fewer.
- Tier: the orchestrator runs `bun run scripts/risk-check.ts` on the PR range. `light` gets a Haiku verifier, `full` gets Sonnet high.

## Reproduce before you read the tests (retro 4, 2026-11-03)
For a check, report or guard, build your own input that should make it fail (a bundle, a path, a stale head) and run the real code on it before reading the PR's tests. A check that prints PASS on an input it never looked at is Important.
