# PR #134 follow-up verification

Reviewed and modified locally on top of PR head `92956972e33374b30b0e93cca24bb0f1befbb4fa`. This report records local verification before publication to the PR.

## Changes

- Installed Bun 1.4.3 and pinned Oxlint 1.90.0. Strict correctness lint and the 1,000-physical-line limit pass with no warnings. The earlier 62 diagnostics were pre-existing; see the historical `pr134-local-verification.md` and `pr134-lint-findings.tsv` for the initial assessment.
- Fixed unused symbols, expression/regex issues, sparse-array construction, effect dependencies, and render-time ref writes. Preserved snapshot iteration for listener collections. Async loads now use stable callbacks and derive loading state from request identity; frame images retain cleanup and stale-request protection.
- Retained five documented, single-line exceptions for intentional synchronization/ref assignments and generators that deliberately throw before yielding. No global rule exclusions were added.
- Split lab execution from CLI and draft-label generation; moved proposal types and validation into their own schema module. Updated callers to import from the responsible module.
- Split app tests into views, transport, speech/storage, and session behavior; HTTP into transport/auth, review, and record/evidence; providers into Jev, Claude, and ledger/memo; evidence into ingestion and storage; reviews into core, corrections, and turns. Shared fixture modules avoid duplicated setup. Existing behavior assertions remain.
- Consolidated extension packaging checks onto one shared production build plus a separate autostart build (two builds instead of four). The resource walker resolves URLs relative to each referencing HTML/CSS file, traverses nested stylesheets, and checks missing files, external URLs, path traversal, and symlink escapes. Eight focused tests cover the walker.
- Added Playwright checks across desktop (1440px) and narrow (320px) layouts: Saved notes in three room skins, edit/save/cancel, scrolling, overflow, dialog focus/Escape, notebook retry, and evidence retry with a decoded frame. Added an independent CI browser job and included browser code in lint/typechecking.

## Results

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass; lockfile unchanged |
| `bun run lint` | Pass; zero warnings/errors |
| `bun run typecheck` | Pass |
| `bun test` | See exact final summary below |
| `PLAYWRIGHT_CHANNEL=chrome bun run test:browser` | 10 passed, 0 failed; 33.7s |
| `bun run build:ext` | Pass |
| `bun run build:app` | Pass |
| `bun run scripts/preview-ui.ts --build-only` | Pass |
| `git diff --check` | Pass |

```text
 1661 pass
 4 todo
 0 fail
 63911 expect() calls
Ran 1665 tests across 72 files. [72.92s]
```

The first final-suite attempt reported 1,660 passes and one migration failure during transient disk exhaustion (the shell also reported “no space left on device”). After removing temporary review dependencies, the unchanged migration file passed all 33 tests, and the complete suite passed as shown above. No test was skipped to obtain the passing result.

Local raw logs: `/tmp/pr134-final-tests-recheck.log`, `/tmp/pr134-final-browser.log`, and `/tmp/pr134-migration-recheck.log`.

## Limits and remaining issues

Four existing TODO tests remain in the rules suite; they are not failures or new omissions from this change. Live provider calls, real YouTube capture, and the Linux CI environment were not exercised locally. The browser checks use fixture data and installed Chrome; CI is configured to install Playwright Chromium. These results establish functional layout behavior, not exhaustive visual approval of every pixel.

All scanned source/test JavaScript and TypeScript files are below the limit; the largest is `scripts/jev-lab-propose.ts` at 945 lines. The split boundaries and shared packaging build address the outstanding modularity and test-consolidation recommendations. No additional confirmed blocker was identified in the checks described here.
