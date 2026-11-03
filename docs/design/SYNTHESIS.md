# Architecture synthesis

Arena of two design candidates, 2026-11-03. Both packages are kept next to this file for reference.

- Candidate 1 (Opus 5.5, high effort): "facts in, derivations out, memoized calls". 27 sketch files.
- Candidate 2 (Sonnet 5.5, high effort): "pure reducers under thin IO shells, content-addressed store, fenced job table". 75 sketch files.

Cross-judge skipped. The arena rule wants a judge from a different model family than the parent. Every configured model is Claude, so no judge qualified, and the base was picked by the orchestrator alone.

## Rubric (fixed before reading the candidates)

| # | Criterion | C1 | C2 |
| --- | --- | --- | --- |
| 1 | Derek's rules encoded in types or structure, not prose | Strong. R8 holds by construction (outdated results are never looked up). R4 single slot with claims keyed by evidence, so a boundary move keeps unchanged claims and their used revision. | Strong. Explicit R8 SQL fence. R16 DB trigger. But a boundary revision recomputes every claim in the chunk, which re-opens the R4 TLC break ("same claim, second revision"). |
| 2 | Interface depth: small public surface, deep modules, ≤3 files to trace | Deeper. No job table; one `memo.run` path does cache, staleness, cancel, metering and replay. | Wider. 22-route Engine, job leases, a mutable `open_chunk` row. |
| 3 | Lifecycles explicit and pure-testable | Derived folds over facts; `allowedMoves` state machine. | Explicit `Transition` reducers with `never`-typed forbidden moves. Slightly more legible per lifecycle. |
| 4 | Boundary discipline (zod at wire, domain inside) | Yes (`wire.ts`, memo decode). | Yes (domain + zod, providers own wire). |
| 5 | Parallel split, ≤10 workers, disjoint files | Kernel then 9 workers. | Foundation then 10 workers. |
| 6 | MVP fit and laziness | Smaller, fewer concepts. | More machinery than the MVP needs (leases, crash recovery, route-table codegen). |

**Base: candidate 1.** It wins on 1, 2 and 6 and ties on 4 and 5. It also resolves four of the six TLC breaks structurally (R3 and R4 via evidence-keyed claims, R7 via frozen `scope.material`, R8 via the content-keyed memo plus `Seq` cutoff).

## Grafts from candidate 2

1. **Header-first tutor output.** C1 streams prose then a `<<<MOVE>>>` tail, so speech could start before `validateMove` runs. C2 puts the move header first so the gate passes before any word is spoken. Adopted: the tutor emits a JSON move header line, code validates it, then prose streams. This is what makes R3 and R11 hold in speech, not just in the saved record.
2. **R16 as a DB trigger plus tombstoned user deletion**, in addition to C1's live join. Expiry SQL also says `NOT EXISTS`. Pending saves count as citing (the TLC R16 fix).
3. **Ad detection fails closed.** DOM ad class OR duration mismatch; backend quarantines spans that grow faster than wall time or exceed duration (R2).
4. **Client-allocated `TurnId` and `ReviewId`.** A retried request is the same request (R15 for turns, not only for the final save).
5. **Local server hardening.** Host header match (DNS rebinding), Origin allow-list, pairing token. No CORS `*`.
6. **JPEG frames capped at 1280 px longest side at capture**, so they satisfy Jev's 280–1568 px bounds without a backend image decoder. PNG is a one-line switch if equations soften.
7. **R14 clamp**: an observation with an open or unsettled dispute is saved as `disputed`, never as a learning gap (the TLC R14 fix; C1's `isLearningGap` already excludes it, C2 states the clamp explicitly).

## Rejected from candidate 2

- Job table with leases and an R8 fence. C1's derived demand makes it unnecessary.
- Route-table-generated Engine and client. More surface than the MVP needs; plain routes plus a small typed client.
- Chunk-scoped claim recompute on boundary moves (re-opens R4).

## Corrections applied to both

- `claude -p --bare` never reads subscription login (`claude --help`). Calls use `--restricted --tools Read --strict-mcp-config --disable-slash-commands --system-prompt … --no-session-persistence` instead. Untested; the first live call confirms login works.
- `@anthropic-ai/sdk` is dropped from the stack. Claude goes through the CLI only.

## Open product questions (defaults applied, Derek to confirm)

These came up in the candidates. Each default is reversible and lives in one place in code.

1. After an automatic pause for leaving YouTube, capture waits for Derek to resume. It never resumes on its own.
2. "I don't know" with no later answer is saved as `unresolved`.
3. `after_help` is not counted as a learning gap.
4. A caption segment is evidence only if fully inside watched time (strict R1); partly watched segments are flagged, not used.
5. A `session_end` close sends no invite; Review now stays available.
6. R12 counts declared help only (`hint`, `explain`, correction disclosure). Detecting a follow-up that leaks the answer is parked.
