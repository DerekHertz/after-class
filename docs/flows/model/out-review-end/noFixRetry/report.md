# ReviewEnd

TLC reached 36 states and 88 steps. The chart draws 15 states and 19 arrows.
The chart does not draw 38 steps that stay in one chart state.
The view hides 2 steps, so the chart does not draw them.
The step you go home changes Finish and Screen at the same time.
The step the tutor wraps up changes Finish and Save at the same time.

## RetryAlwaysResends breaks
The shortest path has 3 steps:
0. Finish Reviewing, Save Not saved, Screen Review screen
1. you confirm Finish: Finish Finishing, Save Not saved, Screen Review screen
2. the backend stores your finish: Finish Finishing, Save Not saved, Screen Review screen
3. the tutor's wrap-up fails: Finish Finish failed after delivery, Save Not saved, Screen Review screen

## Rules that hold
TypeOK, FinishIsNeverSilentlyDropped, EndedUnsavedIsReachableFromHome, NoDeadlock, AFinishedReviewEventuallySaves
