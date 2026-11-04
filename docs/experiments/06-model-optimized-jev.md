# Experiment 6: can a slow model train Jev for After Class?

Derek's question, 2026-11-04: the flow depends on Jev making the fast decisions and a Claude model (Opus or Fable) doing the deliberate work, so test that pairing directly. A Claude model first proposes where the boundaries, visual steps and duplicates are in a set of lecture clips, Derek verifies, Jev is run on his verified labels, and then Opus and Fable each try to improve Jev for After Class by rewriting its questions and thresholds. This file is the pre-registered protocol. It was written before any Claude or Jev call for this experiment, and nothing here is tuned after a result.

This experiment is outside the five approved in `docs/flows/after-class.md`. Derek approved it in chat on 2026-11-04 (cost is not a constraint in development; Opus and Fable both used). Every number below that he has not yet said yes to is marked `PROPOSED, needs Derek's OK before any call`.

## Decisions for Derek

1. **Models and arms. ADOPTED 2026-11-04.** Opus 5.5 and Fable 5.1 both label (independently) and both optimize (two arms), next to an unmodified Jev baseline.
2. **The data.** The assembled set of 11 clips (the two real captures replayed into one capture, see `assembled-captures.md`), as one lecture under Amendment 1 of `02-jev-lab.md`. PROPOSED. The Georgia Tech Lamport clip is available as a twelfth. Only Derek's verified labels count, never a model's.
3. **Rounds.** At most 3 optimizer rounds per arm. PROPOSED.
4. **What an optimizer may change.** The wording of the three bool questions (`newConcept`, `stoppingPoint`, `teachingChange`), the Jev verdict thresholds, and `SEGMENTATION_DEFAULTS`. Question types stay bool. Not the model, the routing table, the labels, the split, the scoring, or the frame sampler. PROPOSED.
5. **How a round is picked.** Per arm, the round whose first-half report passes the most of the four bar clauses; ties go to the higher boundary recall, then fewer false closes, then the earlier round. The held-out half is never used to pick. PROPOSED.
6. **Budgets.** Jev: a hard 3,000 calls across the whole experiment, retries included. On the assembled 11-clip set `plan` counts about 195 calls for a first-half run and about 256 for a held-out run, so a baseline round, 2 arms x 3 rounds and three held-out runs come to about 2,130 before retries. Claude: a hard 150 calls, retries included (labelers about 2 x 40, optimizers 2 x 3 plus retries, plus a 3-call timing pilot per model). PROPOSED.
7. **Held-out scoring.** Each of the three arms is scored once on the held-out half. PROPOSED.

## What it does and does not show

It shows whether a model-rewritten Jev agrees better with Derek's verified labels on held-out clips than the unmodified Jev does, for this one set of clips. It does not show that Jev or the pairing improves learning, that the labels are objectively right (they are Derek's judgment after checking model proposals), or anything about other courses, other lecturers or other machines. A model that fits the tuning-half labels and fails the held-out half is a possible and reportable outcome.

## Stages

1. **Assemble.** Build the one-capture set (`scripts/assemble-capture.ts`). No call.
2. **Timing pilot.** 3 calls to each of Opus and Fable, to read latency and confirm the model ids work through `claude -p`. Reported, not scored.
3. **Model labels.** Each labeler (Opus, Fable) separately sees the lecture set the way the product does: the transcript passages with their media times and the captured frames (read as image files), per clip. It sees no Jev output and no other model's labels. Each proposes boundaries, visual steps and duplicate groups, with a one-sentence reason per item. Clip joins are free boundary candidates (the product's rule is that a video ending does not close and the next clip's first window decides). Responses are stored verbatim.
4. **Derek verifies.** The set-aware labeling sheet shows both models' proposals with their reasons and marks where they disagree. Derek confirms, edits, rejects and adds, then types his name and the date. Only a signed-off label file is used from here on. Derek's rule for visual steps applies: a visual step is when the actual slide content changes (new text or a new figure shown on screen); the same slide staying up across several transcript passages is not a new step.
5. **Baseline.** The lab runs the unmodified Jev (current `QUESTIONS`, `THRESHOLDS`, `SEGMENTATION_DEFAULTS`) on the first halves.
6. **Optimizer rounds,** per arm. The optimizer is given the task description, Derek's rules for these decisions (quoted from `docs/flows/after-class.md`, never reworded), the arm's current wording and thresholds, and for the FIRST HALVES ONLY the windows and frames, Jev's `p` values and verdicts, and Derek's verified labels. It returns a structured proposal limited to decision 4, which the lab validates and refuses if it touches anything else. Jev is re-run on the first halves with the proposal and scored. Up to 3 rounds.
7. **Held-out.** Each arm's selected round (decision 5) and the baseline are scored once on the held-out half, with the same report as experiment 2, side by side. Neither optimizer, nor Derek, tunes anything after this.

## Fixed and enforced

- Claude calls go only through the product's Claude client: `claude -p` with `--restricted --tools Read --strict-mcp-config --disable-slash-commands --no-session-persistence`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` stripped from the child environment, `--add-dir` only for the copied frame files. Subscription calls, cost recorded as notional.
- Jev calls reuse experiment 2's rails: a 0600 key file, `--live`, a hard call cap, signed-off labels, persisted counters that a deleted `state.json` cannot reset, redaction of the key, stored judgments so any report can be rescored with no call.
- Claude calls need their own `--live-claude` and `--max-claude-calls` flags and a persisted counter. No stage runs another stage's calls.
- The held-out half and its labels are never passed to a labeler-optimizer prompt after stage 4 and never used in stages 5 and 6. This is checked in code, and the prompt text sent is stored so it can be inspected.
- Every prompt and every response is stored verbatim. Every proposal that was refused is stored with the reason.
- Every printed line is tagged `[fixture]` (tests) or `[live]`; data replayed from recorded sessions is also labelled `assembled (replayed live data)`.

## Results

None yet. This section is filled only from Derek's runs and pasted unedited.
