# Experiment 6: the approved optimizer prompt template

**Tooling retired 2026-11-13.** The scripts this file names were removed from master after commit 1817f06, so check out that commit to run the commands below.

Approved by Derek on 2026-11-05. The text between the two marker comments is the template, word for word; do not reword it. `scripts/jev-lab-optimize.ts` reads it from this file at run time, fills the `<<...>>` placeholder lines (and `<<N>>`, `<<M>>` inside a line), and refuses to run if the text between the markers no longer has the approved SHA-256 (`a10cf915d4b789951c10174e19f58574830e8fb85c747ffd142142e31ca81492`). A change to the template is a new approval from Derek, not an edit.

<!-- BEGIN APPROVED TEMPLATE -->
You are improving how a fast yes/no model, Jev, makes decisions for After Class, an app that turns lecture videos a student watches into review sessions. Jev answers each question with a probability that the answer is yes. Your job is to propose better question wording, thresholds and segmentation settings so Jev's decisions match the student's verified labels.

## How Jev is used (Derek's approved flow, quoted)

<<flow B, quoted verbatim from docs/flows/after-class.md, including the routing table>>

A chunk closes at a topic boundary only when both boundary questions are yes (p at or above the yes threshold). Everything else does not close.

## What a topic boundary is (Derek's definition, quoted)

> typically within a single video (at least the playlist ones i'm watching that are only a few minutes long each), the topic is definitely not changing in the middle of the video. for example, if i'm watching a set of lectures on active networks, that is one topic. if it switches to component design, that's a new topic and we've crossed a boundary.

and: "this may not be true for longer lectures!"

## What a visual step is (Derek's rule, quoted)

> A visual step is when the actual slide content changes (new text or a new figure shown on screen). The same slide staying up across several transcript passages is not a new step.

## What Jev sees in each request

- Boundary questions (one request per window): `state.context` (the earlier ~2 min of captions, each with a time), `state.passage` (the new ~30 s of captions), and up to 2 frames.
- Frame question (one request per new frame): `state.before` and `state.after` (two images) and `state.captions` (captions within 15 s).

## What you may change, and nothing else

- The wording of the three yes/no questions: `newConcept`, `stoppingPoint`, `teachingChange`. They stay yes/no questions about the state above, and must make sense for any lecture: do not name this course, its clips, titles or times.
- The thresholds `yesAtOrAbove` and `noAtOrBelow`.
- The segmentation settings `windowNewS`, `contextS`, `timeCapS`, `maxFramesPerWindow`, `reviseOnNextNoNo`.

You may not change the model, the routing table, the labels, the scoring, or how frames are sampled.

## The current configuration

<<the arm's current config as JSON>>

## Results on the tuning clips only

These are the first <<N>> clips of a <<M>>-clip set. The remaining clips are held out: you will never see them, and your final configuration is scored once on them. Fitting these clips at the expense of the general case will likely score worse there.

<<the first-half report of the current configuration: the four bars and their numbers>>

<<per clip, in watch order: title, the timed transcript>>

<<per boundary window: clip, the time range of its new passage and of its context, p(new concept), p(stopping point), the verdicts and the routed action, and whether a labeled boundary is within 60 s>>

<<per judged frame: clip, time, p(teaching change), verdict, and whether Derek labeled it a visual step, a duplicate of an earlier frame, or neither>>

<<Derek's verified labels for these clips: boundaries, visual steps, duplicate groups>>

<<on rounds 2 and 3: your earlier proposals, their rationale, and their results>>

## The bars the configuration is judged against

- At least 70% of labeled boundaries detected within ±60 s.
- At most 1 false close per 15 min watched.
- At most 1 important visual step lost per lecture.
- At least 50% of duplicate frames dropped.

## Answer

Reply with exactly one JSON object and nothing else:

{ "schemaVersion": 1, "kind": "jev-arm-config",
  "questions": { "newConcept": "...", "stoppingPoint": "...", "teachingChange": "..." },
  "thresholds": { "yesAtOrAbove": 0.0, "noAtOrBelow": 0.0 },
  "segmentation": { "windowNewS": 0, "contextS": 0, "timeCapS": 0, "maxFramesPerWindow": 0, "reviseOnNextNoNo": false },
  "rationale": "a few sentences: what you changed and why" }

Each question at most 600 characters. A reply that changes anything else, or is not valid JSON, is refused and you get one retry.
<!-- END APPROVED TEMPLATE -->
