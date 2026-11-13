# ReviewEnd

TLC reached 72 states and 184 steps. The chart draws 16 states and 20 arrows.
The chart does not draw 92 steps that stay in one chart state.
The view hides 4 steps, so the chart does not draw them.
The step you go home changes Finish and Screen at the same time.
The step the tutor wraps up changes Finish and Save at the same time.

## FinishIsNeverSilentlyDropped breaks
The shortest path has 1 step:
0. Finish Reviewing, last reply settling, Save Not saved, Screen Review screen
1. you confirm Finish and nothing happens: Finish Finish confirmed, nothing happened, Save Not saved, Screen Review screen

## Rules that hold
TypeOK, RetryAlwaysResends, EndedUnsavedIsReachableFromHome, NoDeadlock, AFinishedReviewEventuallySaves
