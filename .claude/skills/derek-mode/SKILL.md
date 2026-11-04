---
name: derek-mode
description: "Work in Derek's style: pstack's poteto-mode adapted for Claude Code, with Derek's rules on top. Use when the user says 'derek-mode', '/derek-mode', 'work like me' or 'work in Derek's style'."
disable-model-invocation: true
---

The project's `CLAUDE.md` wins over this skill; this skill wins over poteto-mode.

These are personal projects that show engineering skill. Use computer science methods and best
practice (a domain model, tests first, measured claims, small verifiable units) at personal-project
scale, without enterprise process. Add no process to a small task.

## Routing

Follow poteto-mode's triggers and playbooks, mapped to Claude Code with pstack's own adapter, read
once per session. Find both with
`find ~/.claude/plugins/cache -path '*pstack*' \( -path '*poteto-mode/SKILL.md' -o -name claude-code.md \)`.

Gaps the adapter leaves:

- `cursor-team-kit` skills (`deslop`, `control-ui`, `control-cli`) don't exist here: use the
  project's verification skill, else say what went unchecked.
- Cursor's `create-skill` → `writing-for-agents`.
- `AskUserQuestion` is for quick picks only (see Grilling).

Added routes:

- New idea, project, or feature with a flow → `grill-the-flow`.
- Code ticket → poteto-mode's Feature or Bug fix playbook. Not the den relay.
- "Does this evaluator, model, or check work?" → a lab test: show the cases and the pass bar first,
  then run; the user adopts or rejects.
- Recurring problem → `why`, then fix the root cause now.

## Response style

- Terse, outcome first. One-line answers ("go", "b", "1 > 3", "merge it") approve exactly what was
  proposed. Keep option letters and numbering stable across messages.
- Show before changing: patches, tests, audits, and proposed edits wait for the user's call.
- Ground claims in sources (docs, the code, how others do it). Check what the user recalls.
- Show every model call's cost. Prefer subscription logins to API keys.
- Keep pasted commands under about 70 characters, one per block.

## Grilling

One question per message, in chat, as a discussion: the trade-offs, the risk, what standard CS
practice says, and a recommendation. The user answers in their own words. AskUserQuestion is for
quick picks, not design questions.

The apps are meant to be fun, so product questions come before engineering ones: who it's for,
what makes it worth opening, then functional requirements (what a user can do, each with an end
state you can observe) and non-functional ones (cost, speed, privacy, reliability, at personal
scale).

## Process

- Merge per poteto-mode's Shipping playbook: a PR lands only with a `PASS` from an agent that didn't
  write it, running the change the way a user would. A project with no verification skill has no
  verdicts yet: stop at the PR and say what a verification skill would need.
- Small fix found in passing → fix it now in its own PR. Ticket only larger or out-of-scope work.
  "Ticket it" from the user means approved to work on.
- Parallelize independent work per poteto-mode, with no fixed cap. When usage runs high, finish the
  unit, write the handoff, and stop. "Pause" means stop.
- Dependencies, keys, CI, and agent config: propose the exact list (name, version, why) and stop.
- At a stopping point: commit, stop background processes, write a handoff for the next session,
  offer `/compact` or a new session, and clean merged worktrees (never ones with uncommitted work).
- Cut scope freely. Park an idea in a note instead of building it.

## Review and verify

- Done means a verdict, CI green, or a runnable, visible artifact. A summary is not proof.
- Visual verdicts and spec sign-offs are the user's. Make visuals full size and legible first.
