# How to write PR descriptions and commit messages

These rules come from pstack's `technical-writing` and `unslop` skills. They are here so that agents without pstack, such as the `@claude` workflow, follow them too. When a rule makes a sentence worse, fix the sentence another way.

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
- No decorative emoji, no title-case headings, no curly quotes, and no chatbot phrases such as "Let me know if...".

## Shape

1. The first line says what the PR does and links the issue it fixes.
2. A short paragraph says why the change is needed.
3. A short paragraph or a few bullets say what changed, with real paths.
4. The last paragraph lists the checks you ran and their results, and anything not verified.

Introduce a list with a full sentence. Use numbered lists only for steps in order.
