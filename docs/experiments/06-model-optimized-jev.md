# Experiment 6: can a slow model train Jev for After Class?

Derek's question, 2026-11-04: the flow depends on Jev making the fast decisions and a Claude model (Opus or Fable) doing the deliberate work, so test that pairing directly. A Claude model first proposes where the boundaries, visual steps and duplicates are in a set of lecture clips, Derek verifies, Jev is run on his verified labels, and then Opus and Fable each try to improve Jev for After Class by rewriting its questions and thresholds. This file is the pre-registered protocol. It was written before any Claude or Jev call for this experiment, and nothing here is tuned after a result.

This experiment is outside the five approved in `docs/flows/after-class.md`. Derek approved it in chat on 2026-11-04 (cost is not a constraint in development; Opus and Fable both used). Every number below that he has not yet said yes to is marked `PROPOSED, needs Derek's OK before any call`.

**Status, 2026-11-05.** Decisions 2 to 6 are adopted (above). Stages 1 to 5 are done on the 43-clip set: assembled (`assembled-2`), model labels (Opus 62 Claude calls, Fable 63 with one retry), Derek verified and signed `labels-set-2-signed.json`, and the baseline is experiment 2's Run 2 (yes at 0.4, recall 2 of 5 on the held-out half, see `02-jev-lab.md`). Stage 6 (optimizer rounds) and stage 7 are not started; the lab side of the build prerequisites below is built (the items marked BUILT under "Build prerequisites"), the optimizer runner and the held-out prompt guard are built too (`scripts/jev-lab-optimize.ts`, see "Optimizer rounds: commands"). No optimizer call has been made.

## Decisions for Derek

1. **Models and arms. ADOPTED 2026-11-04.** Opus 5.5 and Fable 5.1 both label (independently) and both optimize (two arms), next to a baseline (Jev as experiment 2 leaves it, question wording unchanged).
2. **The data. ADOPTED 2026-11-05 (changed from the 11-clip set this decision first named).** The assembled set of 43 clips (`assembled-2`: the seven topic-boundary windows of Advanced Operating Systems Part 3, replayed live captures, see `assembled-captures.md`), as one lecture under Amendments 1 and 2 of `02-jev-lab.md`; labels `labels-set-2-signed.json`, signed by Derek on 2026-11-05. The 11-clip set is superseded: its held-out half was spent and its boundaries were labeled under the earlier definition (experiment 2 Amendment 2). The split is before clip 23 (tuning clips 1 to 22, held-out clips 23 to 43). Only Derek's verified labels count, never a model's.
3. **Rounds.** At most 3 optimizer rounds per arm. ADOPTED 2026-11-05.
4. **What an optimizer may change.** The wording of the three bool questions (`newConcept`, `stoppingPoint`, `teachingChange`), the Jev verdict thresholds, and `SEGMENTATION_DEFAULTS`. Question types stay bool. Not the model, the routing table, the labels, the split, the scoring, or the frame sampler. ADOPTED 2026-11-05.
5. **How a round is picked.** Per arm, the round whose first-half report passes the most of the four bar clauses; ties go to the higher boundary recall, then fewer false closes, then the earlier round. The held-out half is never used to pick. This is an explicit exception, for experiment 6 only, to adopted definition 10 of `02-jev-lab.md` ("The scored run uses the config of the last tune round"): here an arm is scored on its selected round, which can be an earlier one. Experiment 2's own run is unchanged. ADOPTED 2026-11-05.
6. **Budgets.** Jev: a hard 3,000 calls across experiment 6, retries included, plus a per-run-directory ceiling of 1,000 for an optimizer arm, because an arm needs 3 x 195 + 256 = 841 calls before retries and experiment 2's ceiling of 800 per lab directory would refuse it. This is the third explicit exception to experiment 2's adopted definitions (with decisions 5 and 7), for experiment 6 only: experiment 2's own 800 stays as it is. Enforcing it needs a configurable per-directory ceiling and a persisted counter across the arms' directories, both build prerequisites. The baseline is experiment 2's run and is counted in its own 800. On the assembled 11-clip set `plan` counts about 195 calls for a first-half run and about 256 for a held-out run, so 2 arms x 3 rounds of first-half runs and 2 held-out runs come to about 1,680 before retries. Claude: a hard 150 calls, retries included. Labelers: the planned count per model is one call per clip plus one per chunk of at most 24 frames (about 17 chunks if chunked over the pooled 393 frames, more if chunked per clip), so about 28 or a few more per model; `jev-lab-propose plan` prints the exact count and it must fit before anything runs. Optimizers: 2 x 3 plus retries. Plus a 3-call timing pilot per model. ADOPTED 2026-11-05 as amended below: the Claude and Jev figures in this paragraph were sized for the 11-clip set and are replaced by the two amendments that follow, which Derek approved; the pilot is not re-run.

   **Amendment (2026-11-05), before any of these calls: the Claude ceiling is 250, not 150.** Derek chose "steps and dups, all clips" for the new 43-clip set, after being told the cap would go to about 200 (the exact 250 is the agent's figure from the plan below, not a number Derek stated; he can lower it) (the seven topic-boundary windows, assembled as `data/lab/assembled-2`, experiment 2 Amendment 2). `jev-lab-propose plan` on that set counts 62 calls per model at the minimum, 124 for both, and no pilot is re-run. 52 calls were already used on the old 11-clip set, so the minimum is 176 and the old ceiling of 150 would refuse it. 250 leaves 74 for retries and the optimizers; it is an upper bound, not an estimate of spend (the old run used its planned count exactly, no retries). If the optimizers need more, that is a new amendment before they run.

   **Amendment 2 to this decision (2026-11-05), before any Jev call on the 43-clip set: Jev 5,000 total across experiment 6, and 2,400 per run directory.** Derek approved these numbers ("Yes, those numbers"); they are the agent's, derived from `plan` on the 43-clip set (542 calls for a first-half run, 538 for the held-out run): an arm is at most 3 x 542 + 538 = 2,164 calls before retries, so two arms come to about 4,330, and 5,000 leaves room for retries. The baseline is experiment 2's run on the same set (`labels-set-2-signed.json`), counted in experiment 2's own 2,400 (experiment 2 Amendment 3). The per-directory ceiling is now 2,400 for both experiments, so the "configurable per-directory ceiling" prerequisite is no longer needed; the persisted counter across the arms' directories (5,000) still is. The 1,000 and 3,000 above were sized for the 11-clip set and are superseded.
7. **Held-out scoring. ADOPTED 2026-11-04.** Each arm is scored once on the held-out half. The baseline arm is experiment 2's own single held-out scoring, read back with `rescore`, which recomputes the report from stored judgments and makes no new judgment, so there is no second look at the held-out half. The two optimizer arms are each scored once, each in its own lab run directory, with their configurations frozen before any held-out run. This is an explicit exception, for experiment 6 only, to experiment 2's "score once on held-out second halves": the held-out half is scored once per arm (three times in all, one of them experiment 2's). Nobody picks among the arms afterwards; all three are reported side by side. The rule's purpose is that nothing is tuned against the held-out half, and this keeps it.

## What it does and does not show

It shows whether a model-rewritten Jev agrees better with Derek's verified labels on held-out clips than Jev as experiment 2 leaves it does, for this one set of clips. It does not show that Jev or the pairing improves learning, that the labels are objectively right (they are Derek's judgment after checking model proposals), or anything about other courses, other lecturers or other machines. A model that fits the tuning-half labels and fails the held-out half is a possible and reportable outcome.

## Stages

1. **Assemble.** Build the one-capture set (`scripts/assemble-capture.ts`). No call.
2. **Timing pilot.** 3 calls to each of Opus and Fable, to read latency and confirm the model ids work through `claude -p`. Reported, not scored.
3. **Model labels.** Each labeler (Opus, Fable) separately sees the lecture set the way the product does: the transcript passages with their media times and the captured frames (read as image files), per clip. It sees no Jev output and no other model's labels. Each proposes boundaries, visual steps and duplicate groups, with a one-sentence reason per item. Clip joins are free boundary candidates (the product's rule is that a video ending does not close and the next clip's first window decides). Responses are stored verbatim.
4. **Derek verifies.** The set-aware labeling sheet (a build prerequisite, see "Build prerequisites"; the sheet on `master` refuses a set) shows both models' proposals with their reasons and marks where they disagree. Derek confirms, edits, rejects and adds, then types his name and the date. Only a signed-off label file is used from here on. Derek's rule for visual steps applies, quoted verbatim from `docs/experiments/02-jev-lab.md` ("The visual-step rule (Derek's wording, verbatim)"): "A visual step is when the actual slide content changes (new text or a new figure shown on screen). The same slide staying up across several transcript passages is not a new step."
5. **Baseline.** Experiment 2 runs first on the verified labels, with its own tuning rounds and its single held-out scoring. Its final configuration (`QUESTIONS`, `THRESHOLDS`, `SEGMENTATION_DEFAULTS` as left by experiment 2) is the baseline arm and the starting point of both optimizer arms. Experiment 6 does not re-run it.
6. **Optimizer rounds,** per arm. The optimizer is given the task description, Derek's rules for these decisions (quoted from `docs/flows/after-class.md`, never reworded), the arm's current wording and thresholds, and for the FIRST HALVES ONLY the windows and frames, Jev's `p` values and verdicts, and Derek's verified labels. It returns a structured proposal limited to decision 4, which the lab validates and refuses if it touches anything else. Jev is re-run on the first halves with the proposal and scored. Up to 3 rounds.
7. **Held-out.** Each optimizer arm's selected round (decision 5) is scored once on the held-out half with the same report as experiment 2. The baseline's report is experiment 2's, rescored from stored judgments. The three reports are shown side by side (decision 7). Neither optimizer, nor Derek, tunes anything after this.

## Build prerequisites

None of the following exists on `master` when this was written. Each is built, tested and independently verified in its own PR before the stage that needs it runs, and no stage runs before then. This file is not a claim that any of it already works.

- The set-aware labeling sheet with model proposals and a disagreements panel (stage 4). Until it merges, the sheet refuses a set.
- `jev-lab-propose`: the timing pilot, the labeler, the deterministic comparison of two models' proposals, and the Claude-call rails named below (stages 2 and 3).
- The optimizer runner (stage 6). **BUILT** (`scripts/jev-lab-optimize.ts`, optimizer-runner PR): it builds the first-half-only prompt from the approved template (`exp6-optimizer-prompt.md`), asks one model for one round's proposal, and validates it against decision 4 with `validateArmConfig`. It does not re-run Jev: `jev-lab run --phase tune --arm <name> --arm-config` does that, with its own rails. No frame images are attached (text only, Derek's approval).
- Scoring an arm's selected round, which is not always the last tune round (decision 5). **BUILT** (arm-lab PR): `selectRound` in `scripts/jev-lab-arm.ts` and `run --phase score --arm <name>`; the held-out half is never read to pick.
- Separate lab run directories per arm, a per-directory Jev ceiling (decision 6, Amendment 2 to it: now 2,400 for both experiments, so nothing separate to build; this line first said "raise to 1,000 while experiment 2 keeps 800"), and a persisted Jev-call counter across the arms' directories for the 5,000 total (decision 6, Amendment 2; this line first said 3,000) (decisions 6 and 7). **BUILT** (arm-lab PR): `run --arm <name>` writes `<lab>/exp6/<arm>/<origin>`, and `EXP6_BUDGET_CALLS` (5,000) is checked up front and before every request against the floored counters of all arm directories.
- Lab-side inputs for the optimizer (decision 4): the arm config file (`jev-arm-config`, validated, exactly the three wordings, the thresholds and the segmentation), question wording as an input to the Jev tasks with the wording version in every cache key, and `plan --arm-config`. **BUILT** (arm-lab PR). The optimizer runner above and the code check below are NOT built.
- A code check that no optimizer prompt contains held-out material (see "Fixed"). **BUILT** (same PR): `scanForHeldOut` scans the full prompt, and every retry prompt, before any call and refuses with nothing sent. Labeler prompts are not covered: they are built before any label is signed and before the split exists, so they have no held-out half to leak.

## Arm runs: commands (lab side, built)

All paths are examples; nothing here makes a Jev call without `--live`, a 0600 keys file, `--max-calls` and signed labels, exactly as in experiment 2. An arm name is letters, digits and dashes.

```
# starting config from experiment 2's final state (product wording, its thresholds and segmentation): write it as JSON
# with armConfigFromBaseline(lastTune) from scripts/jev-lab-arm.ts, then edit only what decision 4 allows.

# price a round (counts only; with --lab and --arm, the arm's stored judgments are not counted as new)
bun run scripts/jev-lab.ts plan --data <dir> --labels <signed.json> --arm-config <arm-config.json> --lab <lab> --arm opus-1

# a tune round (first halves only; at most 3 per arm); the per-knob flags are refused with --arm
bun run scripts/jev-lab.ts run --data <dir> --lab <lab> --labels <signed.json> --phase tune --arm opus-1 --arm-config <arm-config.json> [--live --max-calls <n>]

# the held-out run, once per arm directory: scores the arm's SELECTED round (decision 5), not necessarily the last
bun run scripts/jev-lab.ts run --data <dir> --lab <lab> --labels <signed.json> --phase score --arm opus-1 [--live --max-calls <n>]

# read any run back with no call
bun run scripts/jev-lab.ts rescore --results <lab>/exp6/opus-1/live/runs/score-1.jsonl --labels <signed.json>
```

The results header records the arm, the question wording when it differs from the product's (the report then prints a `Questions` block; experiment 2's reports are unchanged), and for a scored run the selected round and the counts compared. A judgment made with other wording is never reused: the wording version (`arm-<16 hex of sha256 of the wording>`) is part of its cache key, and the product's wording keeps version `1`.

## Optimizer rounds: commands (built)

`scripts/jev-lab-optimize.ts propose` makes ONE optimizer round's proposal for ONE arm. Nothing here makes a Claude call without `--live-claude` and `--max-claude-calls`, and nothing makes a Jev call. The per-round loop, per arm (`opus-1`, `fable-1`), up to 3 rounds:

```
# 0. FIRST STEP, before any live call: add --dry-run (and drop the live flags) to build the real prompt and run the guard.
#    It writes <out>/prompt.txt, guard.json and README.md for inspection, makes no call and never touches the ledger.
# 1. propose (round 1: the baseline's tune results and experiment 2's state.json; the held-out report is only scanned for)
bun run scripts/jev-lab-optimize.ts propose --data <assembledDir> --labels <signed.json> --lab <lab> --arm opus-1 \
  --model claude-opus-5-5 --out <ledger>/opt-opus-1-r1 --from-results <lab>/live/runs/tune-N.jsonl \
  --baseline-state <lab>/live/state.json --heldout-report <lab>/live/runs/score-1.report.txt \
  [--live-claude --max-claude-calls 2 --claude-ledger <ledger>]

# 2. run it on the first halves (Jev; its own flags and ceilings)
bun run scripts/jev-lab.ts run --data <dir> --lab <lab> --labels <signed.json> --phase tune --arm opus-1 \
  --arm-config <ledger>/opt-opus-1-r1/arm-config.json [--live --max-calls <n>]

# 3. round 2 and 3: the arm's own tune results (every round so far, in order) and the earlier proposal dirs (in order)
bun run scripts/jev-lab-optimize.ts propose ... --out <ledger>/opt-opus-1-r2 \
  --from-results <lab>/exp6/opus-1/live/runs/tune-1.jsonl --previous <ledger>/opt-opus-1-r1
```

`--claude-ledger` is the parent directory that holds `claude-state.live.json` (`data/lab/propose`, the labelers' ledger); `--claude-ledger` is REQUIRED with `--live-claude` and must equal the parent of `--out` (anything else is refused), so a live run can never start a fresh ledger outside the shared cap: the same persisted counter and call floor, and `BUDGET_CLAUDE_CALLS` (250), count the optimizers' calls with the labelers'. Models are `claude-opus-5-5` and `claude-fable-5-1` only, effort high.

Output: `arm-config.json` (the config, exactly what `jev-lab run --arm-config` takes), `rationale.txt`, `guard.json`, `README.md`, and `calls/<n>.prompt.txt|.response.txt|.meta.json` for every attempt, the prompt stored before the call. A reply is refused unless it is one JSON object with a non-empty `rationale` and a body that `validateArmConfig` accepts, and its question wordings name no clip title, videoId or mm:ss time; a refusal is stored with its reason and retried once with the reason appended, and a second refusal stops (no `arm-config.json`, the README says INCOMPLETE).

Held-out guard, before every call: the prompt is built only from first-half inputs, and the full text is scanned for held-out clip videoIds and sourceIds, titles that only held-out clips have, window and frame or passage ids, any 40-character run of a held-out passage that the first half does not also contain, a reference to a held-out clip number, a held-out label time next to a held-out clip, and every non-trivial line of experiment 2's held-out report (`--heldout-report`, required with `--live-claude`) that the first-half report and the template do not also carry, and every fraction or decimal (2/5, 0.559, 387/424) in that report's results block that the first-half bars, the template, flow B and the configs do not also carry. A `--from-results` file of a score run is refused. A hit stops the run with no call and the reason stored in `guard.json` and the README.

**Claude calls for a full experiment 6 optimizer stage:** 2 arms x 3 rounds = 6 calls at the minimum, 12 if every round needs its one retry. With 177 already used by the pilot and the two labelers (52 + 62 + 63), that leaves 73 of the 250, so 12 fits. `--max-claude-calls 2` per proposal covers one retry.

## Fixed, to be enforced in code

The rules below are decided now and are enforced and tested by the prerequisites above before stage 3. The three exceptions to experiment 2's adopted definitions (decision 5, the selected round; decision 6, the Jev ceiling; decision 7, score once per arm) apply to experiment 6 only and are enforced by the same prerequisites. Implemented and tested so far: the Claude rails (`jev-lab-propose`), the Jev rails, arm configs, per-arm directories, the cross-arm Jev counter and selected-round scoring (PR #75), and the optimizer runner with its held-out prompt guard (`jev-lab-optimize`, with `--dry-run`). The optimizer prompt guard is the only held-out check; labeler prompts precede signing and the split. Nothing in this list has been run live for experiment 6's optimizer stage, and no optimizer call has been made.

- Claude calls go only through the product's Claude client: `claude -p` with `--restricted --tools Read --strict-mcp-config --disable-slash-commands --no-session-persistence`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` stripped from the child environment, `--add-dir` only for the copied frame files. Subscription calls, cost recorded as notional.
- Jev calls reuse experiment 2's rails: a 0600 key file, `--live`, a hard call cap, signed-off labels, persisted counters that a deleted `state.json` cannot reset, redaction of the key, stored judgments so any report can be rescored with no call.
- Claude calls need their own `--live-claude` and `--max-claude-calls` flags and a persisted counter. No stage runs another stage's calls.
- After the labels are signed, no labeler or optimizer prompt ever contains held-out material: not the held-out half's windows, frames, passages, labels or judgments, and not experiment 2's held-out report or any number taken from it. The baseline's first-half results and Derek's labels for the first halves are all an optimizer sees. This is checked in code (prompts are built only from first-half inputs, and each is scanned before it is sent for held-out ids, times and report numbers), and the prompt text sent is stored so it can be inspected. Experiment 2's held-out report exists before stage 6 starts (stage 5), so this guard is what keeps it out of the optimizers' reach.
  - How the code enforces it (note, 2026-11-05, not a change to the rule): prompts are built only from first-half inputs; the guard then refuses on held-out ids, titles unique to the held-out half, 40+ character held-out passages, held-out clip numbers and label times, lines of experiment 2's held-out report, and any fraction or decimal from that report's results block not also present in first-half material. Plain integers and percentages are not scanned (they occur everywhere as seconds and counts); construction from first-half inputs is what keeps them out.
- Every prompt and every response is stored verbatim. Every proposal that was refused is stored with the reason.
- Every printed line is tagged `[fixture]` (tests) or `[live]`; data replayed from recorded sessions is also labelled `assembled (replayed live data)`.

## Results

None yet. This section is filled only from Derek's runs and pasted unedited.
