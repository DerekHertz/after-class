# Frontend review

[The reference fidelity correction](../frontend-v2/README.md) replaces the artwork and visual evidence here. The controller and fixture verification below stays as historical evidence.

The implementation stack starts at [PR #44](https://github.com/DerekHertz/after-class/pull/44), above the design handoff in [#42](https://github.com/DerekHertz/after-class/pull/42). Nothing in it authorizes merging or deployment, and the owner gives final visual approval.

To run it, `git switch codex/frontend-validation` and run `bun scripts/preview-ui.ts`. The fixture server binds to loopback and runs the real React screens and controllers against a deterministic fake API, with no Jev, Claude, microphone or captured lecture. Its toolbar picks a scenario, releases pending operations, simulates speech and shows a ledger of every fake request.

## Implemented

- One workspace with three room skins and six vector companions, chosen independently.
- Versioned appearance preferences with recovery from bad values, a fallback when storage fails, companion visibility and reduced motion.
- Chronological dialogue, an anchored composer with an IME-safe single-submit shortcut, and the existing review actions.
- Evidence pinning and restore, provenance, missing and error states, scope browsing and focus return.
- Capture readiness and coverage, record editing, observation corrections, dispute resolution, concept-link decisions and usage views.

The artwork is a vector adaptation of the approved raster studies, not a claim of image parity.

## Verification

- [Eighteen appearance combinations](appearance-combinations.json) kept the typed draft, and the request ledger stayed at its initial reads.
- [Narrow checks](narrow-scenarios.json) rendered 17 states at 390px without horizontal overflow. They check rendering, not every interaction.
- Browser checks covered pinned evidence during a pending reply, evidence restoring from 6:42 to 8:00, citation focus return, keyboard submit, identical turn IDs on retry, simulated speech across switches, save-failure recovery and notebook edits.
- Unit and controller tests cover bad preferences, missing storage, IME, repeat and empty input guards, per-turn evidence, and retry and save semantics.
- With Bun 1.4.4, typecheck passed, 941 tests passed with 4 existing TODOs and 0 failures, and all builds passed. PRs #44 through #47 passed CI on Bun 1.4.3.

Captures use deterministic data: [Last Desk](last-desk.png), [Projection Booth](projection-booth.png), [Study Bench](study-bench.png), [notebook](notebook.png), [appearance choices](appearance-picker.png) and [narrow review](narrow-review.png).

Not verified:

- Browser tests use fake speech, so a real microphone in Chrome on macOS is untested.
- The owner's visual review of companions, materials, tool art, typography, spacing and responsive layout is pending on the base PR.
- Passing checks says nothing about capture feasibility, model accuracy or learning effectiveness.
