# Experiment 2: the Jev boundary and visual lab

**Tooling retired 2026-11-13.** The scripts this file names were removed from master after commit e197fd2, so check out that commit to run the commands below.

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
10. **The budget.** "~800 Jev calls" is read as a hard ceiling of 800 that counts every request, retries included (`BUDGET_CALLS = 800`; 2,400 from Amendment 3). One tune round is one `run --phase tune`, whatever it changes. The scored run uses the config of the last tune round. A stored judgment with the same input is reused at no call, but a round that reuses everything still counts as a round.

## Amendment 1 (Derek, 2026-11-04, before any paid call): a lecture is the set of clips

**Why.** The adopted design scores each video as its own lecture. Derek's real material is a set of pre-split clips (a course playlist), so the topic boundaries are the joins between clips. **[SUPERSEDED by Amendment 2: a join is a boundary candidate only, and it is a boundary only when the topic changes there.]** The product's own rule is that a video ending does not close a chunk and the next clip's first window decides (flow B: "Video ends → do NOT close; the next clip's first window decides."). Under the adopted rule (definition 9: each lecture alone, each half folded alone) the first window of every clip has nothing before it, so a clip join can never be detected and the boundary bar is unmeasurable. Derek, 2026-11-04: "it should be the set of clips ... there are NO boundaries [within a clip], the split is the boundary", and "visual steps should only be when the actual slide content changes ... it's ok to record transcript between the slide changes (new text shown on screen counts as a visual step)". He told the agent to amend the lab. No Jev or Claude call has been made. The bar text, the budget and the other adopted definitions are not changed.

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

One-to-one and +-60 s inclusive (definition 2), and only within the SAME videoId: the distance between places in different clips is undefined, so a detection never matches a label of another clip, however close in watch time. **[SUPERSEDED by Amendment 2 for what makes a join a boundary: Derek labels a join as a boundary only when the topic changes there, not every join.]** A join label is a boundary labeled at the start of clip N (the videoId of clip N, mediaS inside its first window), so a Jev-driven close whose next chunk starts at that clip's start matches it. The first clip's start is not a boundary.

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
- Budget 800 hard (2,400 from Amendment 3), 3 tune rounds, score once, and every safety rail are unchanged.

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

## Amendment 2 (Derek, 2026-11-05, after the first scored run): a topic boundary is a change of topic

Why. After run 1's held-out scoring (recall 0 of 3), Derek said what a boundary is. His words, verbatim:

> typically within a single video (at least the playlist ones i'm watching that are only a few minutes long each), the topic is definitely not changing in the middle of the video. for example, if i'm watching a set of lectures on active networks, that is one topic. if it switches to component design, that's a new topic and we've crossed a boundary.

and, about the observation that a topic does not change inside a clip: "this may not be true for longer lectures!"

The definition. A topic boundary is a place where the subject being taught changes to a different topic. The unit is the topic, not the clip. A join between two clips of the same topic is not a boundary. A boundary can be a clip join (when the next clip starts a different topic) or can fall inside a long lecture. In the short playlist clips used so far a topic does not change inside a clip; that is an observation about those clips, not a rule of the lab.

What it changes in Amendment 1 (PROPOSED wording, Derek to confirm when he next reviews this file):

- A clip join is a boundary CANDIDATE only. Derek confirms it only when the topic changes there. Amendment 1 said "so the topic boundaries are the joins between clips"; that is superseded.
- The product's rule is unchanged: a video ending does not close a chunk, and the next clip's first window decides.
- Everything else in Amendment 1 (the set as the lecture, the split at the nearest join, matching, the undetectable-label rule) stays as written.

Effect on run 1. The labels signed on 2026-11-05 confirmed all 10 joins of the 11-clip set as boundaries. My reading of the clip titles (clips 1 to 6 are the Active Networks lesson, ending with "ANTS Capsule and API"; clips 7 to 11 start with "Object based vs Procedural Design" and continue with Spring, the component-design lesson) is that only the join from clip 6, "ANTS Capsule and API", to clip 7, "Object based vs Procedural Design", is a topic change. That is my inference from titles and Derek's two example topics, not a label: no labels have been made under this definition, and Derek has not yet said which joins he would confirm. On that reading, run 1 was scored against labels that were wrong by this definition. Its results are kept below as a record and are SUPERSEDED: they are not an experiment 2 result against the bars. In particular, recall 0 of 3 on the held-out half counted joins that, on that reading, are not boundaries, and the held-out half (clips 8 to 11) would then contain no boundary, so recall there would be NOT MEASURED.

The held-out half is spent. This definition was written after it was scored once, so the stored judgments are not re-read against new labels as if that were a clean held-out result. A new set with labels made under this definition, scored once, replaces it.

An observation made after the fact, not a result: in the tuning half, at yes 0.5, Jev's one close was at the start of clip 7, which on the reading above is the one topic change in that half. It is one boundary.

Next, not yet run at the time of writing (done: Run 2 below): capture more topic changes with automated watching (Derek approved driving Chrome through playlists, and may supply links), label them under this definition, then run tuning and a single scoring on a held-out set that has several boundaries. The counts and budget will be written here before any call. `docs/experiments/06-model-optimized-jev.md` names experiment 2's scoring of the 11-clip set as its baseline; that must be updated to the new set before experiment 6 runs.

## Amendment 3 (Derek, 2026-11-05, before any Jev call on the 43-clip set): the Jev call ceiling is 2,400

Why. Decision 10 read "~800 Jev calls" as a hard ceiling of 800, a number sized for the 11-clip set. The new set is 43 clips (the seven topic-boundary windows of Advanced Operating Systems Part 3, `assembled-2`, labels signed 2026-11-05). `plan` on it counts 542 calls for one tuning round (first half, nothing cached) and 538 for the scored run (second half): 1,080 for one round plus the score, and 2,164 in the worst case of three tuning rounds that each change windowing, so the lab would refuse to run it.

The decision. Derek was asked "Approve a 2,400 Jev ceiling for experiment 2 and 5,000 total for experiment 6?" and answered "Yes, those numbers". The numbers are the agent's: 2,164 plus about 10% for retries, rounded to 2,400. The ceiling is a guard, not an estimate of spend.

What it changes: `BUDGET_CALLS` is 2,400 (was 800) and the budget text says so. Every other part of decision 10 is unchanged: it counts every request including retries, one tune round is one `run --phase tune`, at most 3 tune rounds, the scored run once, and every safety rail. `docs/flows/after-class.md` still quotes "~800 Jev calls", the text Derek approved for the flow; it is not edited, and this amendment is what changes the ceiling for this lab. The older 11-clip run (451 of its 800 calls, superseded by Amendment 2) printed the old budget line in its stored report, so a rescore of that old report now differs from it in that one line only.

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
| `--max-calls N` | Required, an integer from 1 to the ceiling (800; 2,400 from Amendment 3). The run refuses before its first call if it needs more than N new calls, and aborts before any call beyond N. |
| The call budget (800; 2,400 from Amendment 3) | A persisted counter in the lab dir, written before each request, across all phases. A run that would cross the ceiling refuses up front, and a request that would cross it is never sent, retries included. |
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
3. `plan` counts the Jev calls from the real windowing and compares them with the ceiling (800; 2,400 from Amendment 3). It exits non-zero when one tune round plus the scored run is over budget, and prints the worst case (3 tune rounds that each change windowing). No call is made.
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

#### The set sheet (schema 2)

A schema 2 label file (a `draft-labels-set` draft) is a lecture of many clips, so it gets ONE page, not one per clip. This replaces the Amendment 1 sentence "a set has no sheet yet". It adds no rule to the lab: it only lets Derek label a set and, optionally, review what two models proposed.

```
bun run scripts/jev-lab-sheet.ts --data <dir> --labels <set draft> [--proposals <file> [--proposals <file>]] --out <dir>
```

- **Output.** `<out>/index.html` (about 0.2 MB for the 11-clip set) and `<out>/frames/cNN-fNNNN.jpg`. Frames are files, not data: URIs, because the assembled set has 393 frames (42.8 MB, 57 MB as base64) and an embedded page must be read and parsed whole before it shows anything. The folder is still fully offline: the Content-Security-Policy is `default-src 'none'; img-src 'self'` plus the hashes of the one script and one style, and the page builds an image address only from the fixed pattern `frames/cNN-fNNNN.jpg`. Keep the folder together. The per-clip sheet of a schema 1 file is unchanged (frames embedded).
- **On the page.** Derek's visual-step rule, verbatim. All clips in watch order with the clip joins drawn: each join is a boundary candidate ("Boundary at this join"), because the next clip's first window decides. A timeline of the whole set with the clip joins and the split. Which clips are tuning and which held-out, in plain words: the lab may look at the tuning clips and their labels while it adjusts settings (up to 3 rounds), and scores the held-out clips once at the end, never tuning on them. A clip's transcript and frames are built when it is opened (the first clip is open, and "Open all clips" opens every one), so the page starts fast. The controls of the per-clip sheet are all there, across clips: boundary here, visual step, select frames for a duplicate group (a group may span clips), confirm and reject per candidate, notes, YouTube "watch at this time" links, search, "Next unconfirmed", the localStorage mirror, and "Reset to the draft" with a confirmation.
- **The split** shown on the page is the lab's own (`makeSplitter` over the clips' watched seconds, read from the capture), so the page and `split` cannot disagree.
- **Model proposals** (`proposals.json`, schema version 1, validated by `scripts/jev-lab-proposals.ts`): `{ schemaVersion: 1, kind: "label-proposals", proposedBy: { model, effort }, captureId, provenance, createdAt, items: { boundaries: [{ videoId, mediaS, reason, source: "model" | "join" }], visualSteps: [{ videoId, mediaS, reason }], duplicateGroups: [{ frames: [{ videoId, mediaS, frameId? }], reason }] } }`. Zero, one or two files. Each proposed item is a candidate on the page, labelled with who proposed it (Opus, Fable or both) and its reason, shown as text. A proposal is never pre-confirmed and never signed: it is confirmed only by Derek's click. A proposals file may carry `origin: "fixture"` (made by a scripted test client, not a model): the sheet refuses it unless `--allow-fixture-proposals` is passed, and then labels every candidate and the Disagreements panel "FIXTURE, not a model", never Opus or Fable; `origin: "live"` or no origin is shown as the model. A proposal for another capture, a video that is not in the set, a time outside that video's labeled span (half-open) or a frame id the capture does not hold is refused when the sheet is generated, with every problem listed, and nothing is written.
- **Disagreements.** A panel lists what only one model proposed and what both proposed, each linking to its place, and "Show only disagreements" hides everything else. Two boundaries are the same when within 60 s in the same clip, two visual steps when within 10 s (inclusive), and two duplicate groups when they share at least 2 frames. PROPOSED (not adopted): these tolerances (`BOUNDARY_TOLERANCE_S`, `STEP_TOLERANCE_S`, `GROUP_FRAME_MATCH_S` in `scripts/jev-lab-set-client.ts`) only decide how the page groups proposals. They do not touch the lab's own matching. Pairing is one to one, closest pair first; a pair becomes one candidate at the earlier time with both reasons.
- **Export.** One schema 2 file, `status: "draft"` with null name and date until every item is confirmed or rejected and Derek has typed his name and an ISO date. Every item carries its `videoId`; a confirmed model proposal keeps `cue: "proposed by <model>: <reason>"` (the model id as in the proposals file; two models join their cues with "; "); an item Derek added himself has no cue. The blockers mirror `validateLabels` for schema 2: unconfirmed items, name, date, a time outside its clip's span, a video that is not one of the clips, a duplicate group of fewer than two distinct frames. The clips keep the draft's watch order, which the lab checks against the capture. Check the saved file with `bun run scripts/jev-lab.ts split --data <dir> --labels <file>`.

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

### Run 1 (2026-11-05), the 11-clip set, SUPERSEDED by Amendment 2

Scored against labels that counted all 10 clip joins as boundaries. Kept for the record; not an experiment 2 result. The labels file was signed by Derek on 2026-11-05 after he verified model proposals on the sheet; the signed file differs from his download by the cleanup recorded in its description.

Tuning rounds on the first halves (clips 1 to 7), 195 live Jev calls in round 1 and none in rounds 2 and 3 (stored judgments reused):

| Round | Settings changed | Recall | Jev closes | False closes | Steps lost | Duplicates dropped |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | none (yes at 0.7, no at 0.3) | 0 of 6 | 0 | 0 | 1 of 8 | 38 of 40 |
| 2 | yes at 0.5 | 1 of 6 | 1 | 0 | 1 of 8 | 38 of 40 |
| 3 | yes at 0.5, `reviseOnNextNoNo` on | 1 of 6 | 1 | 0 | 1 of 8 | 38 of 40 |

The scored run on the held-out half (clips 8 to 11), once, 256 live calls, with round 3's settings. The report below is pasted unedited from `score-1.report.txt`; `rescore` reproduces it byte for byte.

```text
[live] Jev lab report score-1
[live] Data origin: live
[live] Scope: held-out second halves (scored once)
[live] Model: jev-1.13.0
[live] Config: windowNewS=30, contextS=120, timeCapS=480, maxFramesPerWindow=2, reviseOnNextNoNo=true
[live] Thresholds: yes at or above 0.5, no at or below 0.3
[live] Budget: "~800 Jev calls, max 3 tuning rounds, tune on first halves, score once on held-out second halves"
[live] Lecture cap_z2fpbreijoryj4as3xvxp3ic7l/set:-nY-8shbqOo+10: 11 clips in watch order, split at the join before clip 8 (watched 1038.049 s before it and 1165.268 s after; the midpoint of 2203.317 s is 1101.659 s), tune clips 1-7, held-out clips 8-11, scored second half; labels labels-set-signed.json sha256 5138e96ca3ea
[live]   clip 1: -nY-8shbqOo, span [3.3, 134.081), watched 130.781 s
[live]   clip 2: 6E0bLlZhq68, span [0, 216.741), watched 216.741 s
[live]   clip 3: pV3YVncEwp0, span [0.013, 137.121), watched 137.108 s
[live]   clip 4: 8TKdsjd_HAo, span [0.019, 167.181), watched 167.162 s
[live]   clip 5: ZKgQChNiwzY, span [0, 185.021), watched 185.021 s
[live]   clip 6: 9PvZIjEs2uE, span [0, 16.9), watched 16.9 s
[live]   clip 7: Uks_t77_nyk, span [0.005, 184.341), watched 184.336 s
[live]   clip 8: DS_idEsax-s, span [0, 229.421), watched 229.421 s
[live]   clip 9: nxkoYy7FOp8, span [0, 403.361), watched 403.361 s
[live]   clip 10: blYTia8r3s8, span [0.005, 338.841), watched 338.836 s
[live]   clip 11: fcaUwpeKAoY, span [0.009, 193.66), watched 193.65 s

[live] Boundary recall: FAIL
[live] Bar: "≥70% of labeled boundaries detected within ±60s"
[live] Measured: 0/3 labeled boundaries detected within ±60s = 0%.
[live]   cap_z2fpbreijoryj4as3xvxp3ic7l/set:-nY-8shbqOo+10: 0/3 detected; missed at clip 9 0s, clip 10 0.005s, clip 11 0.009s
[live]   cap_z2fpbreijoryj4as3xvxp3ic7l/set:-nY-8shbqOo+10: 1 label(s) at clip 8 0s lie in the first window of the second half, so no model could detect them (PROPOSED rule, Amendment 1); excluded from the denominator

[live] False closes: PASS
[live] Bar: "≤1 false close per 15 min"
[live] Measured: 0 false close(s) in 1165.268 s watched = 0 per 15 min.
[live]   cap_z2fpbreijoryj4as3xvxp3ic7l/set:-nY-8shbqOo+10: 0 Jev close(s), 0 false at none in 1165.268 s watched

[live] Visual steps: PASS
[live] Bar: "≤1 important visual step lost per lecture"
[live] Measured: most lost in one lecture 1 (limit 1); this is the scored half only, not a whole lecture.
[live]   cap_z2fpbreijoryj4as3xvxp3ic7l/set:-nY-8shbqOo+10: 1/6 lost (clip 9 219.92s every candidate frame dropped)

[live] Duplicates: PASS
[live] Bar: "≥50% duplicates dropped"
[live] Measured: 202/213 labeled duplicates dropped = 94.836%.
[live]   cap_z2fpbreijoryj4as3xvxp3ic7l/set:-nY-8shbqOo+10: 202/213 dropped

[live] Usage (this run, measured; Jev reports tokens only, so cost is unknown):
[live]   calls 256 (boundary 37, frame change 219, failed 0); judgments reused from earlier calls 0
[live]   input tokens 1414658 (0 call(s) without a count), output tokens 6554 (0 call(s) without a count)
[live]   cost unknown
[live] Latency (report only, no target): all calls p50 436 ms, p95 1003 ms (n=256)
[live]   boundary p50 536 ms, p95 812 ms (n=37)
[live]   frame change p50 430 ms, p95 1072 ms (n=219)

[live] OVERALL: FAIL (failed: recall)
[live] Not shown by this lab: model accuracy beyond this label set, other lectures, other machines, learning effectiveness. Labels are Derek's judgment.
```


### Run 2 (2026-11-05 local evening), the 43-clip set, labels made under Amendment 2

The set is the seven topic-boundary windows of Advanced Operating Systems Part 3 (43 clips, `assembled-2`, replayed live captures made with a test-only autostart extension; all but 69 of about 6,770 watched seconds were captured with the tab visible: 68 s hidden in window 3 and 1 s in window 2). Labels: `labels-set-2-signed.json`, signed "Derek" on 2026-11-05 after Derek verified Opus and Fable proposals on the sheet; sha256 `0a4789cc...c7a9`. They hold 9 boundaries, 38 visual steps and 75 duplicate groups. The 9 boundaries are the 7 lesson changes plus 2 more that Derek confirmed on the sheet (clip 2, "Roadblocks Quiz Solution" to "Feasible", in the tuning half; clip 43, NFS to DFS, in the held-out half). The split is before clip 23: tuning clips 1 to 22 (4 boundaries), held-out clips 23 to 43 (5 boundaries). Budget: Amendment 3 (2,400), 1,080 calls used, none failed.

Tuning rounds on the first half (stored judgments reused when only thresholds change):

| Round | Settings | Jev calls | Recall | Jev closes | False closes | Steps lost | Duplicates dropped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | product defaults (yes at 0.7, no at 0.3) | 542 | 0 of 4 | 0 | 0 | 0 of 25 | 378 of 392 |
| 2 | yes at 0.4 | 0 | 1 of 4 | 7 | 6 (1.52 per 15 min) | 0 of 25 | 378 of 392 |

Round 3 was not used. The scored run takes the config of the last tune round and a third round could not be undone, so a worse windowing change would have become the baseline for experiment 6; the agent proposed stopping and Derek agreed ("Yes, score now"). Observations from round 1, not results: no stopping-point probability reached 0.7 (maximum 0.59), and at the four labeled joins its first-window values were 0.30, 0.24, 0.41 and 0.44 while ordinary joins reached 0.46, so a threshold alone does not separate topic changes from other joins.

The scored run on the held-out half (clips 23 to 43), once, 538 live calls, with round 2's config. A first attempt refused before any call because the agent had passed `--yes-at`, which a scored run does not accept; no call was made and the score was not used. The report below is pasted unedited from `score-1.report.txt`; `rescore` reproduces it byte for byte.

```text
[live] Jev lab report score-1
[live] Data origin: live
[live] Scope: held-out second halves (scored once)
[live] Model: jev-1.13.0
[live] Config: windowNewS=30, contextS=120, timeCapS=480, maxFramesPerWindow=2, reviseOnNextNoNo=false
[live] Thresholds: yes at or above 0.4, no at or below 0.3
[live] Budget: "~2400 Jev calls (Amendment 3; ~800 until then), max 3 tuning rounds, tune on first halves, score once on held-out second halves"
[live] Lecture cap_tgdrnaulw4pau7lyfk2wy2tqlq/set:gj8SEvEc8q8+42: 43 clips in watch order, split at the join before clip 23 (watched 3546.876 s before it and 3221.466 s after; the midpoint of 6768.341 s is 3384.171 s), tune clips 1-22, held-out clips 23-43, scored second half; labels labels-set-2-signed.json sha256 0a4789ccd3d6
[live]   clip 1: gj8SEvEc8q8, span [0.003, 115.521), watched 115.518 s
[live]   clip 2: oIwmkFTpo8o, span [0.004, 146.401), watched 146.349 s
[live]   clip 3: XkOpgZwzF1w, span [0.009, 97.596), watched 97.587 s
[live]   clip 4: 3pKfZb7cplY, span [0.003, 156.181), watched 156.178 s
[live]   clip 5: QTpdTk6wMDk, span [0.002, 271.981), watched 271.979 s
[live]   clip 6: WF9o7pvNvyM, span [0.003, 290.441), watched 290.438 s
[live]   clip 7: Z0RWTiD_pHM, span [0.003, 202.081), watched 202.078 s
[live]   clip 8: UtwGUDBZmvo, span [0.003, 309.381), watched 309.378 s
[live]   clip 9: ORfwa0dxzcE, span [0.006, 57.461), watched 57.455 s
[live]   clip 10: 61f7BVQO6fY, span [0.018, 167.721), watched 167.703 s
[live]   clip 11: jxv0AOe4HQo, span [0.007, 180.303), watched 180.296 s
[live]   clip 12: Uks_t77_nyk, span [0.003, 184.341), watched 184.338 s
[live]   clip 13: iW9-T8d4nFY, span [0.004, 167.701), watched 167.677 s
[live]   clip 14: NxsgAAwO0kg, span [0.002, 234.761), watched 234.759 s
[live]   clip 15: eV86JsLbPt8, span [0.007, 47.181), watched 47.174 s
[live]   clip 16: 6OiieeFFSCo, span [0.013, 25.761), watched 25.748 s
[live]   clip 17: rwFYdb1AUxA, span [0.008, 19.001), watched 18.993 s
[live]   clip 18: eCx87JRJ31s, span [0, 13.621), watched 13.621 s
[live]   clip 19: i8eTe51yH1s, span [0.003, 58.801), watched 58.798 s
[live]   clip 20: isg_qmXmcN0, span [0.03, 212.581), watched 212.551 s
[live]   clip 21: IsJnQgacCmY, span [0.139, 248.041), watched 247.902 s
[live]   clip 22: ASu4g8Q1dVc, span [0.003, 340.361), watched 340.358 s
[live]   clip 23: oYA5VHWxA9w, span [0.005, 36.201), watched 36.196 s
[live]   clip 24: QCL4w7adhTI, span [0.006, 67.761), watched 67.755 s
[live]   clip 25: IXbsbljB9nQ, span [0.017, 160.981), watched 160.964 s
[live]   clip 26: mmM7uxkXmRM, span [0.008, 241.221), watched 241.213 s
[live]   clip 27: -lJxenRuzdc, span [0.087, 401.101), watched 401.014 s
[live]   clip 28: JcW7DfUP4Lw, span [0, 72.401), watched 72.401 s
[live]   clip 29: aashdwoAiog, span [0.011, 188.281), watched 188.27 s
[live]   clip 30: _vr032NsptA, span [0.019, 412.881), watched 412.862 s
[live]   clip 31: XPDuZ3OpBsI, span [0.104, 244.361), watched 244.257 s
[live]   clip 32: WumSP2BLj2A, span [0.006, 281.841), watched 281.835 s
[live]   clip 33: jNjiBT3XRuE, span [0.008, 94.621), watched 94.613 s
[live]   clip 34: E4TSFpP3cTU, span [0.004, 72.261), watched 72.257 s
[live]   clip 35: 1JlFKgJ1bUg, span [0.003, 139.141), watched 139.138 s
[live]   clip 36: 2bY1PxhkBBE, span [0.002, 183.821), watched 183.819 s
[live]   clip 37: LTVbD9_t4iE, span [0, 86.129), watched 86.129 s
[live]   clip 38: IffxZvPBAiY, span [0.003, 148.91), watched 148.906 s
[live]   clip 39: qVEMq_tl5Sk, span [0.015, 32.041), watched 32.026 s
[live]   clip 40: z_UNXO7yaro, span [0.003, 61.721), watched 61.718 s
[live]   clip 41: 6ap7_kBQUb4, span [0.011, 29.861), watched 29.85 s
[live]   clip 42: wOQym_iOULE, span [0.016, 143.761), watched 143.745 s
[live]   clip 43: 0zRt8G366UU, span [0.002, 122.501), watched 122.499 s

[live] Boundary recall: FAIL
[live] Bar: "≥70% of labeled boundaries detected within ±60s"
[live] Measured: 2/5 labeled boundaries detected within ±60s = 40%.
[live]   cap_tgdrnaulw4pau7lyfk2wy2tqlq/set:gj8SEvEc8q8+42: 2/5 detected; missed at clip 34 0.004s, clip 40 0.003s, clip 43 0.002s

[live] False closes: PASS
[live] Bar: "≤1 false close per 15 min"
[live] Measured: 2 false close(s) in 3221.466 s watched = 0.559 per 15 min.
[live]   cap_tgdrnaulw4pau7lyfk2wy2tqlq/set:gj8SEvEc8q8+42: 4 Jev close(s), 2 false at clip 32 4s, clip 33 10s in 3221.466 s watched

[live] Visual steps: PASS
[live] Bar: "≤1 important visual step lost per lecture"
[live] Measured: most lost in one lecture 0 (limit 1); this is the scored half only, not a whole lecture.
[live]   cap_tgdrnaulw4pau7lyfk2wy2tqlq/set:gj8SEvEc8q8+42: 0/13 lost

[live] Duplicates: PASS
[live] Bar: "≥50% duplicates dropped"
[live] Measured: 387/424 labeled duplicates dropped = 91.274%.
[live]   cap_tgdrnaulw4pau7lyfk2wy2tqlq/set:gj8SEvEc8q8+42: 387/424 dropped

[live] Usage (this run, measured; Jev reports tokens only, so cost is unknown):
[live]   calls 538 (boundary 100, frame change 438, failed 0); judgments reused from earlier calls 0
[live]   input tokens 2976666 (0 call(s) without a count), output tokens 14174 (0 call(s) without a count)
[live]   cost unknown
[live] Latency (report only, no target): all calls p50 402 ms, p95 921 ms (n=538)
[live]   boundary p50 351 ms, p95 554 ms (n=100)
[live]   frame change p50 418 ms, p95 965 ms (n=438)

[live] OVERALL: FAIL (failed: recall)
[live] Not shown by this lab: model accuracy beyond this label set, other lectures, other machines, learning effectiveness. Labels are Derek's judgment.
```

Result: boundary recall 2 of 5 (40%), FAIL against the 70% bar; false closes 0.559 per 15 min, PASS; visual steps lost 0 of 13, PASS; duplicates dropped 387 of 424 (91.3%), PASS. OVERALL: FAIL (recall). The detected boundaries are at clips 24 and 29; the misses are clips 34, 40 and 43. This is a Jev result on one set, one labeler and one machine; it is not a claim about other lectures or about learning effectiveness. This run is the baseline for experiment 6 (`06-model-optimized-jev.md`), whose protocol still names the 11-clip set; per Amendment 2 it must be updated to this set before experiment 6 runs.
