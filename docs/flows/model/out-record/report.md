# Record

TLC reached 2,276 states, more than the chart budget of 500, so the chart draws only the bug paths: 6 states and 4 arrows.
The chart does not draw 2 steps that stay in one chart state.
The step you end the review and the save fails changes Review and Note at the same time.

## R14_DisputedNeverCountedAsGap breaks
The shortest path has 5 steps:
0. Review Reviewing, Note No note yet, Evidence Evidence kept
1. the tutor asks about a claim: Review Question open, Note No note yet, Evidence Evidence kept
2. you answer: Review Reviewing, Note No note yet, Evidence Evidence kept
3. you dispute the interpretation: Review Reviewing, Note No note yet, Evidence Evidence kept
4. you settle the dispute as not a gap: Review Reviewing, Note No note yet, Evidence Evidence kept
5. you end the review and the save fails: Review Review ended, Note Save pending, Evidence Evidence kept

## Rules that hold
TypeOK, R11_DetourOnlyAfterYes, R16_CitedEvidenceNeverExpires, NoDeadlock
