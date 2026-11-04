---
name: grill-the-flow
description: Grill a plan until it's settled, then write its flow as pseudocode that says who does each step (code, an agent, Jev, a formal check, the user), have the user write the rules in their own sentences, and check the flow with a TLA+ statechart. Use for /grill-the-flow, or when a plan has a pipeline, a lifecycle, handoffs or retries that agents will build.
---

# Grill the flow

Grilling settles the decisions. This skill adds what grilling leaves implicit: the flow those
decisions make, who does each step, and the rules it must keep, checked before anyone builds it.

## 1. Grill

Follow the `grilling` skill until its frontier is empty. Start the design tree with the product:
who it's for and what makes it worth using. Then requirements: functional (what a user can do, each
with an observable end state) and non-functional (cost, speed, privacy, reliability). Each
functional requirement is a feature in the project's verification skill's map. Then add three
branches: which steps exist, what each one takes in and hands on, and who does it.

## 2. Write the flow as pseudocode

Whatever shape reads clearest (branches, loops, a sequence of calls, a handler per event), one
line per step, each tagged with who does it:

- `[code]`: anything code can decide (counts, paths, exact strings, diffs, imports).
- `[agent]`: writing (code, labels, models, summaries).
- `[Jev]`: a typed judgment with probabilities ("is X shown by Y?", "which of these?"). Jev never writes.
- `[formal]`: TLC on the model (step 4).
- `[user]`: rules, approvals, visual verdicts.

Every branch ends in an action, including "skip" and "one line in the log". A person sees only
what a branch routes to them. Each `[Jev]` line names what Jev is given and what counts as yes and
as no. Show the flow and revise it until the user agrees.

## 3. The user writes the rules

Ask the user for each rule the flow must keep, one plain sentence each. Don't write them. You may
list what looks like a rule from the grilling and ask which ones must hold. From then on, quote
the rules word for word.

## 4. Model and check

When the flow has states that matter (a lifecycle, a handoff, a retry, a budget), model it with
pstack's `statechart`. Read its SKILL.md and follow it for the spec, the view and the report:

```sh
find ~/.claude/plugins -path '*skills/statechart/scripts/statechart'
```

- Each rule is an INVARIANT, with the user's sentence as a comment above it.
- Keep the chart to about 8 states in the reader's words.
- When the model describes code that exists, comment each action with the functions it passes
  through. A step check needs every one of them; a step linked to one function of several can't
  be confirmed.
- Without mise, set `TLA2TOOLS` to a `tla2tools.jar` checked against the checksum in statechart's
  `run.ts`, and `JAVA` to Java 11 or later.

When a rule breaks, give the path in the reader's words and ask whether the flow or the rule is
wrong. Never weaken a rule to make it hold. When the flow is a pipeline with no states that matter,
skip this step and say so.

## 5. Hand off

Write one file where the project keeps decisions (else `docs/flows/<name>.md`): the pseudocode,
the user's rules verbatim, the chart's Mermaid, what TLC found, what the model leaves out, and the
command that reruns the check.
