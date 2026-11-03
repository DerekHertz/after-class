# After Class

Local app: a Chrome MV3 extension captures YouTube lectures, a Bun backend in WSL prepares them with Jev and Claude, and a React review view runs Socratic reviews.

- Approved flow, Derek's rules (R1–R17, quote verbatim), stack and pass bars: `docs/flows/after-class.md`. Product: `docs/After Class - MVP PRD.md`.
- Never invent or reword Derek's rules. Never claim capture feasibility, model accuracy or learning effectiveness without evidence; label mock, replay and live data.
- Dependencies: exact pins only, `minimumReleaseAge` 7 days, no `trustedDependencies`. Propose any new package (name, version, why) before adding it.
- Claude calls go through `claude -p --bare` (subscription). Jev uses `TYPESAFE_API_KEY`. Paid or subscription experiments outside the five listed in the flow doc need Derek's OK.
- Checks: `bun run typecheck`, `bun test`.
