---- MODULE Record ----
\* One review and its learning record from docs/flows/after-class.md section D, starting when the
\* review has started on a frozen scope of supported claims. Checks R11, R14, R16.
\* Each flow line tagged "(TLC fix Rn)" is quoted above the step that models it.
\* Preparation, scope and capture are Preparation.tla.
\* [agent] steps may give any answer the flow allows. [code] steps do what their line says.

EXTENDS Naturals

CONSTANTS Claims

NoQuestion == 0

VARIABLES
    review,     \* "active" | "ended"
    resources,  \* the supplemental resource search for this scope
    question,   \* NoQuestion, or the claim the open question is about
    obs,        \* each claim's observation in the review
    counted,    \* each claim's saved assessment
    detour,     \* "none" | "offered" | "waiting" | "on"
    detourYes,  \* I said yes to the current detour offer
    note,       \* the note for this review
    evidence    \* the raw evidence the note cites

vars == <<review, resources, question, obs, counted, detour, detourYes, note, evidence>>
RecordVars == <<note, evidence>>

TypeOK ==
    /\ review \in {"active", "ended"}
    /\ resources \in {"not started", "searching", "found", "failed"}
    /\ question \in {NoQuestion} \union Claims
    /\ obs \in [Claims -> {"none", "answered", "disputed", "resolved gap", "resolved not gap"}]
    /\ counted \in [Claims -> {"none", "gap", "not gap", "not assessed", "disputed"}]
    /\ detour \in {"none", "offered", "waiting", "on"}
    /\ detourYes \in BOOLEAN
    /\ note \in {"none", "pending", "saved", "deleted"}
    /\ evidence \in {"kept", "expired", "deleted by me"}

Init ==
    /\ review = "active"
    /\ resources \in {"not started", "searching", "found", "failed"}
    /\ question = NoQuestion
    /\ obs = [c \in Claims |-> "none"]
    /\ counted = [c \in Claims |-> "none"]
    /\ detour = "none"
    /\ detourYes = FALSE
    /\ note = "none"
    /\ evidence = "kept"

\* [code] Store citations + relevance links; failure never blocks review.
ResourceSearchEnds ==
    /\ resources = "searching"
    /\ resources' \in {"found", "failed"}
    /\ detour' = IF detour = "waiting" THEN "on" ELSE detour
    /\ UNCHANGED <<review, question, obs, counted, detourYes>> /\ UNCHANGED RecordVars

\* [agent] Up to 3 main questions; follow-ups as needed. Evidence shown beside.
TutorAsksAboutAClaim(c) ==
    /\ review = "active"
    /\ question = NoQuestion
    /\ detour = "none"
    /\ obs[c] = "none"
    /\ question' = c
    /\ UNCHANGED <<review, resources, obs, counted, detour, detourYes>> /\ UNCHANGED RecordVars

\* [user] Speak/type an answer.
YouAnswer ==
    /\ review = "active"
    /\ question # NoQuestion
    /\ obs' = [obs EXCEPT ![question] = "answered"]
    /\ question' = NoQuestion
    /\ UNCHANGED <<review, resources, counted, detour, detourYes>> /\ UNCHANGED RecordVars

\* [user] ... skip, "I don't know".
YouSkip ==
    /\ review = "active"
    /\ question # NoQuestion
    /\ question' = NoQuestion
    /\ UNCHANGED <<review, resources, obs, counted, detour, detourYes>> /\ UNCHANGED RecordVars

\* [user] Dispute an interpretation.
YouDispute(c) ==
    /\ review = "active"
    /\ obs[c] = "answered"
    /\ obs' = [obs EXCEPT ![c] = "disputed"]
    /\ UNCHANGED <<review, resources, question, counted, detour, detourYes>> /\ UNCHANGED RecordVars

\* [agent] Recheck source, show evidence, let the user explain; unsettled -> stays disputed.
\* Settling is mine: I either accept it as a gap or show it is not one.
YouSettleTheDispute(c) ==
    /\ review = "active"
    /\ obs[c] = "disputed"
    /\ obs' \in {[obs EXCEPT ![c] = "resolved gap"], [obs EXCEPT ![c] = "resolved not gap"]}
    /\ UNCHANGED <<review, resources, question, counted, detour, detourYes>> /\ UNCHANGED RecordVars

\* [agent] Prerequisite gap suspected -> propose a detour.
TutorOffersADetour ==
    /\ review = "active"
    /\ question = NoQuestion
    /\ detour = "none"
    /\ \E c \in Claims : obs[c] # "none"
    /\ detour' = "offered"
    /\ detourYes' = FALSE
    /\ UNCHANGED <<review, resources, question, obs, counted>> /\ UNCHANGED RecordVars

\* [user] Accept or decline the detour.
\* [code] Detour needs a pending resource -> offer wait, or continue on lecture evidence.
YouAcceptTheDetour ==
    /\ detour = "offered"
    /\ detourYes' = TRUE
    /\ detour' = IF resources = "searching" THEN "waiting" ELSE "on"
    /\ UNCHANGED <<review, resources, question, obs, counted>> /\ UNCHANGED RecordVars

YouDeclineTheDetour ==
    /\ detour = "offered"
    /\ detour' = "none"
    /\ UNCHANGED <<review, resources, question, obs, counted, detourYes>> /\ UNCHANGED RecordVars

\* "... or continue on lecture evidence."
YouContinueOnLectureEvidence ==
    /\ detour = "waiting"
    /\ detour' = "on"
    /\ UNCHANGED <<review, resources, question, obs, counted, detourYes>> /\ UNCHANGED RecordVars

TheDetourEnds ==
    /\ detour = "on"
    /\ detour' = "none"
    /\ UNCHANGED <<review, resources, question, obs, counted, detourYes>> /\ UNCHANGED RecordVars

\* [user] ... end.
\* [agent] Propose each observation's status (independent / partial / after help / unresolved /
\*         not assessed) from the actual turns. Here "gap" stands for the statuses that count as a
\*         learning gap and "not gap" for the rest.
\* [code] Clamp the proposal: help before the answer caps at "after help";
\*        skipped or unanswered is "not assessed"; a dispute still open or
\*        unsettled saves as "disputed", never as a gap.  (TLC fix R14)
\* [code] Save notes, observations, suggested graph links, evidence refs (stable IDs).
\* [code] Save fails -> keep a pending save locally, show it, offer retry.
YouEndTheReview ==
    /\ review = "active"
    /\ \E proposal \in [Claims -> {"gap", "not gap"}] :
        counted' = [c \in Claims |->
                      CASE obs[c] = "none" -> "not assessed"
                        [] obs[c] = "disputed" -> "disputed"
                        [] OTHER -> proposal[c]]
    /\ note' \in {"saved", "pending"}
    /\ review' = "ended"
    /\ question' = NoQuestion
    /\ detour' = "none"
    /\ detourYes' = FALSE
    /\ UNCHANGED <<resources, obs, evidence>>

\* [code] ... offer retry (stable IDs make retry overwrite, not duplicate).
YouRetryTheSave ==
    /\ note = "pending"
    /\ note' = "saved"
    /\ UNCHANGED <<review, resources, question, obs, counted, detour, detourYes, evidence>>

\* [user] Inspect, edit, accept/correct links, revisit, delete.
YouDeleteTheNote ==
    /\ note = "saved"
    /\ note' = "deleted"
    /\ UNCHANGED <<review, resources, question, obs, counted, detour, detourYes, evidence>>

YouDeleteTheEvidence ==
    /\ review = "ended"
    /\ evidence = "kept"
    /\ evidence' = "deleted by me"
    /\ UNCHANGED <<review, resources, question, obs, counted, detour, detourYes, note>>

\* From the MVP spec: "the accepted thirty-day expiry applies only to uncited raw captures".
\* Not while the review is open.
\* [code] Evidence cited by a pending save counts as cited; expiry skips it.  (TLC fix R16)
RawEvidenceExpires ==
    /\ review = "ended"
    /\ evidence = "kept"
    /\ note \notin {"saved", "pending"}
    /\ evidence' = "expired"
    /\ UNCHANGED <<review, resources, question, obs, counted, detour, detourYes, note>>

\* Nothing is left to happen: the review ended, I deleted the note, and the evidence is gone.
Done ==
    /\ review = "ended"
    /\ resources # "searching"
    /\ note = "deleted"
    /\ evidence # "kept"
    /\ UNCHANGED vars

Next ==
    \/ ResourceSearchEnds
    \/ \E c \in Claims : TutorAsksAboutAClaim(c)
    \/ YouAnswer
    \/ YouSkip
    \/ \E c \in Claims : YouDispute(c)
    \/ \E c \in Claims : YouSettleTheDispute(c)
    \/ TutorOffersADetour
    \/ YouAcceptTheDetour
    \/ YouDeclineTheDetour
    \/ YouContinueOnLectureEvidence
    \/ TheDetourEnds
    \/ YouEndTheReview
    \/ YouRetryTheSave
    \/ YouDeleteTheNote
    \/ YouDeleteTheEvidence
    \/ RawEvidenceExpires
    \/ Done

Spec == Init /\ [][Next]_vars

\* ================= Derek's [TLC] rules, verbatim =================

\* R11: A detour only starts after I say yes.
R11_DetourOnlyAfterYes ==
    detour \in {"waiting", "on"} => detourYes

\* R14: A disputed assessment is never counted as a learning gap unless I resolve it that way.
R14_DisputedNeverCountedAsGap ==
    \A c \in Claims : counted[c] = "gap" => obs[c] \in {"answered", "resolved gap"}

\* R16: Evidence cited by a saved note is only deleted when I delete it, never by expiry.
R16_CitedEvidenceNeverExpires ==
    note = "saved" => evidence # "expired"
====
