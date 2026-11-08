# Linting

Run `bun run lint` after `bun install --frozen-lockfile`. CI runs lint in a separate job so lint failures do not prevent typechecking, tests, and builds from running.

Oxlint 1.90.0 is pinned in the lockfile. The configuration enables correctness checks for TypeScript and React, plus a hard maximum of 1,000 physical lines per JavaScript/TypeScript file, including comments and blank lines. It checks `src`, `scripts`, `test`, and `e2e`; generated output, data, and design prototypes are excluded. CSS and HTML are not covered by this command. Continue running typechecking and browser checks.

The line cap follows [Kun Chen's recommendation](https://x.com/kunchenguid/status/2118411953958010957). Split files by responsibility rather than compressing code or deleting useful comments to meet the cap. Split tests by behavior and extract only genuinely shared fixtures; keep independently meaningful assertions.

## Adoption and verification

PR #134's base and head originally reported 62 diagnostics, including seven files over the line cap. The follow-up fixes leave the strict command passing. The lab tooling is split into execution, CLI, draft-label generation, and proposal-schema modules. App, HTTP, provider, evidence, and review tests are split by behavior with shared fixtures.

Five narrow exceptions remain, each explained beside the code: synchronizing persistence errors and speech state with external systems, assigning a forwarded ref in a callback ref, and two test generators that intentionally throw before yielding. No rule is disabled globally.

The limit was checked with two temporary TypeScript fixtures: 1,000 lines passes and 1,001 lines fails. The linter is not configured for type-aware analysis; `bun run typecheck` remains a separate check.

## Browser checks

Run `bun x --no-install playwright install chromium` once, then `bun run test:browser`. CI installs Chromium and its system dependencies in a separate browser job. To use an installed Chrome locally, run `PLAYWRIGHT_CHANNEL=chrome bun run test:browser`.

The browser suite uses the local fixture preview and checks Saved notes in all three room skins at desktop and 320px widths, including editing, saving, cancellation, scrolling, Escape, focus restoration, and retrying notebook/evidence failures. It does not call live providers. Traces and screenshots are retained on failure in the ignored `test-results` directory.
