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
[code] Every job carries the claim revision it worked on; a result for an
       outdated revision is logged, never applied.                         (TLC fix R8)
[code] A claim keeps its used revision through reprocessing and retry.     (TLC fix R4)
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
[code] While a review is open, a boundary move can't add material to its scope;
       extra material queues for a later review. Shrinking is allowed.     (TLC fix R7)
[code] A claim being rechecked is out of assessment until it passes again; an
       open question on it pauses and the tutor says why.                  (TLC fix R3)
[agent] Disclose the correction with evidence; update only affected observations.
[code] Soft target (default 10 min, configurable) reached at a natural pause →
       offer continue / wrap up. Never a forced cutoff.
[agent] Propose each observation's status (independent / partial / after help /
       unresolved / not assessed) from the actual turns.
[code] Clamp the proposal: help before the answer caps at "after help";
       skipped or unanswered is "not assessed"; a dispute still open or
       unsettled saves as "disputed", never as a gap.                       (TLC fix R14)
[code] A dispute you settle saves the way you settled it; the tutor's
       proposal can't override it.                                          (TLC fix R14, second path)
[code] Save notes, observations, suggested graph links, evidence refs (stable IDs).
[code] Save fails → keep a pending save locally, show it, offer retry
       (stable IDs make retry overwrite, not duplicate).
[code] Evidence cited by a pending save counts as cited; expiry skips it.  (TLC fix R16)
[user] Inspect, edit, accept/correct links, revisit, delete.
```

Flow sections A–D approved as a whole on 2026-11-03. The first TLC run broke R3, R4, R7, R8, R14 and R16; Derek approved the six flow fixes marked "TLC fix" above on 2026-11-03 (rules unchanged). The re-check held 10 of 11 rules; R14 broke on a second path (a dispute Derek settles), and Derek approved the "second path" line the same day. Final re-check pending.

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

## Stack (approved 2026-11-03)

TypeScript throughout. Bun 1.4.3 runs, bundles, serves, tests, and provides SQLite (`bun:sqlite`). Chrome MV3 extension bundled by `Bun.build`, hand-written manifest. Review app is React served by `Bun.serve`. Keys in `~/.config/afterclass/keys.env` (0600), backend-only.

Supply-chain policy: exact pins, committed `bun.lock`, frozen installs, `minimumReleaseAge = 604800` in `bunfig.toml`, no `trustedDependencies` (no dependency install scripts).

| Package | Version | Kind |
| --- | --- | --- |
| zod | 4.6.7 | runtime |
| react, react-dom | 19.3.1 | runtime |
| @anthropic-ai/sdk | 1.3.0 | runtime |
| typescript | 7.0.2 | dev |
| @types/chrome | 0.3.6 | dev |
| @types/react | 19.3.0 | dev |

Transcript source: YouTube transcript panel first, player caption interception as fallback; only segments inside watched intervals become evidence (R1).

Speech: input via Chrome Web Speech API. Output must not sound robotic (Derek); provider pending. Tutor turns stream to speech by sentence; the tutor stops talking when Derek starts.

Voice provider: parked by Derek (2026-11-03). Candidates when resumed are OpenAI gpt-4o-mini-tts, ElevenLabs and Cartesia, chosen by a blind listening test. Chrome speechSynthesis is the fallback only.

Models: interpretation and tutor default to Claude Opus 5.5 ($4/$20 per MTok, cache read $0.20). Sonnet 5.5 ($2/$10) is the comparison arm in a lab test. Prices are from the Claude API reference cached 2026-10-06.

## Live-call scope (approved 2026-11-03)

Five named experiments. Claude calls go through `claude -p` on Derek's subscription, with cost recorded as notional. Jev runs on `TYPESAFE_API_KEY`, with cost recorded as unknown until reported. Anything outside the five needs Derek's OK first. Sizes and pass bars are proposals pending Derek's adoption (see the experiments section once approved).

## Experiments and pass bars (adopted by Derek, 2026-11-03)

Set before any results; not to be tuned to fit observations. Derek runs the tests that need him later.

1. Capture probe (free). Bar: every watched interval has evidence or a logged gap; ≥9/10 spot checks caption-to-screen within ±2s; board text readable in ≥9/10 frames; zero ad evidence.
2. Jev boundary and visual lab (~800 Jev calls, max 3 tuning rounds, tune on first halves, score once on held-out second halves). Bar: ≥70% of labeled boundaries detected within ±60s; ≤1 false close per 15 min; ≤1 important visual step lost per lecture; ≥50% duplicates dropped.
3. Interpretation and claim checks (~8 Opus calls, ≤80 Jev checks). Bar: zero claims Jev marked supported that the audit finds wrong (each one reported as an error); every visual claim cites a frame.
4. Sonnet 5.5 vs Opus 5.5, blind audit. Opus stays default unless Sonnet matches accuracy; then Derek chooses.
5. Two live reviews. Bar: the R12, R13 and R14 checks pass and contributions are credited correctly; time to first spoken word reported with no target yet.
