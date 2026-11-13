# ReviewEnd

TLC reached 152 states and 426 steps. The chart draws 53 states and 109 arrows.
The chart does not draw 204 steps that stay in one chart state.
The view hides 8 steps, so the chart does not draw them.
The model goes from Finish Finishing, App no end, Save Not saved, Screen Review screen to Finish Finish failed after delivery, App no end, Save Not saved, Screen Review screen by the tutor's wrap-up fails, which the regions chart cannot show. So the chart draws parent states in place of regions.

## FinishIsNeverSilentlyDropped breaks
The shortest path has 1 step:
0. Finish Reviewing, last reply settling, App no end, Save Not saved, Screen Review screen
1. you confirm Finish and nothing happens: Finish Finish confirmed, nothing happened, App no end, Save Not saved, Screen Review screen

## Rules that hold
TypeOK, RetryAlwaysResends, EndedUnsavedIsReachableFromHome, NoDeadlock, AFinishedReviewEventuallySaves
