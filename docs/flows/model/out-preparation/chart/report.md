# PreparationChart

TLC reached 249 states and 644 steps. The chart draws 9 states and 18 arrows.
The chart does not draw 364 steps that stay in one chart state.
The regions chart lets Capture Capturing, Preparation Prepared, Review No review go to Capture Capturing, Preparation Preparing, Review Reviewing by Next, which the model never does. So the chart draws parent states in place of regions.

## Rules that hold
TypeOK, R3_JudgedOnlyAgainstCheckedClaims, R4_AtMostOneRevision, R7_ScopeNeverGrows, R8_LateResultsNeverOverwrite
