# Record

TLC reached 3,400 states, more than the chart budget of 500, so the chart draws only the bug paths: 8 states and 6 arrows.
The chart does not draw 1 steps that stay in one chart state.
The step you end the review and the save fails changes Review and Note at the same time.

## R16_CitedEvidenceNeverExpires breaks
The shortest path has 3 steps:
0. Review Reviewing, Note No note yet, Evidence Evidence kept
1. you end the review and the save fails: Review Review ended, Note Save pending, Evidence Evidence kept
2. the evidence expires: Review Review ended, Note Save pending, Evidence Evidence expired
3. you retry the save: Review Review ended, Note Note saved, Evidence Evidence expired

## R14_DisputedNeverCountedAsGap breaks
The shortest path has 4 steps:
0. Review Reviewing, Note No note yet, Evidence Evidence kept
1. the tutor asks about a claim: Review Question open, Note No note yet, Evidence Evidence kept
2. you answer: Review Reviewing, Note No note yet, Evidence Evidence kept
3. you dispute the interpretation: Review Reviewing, Note No note yet, Evidence Evidence kept
4. you end the review and the save fails: Review Review ended, Note Save pending, Evidence Evidence kept

## Rules that hold
TypeOK, R11_DetourOnlyAfterYes, NoDeadlock
