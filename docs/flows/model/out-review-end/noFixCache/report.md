# ReviewEnd

TLC reached 36 states and 90 steps. The chart draws 15 states and 18 arrows.
The chart does not draw 36 steps that stay in one chart state.
The view hides 2 steps, so the chart does not draw them.
The step you go home changes Finish and Screen at the same time.
The step the tutor wraps up changes Finish and Save at the same time.

## AFinishedReviewEventuallySaves breaks
TLC's counterexample is in tlc-AFinishedReviewEventuallySaves.out. It has 8 steps:
0. Finish Reviewing, Save Not saved, Screen Review screen
1. you confirm Finish: Finish Finishing, Save Not saved, Screen Review screen
2. the backend stores your finish: Finish Finishing, Save Not saved, Screen Review screen
3. the tutor wraps up: Finish Review ended, Save Saving, Screen Review screen
4. the model or network starts failing: Finish Review ended, Save Saving, Screen Review screen
5. the save fails: Finish Review ended, Save Save failed, failure cached, Screen Review screen
6. the model or network recovers: Finish Review ended, Save Save failed, failure cached, Screen Review screen
7. you press Retry save: Finish Review ended, Save Saving, failure cached, Screen Review screen
8. the save returns the cached failure: Finish Review ended, Save Save failed, failure cached, Screen Review screen
The run loops through "Finish Review ended, Save Save failed, failure cached, Screen Review screen" and "Finish Review ended, Save Saving, failure cached, Screen Review screen" forever.

## Rules that hold
TypeOK, RetryAlwaysResends, FinishIsNeverSilentlyDropped, EndedUnsavedIsReachableFromHome, NoDeadlock
