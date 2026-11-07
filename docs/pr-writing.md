# How to write PR descriptions and commit messages

These rules come from pstack's `technical-writing` and `unslop` skills. They are here so that agents without pstack, such as the `@claude` workflow, follow them too.

A PR body is a briefing that a reviewer can read in under a minute. Say what changed, why, and how you know it works. Link logs, runs, and long tables instead of pasting them.

## Write plain sentences

- Cut every word that does no work. "In order to" is "to".
- Use the short, everyday word: "use", not "utilize" or "leverage".
- Write the real file, symbol, flag, or command in code font, not a description of it.
- Say who does what: "the parser rejects the date", not "the date is rejected".
- Write whole sentences with their articles and verbs. No arrows, symbol-speak, or verbless fragments.
- Use one thought per sentence. Split sentences longer than about 25 words.
- Call each thing by one name everywhere.
- Make every "it", "this", and "they" point at one obvious thing.
- Be specific: "a column rename fails the build", not "schema changes can cause issues".
- State results as facts and numbers. Don't hedge, and don't claim what you did not check. Say what is not verified.

## Avoid these tells

- No em dashes or semicolons. End the sentence or use a comma.
- No colon as a mid-sentence connector. A colon before a list is fine.
- No bold label and colon at the start of a bullet ("**Tests:** ..."). Write the sentence.
- No AI vocabulary: additionally, crucial, delve, enhance, robust, seamless, pivotal, showcase, underscore, leverage.
- No "serves as" or "boasts". Say "is" or "has".
- No "not just X, but Y", no forced groups of three, and no closing summary line.
- No metaphors for code: "harness", "surface", "wedge", "north star", "rides along".
- No decorative emoji, no title-case headings, and no chatbot phrases ("Let me know if...").

## Shape

1. The first line says what the PR does and links the issue it fixes.
2. A short paragraph says why the change is needed.
3. A short paragraph or a few bullets say what changed, with real paths.
4. The last paragraph lists the checks you ran and their results, and anything not verified.

Introduce a list with a full sentence. Use numbered lists only for steps in order.
