---- MODULE PreparationChart ----
\* A slice of Preparation.tla small enough to chart whole (under 500 states). It checks nothing new:
\* the rules are checked on the full model with Preparation.cfg. The slice keeps one closed chunk,
\* one review, capture that never pauses or stops, no resource search, and no page waiting on an ask.
EXTENDS Preparation

ChartSlice ==
    /\ resources = "not started"
    /\ capture \in {"not started", "capturing"}
    /\ review # "nothing to review"
    /\ 2 \notin closed
    /\ waitingOn = 0
====
