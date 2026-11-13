# ReviewEnd

TLC reached 76 states and 211 steps. The chart draws 37 states and 77 arrows.
The chart does not draw 74 steps that stay in one chart state.
The view hides 4 steps, so the chart does not draw them.
The model goes from Finish Finishing, App no end, Save Not saved, Screen Review screen to Finish Finish failed after delivery, App no end, Save Not saved, Screen Review screen by the tutor's wrap-up fails, which the regions chart cannot show. So the chart draws parent states in place of regions.

## Rules that hold
TypeOK, RetryAlwaysResends, FinishIsNeverSilentlyDropped, EndedUnsavedIsReachableFromHome, NoDeadlock, AFinishedReviewEventuallySaves
