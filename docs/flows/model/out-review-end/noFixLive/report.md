# ReviewEnd

TLC reached 67 states and 180 steps. The chart draws 32 states and 55 arrows.
The chart does not draw 78 steps that stay in one chart state.
The view hides 3 steps, so the chart does not draw them.
The model goes from Finish Finishing, App no end, Save Not saved, Screen Review screen to Finish Finish failed after delivery, App no end, Save Not saved, Screen Review screen by the tutor's wrap-up fails, which the regions chart cannot show. So the chart draws parent states in place of regions.

## RetryAlwaysResends breaks
The shortest path has 3 steps:
0. Finish Reviewing, App no end, Save Not saved, Screen Review screen
1. you confirm Finish: Finish Finishing, App no end, Save Not saved, Screen Review screen
2. the backend stores your finish: Finish Finishing, App no end, Save Not saved, Screen Review screen
3. the tutor's wrap-up fails: Finish Finish failed after delivery, App no end, Save Not saved, Screen Review screen

## Rules that hold
TypeOK, FinishIsNeverSilentlyDropped, EndedUnsavedIsReachableFromHome, NoDeadlock, AFinishedReviewEventuallySaves
