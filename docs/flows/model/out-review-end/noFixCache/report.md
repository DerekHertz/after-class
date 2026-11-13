# ReviewEnd

TLC reached 76 states and 211 steps. The chart draws 37 states and 77 arrows.
The chart does not draw 71 steps that stay in one chart state.
The view hides 4 steps, so the chart does not draw them.
The model goes from Finish Finishing, App no end, Save Not saved, Screen Review screen to Finish Finish failed after delivery, App no end, Save Not saved, Screen Review screen by the tutor's wrap-up fails, which the regions chart cannot show. So the chart draws parent states in place of regions.

## AFinishedReviewEventuallySaves breaks
TLC's counterexample is in tlc-AFinishedReviewEventuallySaves.out. It has 8 steps:
0. Finish Reviewing, App no end, Save Not saved, Screen Review screen
1. you confirm Finish: Finish Finishing, App no end, Save Not saved, Screen Review screen
2. the backend stores your finish: Finish Finishing, App no end, Save Not saved, Screen Review screen
3. the tutor wraps up: Finish Review ended, App review ended, Save Saving, Screen Review screen
4. the model or network starts failing: Finish Review ended, App review ended, Save Saving, Screen Review screen
5. the save fails: Finish Review ended, App review ended, Save Save failed, failure cached, Screen Review screen
6. the model or network recovers: Finish Review ended, App review ended, Save Save failed, failure cached, Screen Review screen
7. you press Retry save: Finish Review ended, App review ended, Save Saving, failure cached, Screen Review screen
8. the save returns the cached failure: Finish Review ended, App review ended, Save Save failed, failure cached, Screen Review screen
The run loops through "Finish Review ended, App review ended, Save Save failed, failure cached, Screen Review screen" and "Finish Review ended, App review ended, Save Saving, failure cached, Screen Review screen" forever.

## Rules that hold
TypeOK, RetryAlwaysResends, FinishIsNeverSilentlyDropped, EndedUnsavedIsReachableFromHome, NoDeadlock
