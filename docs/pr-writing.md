# How to write PR descriptions and commit messages

Every PR in this repository follows pstack's Opening a PR playbook, then its `technical-writing` and `unslop` skills. These rules apply to humans, local agents and the `@claude` workflow, even when pstack is not installed. The repository template is `.github/PULL_REQUEST_TEMPLATE.md`. When a prose rule makes a sentence worse, fix the sentence another way.

A PR body is a briefing that a reviewer can read in under a minute. Say what changed, why, and how you know it works. Link logs, runs, SHA lists, and long tables instead of pasting them.

## Write plain sentences

- Cut every word that does no work. "In order to" is "to".
- Use the short, everyday word. Write "use", not "utilize" or "leverage".
- Write the real file, symbol, flag, or command in code font, not a description of it.
- Say who does what. Write "the parser rejects the date", not "the date is rejected".
- Write whole sentences with their articles and verbs. Leave out arrows, symbol-speak, and verbless fragments.
- Use one thought per sentence. Split sentences longer than about 25 words.
- Call each thing by one name everywhere.
- Make every "it", "this", and "they" point at one obvious thing.
- Be specific. Write "a column rename fails the build", not "schema changes can cause issues".
- Cut adverbs. Use a stronger verb or the measured number.
- Make every count true at the commit that lands it, and give the command that produces it.
- State results as facts and numbers. Don't hedge, and don't claim what you did not check. Say what is not verified.

## Avoid these tells

- No em dashes, en dashes, semicolons, or parentheses. End the sentence or use a comma.
- No colon as a mid-sentence connector. A colon before a list or an example is fine.
- No bold label and colon at the start of a bullet, such as "**Tests:** ...". Write the sentence.
- No AI vocabulary. The list includes additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape, pivotal, showcase, tapestry, testament, underscore, and vibrant.
- No "-ing" tails such as "ensuring...", "highlighting...", or "reflecting...".
- No vague attributions such as "experts believe". Name the source or cut the claim.
- No "serves as" or "boasts". Say "is" or "has".
- No "not just X, but Y", no forced groups of three, and no closing summary line.
- No "simply", "easy", or "quickly" in steps.
- No slashes such as "and/or", and no plurals written as "(s)".
- No metaphors for code, such as "harness", "surface", "wedge", "north star", or "rides along".
- No decorative emoji, no title-case headings beyond the required PR section names below, no curly quotes, and no chatbot phrases such as "Let me know if...".

## Title

Use `type(scope): subject`, with no trailing period. Use a short imperative subject that describes the final change. For example, `fix(review): preserve notebook drafts`.

Choose a type such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore` or `perf`. The scope names the affected area. The title syntax is exempt from the prose punctuation rules above.

## Body

Keep the body under about 40 lines. It becomes the squash commit body. Use these exact headings in this order. Keep `## Scope` in every PR and omit other sections only when there is nothing to say.

- `## Why` gives the problem and approach in one to three short sentences. Link the issue it addresses. Omit commit history and branch ancestry.
- `## What changed` gives one to three short bullets. Name a path or symbol only when it helps explain the change. Name both sides of a rename.
- `## Scope` always gives one to three short items about what the PR covers and deliberately leaves out. Avoid paths and file inventories here.
- `## Tradeoffs` is optional. Include only rejected alternatives that a reviewer would otherwise ask about.
- `## Blast Radius` gives one or two sentences about affected users or behavior and the relevant risk. If the main branch is failing, explain the cost of leaving it that way.
- `## Verification` gives one to three bullets with actual commands or user flows and their results. State what remains unverified. For performance work, report one primary before and after measurement with its unit and link the full evidence.

Attach screenshots or videos after the sections when they prove a claim. Link detailed logs, commit IDs, review notes and token reports instead of pasting them into the body. Rewrite the title and body around the final implementation when scope changes.

Use whole sentences in bullets. Use numbered lists only for steps in order. When an agent uses a CLI to publish a multiline body, write the exact Markdown to a file and pass `--body-file`. Read the published PR back to verify the title and formatting.
