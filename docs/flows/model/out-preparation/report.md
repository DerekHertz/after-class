# Preparation

TLC reached more states than the chart budget of 500, so the chart draws only the bug paths: 8 states and 6 arrows.
The chart does not draw 11 steps that stay in one chart state.

## R3_JudgedOnlyAgainstCheckedClaims breaks
The shortest path has 9 steps:
0. Capture Not capturing, Preparation Nothing closed yet, Review No review
1. you start capture: Capture Capturing, Preparation Nothing closed yet, Review No review
2. you watch a passage: Capture Capturing, Preparation Nothing closed yet, Review No review
3. you watch a passage: Capture Capturing, Preparation Nothing closed yet, Review No review
4. a chunk closes at a topic boundary: Capture Capturing, Preparation Preparing, Review No review
5. the agent writes a claim: Capture Capturing, Preparation Preparing, Review No review
6. Jev says a claim is supported: Capture Capturing, Preparation Prepared, Review No review
7. you press Review now: Capture Capturing, Preparation Prepared, Review Reviewing
8. a later window moves a boundary: Capture Capturing, Preparation Preparing, Review Reviewing
9. the tutor asks about a claim: Capture Capturing, Preparation Preparing, Review Question open

## R4_AtMostOneRevision breaks
The shortest path has 10 steps:
0. Capture Not capturing, Preparation Nothing closed yet, Review No review
1. you start capture: Capture Capturing, Preparation Nothing closed yet, Review No review
2. you watch a passage: Capture Capturing, Preparation Nothing closed yet, Review No review
3. you watch a passage: Capture Capturing, Preparation Nothing closed yet, Review No review
4. a chunk closes at a topic boundary: Capture Capturing, Preparation Preparing, Review No review
5. the agent writes a claim: Capture Capturing, Preparation Preparing, Review No review
6. Jev says a claim is not supported: Capture Capturing, Preparation Preparing, Review No review
7. the agent revises a claim: Capture Capturing, Preparation Preparing, Review No review
8. a later window moves a boundary: Capture Capturing, Preparation Preparing, Review No review
9. Jev says a claim is not supported: Capture Capturing, Preparation Preparing, Review No review
10. the agent revises a claim: Capture Capturing, Preparation Preparing, Review No review

## R7_ScopeNeverGrows breaks
TLC's counterexample is in tlc-R7_ScopeNeverGrows.out. It has 8 steps:
0. Capture Not capturing, Preparation Nothing closed yet, Review No review
1. you start capture: Capture Capturing, Preparation Nothing closed yet, Review No review
2. you watch a passage: Capture Capturing, Preparation Nothing closed yet, Review No review
3. a chunk closes at a topic boundary: Capture Capturing, Preparation Preparing, Review No review
4. you watch a passage: Capture Capturing, Preparation Preparing, Review No review
5. the agent writes a claim: Capture Capturing, Preparation Preparing, Review No review
6. Jev says a claim is supported: Capture Capturing, Preparation Prepared, Review No review
7. you press Review now: Capture Capturing, Preparation Prepared, Review Reviewing
8. a later window moves a boundary: Capture Capturing, Preparation Preparing, Review Reviewing

## R8_LateResultsNeverOverwrite breaks
TLC's counterexample is in tlc-R8_LateResultsNeverOverwrite.out. It has 7 steps:
0. Capture Not capturing, Preparation Nothing closed yet, Review No review
1. you start capture: Capture Capturing, Preparation Nothing closed yet, Review No review
2. you watch a passage: Capture Capturing, Preparation Nothing closed yet, Review No review
3. you watch a passage: Capture Capturing, Preparation Nothing closed yet, Review No review
4. a chunk closes at a topic boundary: Capture Capturing, Preparation Preparing, Review No review
5. the agent writes a claim: Capture Capturing, Preparation Preparing, Review No review
6. a later window moves a boundary: Capture Capturing, Preparation Preparing, Review No review
7. an outdated result lands on a claim: Capture Capturing, Preparation Prepared, Review No review

## Rules not checked
TypeOK, R6_ResourcesNeverBlockReview, NoDeadlock, R5_LaterLeavesPreparation, R5_PreparationFinishesAfterLater, R5_OnlyStopEarlyCancels, R9_ReviewAndCaptureIndependent, R10_NeverStartsEmpty
After the first break, each TLC run stops at 100,000 distinct states. A run reached that bound before it checked these rules in every state.
