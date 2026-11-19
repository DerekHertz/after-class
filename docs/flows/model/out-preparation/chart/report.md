# PreparationChart

TLC reached 383 states and 1030 steps. The chart draws 9 states and 18 arrows.
The chart does not draw 548 steps that stay in one chart state.
The regions chart lets Capture Capturing, Preparation Prepared, Review Reviewing go to Capture Capturing, Preparation Preparing, Review No review by Next, which the model never does. So the chart draws parent states in place of regions.

## Rules that hold
TypeOK, R3_JudgedOnlyAgainstCheckedClaims, R4_AtMostOneRevision, R7_ScopeNeverGrows, R8_LateResultsNeverOverwrite
