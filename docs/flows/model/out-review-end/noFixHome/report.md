# ReviewEnd

TLC reached 70 states and 191 steps. The chart draws 36 states and 73 arrows.
The chart does not draw 66 steps that stay in one chart state.
The view hides 4 steps, so the chart does not draw them.
The model goes from Finish Finishing, App no end, Save Not saved, Screen Review screen to Finish Finish failed after delivery, App no end, Save Not saved, Screen Review screen by the tutor's wrap-up fails, which the regions chart cannot show. So the chart draws parent states in place of regions.

## EndedUnsavedIsReachableFromHome breaks
The shortest path has 4 steps:
0. Finish Reviewing, App no end, Save Not saved, Screen Review screen
1. you confirm Finish: Finish Finishing, App no end, Save Not saved, Screen Review screen
2. the backend stores your finish: Finish Finishing, App no end, Save Not saved, Screen Review screen
3. the wrap-up is saved but the reply is lost: Finish Review ended, last request failed, App no end, Save Save pending, Screen Review screen
4. you go home: Finish Review ended, App no end, Save Save pending, Screen Home

## AFinishedReviewEventuallySaves breaks
TLC's counterexample is in tlc-AFinishedReviewEventuallySaves.out. It has 5 steps:
0. Finish Reviewing, App no end, Save Not saved, Screen Review screen
1. you confirm Finish: Finish Finishing, App no end, Save Not saved, Screen Review screen
2. the backend stores your finish: Finish Finishing, App no end, Save Not saved, Screen Review screen
3. the wrap-up is saved but the reply is lost: Finish Review ended, last request failed, App review ended, Save Save pending, Screen Review screen
4. the model or network recovers: Finish Review ended, last request failed, App review ended, Save Save pending, Screen Review screen
5. you go home: Finish Review ended, App review ended, Save Save pending, Screen Home
The run stops in "Finish Review ended, App review ended, Save Save pending, Screen Home" forever.

## Rules that hold
TypeOK, RetryAlwaysResends, FinishIsNeverSilentlyDropped, NoDeadlock
