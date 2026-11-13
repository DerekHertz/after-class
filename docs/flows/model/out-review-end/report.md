# ReviewEnd

TLC reached 36 states and 90 steps. The chart draws 15 states and 19 arrows.
The chart does not draw 36 steps that stay in one chart state.
The view hides 2 steps, so the chart does not draw them.
The step you go home changes Finish and Screen at the same time.
The step the tutor wraps up changes Finish and Save at the same time.

## Rules that hold
TypeOK, RetryAlwaysResends, FinishIsNeverSilentlyDropped, EndedUnsavedIsReachableFromHome, NoDeadlock, AFinishedReviewEventuallySaves
