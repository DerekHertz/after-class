# Experiment 2: the Jev boundary and visual lab

The lab measures whether Jev, asked the product's own questions about windows of a real lecture and about changes between frames, finds the topic boundaries and keeps the visual steps that Derek labeled. It runs the product's windowing and the product's `boundaryTask` and `frameChangeTask` through `scripts/jev-lab.ts`.

This file is a pre-registered protocol. It was written before any Jev call, and nothing here is tuned after a result. The numbers in the bar text and the budget are Derek's, adopted 2026-11-03. Every other definition was proposed, and Derek adopted all ten as proposed on 2026-11-04 (see "Decisions").

The tooling is finished and has made no Jev call. No key exists on the machine that built it. Results come from Derek's run, and they are pasted under "Results", not edited.

## Decisions (adopted by Derek, 2026-11-04)

Each item below is a definition the bar text leaves open. Derek adopted all ten exactly as written, one at a time, on 2026-11-04, before any paid call. A numeric one is a named constant in `scripts/jev-lab-score.ts` (the `PROPOSED_` prefix in the constant names is a leftover from the proposal stage; they are adopted). Changing any of them after a result is not allowed. Anything not in this list is fixed by the bar text, the budget or the flow doc.

1. **What a detected boundary is.** A chunk that the product's `planChunks` closes with provenance `boundary` or `boundary_revised` (Jev said "new concept" yes and "stopping point" yes). Its time is the media start of the first window of the next chunk. Time-cap closes and session-end closes are not Jev's and are not detections.
2. **How labels and detections pair.** One-to-one: each label takes at most one detection, each detection serves at most one label. "Within ±60s" is inclusive: exactly 60 s apart matches.
3. **What a false close is.** A detection that no label took (so a second close beside an already matched label is false). Computed over the held-out half of the lectures that have at least one labeled boundary there; a lecture with none is excluded and listed, never counted as "no boundaries".
4. **"Per 15 min" is watched time.** `false closes x 900 / watched seconds in the held-out halves`, pooled over those lectures. PASS at exactly 1.0 or less. Watched time, because evidence exists only for watched time.
5. **Pooled recall.** `matched / labeled` pooled over lectures, PASS at exactly 70%. A label that lies outside watched time cannot be detected by any model, so it is excluded from the denominator and printed.
6. **When an important visual step is lost.** A labeled step at media time `s` is shown by the candidate frames in `[s, s + 30 s)` of the same half (`PROPOSED_STEP_CATCH_S = 30`). It is lost when there is no such frame, or when every such frame was dropped. Both causes count as lost and are printed separately, because the product loses the step either way.
7. **Steps lost "per lecture".** The scored half is half a lecture. The count is not scaled: PASS only if every lecture that has labeled steps in the held-out half lost 1 or fewer.
8. **What a duplicate is.** A labeled duplicate group is frames showing the same content. The earliest member (by media time) is the original, every later member is a duplicate. A duplicate is dropped when Jev's verdict on its frame is "no". "Uncertain" keeps the frame (flow B: "Uncertain visual → keep the frame."). A label with no frame id resolves to the nearest candidate frame within 2 s (`PROPOSED_DUPLICATE_MATCH_S = 2`); a duplicate that resolves to no frame counts as not dropped. Pooled, PASS at exactly 50%.
9. **The split.** The midpoint of the lecture span in the label file. Each half is folded by the product's `planChunks` on its own, with no state carried across the split, so a boundary at the very first window of the second half cannot be detected. A window belongs to the lecture and half of its first new passage and its earliest new media second.
10. **The budget.** "~800 Jev calls" is read as a hard ceiling of 800 that counts every request, retries included (`BUDGET_CALLS = 800`). One tune round is one `run --phase tune`, whatever it changes. The scored run uses the config of the last tune round. A stored judgment with the same input is reused at no call, but a round that reuses everything still counts as a round.

## The four bars

Quoted from `docs/flows/after-class.md`, "Experiments and pass bars":

> Jev boundary and visual lab (~800 Jev calls, max 3 tuning rounds, tune on first halves, score once on held-out second halves). Bar: ≥70% of labeled boundaries detected within ±60s; ≤1 false close per 15 min; ≤1 important visual step lost per lecture; ≥50% duplicates dropped.

| Clause | Text | Measured as |
| --- | --- | --- |
| Recall | "≥70% of labeled boundaries detected within ±60s" | detections and labels paired one-to-one (decisions 1, 2, 5) |
| False closes | "≤1 false close per 15 min" | unpaired detections per 900 s of watched time (decisions 3, 4) |
| Visual steps | "≤1 important visual step lost per lecture" | labeled steps with no surviving candidate frame (decisions 6, 7) |
| Duplicates | "≥50% duplicates dropped" | labeled duplicates whose frame Jev dropped (decision 8) |

All four are scored on the held-out second halves, once. A clause with nothing to measure (no labeled boundary, no labeled step, no labeled duplicate in the held-out halves, no watched time) is NOT MEASURED, never a pass. The OVERALL line is PASS only when no clause is FAIL or NOT MEASURED.

## What a run does

For each label file, the lab opens a scratch copy of the data dir's database (the data dir is never written), builds the product's windows with `buildWindows` and the run's `SegmentationConfig`, and builds the product's frame-change inputs from the evidence store. It then asks Jev through `boundaryTask(jev)` (two questions in one request, the window's text and up to 2 frames) and `frameChangeTask(jev)` (before and after frames with nearby captions), and stores every judgment. Scoring reads the stored judgments only.

- A boundary judgment is the pair of probabilities `p(new concept)` and `p(stopping point)` Jev returned. The lab stores the raw `p`, and maps it to yes, no or uncertain with `toVerdict`'s rule at the run's thresholds when it scores.
- A failed judgment reads as uncertain, which routes to "continue" for a window and keeps a frame, as the product does.
- A frame with no earlier frame in its source is kept without a call, as the product does.
- The lab imports `buildWindows` and `planChunks` through `src/backend/segmentation/index.ts`, which now re-exports them (and `src/MODULES.md` lists them as public). It does not import `core.ts`, so the lab measures the code the product runs and not a copy of it.

Not scored and not claimed: the product's cross-clip behavior ("Video ends → do NOT close; the next clip's first window decides"). Each lecture is folded alone.

## Tuning

**May change in a round (and nothing else):**

- `SEGMENTATION_DEFAULTS`: `windowNewS`, `contextS`, `timeCapS`, `maxFramesPerWindow`, `reviseOnNextNoNo`.
- The Jev verdict thresholds in `THRESHOLDS`: `yesAtOrAbove` and `noAtOrBelow`.

**Off limits** (Derek confirmed on 2026-11-04 that question wording stays off limits in this lab; rewriting criteria after seeing results is a separate, labeled follow-up experiment that needs his OK, and any Claude call in it is outside the five approved experiments): question wording (`QUESTIONS`), the model (`JEV_MODEL`), the routing table (`route`), the labels, the label rules above, the split, the lecture set, the bar text, the tolerance, the budget, the frame sampler in the extension, and the scoring code. A threshold change is a round like any other: there is no way to re-score a tune run with different thresholds, so offline exploration cannot dodge the cap.

**Cap and halves:**

- At most 3 tune rounds. The counter is persisted in the lab output dir, and a fourth `run --phase tune` refuses.
- Tune rounds use first halves only; the scored run uses second halves only. The lab asserts this before it sends anything.
- The held-out half is scored once. After `run --phase score` completes, a marker makes a second score run refuse. There is no flag to override it. `rescore` from stored judgments is the only way to read it again. A score run that died before finishing wrote no results and may be re-run; stored judgments are reused.
- The scored run takes no tuning flags. It uses the config of the last tune round, so a defaults run needs one tune round with the defaults first.
- Adopting the final values in the product (`SEGMENTATION_DEFAULTS`, `THRESHOLDS`) is a separate change after the scored run, and is not made by the lab.

## Labels

One file per lecture in `docs/experiments/labels/<name>.json`. A lecture is one video of one capture. `docs/experiments/labels/example-fixture.json` is a hand-made format example (a fixture, not Derek's labels).

```json
{
  "schemaVersion": 1,
  "status": "draft | signed_off",
  "signedOffBy": null,
  "signedOffAt": null,
  "lecture": { "captureId": "cap_...", "videoId": "...", "title": "...", "spanS": { "start": 0, "end": 1200 } },
  "boundaries":  [{ "mediaS": 312, "note": "...", "confirmed": true }],
  "visualSteps": [{ "mediaS": 400, "note": "...", "confirmed": true }],
  "duplicateGroups": [{ "note": "...", "confirmed": true, "frames": [{ "mediaS": 410 }, { "mediaS": 431.5, "frameId": "ev_..." }] }]
}
```

- Times are media seconds of the video, not wall clock. Every time must lie in `[spanS.start, spanS.end)`, which is half-open.
- `spanS` is the part of the lecture that is labeled, and it fixes the split. `draft-labels` sets it to the first and last watched second.
- A duplicate group needs at least 2 frames, each with a media time and optionally a frame id.
- `cue` (optional) says why a draft item was suggested.
- `status: "signed_off"` needs `signedOffBy` and `signedOffAt` (an ISO date), and every item `confirmed: true`. A draft carries nulls. A misspelled field is an error, not ignored. `validateLabels` lists every problem at once, each with its field path.
- The scored run refuses labels that are not `signed_off`. A live run refuses them too. A run stores each label file's sha256, and `rescore` refuses labels that changed since.

`draft-labels` builds a draft with no model: boundary candidates are caption pauses of 3 s or more (the longest in each 60 s stretch, inside one watched interval), visual step candidates are frames whose JPEG size jumped by 15% or more, and duplicate candidates are frames with byte-identical JPEG files. Near-identical frames are not computed (there is no image decoder), so Derek adds those by hand. Every item is `confirmed: false`, and the file says it is a draft starting point, not truth.

## Safety rails

A model call needs all of the following. Each is enforced in code and has a test.

| Rail | Refusal |
| --- | --- |
| `--live` | Without it the run uses a deterministic fake client, and the real adapter is never built. |
| A key | `~/.config/afterclass/keys.env` (or `--keys`), mode 0600, with `TYPESAFE_API_KEY`, read by the backend's own `readKeys`. The key is held only by the Jev adapter. Output, errors, stored judgments and results are redacted for it. |
| `--max-calls N` | Required, an integer from 1 to 800. The run refuses before its first call if it needs more than N new calls, and aborts before any call beyond N. |
| The 800 budget | A persisted counter in the lab dir, written before each request, across all phases. A run that would cross 800 refuses up front, and a request that would cross it is never sent, retries included. |
| `signed_off` labels | For a live run and for any scored run. |
| 3 tune rounds | A fourth refuses. |
| Score once | A second score run refuses and points at `rescore`. A scored run in which any Jev call failed writes no result and does not use up the scoring: re-run the same command and only the failed judgments are retried. |
| Failed calls | A tune or score run in which any judgment failed (a network error, a 5xx) throws before writing results, and uses up no tuning round. If the same judgment keeps failing, stop and ask Derek; there is no flag to score around it. |
| Tune after score | Refuses once the held-out half is scored: tuning after seeing it would tune on the held-out data. |
| A deleted or damaged `state.json` | A malformed file is refused. A deleted one does not reset the rails: tune and score result files and cached judgments in the run directory set a floor under the round, score and call counters. |
| Halves | Tune work may hold only first-half items, score work only second-half items. |

State lives under `<lab>/<origin>/`: `fixture` and `live` runs have separate counters, so a dry run never spends a live round.

## How to run it

All commands are `bun run scripts/jev-lab.ts <command> ...`.

```
draft-labels --data <dir> --capture <id> [--video <id>] --out <file> [--force]
split        --labels <file> [--labels <file> ...]
plan         --data <dir> --labels <file> ...
run          --data <dir> --lab <dir> --labels <file> ... --phase tune|score
             [--window-new-s N --context-s N --time-cap-s N --max-frames-per-window N
              --revise-on-next-no-no true|false --yes-at P --no-at P]      (tune only)
             [--live --max-calls N [--keys <path>]]
report       --results <file> --labels <file> ...
rescore      --results <file> --labels <file> ... [--expect <report.txt>]
```

1. `draft-labels` for each lecture, then Derek corrects, confirms and signs the files off.
2. `split` shows Derek the tune and held-out split before anything runs.
3. `plan` counts the Jev calls from the real windowing and compares them with 800. It exits non-zero when one tune round plus the scored run is over budget, and prints the worst case (3 tune rounds that each change windowing). No call is made.
4. `run --phase tune --live --max-calls N`, up to 3 times.
5. `run --phase score --live --max-calls N`, once.
6. `rescore --results <runs/score-1.jsonl> --labels ... --expect <runs/score-1.report.txt>` re-reads the held-out run from stored judgments, with no Jev call. It prints the report and exits 1 if it differs from the original by a byte. `report` is the same computation without the check.

Each run writes `<lab>/<origin>/runs/<phase>-<round>.jsonl` (a header, the lecture and window records, one line per judgment, an end record) and `.report.txt`. A file with no end record is not a result and is refused. A judgment line holds the input hash (`key`), purpose, model, question version, raw `p` per question, any error, and per request the start time, duration and token counts. `judgments.jsonl` in the same dir is the append-only store the next run reuses from.

## The report

Every line starts with `[fixture]` or `[live]`, like the probe report. A run is `live` only with `--live`; every other output is `fixture`. `plan`, `split` and `draft-labels` take `--origin fixture|live` (default `fixture`).

- The four clauses, each next to its bar text with PASS, FAIL or NOT MEASURED, and per-lecture detail.
- Measured Jev usage for the run: request counts, input and output tokens. Cost is shown as unknown, because Jev returns tokens only. R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
- Latency per request, p50 and p95 (nearest rank), overall and by question kind. Report only: no target was approved, and there is no baseline.
- An OVERALL line. A tune run's line says it is a tuning round and not a result.

## What the lab does not show

- It does not show model accuracy beyond this label set. A pass is evidence about these lectures, labeled this way, on the day of the run.
- The labels are Derek's judgment. A different labeler, or Derek on another day, could label differently, and no inter-rater check is made.
- It is one machine, one network path and one Jev model version (`jev-1.13.0`). Latency is not comparable across machines.
- It does not measure learning effectiveness, interpretation quality or the review.
- The held-out half is half a lecture, so "steps lost per lecture" is a count over half a lecture (decision 7), and a lecture with few labels gives a wide range.
- Data labelled `fixture` shows only that the tools work.

## Results

No run yet. Derek's label sign-off and a run with a key are still needed.
