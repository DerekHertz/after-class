# Setting up After Class on another machine

Written 2026-11-03 for moving from WSL and Windows Chrome to a MacBook; it works for any new machine. Read `docs/trail/handoff-1.md` after this.

## 1. Tools
- git and `gh` (`gh auth login`).
- Bun 1.4.3 (the repo pins it; `bun --version`).
- Claude Code, signed in to Derek's subscription (the app calls `claude -p`; never `--bare`).
- Chrome, to load the extension unpacked.
- Optional, only to rerun the TLA+ models: Java 11 or later and `tla2tools.jar` (`docs/flows/model/check.sh`).

## 2. The repo
```bash
git clone https://github.com/DerekHertz/after-class && cd after-class
git config user.name "Derek Hertzell"
git config user.email "97211702+DerekHertz@users.noreply.github.com"
bun install --frozen-lockfile
bun run typecheck && bun test
```
The repo is public, so always commit with the noreply address, never the gmail one. `bun test` should end with 0 failures (926 pass, 4 todo on 2026-11-03).

## 3. Skills and plugins
In the repo (project skills, loaded automatically when Claude Code runs in this folder):
- `.claude/skills/derek-mode/`: Derek's working style, on top of pstack's `poteto-mode`. `CLAUDE.md` wins over it.
- `.claude/skills/grill-the-flow/`: grill a plan, write the flow, have Derek write the rules, check with TLA+.

These are snapshots from 2026-11-03 of Derek's own user-level skills. If a newer copy exists in `~/.claude/skills/`, update the repo copy in a PR so the two do not drift.

Not copied, because they belong to other authors: install them from their marketplaces. These are the versions used on the original machine.
```bash
claude plugin marketplace add cursor/plugins
claude plugin install pstack@cursor-plugins            # 0.15.36: poteto-mode, statechart, ketchup, and the rest
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install mattpocock-skills@claude-plugins-official   # 1.3.1: wizard, grilling, writing-for-agents, tdd
claude plugin marketplace add typesafe-ai/skills
claude plugin install typesafe@typesafe-ai             # 0.5.7: Jev tools; only needed from M12
```
`derek-mode` finds pstack's adapter with `find ~/.claude/plugins/cache -path '*pstack*' -name claude-code.md`, so pstack must be installed. The original machine also has `~/.claude/rules/pstack-models.md` (which model each pstack role uses). Recreate it if you want the same budget:
```text
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# budget: medium (high)
feature, refactoring: sonnet high
bug-fix: sonnet high
perf-issue: sonnet high
hillclimb: sonnet high
judgment and prose: opus high
hardest tasks: opus high
how explorer: sonnet high
how explainer: opus high
why investigators: sonnet high
why synthesizer: opus high
reflect tooling: sonnet high
reflect judgment, divergent, synthesizer: opus high
arena runners: opus high, sonnet high
arena cross-judge pool: sonnet high, fable high
swarm workers: sonnet high
architect runners: opus high, sonnet high
interrogate reviewers: opus high, sonnet high
```
The project's own verification skill (`verify-afterclass`, M9) was dropped; PRs are verified by independent verifier agents (`docs/trail/briefs/`).

## 4. Keys and local state
- Keys: `~/.config/afterclass/keys.env`, mode 0600, read by the backend only. It holds `TYPESAFE_API_KEY` for Jev. The capture probe needs no keys. Never paste a key into chat, the repo or the extension.
- The pairing token is created on first backend start at `~/.config/afterclass/pairing-token` (0600).
- `AFTERCLASS_EXTENSION_ID` is the id Chrome shows for the unpacked extension; the capture-probe wizard writes it to `.env`, which git ignores.

## 5. What does not carry over
Claude's saved memory notes (`~/.claude/projects/...`), the scratchpad, the agent worktrees and the 5-hour usage window are per machine. The handoff and `CLAUDE.md` hold the standing rules, so a new session loses nothing that matters.

## 6. The capture probe on a Mac
Run `scripts/wizards/capture-probe.sh` from the repo root once the macOS wizard PR has merged (see `docs/experiments/01-capture-probe.md`).
