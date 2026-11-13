# ReviewEnd

TLC reached 32 states and 78 steps. The chart draws 15 states and 19 arrows.
The chart does not draw 32 steps that stay in one chart state.
The view hides 2 steps, so the chart does not draw them.
The step you go home changes Finish and Screen at the same time.
The step the tutor wraps up changes Finish and Save at the same time.

## EndedUnsavedIsReachableFromHome breaks
The shortest path has 6 steps:
0. Finish Reviewing, Save Not saved, Screen Review screen
1. you confirm Finish: Finish Finishing, Save Not saved, Screen Review screen
2. the backend stores your finish: Finish Finishing, Save Not saved, Screen Review screen
3. the tutor wraps up: Finish Review ended, Save Saving, Screen Review screen
4. the model or network starts failing: Finish Review ended, Save Saving, Screen Review screen
5. the save fails: Finish Review ended, Save Save failed, failure cached, Screen Review screen
6. you go home: Finish Review ended, Save Save failed, failure cached, Screen Home

## AFinishedReviewEventuallySaves breaks
TLC's counterexample is in tlc-AFinishedReviewEventuallySaves.out. It has 7 steps:
0. Finish Reviewing, Save Not saved, Screen Review screen
1. you confirm Finish: Finish Finishing, Save Not saved, Screen Review screen
2. the backend stores your finish: Finish Finishing, Save Not saved, Screen Review screen
3. the tutor wraps up: Finish Review ended, Save Saving, Screen Review screen
4. the model or network starts failing: Finish Review ended, Save Saving, Screen Review screen
5. the save fails: Finish Review ended, Save Save failed, failure cached, Screen Review screen
6. you go home: Finish Review ended, Save Save failed, failure cached, Screen Home
7. the model or network recovers: Finish Review ended, Save Save failed, failure cached, Screen Home
The run stops in "Finish Review ended, Save Save failed, failure cached, Screen Home" forever.

## Rules that hold
TypeOK, RetryAlwaysResends, FinishIsNeverSilentlyDropped, NoDeadlock
