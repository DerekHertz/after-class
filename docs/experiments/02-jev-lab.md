# Experiment 2: the Jev boundary and visual lab

The lab measures whether Jev, asked the product's own questions about windows of a real lecture and about changes between frames, finds the topic boundaries and keeps the visual steps that Derek labeled. It runs the product's windowing and the product's `boundaryTask` and `frameChangeTask` through `scripts/jev-lab.ts`.

This file is a pre-registered protocol. It was written before any Jev call, and nothing here is tuned after a result. The numbers in the bar text and the budget are Derek's, adopted 2026-11-03. Every other definition was proposed, and Derek adopted all ten as proposed on 2026-11-04 (see "Decisions").

The tooling is finished and has made no Jev call. No key exists on the machine that built it. Results come from Derek's run, and they are pasted under "Results", not edited.

## Decisions (adopted by Derek, 2026-11-04)

Each item below is a definition the bar text leaves open. Derek adopted all ten exactly as written, one at a time, on 2026-11-04, before any paid call. A numeric one is a named constant in `scripts/jev-lab-score.ts` (the `PROPOSED_` prefix in the constant names is a leftover from the proposal stage; they are adopted). Changing any of them after a result is not allowed. Anything not in this list is fixed by the bar text, the budget or the flow doc.

1. **What a detected boundary is.** A chunk that the product's `planChunks` closes with provenance `boundary` or `boundary_revised` (Jev said "new concept" yes and "stopping point" yes). Its time is the media start of the first window of the next chunk. Time-cap closes and session-end closes are not Jev's and are not detections.
2. **How labels and detections pair.** One-to-one: each label takes at most one detection, each detection serves at most one label. "Within ±60s" is inclusive: exactly 60 s apart matches.
3. **What a false close is.** A detection that no label took (so a second close beside an already matched label is false). Computed over the held-out half of the lectures that have at least one labeled boundary there; a lecture with none is excluded and listed, never counted as "no boundaries". **[Amended: "lecture" is now a set of clips; see Amendment 1.]**
4. **"Per 15 min" is watched time.** `false closes x 900 / watched seconds in the held-out halves`, pooled over those lectures. PASS at exactly 1.0 or less. Watched time, because evidence exists only for watched time.
5. **Pooled recall.** `matched / labeled` pooled over lectures, PASS at exactly 70%. A label that lies outside watched time cannot be detected by any model, so it is excluded from the denominator and printed. **[Amended: a second class of label is excluded for sets; see Amendment 1.]**
6. **When an important visual step is lost.** A labeled step at media time `s` is shown by the candidate frames in `[s, s + 30 s)` of the same half (`PROPOSED_STEP_CATCH_S = 30`). It is lost when there is no such frame, or when every such frame was dropped. Both causes count as lost and are printed separately, because the product loses the step either way.
7. **Steps lost "per lecture".** The scored half is half a lecture. The count is not scaled: PASS only if every lecture that has labeled steps in the held-out half lost 1 or fewer. **[Amended: "lecture" is now a set of clips; see Amendment 1.]**
8. **What a duplicate is.** A labeled duplicate group is frames showing the same content. The earliest member (by media time) is the original, every later member is a duplicate. A duplicate is dropped when Jev's verdict on its frame is "no". "Uncertain" keeps the frame (flow B: "Uncertain visual → keep the frame."). A label with no frame id resolves to the nearest candidate frame within 2 s (`PROPOSED_DUPLICATE_MATCH_S = 2`); a duplicate that resolves to no frame counts as not dropped. Pooled, PASS at exactly 50%.
9. **The split.** The midpoint of the lecture span in the label file. Each half is folded by the product's `planChunks` on its own, with no state carried across the split, so a boundary at the very first window of the second half cannot be detected. A window belongs to the lecture and half of its first new passage and its earliest new media second. **[SUPERSEDED for sets of two or more clips by Amendment 1, which keeps this wording only for a one-video lecture.]**
10. **The budget.** "~800 Jev calls" is read as a hard ceiling of 800 that counts every request, retries included (`BUDGET_CALLS = 800`). One tune round is one `run --phase tune`, whatever it changes. The scored run uses the config of the last tune round. A stored judgment with the same input is reused at no call, but a round that reuses everything still counts as a round.

## Amendment 1 (Derek, 2026-11-04, before any paid call): a lecture is the set of clips

**Why.** The adopted design scores each video as its own lecture. Derek's real material is a set of pre-split clips (a course playlist), so the topic boundaries are the joins between clips. The product's own rule is that a video ending does not close a chunk and the next clip's first window decides (flow B: "Video ends → do NOT close; the next clip's first window decides."). Under the adopted rule (definition 9: each lecture alone, each half folded alone) the first window of every clip has nothing before it, so a clip join can never be detected and the boundary bar is unmeasurable. Derek, 2026-11-04: "it should be the set of clips ... there are NO boundaries [within a clip], the split is the boundary", and "visual steps should only be when the actual slide content changes ... it's ok to record transcript between the slide changes (new text shown on screen counts as a visual step)". He told the agent to amend the lab. No Jev or Claude call has been made. The bar text, the budget and the other adopted definitions are not changed.

Items marked **PROPOSED** below are the agent's details for the parts Derek's decision left open. They are not adopted until he says so, and none may change after a result.

**What it changes.** Definitions 3, 5, 7 and 9. Definitions 1, 2, 4, 6, 8 and 10 keep their meaning with "lecture" read as the set. The superseded wording stays above, marked.

| Definition | Adopted wording (still above) | Under Amendment 1 |
| --- | --- | --- |
| 9, the split | midpoint of the lecture span; windows belong to the lecture and half of their first new passage | a set of 2+ clips splits at a clip join (below); a one-video lecture keeps the midpoint rule |
| 3, false close | held-out half of lectures with at least one labeled boundary | held-out half of sets with at least one labeled, detectable boundary |
| 5, recall | labels outside watched time are excluded | also excluded: a boundary no model could detect (PROPOSED, below) |
| 7, steps lost per lecture | per lecture | per set, not scaled |

### The lecture

A lecture is the set of clips (videos) of one capture, in WATCH ORDER. A capture of one video is a lecture of one video, and every number the lab produced for it before this amendment is reproduced exactly (a regression test pins the reports line for line).

### Windowing and folding

Windows are the product's: `buildWindows` over the whole capture in watch order, folded by `planChunks`, both through `src/backend/segmentation/index.ts`. So the clip-join rule is the product's: a video ending does not close, and the next clip's first window decides. A detected boundary keeps its adopted meaning (definition 1: a Jev-driven close, time = media start of the next chunk's first window) and is now reported as a place, (videoId, mediaS).

**PROPOSED, which clip a window belongs to.** A window is cut from ~30 s of new passages in watch order, so the last seconds of one clip and the first seconds of the next usually share one window. For a set, a window belongs to the clip where its new material ENDS, and its place is the earliest second of its new material in that clip. That window is "the next clip's first window", and its place is the start of the clip (on Derek's five clips, 0 to 3 s). Under the one-video rule (first new passage) it would sit at the end of the earlier clip and could never match a join label.

### Matching

One-to-one and +-60 s inclusive (definition 2), and only within the SAME videoId: the distance between places in different clips is undefined, so a detection never matches a label of another clip, however close in watch time. A join label is a boundary labeled at the start of clip N (the videoId of clip N, mediaS inside its first window), so a Jev-driven close whose next chunk starts at that clip's start matches it. The first clip's start is not a boundary.

### The split (replaces definition 9 for sets of two or more clips)

> Superseded wording of definition 9: "The split. The midpoint of the lecture span in the label file. Each half is folded by the product's `planChunks` on its own, with no state carried across the split, so a boundary at the very first window of the second half cannot be detected. A window belongs to the lecture and half of its first new passage and its earliest new media second."

1. Total the watched seconds of every clip, in watch order (watched time inside the clip's labeled span).
2. Split at the clip JOIN nearest the midpoint of that total; a tie goes to the earlier join.
3. The clips before the join are the first half (tune). The clips after it are the second half (held-out, scored once). No clip is cut.
4. No state is carried across the split: each half is folded by `planChunks` on its own. A window, a frame and a label belong to the half of their clip.

Worked example, the real shape: five clips with watched seconds about 184, 229, 403, 339 and 194. The total is 1349 and its midpoint 674.5. The four joins sit at 184, 413, 816 and 1155 watched seconds, which are 490.5, 261.5, 141.5 and 480.5 from the midpoint. The nearest is 816, so the split is after the third clip: clips 1 to 3 tune, clips 4 and 5 held-out.

A lecture of one video (schema 1, or schema 2 with one video) keeps the adopted rule: the midpoint of its span.

### A boundary no model could detect (PROPOSED)

A detection is the start of a window that follows another window of the same half, so a label inside the FIRST window of a half has nothing before it to close. That is the case for the split join, which starts the held-out half. For a set of two or more clips such a label (same clip as the half's first window, mediaS before that window's end) is excluded from the recall denominator, counts in no other measure, and is printed with the reason. A one-video lecture keeps the schema 1 numbers, so it does not exclude it. The exclusion is lenient to the model by up to one window: a close at the second window would still fall within 60 s of such a label, so it is a rule about what the half cannot see, not about the tolerance.

### Other definitions, with "lecture" read as the set

- False closes per 15 min: unmatched detections over the pooled watched seconds of the held-out half, counted only when that half has at least one labeled, detectable boundary (a half with none is excluded and listed).
- Recall pooled; visual steps lost: at most 1 per set (not scaled); duplicates dropped pooled.
- Budget 800 hard, 3 tune rounds, score once, and every safety rail are unchanged.

### The visual-step rule (Derek's wording, verbatim)

> A visual step is when the actual slide content changes (new text or a new figure shown on screen). The same slide staying up across several transcript passages is not a new step.

The JPEG-size cue in the deterministic drafts is only a suggestion. It can fire on a change that is not new content and miss one that is, and it decides nothing: Derek keeps only the changes of slide content.

### Label format, schemaVersion 2

```json
{
  "schemaVersion": 2,
  "status": "draft | signed_off",
  "signedOffBy": null,
  "signedOffAt": null,
  "lecture": {
    "captureId": "cap_...",
    "videos": [
      { "videoId": "clipOne1111", "title": "...", "spanS": { "start": 0, "end": 184.3 } },
      { "videoId": "clipTwo2222", "title": "...", "spanS": { "start": 0, "end": 229.4 } }
    ]
  },
  "boundaries":  [{ "videoId": "clipTwo2222", "mediaS": 0, "note": "...", "confirmed": true }],
  "visualSteps": [{ "videoId": "clipTwo2222", "mediaS": 120, "note": "...", "confirmed": true }],
  "duplicateGroups": [{ "note": "...", "confirmed": true, "frames": [
    { "videoId": "clipOne1111", "mediaS": 80 },
    { "videoId": "clipTwo2222", "mediaS": 5, "frameId": "ev_..." }
  ] }]
}
```

- `lecture.videos` lists the clips in watch order, each once, each with its own `spanS`. A run refuses a set whose order differs from the order in which the capture first saw those videos, and a video the capture never saw.
- Every boundary, visual step and duplicate frame carries a `videoId` of one of the clips, and its `mediaS` must lie in that clip's `spanS` (half-open, as in schema 1).
- A duplicate group needs at least 2 frames, and a group of one is an error. **PROPOSED:** a group may span clips, because the same slide shown at the end of one clip and the start of the next is a real duplicate. Its earliest member is the earliest in watch order (clip order, then media time), and each later member is scored in its own clip's half.
- Sign-off is unchanged: a typed name and an ISO date, every item confirmed, every problem listed with its field path, a misspelled field an error, and the run stores each label file's sha256.
- Schema 1 files stay valid and unchanged. A run holding a schema 2 file refuses label files of another capture, and a video that is in two label files. Schema 1 files alone run as before.
- The lecture id in reports is `<captureId>/<videoId>` for one video and `<captureId>/set:<first videoId>+<other clips>` for a set (PROPOSED).

### Commands

```
draft-labels-set --data <dir> --capture <id> --out <file> [--force]
split            [--data <dir>] --labels <file> ...        (a set needs --data: its split counts watched seconds)
```

`draft-labels-set` writes ONE schema 2 draft for the whole capture, clips in watch order, and no model is used. It puts a boundary candidate at the start of every clip after the first (cue: "start of clip N: the product treats the next clip's first window as the decision point"), nothing inside a clip, the visual-step and duplicate candidates of `draft-labels` per clip (a step candidate compares a frame with the previous candidate frame of its own clip), and every item `confirmed: false` with status draft. `split`, `plan`, `run`, `report` and `rescore` accept both schemas and print per-set and per-half counts. `plan` counts the windows, frame calls and boundary labels of each half from the real windowing, including the labels excluded for lying in a half's first window. Stored judgments record their `videoId`. `rescore` stays byte-identical to the original report. The labeling sheet reads schema 1 files only: a set has no sheet yet.

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

Not scored and not claimed: the product's cross-clip behavior ("Video ends → do NOT close; the next clip's first window decides"). Each lecture is folded alone. **[SUPERSEDED by Amendment 1: a lecture is now the set of clips, so the clip-join rule is scored.]**

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

One file per lecture in `docs/experiments/labels/<name>.json`. In schema 1, described here, a lecture is one video of one capture. **[Amendment 1 adds schema 2, where a lecture is the set of clips of one capture; see its label format.]** `docs/experiments/labels/example-fixture.json` is a hand-made format example (a fixture, not Derek's labels).

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
draft-labels-set --data <dir> --capture <id> --out <file> [--force]       (Amendment 1)
split        [--data <dir>] --labels <file> [--labels <file> ...]
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

### The labeling sheet

Derek labels from a sheet, not from the videos. `scripts/jev-lab-sheet.ts` writes one static HTML page per lecture from the draft label files, and an `index.html` that lists them. It makes no Jev or Claude call, reads no key, and needs no network or server.

```
bun run scripts/jev-lab-sheet.ts --data <dir> --labels <draft file> [--labels <draft file> ...] --out <dir>
```

- It reads the capture through a scratch copy of the database, as `probe-export` does, and refuses an `--out` inside the data dir. Each page holds the transcript with timestamps and the captured frames in time order, a timeline of the watched time, the split midpoint and the draft candidates, with a YouTube "watch at this time" link on every passage and frame. Frames are embedded as they were captured, so a page is as large as its frames (a few MB to about 15 MB). Open the page in Chrome straight from the folder; everything works offline.
- On a page: "Boundary here" on a passage and "Visual step" on a frame add a mark at that media second. Each draft candidate shows its cue and a Confirm and a Reject toggle (a rejected one is left out of the export). Select two or more frames and "Make group" for a duplicate group. Every mark takes a note. Work is kept in the browser's local storage (the page still works if it is blocked) and "Reset to the draft" discards it.
- The Export panel shows the label JSON, with Copy and Download. The file is a draft (nulls for name and date) until Derek types his name and an ISO date in the sign-off block and every item is confirmed or rejected, and only then does it say `signed_off`. The panel lists what blocks sign-off. Nothing is pre-filled or signed for him.
- Save the downloaded file as `docs/experiments/labels/<videoId>.json` (or anywhere) and check it with `bun run scripts/jev-lab.ts split --labels <file>`, which runs the same `validateLabels` as every other command and prints the tune and held-out counts. The scored and live runs still refuse a file that is not `signed_off`.

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
