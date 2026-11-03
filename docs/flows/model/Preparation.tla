---- MODULE Preparation ----
\* Capture, chunking, claim preparation, invites and review scope from docs/flows/after-class.md
\* sections A-D. Checks R3-R10. The review record (detours, disputes, saving, evidence) is Record.tla.
\* Each flow line tagged "(TLC fix Rn)" is quoted above the guard or step that models it.
\* Time is abstract: "~30s", "~8 min" and "~15 min" are free choices of the order of steps.
\* [agent] and [Jev] steps may give any answer the flow allows. [code] steps do what their line says.

EXTENDS Naturals

CONSTANTS Passages, ClaimsPerChunk

Chunks == {1, 2}
Claims == Chunks \X (1..ClaimsPerChunk)
ClaimsIn(S) == {c \in Claims : c[1] \in S}
NoQuestion == <<0, 0>>

InFlight == {"checking", "revising", "rechecking"}
Pending == {"queued"} \union InFlight
Finished == {"supported", "unverified", "dropped"}

VARIABLES
    capture,        \* "not started" | "capturing" | "paused" | "stopped"
    watched,        \* passages watched so far
    closed,         \* chunks that are closed
    boundary,       \* last passage of chunk 1, 0 while chunk 1 is open
    boundaryFixed,  \* a later window already moved chunk 1's boundary (bounded to once)
    status,         \* each claim's preparation state
    revisions,      \* revisions each claim has had in total, 2 means two or more
    late,           \* results still in flight from jobs that were cancelled or made outdated
    resources,      \* the supplemental resource search
    invite,         \* "none" | "invited" | "later" | "waiting"
    review,         \* "none" | "nothing to review" | "active"
    scope,          \* chunks frozen into the review
    reviewed,       \* chunks whose review has ended
    question,       \* NoQuestion, or the claim the open question judges my answer against
    paused          \* NoQuestion, or the claim whose question paused while it is rechecked

vars == <<capture, watched, closed, boundary, boundaryFixed, status, revisions, late,
          resources, invite, review, scope, reviewed, question, paused>>
CaptureVars == <<capture, watched, closed, boundary, boundaryFixed>>
PrepVars == <<status, revisions, late, resources>>
ReviewVars == <<invite, review, scope, reviewed, question, paused>>

\* The passages chunk ch holds when chunk 1 ends at passage b.
MaterialAt(ch, b) ==
    IF ch = 1
    THEN IF 1 \in closed THEN 1..b ELSE 1..watched
    ELSE IF 1 \in closed THEN (b + 1)..watched ELSE {}

Material(ch) == MaterialAt(ch, boundary)

ScopeMaterial == UNION {Material(ch) : ch \in scope}

Prepared(ch) == ch \in closed /\ \A c \in ClaimsIn({ch}) : status[c] \in Finished
ReadyScope == {ch \in closed \ reviewed : Prepared(ch)}
HasSupported(S) == \E c \in ClaimsIn(S) : status[c] = "supported"

TypeOK ==
    /\ capture \in {"not started", "capturing", "paused", "stopped"}
    /\ watched \in 0..Passages
    /\ closed \subseteq Chunks
    /\ boundary \in 0..Passages
    /\ boundaryFixed \in BOOLEAN
    /\ status \in [Claims -> {"none"} \union Pending \union Finished]
    /\ revisions \in [Claims -> 0..2]
    /\ late \in [Claims -> SUBSET {"cancelled", "outdated"}]
    /\ resources \in {"not started", "searching", "found", "failed"}
    /\ invite \in {"none", "invited", "later", "waiting"}
    /\ review \in {"none", "nothing to review", "active"}
    /\ scope \subseteq Chunks
    /\ reviewed \subseteq Chunks
    /\ question \in {NoQuestion} \union Claims
    /\ paused \in {NoQuestion} \union Claims

Init ==
    /\ capture = "not started"
    /\ watched = 0
    /\ closed = {}
    /\ boundary = 0
    /\ boundaryFixed = FALSE
    /\ status = [c \in Claims |-> "none"]
    /\ revisions = [c \in Claims |-> 0]
    /\ late = [c \in Claims |-> {}]
    /\ resources = "not started"
    /\ invite = "none"
    /\ review = "none"
    /\ scope = {}
    /\ reviewed = {}
    /\ question = NoQuestion
    /\ paused = NoQuestion

\* The chunk that is open now, or 0 when both are closed.
OpenChunk == IF 1 \notin closed THEN 1 ELSE IF 2 \notin closed THEN 2 ELSE 0
OpenHasMaterial == OpenChunk # 0 /\ Material(OpenChunk) # {}

\* [code] Chunk closed -> valid cache hit? reuse : queue interpretation.
CloseOpenChunk ==
    /\ closed' = closed \union {OpenChunk}
    /\ boundary' = IF OpenChunk = 1 THEN watched ELSE boundary
    /\ status' = [c \in Claims |-> IF c[1] = OpenChunk THEN "queued" ELSE status[c]]

\* ---------------- A. Capture ----------------

\* [user] Start capture on a YouTube tab.
YouStartCapture ==
    /\ capture = "not started"
    /\ capture' = "capturing"
    /\ UNCHANGED <<watched, closed, boundary, boundaryFixed>>
    /\ UNCHANGED PrepVars /\ UNCHANGED ReviewVars

\* [code] While active, record watched intervals, caption passages, frame candidates.
YouWatchAPassage ==
    /\ capture = "capturing"
    /\ watched < Passages
    /\ 2 \notin closed
    /\ watched' = watched + 1
    /\ UNCHANGED <<capture, closed, boundary, boundaryFixed>>
    /\ UNCHANGED PrepVars /\ UNCHANGED ReviewVars

\* [user] Pause ... capture at any time. [code] Tab leaves YouTube watch pages -> auto-pause capture.
CapturePauses ==
    /\ capture = "capturing"
    /\ capture' = "paused"
    /\ UNCHANGED <<watched, closed, boundary, boundaryFixed>>
    /\ UNCHANGED PrepVars /\ UNCHANGED ReviewVars

\* [user] ... resume ... capture at any time.
YouResumeCapture ==
    /\ capture = "paused"
    /\ capture' = "capturing"
    /\ UNCHANGED <<watched, closed, boundary, boundaryFixed>>
    /\ UNCHANGED PrepVars /\ UNCHANGED ReviewVars

\* [user] ... stop capture at any time.
\* [code] Session ends/stops -> close the open chunk, provenance "session end".
YouStopCapture ==
    /\ capture \in {"capturing", "paused"}
    /\ capture' = "stopped"
    /\ IF OpenHasMaterial
       THEN CloseOpenChunk
       ELSE UNCHANGED <<closed, boundary, status>>
    /\ UNCHANGED <<watched, boundaryFixed, revisions, late, resources>>
    /\ UNCHANGED ReviewVars

\* ---------------- B. Preprocessing during viewing ----------------

\* [Jev] new concept yes, stopping point yes -> close chunk at boundary, queue interpretation; may invite review.
\* [code] Invite on a boundary close (yes/yes).
\* [code] Later -> ... next invite at the next boundary close.
ChunkClosesAtABoundary ==
    /\ capture = "capturing"
    /\ OpenHasMaterial
    /\ CloseOpenChunk
    /\ invite' = "invited"
    /\ UNCHANGED <<capture, watched, boundaryFixed, revisions, late, resources>>
    /\ UNCHANGED <<review, scope, reviewed, question, paused>>

\* [code] Chunk exceeds time cap (~8 min watched) -> close it, provenance "time".
\* [code] On a time-cap close, invite only if >= ~15 min watched since the last invite or Later.
ChunkHitsTheTimeCap ==
    /\ capture = "capturing"
    /\ OpenHasMaterial
    /\ CloseOpenChunk
    /\ invite' \in {invite, "invited"}
    /\ UNCHANGED <<capture, watched, boundaryFixed, revisions, late, resources>>
    /\ UNCHANGED <<review, scope, reviewed, question, paused>>

\* [code] Later evidence revises a boundary mid-review -> reprocess affected claims only.
\* The yes/no row ("flag for re-check on the next window") is how a closed boundary gets revised.
\* The flow does not say which way a boundary may move, so it may move either way by one passage.
\* Claims of closed chunks are reprocessed (checked again). Jobs running on the old chunk become
\* outdated, and their results are still in flight.
ALaterWindowMovesABoundary ==
    /\ capture = "capturing"
    /\ 1 \in closed
    /\ ~boundaryFixed
    /\ \E nb \in {boundary - 1, boundary + 1} :
        /\ nb >= 1
        /\ nb <= watched
        /\ (2 \in closed) => nb < watched
        \* [code] While a review is open, a boundary move can't add material to its scope;
        \*        extra material queues for a later review. Shrinking is allowed.  (TLC fix R7)
        \* A move that would add material waits until the review ends. Until then the material stays
        \* in a chunk outside the scope, which a later review covers.
        /\ review = "active" => UNION {MaterialAt(ch, nb) : ch \in scope} \subseteq ScopeMaterial
        /\ boundary' = nb
    /\ boundaryFixed' = TRUE
    /\ LET redo == {c \in ClaimsIn(closed) : status[c] \in InFlight \union {"supported", "unverified"}}
       IN /\ status' = [c \in Claims |-> IF c \in redo THEN "checking" ELSE status[c]]
          \* [code] A claim being rechecked is out of assessment until it passes again; an
          \*        open question on it pauses and the tutor says why.  (TLC fix R3)
          /\ IF question \in redo
             THEN /\ paused' = question
                  /\ question' = NoQuestion
             ELSE UNCHANGED <<paused, question>>
    /\ late' = [c \in Claims |->
                    IF c \in ClaimsIn(closed) /\ status[c] \in InFlight
                    THEN late[c] \union {"outdated"} ELSE late[c]]
    /\ UNCHANGED <<capture, watched, closed, revisions, resources>>
    /\ UNCHANGED <<invite, review, scope, reviewed>>

\* ---------------- C. Preparation and review invites ----------------

\* [agent] Write evidence-linked concepts, assumptions, possible confusions.
AgentWritesAClaim(c) ==
    /\ status[c] = "queued"
    /\ status' = [status EXCEPT ![c] = "checking"]
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<revisions, late, resources>> /\ UNCHANGED ReviewVars

\* [Jev] "Does this evidence support the claim in its stated scope?"
\* [code] yes -> supported_by_check. no/uncertain -> one revision.
\* [code] A claim keeps its used revision through reprocessing and retry.  (TLC fix R4)
\* revisions is never reset, so a claim checked again after reprocessing or retry that has used
\* its revision goes the way of "Still no/uncertain -> unverified".
JevChecksAClaim(c) ==
    /\ status[c] = "checking"
    /\ status' \in {[status EXCEPT ![c] = "supported"],
                    [status EXCEPT ![c] = IF revisions[c] = 0 THEN "revising" ELSE "unverified"]}
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<revisions, late, resources>> /\ UNCHANGED ReviewVars

\* [agent] Revise once against the evidence; never fill missing capture.
AgentRevisesAClaim(c) ==
    /\ status[c] = "revising"
    /\ status' = [status EXCEPT ![c] = "rechecking"]
    /\ revisions' = [revisions EXCEPT ![c] = IF @ < 2 THEN @ + 1 ELSE 2]
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<late, resources>> /\ UNCHANGED ReviewVars

\* [Jev] Same question on the revised claim.
\* [code] Still no/uncertain -> unverified; excluded from assessment.
JevRechecksAClaim(c) ==
    /\ status[c] = "rechecking"
    /\ status' \in {[status EXCEPT ![c] = "supported"], [status EXCEPT ![c] = "unverified"]}
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<revisions, late, resources>> /\ UNCHANGED ReviewVars

\* [code] Stop early -> ... late results from cancelled jobs are logged, never applied.
\* [code] Every job carries the claim revision it worked on; a result for an
\*        outdated revision is logged, never applied.  (TLC fix R8)
\* An "outdated" job is one whose carried revision is older than the claim's after a boundary move.
ALateResultArrives(c) ==
    /\ \E kind \in late[c] :
        /\ late' = [late EXCEPT ![c] = @ \ {kind}]
        /\ UNCHANGED status
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<revisions, resources>> /\ UNCHANGED ReviewVars

\* [agent] Separate job: find supplemental resources for supported concepts.
ResourceSearchStarts ==
    /\ resources = "not started"
    /\ \E c \in Claims : status[c] = "supported"
    /\ resources' = "searching"
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<status, revisions, late>> /\ UNCHANGED ReviewVars

\* [code] Store citations + relevance links; failure never blocks review.
ResourceSearchEnds ==
    /\ resources = "searching"
    /\ resources' \in {"found", "failed"}
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<status, revisions, late>> /\ UNCHANGED ReviewVars

\* [user] ... Later. [code] Later -> keep preparing; next invite at the next boundary close.
YouChooseLater ==
    /\ invite \in {"invited", "waiting"}
    /\ invite' = "later"
    /\ UNCHANGED CaptureVars /\ UNCHANGED PrepVars /\ UNCHANGED <<review, scope, reviewed, question, paused>>

\* [user] ... wait. [code] Wait -> show Processing; estimate only when reliable.
YouChooseWait ==
    /\ invite = "invited"
    /\ invite' = "waiting"
    /\ UNCHANGED CaptureVars /\ UNCHANGED PrepVars /\ UNCHANGED <<review, scope, reviewed, question, paused>>

\* [user] Review now ... (Review now always available.)
\* [code] Freeze review scope = prepared chunks now; new viewing queues for later.
YouStartAReview ==
    /\ review \in {"none", "nothing to review"}
    /\ HasSupported(ReadyScope)
    /\ review' = "active"
    /\ scope' = ReadyScope
    /\ invite' = "none"
    /\ UNCHANGED <<reviewed, question, paused>>
    /\ UNCHANGED CaptureVars /\ UNCHANGED PrepVars

\* [code] No supported claims in scope -> don't start; show gaps and unverified claims with evidence.
YouPressReviewNowWithNothingSupported ==
    /\ review = "none"
    /\ ~HasSupported(ReadyScope)
    /\ review' = "nothing to review"
    /\ UNCHANGED <<invite, scope, reviewed, question, paused>>
    /\ UNCHANGED CaptureVars /\ UNCHANGED PrepVars

\* [code] ... offer rewatch of that interval or retry.
\* Retry queues again the claims that never finished (Stop early dropped them). Rewatch changes
\* nothing here, because new watching is new material.
YouRewatchOrRetry ==
    /\ review = "nothing to review"
    /\ review' = "none"
    /\ \/ UNCHANGED status
       \/ status' = [c \in Claims |->
                        IF c \in ClaimsIn(closed \ reviewed) /\ status[c] = "dropped"
                        THEN "queued" ELSE status[c]]
    /\ UNCHANGED <<invite, scope, reviewed, question, paused>>
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<revisions, late, resources>>

\* [user] ... Stop early.
\* [code] Stop early -> cancel pending jobs in scope; keep every finished claim.
\* [code] Freeze review scope = prepared chunks now.
\* [code] No supported claims in scope -> don't start.
YouStopEarly ==
    /\ invite \in {"invited", "waiting"}
    /\ review # "active"
    /\ \E c \in ClaimsIn(closed \ reviewed) : status[c] \in Pending
    /\ LET s == [c \in Claims |->
                    IF c \in ClaimsIn(closed \ reviewed) /\ status[c] \in Pending
                    THEN "dropped" ELSE status[c]]
           ok == \E c \in ClaimsIn(closed \ reviewed) : s[c] = "supported"
       IN /\ status' = s
          /\ late' = [c \in Claims |->
                        IF c \in ClaimsIn(closed \ reviewed) /\ status[c] \in InFlight
                        THEN late[c] \union {"cancelled"} ELSE late[c]]
          /\ review' = IF ok THEN "active" ELSE "nothing to review"
          /\ scope' = IF ok THEN closed \ reviewed ELSE scope
    /\ invite' = "none"
    /\ UNCHANGED <<reviewed, question, paused>>
    /\ UNCHANGED CaptureVars /\ UNCHANGED <<revisions, resources>>

\* ---------------- D. Review ----------------

\* [agent] Up to 3 main questions; follow-ups as needed. Evidence shown beside.
\* Code keeps out what the flow excludes: unverified claims ("excluded from assessment") and
\* claims Stop early did not keep ("keep every finished claim").
TutorAsksAboutAClaim(c) ==
    /\ review = "active"
    /\ question = NoQuestion
    /\ c \in ClaimsIn(scope)
    /\ c # paused
    /\ status[c] \notin {"unverified", "dropped"}
    \* [code] A claim being rechecked is out of assessment until it passes again.  (TLC fix R3)
    /\ status[c] \notin Pending
    /\ question' = c
    /\ UNCHANGED <<invite, review, scope, reviewed, paused>>
    /\ UNCHANGED CaptureVars /\ UNCHANGED PrepVars

\* [code] A claim being rechecked is out of assessment until it passes again; an
\*        open question on it pauses and the tutor says why.  (TLC fix R3)
\* The paused question is how the tutor returns to that claim, once the claim passes again. If the
\* claim ends unverified, the question stays paused until the review ends.
TutorResumesThePausedQuestion ==
    /\ review = "active"
    /\ question = NoQuestion
    /\ paused # NoQuestion
    /\ status[paused] = "supported"
    /\ question' = paused
    /\ paused' = NoQuestion
    /\ UNCHANGED <<invite, review, scope, reviewed>>
    /\ UNCHANGED CaptureVars /\ UNCHANGED PrepVars

\* [user] Speak/type an answer, skip, "I don't know", hint, explain-it.
YouAnswer ==
    /\ question # NoQuestion
    /\ question' = NoQuestion
    /\ UNCHANGED <<invite, review, scope, reviewed, paused>>
    /\ UNCHANGED CaptureVars /\ UNCHANGED PrepVars

\* [user] ... end.
YouEndTheReview ==
    /\ review = "active"
    /\ review' = "none"
    /\ reviewed' = reviewed \union scope
    /\ scope' = {}
    /\ question' = NoQuestion
    /\ paused' = NoQuestion
    /\ UNCHANGED invite
    /\ UNCHANGED CaptureVars /\ UNCHANGED PrepVars

Next ==
    \/ YouStartCapture
    \/ YouWatchAPassage
    \/ CapturePauses
    \/ YouResumeCapture
    \/ YouStopCapture
    \/ ChunkClosesAtABoundary
    \/ ChunkHitsTheTimeCap
    \/ ALaterWindowMovesABoundary
    \/ \E c \in Claims : AgentWritesAClaim(c)
    \/ \E c \in Claims : JevChecksAClaim(c)
    \/ \E c \in Claims : AgentRevisesAClaim(c)
    \/ \E c \in Claims : JevRechecksAClaim(c)
    \/ \E c \in Claims : ALateResultArrives(c)
    \/ ResourceSearchStarts
    \/ ResourceSearchEnds
    \/ YouChooseLater
    \/ YouChooseWait
    \/ YouStartAReview
    \/ YouPressReviewNowWithNothingSupported
    \/ YouRewatchOrRetry
    \/ YouStopEarly
    \/ \E c \in Claims : TutorAsksAboutAClaim(c)
    \/ TutorResumesThePausedQuestion
    \/ YouAnswer
    \/ YouEndTheReview

\* Code, agent and Jev preparation steps keep running once they can.
Fairness ==
    \A c \in Claims :
        /\ WF_vars(AgentWritesAClaim(c))
        /\ WF_vars(JevChecksAClaim(c))
        /\ WF_vars(AgentRevisesAClaim(c))
        /\ WF_vars(JevRechecksAClaim(c))

Spec == Init /\ [][Next]_vars /\ Fairness

\* ================= Derek's [TLC] rules, verbatim =================

\* R3: A claim can be used to judge my answers only if it passed the evidence check.
R3_JudgedOnlyAgainstCheckedClaims ==
    question # NoQuestion => status[question] = "supported"

\* R4: A claim gets at most one revision; after that it's unverified.
R4_AtMostOneRevision ==
    \A c \in Claims : revisions[c] <= 1

\* R5: Choosing Later never cancels preparation.
\* Checked three ways. The Later step leaves every claim's preparation as it was. After Later, each
\* claim still being prepared finishes. Finishing includes "dropped" only because Stop early, a
\* separate choice, is the one step that drops a claim, which the third formula checks.
R5_LaterLeavesPreparation ==
    [][YouChooseLater => UNCHANGED <<status, late>>]_vars

R5_PreparationFinishesAfterLater ==
    \A c \in Claims :
        [](invite = "later" /\ status[c] \in Pending => <>(status[c] \in Finished))

R5_OnlyStopEarlyCancels ==
    [][(\E c \in Claims : status[c] # "dropped" /\ status'[c] = "dropped") => YouStopEarly]_vars

\* R6: A pending resource search never blocks a review that is otherwise ready.
R6_ResourcesNeverBlockReview ==
    (review \in {"none", "nothing to review"} /\ HasSupported(ReadyScope)) => ENABLED YouStartAReview

\* R7: Once a review starts, its scope never grows; corrections can change claims inside it but can't add material.
R7_ScopeNeverGrows ==
    [][(review = "active" /\ review' = "active") =>
        (scope' \subseteq scope /\ ScopeMaterial' \subseteq ScopeMaterial)]_vars

\* R8: Results from cancelled or outdated jobs never overwrite current preparation or my notes.
\* (Notes are in Record.tla; no job result reaches them there.)
R8_LateResultsNeverOverwrite ==
    [][\A c \in Claims : (late'[c] # late[c] /\ late'[c] \subseteq late[c]) => status'[c] = status[c]]_vars

\* R9: Starting a review doesn't stop capture, and stopping capture doesn't end a review.
R9_ReviewAndCaptureIndependent ==
    /\ [][(review # "active" /\ review' = "active") => capture' = capture]_vars
    /\ [][(capture # "stopped" /\ capture' = "stopped") => (review' = review /\ scope' = scope)]_vars

\* R10: A review never starts with zero supported claims in scope.
R10_NeverStartsEmpty ==
    [][(review # "active" /\ review' = "active") => HasSupported(scope')]_vars
====
