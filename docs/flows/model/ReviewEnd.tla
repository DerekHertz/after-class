---- MODULE ReviewEnd ----
\* The CODE path from "Finish" to a saved review, across the review app and the backend.
\* Unlike Preparation.tla and Record.tla, which model the approved flow, each action here names
\* the code it describes. Bounds: one review, one End act, stable wrap-up inputs.
\*
\* Each Fix constant is one bug fix that is in the code today. ReviewEnd.cfg sets all four TRUE and
\* every rule holds. Each ReviewEnd-no*.cfg sets one FALSE, which puts that bug back, and must break
\* the rule named in it. check-review-end.sh runs all five.

CONSTANTS
    FixRetry,   \* #139 (PR 158): Retry resends a stored `end` the tutor never wrapped up (core.ts strandedEndTurn)
    FixCache,   \* #95 (PR 156): a save clears a wrap-up failure cached by an earlier save (main.ts wrapUp, asOf)
    FixHome,    \* #97 (PR 157): home links to an ended review whose save is pending (home.tsx reviewTarget)
    FixDrop     \* PR 159: Finish is disabled while the controller's lock is held (review.tsx HeaderActions, state.busy)

VARIABLES
    trouble,    \* the network or the model is failing
    settling,   \* controller.ts exclusive(): the previous turn holds `streaming` while runTurn refreshes the view and saves
    endTurn,    \* "none" | "unsent" (unsent.ts row, backend never stored it) | "stored" (review_turns has
                \* the learner's end, no wrap_up move) | "wrapped" (wrap_up committed: phase "ended")
    live,       \* core.ts Live.status as the screen shows it: "none" | "streaming" | "failed"
    wrapMemo,   \* memo.ts settled() for the record's wrap-up key: "missing" | "terminal" | "hit"
    saved,      \* record/index.ts saveState: "unsaved" | "save_pending" | "saved"
    saving,     \* controller.ts state.saving
    saveError,  \* controller.ts state.saveError !== null
    screen,     \* "review" | "home"
    dropped     \* ghost: a confirmed Finish did nothing and showed nothing

vars == <<trouble, settling, endTurn, live, wrapMemo, saved, saving, saveError, screen, dropped>>

TypeOK ==
    /\ trouble \in BOOLEAN /\ settling \in BOOLEAN
    /\ endTurn \in {"none", "unsent", "stored", "wrapped"}
    /\ live \in {"none", "streaming", "failed"}
    /\ wrapMemo \in {"missing", "terminal", "hit"}
    /\ saved \in {"unsaved", "save_pending", "saved"}
    /\ saving \in BOOLEAN /\ saveError \in BOOLEAN
    /\ screen \in {"review", "home"}
    /\ dropped \in BOOLEAN

Init ==
    /\ trouble \in BOOLEAN
    /\ settling \in BOOLEAN
    /\ endTurn = "none" /\ live = "none" /\ wrapMemo = "missing" /\ saved = "unsaved"
    /\ saving = FALSE /\ saveError = FALSE /\ screen = "review" /\ dropped = FALSE

\* review.tsx canRetry: offered when nothing streams and a turn is unsent, the live turn failed, or (with the fix)
\* a stored end was never wrapped up. unansweredLearnerTurn and owedLearnerTurn are both null for an `end`.
RetryOffered ==
    /\ screen = "review" /\ live # "streaming"
    /\ endTurn = "unsent" \/ live = "failed" \/ (FixRetry /\ endTurn = "stored")
\* controller.ts retryTurn: what it finds to resend (unsent store, then unanswered, owed, stranded end).
RetryFindsATurn == endTurn = "unsent" \/ (FixRetry /\ endTurn = "stored")
\* review.tsx HeaderActions: Finish is disabled while streaming, while a turn is unsent and, with the fix,
\* while the controller's lock is held.
FinishOffered ==
    /\ screen = "review" /\ live # "streaming" /\ endTurn \in {"none", "stored"} /\ ~saving
    /\ (FixDrop => ~settling)

TroubleClears == trouble /\ trouble' = FALSE /\ UNCHANGED <<settling, endTurn, live, wrapMemo, saved, saving, saveError, screen, dropped>>

\* Trouble can come back: the tutor's wrap-up move and the record's wrap-up call are separate model calls.
TroubleStarts == ~trouble /\ saved # "saved" /\ trouble' = TRUE /\ UNCHANGED <<settling, endTurn, live, wrapMemo, saved, saving, saveError, screen, dropped>>

\* controller.ts runTurn finishes refreshView and saveIfEnded; exclusive() releases the lock.
ThePreviousTurnSettles == settling /\ settling' = FALSE /\ UNCHANGED <<trouble, endTurn, live, wrapMemo, saved, saving, saveError, screen, dropped>>

\* review.tsx EndConfirm, then controller.ts send. With the lock held, exclusive() returns undefined and
\* nothing is stored or sent. Since PR 159 send then sets sendError, so that path is not silent; the
\* model keeps only the silent drop that FixDrop = FALSE allows.
YouConfirmFinish ==
    /\ FinishOffered /\ endTurn = "none"
    /\ IF settling
       THEN dropped' = TRUE /\ UNCHANGED <<endTurn, live>>
       ELSE endTurn' = "unsent" /\ live' = "streaming" /\ UNCHANGED dropped
    /\ UNCHANGED <<trouble, settling, wrapMemo, saved, saving, saveError, screen>>

\* api.sendTurn throws before `learner_turn_stored` (controller.ts runTurn catch). The unsent row stays.
TheEndRequestFails ==
    /\ trouble /\ live = "streaming" /\ endTurn = "unsent"
    /\ live' = "failed"
    /\ UNCHANGED <<trouble, settling, endTurn, wrapMemo, saved, saving, saveError, screen, dropped>>

\* review/index.ts turn(): appendTurn learner `end`, yield learner_turn_stored; the app removes the unsent row.
TheBackendStoresYourEnd ==
    /\ live = "streaming" /\ endTurn = "unsent"
    /\ endTurn' = "stored"
    /\ UNCHANGED <<trouble, settling, live, wrapMemo, saved, saving, saveError, screen, dropped>>

\* review/index.ts: the wrap-up move's model call fails -> turn_failed retryable.
TheWrapUpMoveFails ==
    /\ trouble /\ live = "streaming" /\ endTurn = "stored"
    /\ live' = "failed"
    /\ UNCHANGED <<trouble, settling, endTurn, wrapMemo, saved, saving, saveError, screen, dropped>>

\* review/index.ts commits wrap_up and markEndedInTx writes the save row in the same transaction (#138).
\* The app then saves by itself: controller.ts saveIfEnded.
TheTutorWrapsUp ==
    /\ ~trouble /\ live = "streaming" /\ endTurn = "stored"
    /\ endTurn' = "wrapped" /\ saved' = "save_pending" /\ live' = "none"
    /\ saving' = ~saveError
    /\ UNCHANGED <<trouble, settling, wrapMemo, saveError, screen, dropped>>

\* controller.ts retryTurn.
YouPressRetry ==
    /\ RetryOffered
    /\ IF RetryFindsATurn THEN live' = "streaming" ELSE UNCHANGED live
    /\ UNCHANGED <<trouble, settling, endTurn, wrapMemo, saved, saving, saveError, screen, dropped>>

\* A second Finish mints a new turnId; the backend takes it because the phase is still active.
YouPressFinishAgain ==
    /\ FinishOffered /\ endTurn = "stored"
    /\ live' = "streaming"
    /\ UNCHANGED <<trouble, settling, endTurn, wrapMemo, saved, saving, saveError, screen, dropped>>

\* record/index.ts save -> bundleFor -> main.ts wrapUp -> memo.run (memo.ts run, settled, attemptLoop).
\* One memo.run ends in a hit or a terminal failure; a stored terminal failure is returned without a call.
\* With FixCache, wrapUp clears a failure stored before this request began and asks once more.
TheSaveRuns ==
    LET memo == IF FixCache /\ wrapMemo = "terminal" THEN "missing" ELSE wrapMemo
    IN /\ saving
       /\ \/ /\ memo = "hit" \/ (memo = "missing" /\ ~trouble)
             /\ wrapMemo' = "hit" /\ saved' = "saved" /\ saveError' = FALSE
          \/ /\ memo = "missing" /\ trouble
             /\ wrapMemo' = "terminal" /\ saveError' = TRUE /\ UNCHANGED saved
          \/ /\ memo = "terminal"
             /\ saveError' = TRUE /\ UNCHANGED <<wrapMemo, saved>>
       /\ saving' = FALSE
       /\ UNCHANGED <<trouble, settling, endTurn, live, screen, dropped>>

\* review.tsx SaveBanner "Retry save" -> controller.ts save -> POST save.
YouPressRetrySave ==
    /\ screen = "review" /\ endTurn = "wrapped" /\ saved # "saved" /\ ~saving
    /\ saveError \/ saved = "save_pending"
    /\ saving' = TRUE
    /\ UNCHANGED <<trouble, settling, endTurn, live, wrapMemo, saved, saveError, screen, dropped>>

\* Leaving the review drops the controller's state; a reload does the same.
YouGoHome ==
    /\ screen = "review" /\ live # "streaming" /\ ~saving /\ ~settling
    /\ screen' = "home" /\ live' = "none" /\ saveError' = FALSE
    /\ UNCHANGED <<trouble, settling, endTurn, wrapMemo, saved, saving, dropped>>

\* home.tsx reviewTarget: open while not ended, the record once saved, and with the fix the review while its
\* save is pending. Without the fix an ended review that is not saved has no link.
HomeHasALink == endTurn # "wrapped" \/ saved = "saved" \/ (FixHome /\ saved = "save_pending")
YouOpenTheReviewFromHome ==
    /\ screen = "home" /\ HomeHasALink /\ saved # "saved"
    /\ screen' = "review"
    /\ UNCHANGED <<trouble, settling, endTurn, live, wrapMemo, saved, saving, saveError, dropped>>

Done == saved = "saved" /\ UNCHANGED vars

Next ==
    \/ TroubleClears \/ TroubleStarts \/ ThePreviousTurnSettles \/ YouConfirmFinish \/ TheEndRequestFails
    \/ TheBackendStoresYourEnd \/ TheWrapUpMoveFails \/ TheTutorWrapsUp \/ YouPressRetry
    \/ YouPressFinishAgain \/ TheSaveRuns \/ YouPressRetrySave \/ YouGoHome
    \/ YouOpenTheReviewFromHome \/ Done

\* The learner keeps trying and the machines keep running; nothing forces the learner to go home.
Fairness ==
    /\ WF_vars(TroubleClears) /\ WF_vars(ThePreviousTurnSettles)
    /\ WF_vars(TheBackendStoresYourEnd) /\ WF_vars(TheTutorWrapsUp) /\ WF_vars(TheSaveRuns)
    /\ SF_vars(YouConfirmFinish) /\ SF_vars(YouPressFinishAgain)
    /\ SF_vars(YouPressRetry /\ RetryFindsATurn) /\ SF_vars(YouPressRetrySave)
    /\ SF_vars(YouOpenTheReviewFromHome)

Spec == Init /\ [][Next]_vars /\ Fairness

\* "When the screen offers Retry, pressing it resends something."
RetryAlwaysResends == RetryOffered => RetryFindsATurn
\* "A Finish I confirmed is sent, or I am told it was not."
FinishIsNeverSilentlyDropped == ~dropped
\* "A review that ended without saving can always be reached from home."
EndedUnsavedIsReachableFromHome == screen = "home" => HomeHasALink
\* "Once the trouble is over, a review I finished gets saved if I keep retrying."
AFinishedReviewEventuallySaves == <>[](~trouble) => ((endTurn # "none") ~> (saved = "saved"))
====
