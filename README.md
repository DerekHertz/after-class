# After Class

A personal learning tool, in progress. A Chrome extension captures what you actually watched in a YouTube lecture (timestamped transcript and the frames that matter), a local Bun backend prepares it with narrow Jev judgments and Claude interpretation, and a review view runs a short, source-grounded Socratic discussion that saves an honest learning record.

Status: MVP under construction. Nothing here claims capture reliability, model accuracy or learning effectiveness yet; those are measured in the experiments listed in `docs/flows/after-class.md`.

- Product requirements: `docs/After Class - MVP PRD.md`
- Approved flow, rules and pass bars: `docs/flows/after-class.md`
- Formal lifecycle models (TLA+): `docs/flows/model/`
- Architecture: `docs/design/SYNTHESIS.md`, `src/MODULES.md`

```sh
bun install --frozen-lockfile
bun run typecheck && bun test
```
