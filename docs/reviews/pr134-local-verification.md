# PR #134: updated review

Reviewed head `92956972e33374b30b0e93cca24bb0f1befbb4fa` against base `9e3b65855cf3be9bfd7f8ddb8b6007413b689be2` on November 7, 2026 (America/Los_Angeles). No confirmed blocking regression was found. No review or issue was posted to GitHub.

## Local verification

Bun 1.4.3 was downloaded from the official oven-sh/bun release and installed in `~/.bun/bin`. The directory was added to zsh's PATH. This matches the PR's CI runtime version.

The exact PR snapshot passed `bun run typecheck`, `bun run build:app`, `bun run build:ext`, and `bun run scripts/preview-ui.ts --build-only`. The full suite passed with 1,653 passes, four existing TODOs, zero failures, and 63,915 assertions across 61 files. The first sandboxed attempt could not bind local HTTP servers; rerunning with localhost access passed. These tests use replay/fake providers and do not establish live capture or model quality.

## Lint findings

Oxlint 1.90.0, published October 27, was selected to satisfy the repository's seven-day package age requirement. Correctness checks and a hard 1,000-line limit are enabled for TypeScript/JavaScript under `src`, `scripts`, and `test`. Blank lines and comments count. CSS and HTML are outside this linter's scope. Type-aware linting is not enabled.

Both PR base and head produce 62 diagnostics across 156 files. The same findings occur on both revisions; the formatter changes the order/location of one missing-dependency diagnostic, but its dependencies and unchanged effect are identical. None establishes a new defect introduced by #134. See [the full findings](pr134-lint-findings.tsv).

| Category | Diagnostics |
| --- | ---: |
| Unused variables/imports | 19 |
| Files over 1,000 lines | 7 |
| React effects, dependencies, refs, and immutability | 13 |
| Other correctness/style findings | 23 |

Prioritize React findings for behavioral review; do not treat each diagnostic as a confirmed bug. For example, `src/app/front-row.tsx:233` assigns a supplied ref in a ref callback, which needs contextual assessment before changing it. Some test generators intentionally throw without yielding. Remove genuine unused imports separately from lifecycle changes.

| Existing oversized file | Physical lines |
| --- | ---: |
| `test/http.test.ts` | 1,538 |
| `test/review.test.ts` | 1,432 |
| `test/app.test.ts` | 1,393 |
| `test/providers.test.ts` | 1,143 |
| `scripts/jev-lab.ts` | 1,138 |
| `scripts/jev-lab-propose.ts` | 1,084 |
| `test/evidence.test.ts` | 1,011 |

Split these by responsibility or tested behavior. None is changed by #134. Every production file under `src` is below the cap.

## Remaining review recommendations

1. Add browser regression coverage for Saved notes at desktop and 320px: open, scroll long content, edit/save, Escape, and focus return. Static rendering and backend HTTP integration tests cannot establish these behaviors. The PR documents manual verification; this review did not repeat it.
2. Share one read-only production extension build among the three packaging assertions in `test/worker.test.ts:553-597`, keeping the autostart build separate. This reduces four builds to two without merging unrelated assertions. The optimization is small, not a performance blocker.
3. Resolve the packaging test's CSS URLs relative to each stylesheet, and check that paths stay inside the output directory. Current root-level asset paths work, but the test is fragile if stylesheets move.

## Local lint setup

The working checkout now has `.oxlintrc.json`, a pinned dependency and lockfile, `bun run lint`, a separate lint CI job, and `docs/linting.md`. These edits are uncommitted and not part of the reviewed PR head. This older checkout has 58 diagnostics, so the strict lint command currently fails; its CI job will also fail until the existing debt is triaged. No blanket suppressions were added.

`bun install --frozen-lockfile` succeeds with the new dependency. Temporary fixtures verified that 1,000 lines passes and 1,001 lines fails. Whitespace checks pass.
