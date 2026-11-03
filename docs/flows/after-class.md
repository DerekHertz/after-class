# After Class flow

Status: in review. Sections are approved one at a time. Nothing here is formally checked yet.

## Acceptance lectures (approved 2026-11-03)

1. MIT 18.06 Lecture 1, "The geometry of linear equations" (Strang). Chalkboard, equation- and diagram-dependent, CC BY-NC-SA, so it doubles as the replay sample. Caption quality unverified.
2. Georgia Tech Advanced Operating Systems, Lamport's clocks lesson, starting at "Lamport's Physical Clock" (`QgWz_s7uugE`, Udacity playlist `PLAwxTw4SYaPm4vV1XbFV93ZuT2saSq1hO`, index 134). Multi-clip topic, space-time diagrams and clock-drift inequalities. Live only; not redistributable as a sample.

## A. Capture (approved 2026-11-03)

```text
[user] Start capture on a YouTube tab.
[code] Show source, caption status, frame health. On failure, show it, offer retry.
[code] While active, record watched intervals, caption passages, frame candidates.
[code] Pause/seek/speed/replay update media-time intervals; never wall-clock.
[code] Captions unusable → offer opt-in transcription.
[user] Accept, or continue with a visible transcript gap.
[code] A channel fails → keep other evidence, record the missing interval.
[code] Next video in the same tab → new source, same session.
[code] Ad playing → suspend evidence, log the interval as "ad", not a gap.
[code] Tab leaves YouTube watch pages → auto-pause capture, show it.
[code] Tab hidden/minimized → keep captions; frames may stall, log
       those intervals as a frame gap (not invented frames).
[user] Pause, resume or stop capture at any time.
```

## B. Preprocessing during viewing (approved 2026-11-03)

Numbers (30s, 2 min, 8 min) are starting values to tune on held-out clips.

```text
[code] Every ~30s of newly watched captions, build a window:
       last ~2 min of context + the new passage (+ frames if visual-dependent).
[code] Already-judged windows (rewatch/seek back) → reuse cached judgment.
[Jev]  Given the window: "Does the new passage begin a materially different
       concept?" yes = new concept; no = continues/elaborates/example.
[Jev]  Given the same window: "Has the preceding explanation reached a
       coherent stopping point?" yes = closed; no = a step is unfinished.
[code] Route per table below. Jev error/uncertain → treat as "continue".
[code] Chunk exceeds time cap (~8 min watched) → close it, provenance "time".
[code] Video ends → do NOT close; the next clip's first window decides.
[code] Session ends/stops → close the open chunk, provenance "session end".
[code] Code proposes frame candidates by cheap pixel diff.
[Jev]  Given before/after frames + nearby captions: "Does the change add
       teaching content?" yes = keep as step; no = drop as duplicate/motion.
[code] Uncertain visual → keep the frame.
```

| New concept | Stopping point | Action |
| --- | --- | --- |
| yes | yes | Close chunk at boundary, queue interpretation; may invite review |
| no | yes | Soft pause inside topic; don't close; preferred time-fallback cut point |
| yes | no | Don't close; flag for re-check on the next window |
| no | no | Continue collecting |

## C. Preparation and review invites (approved 2026-11-03)

```text
[code] Chunk closed → valid cache hit? reuse : queue interpretation.
[agent] Write evidence-linked concepts, assumptions, possible confusions.
[Jev]  Given one claim + its passages (+ frames if visual): "Does this evidence
       support the claim in its stated scope?" yes = supported; no = not.
[code] yes → supported_by_check. no/uncertain → one revision.
[agent] Revise once against the evidence; never fill missing capture.
[Jev]  Same question on the revised claim.
[code] Still no/uncertain → unverified; excluded from assessment.
[agent] Separate job: find supplemental resources for supported concepts.
[code] Store citations + relevance links; failure never blocks review.
[code] Invite on a boundary close (yes/yes). On a time-cap close, invite only
       if ≥ ~15 min watched since the last invite or Later.
[user] Review now / Later / wait / Stop early. (Review now always available.)
[code] Later → keep preparing; next invite at the next boundary close.
[code] Wait → show Processing; estimate only when reliable.
[code] Stop early → cancel pending jobs in scope; keep every finished claim;
       late results from cancelled jobs are logged, never applied.
[code] Freeze review scope = prepared chunks now; new viewing queues for later.
[code] No supported claims in scope → don't start; show gaps and unverified
       claims with evidence; offer rewatch of that interval or retry.
```

## D. Review and learning record (approved 2026-11-03)

```text
[agent] Open recall question on the frozen scope (no recap first).
[user] Speak/type an answer, skip, "I don't know", hint, explain-it, pause, end.
[agent] Up to 3 main questions; follow-ups as needed. Evidence shown beside.
[agent] Mismatch → one tentative, source-grounded diagnostic question.
[agent] Prerequisite gap suspected → propose a detour.
[user] Accept or decline the detour.
[code] Detour needs a pending resource → offer wait, or continue on lecture evidence.
[user] Dispute an interpretation.
[agent] Recheck source, show evidence, let the user explain; unsettled → stays disputed.
[code] Later evidence revises a boundary mid-review → reprocess affected claims only.
[agent] Disclose the correction with evidence; update only affected observations.
[code] Soft target (default 10 min, configurable) reached at a natural pause →
       offer continue / wrap up. Never a forced cutoff.
[agent] Propose each observation's status (independent / partial / after help /
       unresolved / not assessed) from the actual turns.
[code] Clamp the proposal: help before the answer caps at "after help";
       skipped or unanswered is "not assessed".
[code] Save notes, observations, suggested graph links, evidence refs (stable IDs).
[code] Save fails → keep a pending save locally, show it, offer retry
       (stable IDs make retry overwrite, not duplicate).
[user] Inspect, edit, accept/correct links, revisit, delete.
```

Flow sections A–D approved as a whole on 2026-11-03. Rules and TLC check pending.

## Rules (approved by Derek, 2026-11-03)

Drafted as candidates by the agent from the PRD and approved flow; Derek approved all seventeen as written. Quote verbatim. `[TLC]` rules become model invariants; `[test]` rules are enforced by tests.

- R1 `[test]` Evidence only comes from intervals I actually watched while capture was on.
- R2 `[test]` Ad time never becomes evidence.
- R3 `[TLC]` A claim can be used to judge my answers only if it passed the evidence check.
- R4 `[TLC]` A claim gets at most one revision; after that it's unverified.
- R5 `[TLC]` Choosing Later never cancels preparation.
- R6 `[TLC]` A pending resource search never blocks a review that is otherwise ready.
- R7 `[TLC]` Once a review starts, its scope never grows; corrections can change claims inside it but can't add material.
- R8 `[TLC]` Results from cancelled or outdated jobs never overwrite current preparation or my notes.
- R9 `[TLC]` Starting a review doesn't stop capture, and stopping capture doesn't end a review.
- R10 `[TLC]` A review never starts with zero supported claims in scope.
- R11 `[TLC]` A detour only starts after I say yes.
- R12 `[test]` If the tutor helped before my answer, it can't count as independent.
- R13 `[test]` A skipped or unanswered question is never counted as understood.
- R14 `[TLC]` A disputed assessment is never counted as a learning gap unless I resolve it that way.
- R15 `[test]` Retrying a save never creates a duplicate record.
- R16 `[TLC]` Evidence cited by a saved note is only deleted when I delete it, never by expiry.
- R17 `[test]` Every paid call records a usage event; unknown cost is stored as unknown, not zero.
