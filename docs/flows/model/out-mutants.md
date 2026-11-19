| Rule | Flow line removed | Result |
| --- | --- | --- |
| R8_LateResultsNeverOverwrite | TLC fix R8: a result for an outdated revision is logged, never applied | breaks, 9-state counterexample |
| R4_AtMostOneRevision | TLC fix R4: a claim keeps its used revision through reprocessing and retry | breaks, 12-state counterexample |
| R7_ScopeNeverGrows | TLC fix R7: a boundary move can't add material to an open review's scope | breaks, 10-state counterexample |
| R3_JudgedOnlyAgainstCheckedClaims | TLC fix R3, first half: a claim being rechecked is out of assessment | breaks, 11-state counterexample |
| R3_JudgedOnlyAgainstCheckedClaims | TLC fix R3, second half: an open question on it pauses | breaks, 11-state counterexample |
| R14_DisputedNeverCountedAsGap | TLC fix R14: a dispute still open or unsettled saves as "disputed" | breaks, 5-state counterexample |
| R14_DisputedNeverCountedAsGap | TLC fix R14, second path: a dispute you settle saves the way you settled it | breaks, 6-state counterexample |
| R16_CitedEvidenceNeverExpires | TLC fix R16: evidence cited by a pending save counts as cited | breaks, 4-state counterexample |
| R5_LaterLeavesPreparation | Later -> keep preparing | breaks, 6-state counterexample |
| R5_OnlyStopEarlyCancels | Later -> keep preparing | breaks, 7-state counterexample |
| R5_PreparationFinishesAfterLater | Later -> keep preparing (the Jev check keeps running) | breaks, 9-state counterexample |
| R6_ResourcesNeverBlockReview | failure never blocks review (Review now always available) | breaks, 8-state counterexample |
| R9_ReviewAndCaptureIndependent | Review now leaves capture alone | breaks, 8-state counterexample |
| R9_ReviewAndCaptureIndependent | stop capture leaves the review alone | breaks, 9-state counterexample |
| R10_NeverStartsEmpty | No supported claims in scope -> don't start | breaks, 6-state counterexample |
| R11_DetourOnlyAfterYes | [user] Accept or decline the detour | breaks, 4-state counterexample |
| Lazy_NothingPreparedUnasked | hold it until I ask for this lecture's review (amendment 2026-11-18, not a rule) | breaks, 4-state counterexample |
| Ask_ExhaustedOnlyWhenNothingCanAnswer | an ask is exhausted only when nothing can answer it (not a rule): exhausted as soon as no new claim is supported | breaks, 4-state counterexample |
| Ask_OpenAskEnds | start the review once a prepared chunk has a supported claim (amendment 2026-11-18) | breaks, 13-state counterexample |
| Ask_OpenAskEnds | the derivation that sees nothing can answer an open ask ends it exhausted (not a rule) | breaks, 6-state counterexample |
| Ask_EveryStartTakesANewClaim | every start needs a supported claim no review has started with (not a rule) | breaks, 13-state counterexample |
| Ask_OneReviewPerAsk | a review that starts answers the open ask (not a rule) | breaks, 14-state counterexample |
| Ask_PageFollowsItsOwnAsk | the page waits only on an ask that Review now or Wait opened or joined (not a rule) | breaks, 7-state counterexample |
| Ask_PageFollowsItsOwnAsk | the page opens only the review of the ask it waits on (not a rule) | breaks, 14-state counterexample |
