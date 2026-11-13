# Experiment 7: the optimizer prompt template (DRAFT)

**Tooling retired 2026-11-13.** The scripts this file names were removed from master after commit 1817f06, so check out that commit to run the commands below.

**APPROVED by Derek in chat on 2026-11-05 ("Approve the draft").** The text between the markers below is the approved text, unchanged (SHA-256 `1595e63c4f869faca2bb1a3826c3164f2dd8530fe54ba30bcfa18314af19a8ff`, recorded as `APPROVED_EXP7_TEMPLATE_SHA256`). A live run reads an approved copy of it (`--approved-template`, kept at `data/lab/exp7/optimizer-prompt-approved-2026-11-05.md`); any change to the text needs his new approval. Earlier status: DRAFT — not approved by Derek; no live call may use it until an approved copy with matching SHA exists.

This is a builder's draft of the prompt that asks a Claude model (Fable, per `docs/experiments/07-jev-saves-the-tutor.md`) to refine the wording of experiment 7's three new questions on clips 1 to 22 only. It is modeled on the approved experiment 6 template (`docs/experiments/exp6-optimizer-prompt.md`): Derek's definitions, flow B and the quoted lines of the experiment 7 doc are copied from those documents, not retyped; the parts that are new (what Jev sees for the new questions, the evidence columns, the answer shape) are the builder's and need Derek's reading before approval.

How approval works (the same mechanism as experiment 6): the runner (`scripts/jev-lab-optimize.ts`, `--exp7`) fills this draft in `--dry-run` only, which makes no call. A live run is refused unless `--approved-template <file>` names a copy of the text between the two marker comments below (the markers of an approved copy read `BEGIN APPROVED TEMPLATE` and `END APPROVED TEMPLATE`) whose SHA-256 equals `APPROVED_EXP7_TEMPLATE_SHA256` in the runner. That constant is `null` today, so every live run is refused. After Derek approves a text, a separate change records its SHA-256 there.

<!-- BEGIN DRAFT TEMPLATE -->
You are improving how a fast yes/no model, Jev, makes decisions for After Class, an app that turns lecture videos a student watches into review sessions. Jev answers each question with a probability that the answer is yes. Your job is to propose better wording for the questions below, plus thresholds and segmentation settings, so Jev's decisions match the student's verified labels.

## How Jev is used (Derek's approved flow, quoted)

<<flow B, quoted verbatim from docs/flows/after-class.md, including the routing table>>

## What a topic boundary is (Derek's definition, quoted)

> typically within a single video (at least the playlist ones i'm watching that are only a few minutes long each), the topic is definitely not changing in the middle of the video. for example, if i'm watching a set of lectures on active networks, that is one topic. if it switches to component design, that's a new topic and we've crossed a boundary.

and: "this may not be true for longer lectures!"

## What a visual step is (Derek's rule, quoted)

> A visual step is when the actual slide content changes (new text or a new figure shown on screen). The same slide staying up across several transcript passages is not a new step.

## What the three new questions are for (Derek's adopted design, quoted)

Derek, 2026-11-05: "for providing evidence, jev is significantly cheaper for catching those frames. i said we should stream data to the interpretation layer cheaply (maybe this involves jev). jev should have very well scoped tasks."; and on the task list: "task 1 to 3 but i think the intro or conclusion can aid in determining those boundaries".

> 1. **Frame relevance.** For each kept frame: do the captions around it refer to what it shows? Only frames that are referred to go to the tutor. (Frames are about 80% of what the tutor reads after dedupe.)
> 2. **Earlier-claim relevance (kept by Derek, 2026-11-05: "Keep, measure it").** For each existing claim sent on a delta call: does it relate to the new material; only related claims are sent. Its premise in the adopted draft (that every earlier claim of the lecture is sent and grows with lecture length) was wrong: only claims inside the same chunk revision are sent, on delta calls. So the experiment first measures how many claims delta calls send and how many tokens they cost, then what the filter removes; it may save little or nothing, and that is a reportable result.
> 3. **Chunk boundaries, with intro and conclusion as evidence.** The boundary questions use the wording Fable wrote in experiment 6, and a new yes/no question per window asks whether the passage is a lesson introduction or the context ends in a conclusion or summary (Derek: "the intro or conclusion can aid in determining those boundaries"). How that answer enters the close decision is in Design item 6; it changes the product's routing table, so it needs Derek's approval in the flow doc before it ships.

and, as the experiment builds them:

> - `frameRelevanceTask` (task 1): one kept frame image plus the captions within 15 s of it (`passagesNear`); yes or uncertain or failed keeps the frame, only a no drops it (`framesKept`).
> - `claimRelevanceTask` (task 2): one existing claim's text plus the new material's passages, no images; only a no drops the claim (`claimsKept`).
> - `lessonFramingTask` (task 3): `boundaryTask` with the intro/conclusion question as a third question in the same request, so it costs no extra round trip and the window's frames are sent once. The verdict is `lessonFraming` on the judgment.

> 6. **Routing for task 3 (ADOPTED for this experiment).** Close when new concept and stopping point are both yes, OR when new concept is yes and the intro/conclusion question is yes. Clip joins add nothing by themselves.

## What Jev sees in each request

- Boundary questions (one request per window, three questions): `state.context` (the earlier ~2 min of captions, each with a time), `state.passage` (the new ~30 s of captions), and up to 2 frames. The questions are `newConcept`, `stoppingPoint` and `lessonFraming`.
- Frame question (one request per new frame, the dedupe step): `state.before` and `state.after` (two images) and `state.captions` (captions within 15 s). Its wording is `teachingChange`.
- Frame relevance (one request per kept frame): `state.frame` (one image) and `state.captions` (captions within 15 s of the frame). Its wording is `frameRelevance`.
- Claim relevance (one request per existing claim): `state.claim` (the claim's text) and `state.passages` (the new material's captions), no images. Its wording is `claimRelevance`.

## What you may change, and nothing else

- The wording of the six yes/no questions: `newConcept`, `stoppingPoint`, `teachingChange`, `frameRelevance`, `claimRelevance`, `lessonFraming`. They stay yes/no questions about the state above, and must make sense for any lecture: do not name this course, its clips, titles or times.
- The thresholds `yesAtOrAbove` and `noAtOrBelow`.
- The segmentation settings `windowNewS`, `contextS`, `timeCapS`, `maxFramesPerWindow`, `reviseOnNextNoNo`.

You may not change the model, the routing, the labels, the scoring, or how frames are sampled.

## The current configuration

<<the arm's current config as JSON>>

## Results on the tuning clips only

These are the first <<N>> clips of a <<M>>-clip set. The remaining clips are held out: you will never see them. Fitting these clips at the expense of the general case will likely score worse there.

<<the first-half report of the current configuration: the four bars and their numbers>>

<<per clip, in watch order: title, the timed transcript>>

<<per boundary window: clip, the time range of its new passage and of its context, p(new concept), p(stopping point), p(lesson framing) where Jev has been asked it, the verdicts and the routed action, and whether a labeled boundary is within 60 s>>

<<per kept frame: clip, time, p(teaching change), p(frame relevance) and its verdict where Jev has been asked it, and whether Derek labeled it a visual step, a duplicate of an earlier frame, or neither>>

<<per claim-relevance item: what evidence exists>>

<<Derek's verified labels for these clips: boundaries, visual steps, duplicate groups>>

<<on rounds 2 and 3: your earlier proposals, their rationale, and their results>>

## The bars the configuration is judged against

- At least 70% of labeled boundaries detected within ±60 s.
- At most 1 false close per 15 min watched.
- At most 1 important visual step lost per lecture.
- At least 50% of duplicate frames dropped.

and, from Derek's adopted experiment 7 bars:

> - The scoped-Jev arm sends the tutor at most 50% of the Today arm's input tokens. Both arms already send only the frames Jev's dedupe kept, so this needs task 1 to remove a large share of the kept frames: roughly 40% or more if task 2 saves nothing, using this doc's estimated token counts (1,200 tokens per image, about 25k of transcript).
> - No claim in the scoped-Jev arm loses a frame it needed (each case Derek marks as needed counts against it).

## Answer

Reply with exactly one JSON object and nothing else:

{ "schemaVersion": 1, "kind": "jev-arm-config-exp7",
  "questions": { "newConcept": "...", "stoppingPoint": "...", "teachingChange": "...", "frameRelevance": "...", "claimRelevance": "...", "lessonFraming": "..." },
  "thresholds": { "yesAtOrAbove": 0.0, "noAtOrBelow": 0.0 },
  "segmentation": { "windowNewS": 0, "contextS": 0, "timeCapS": 0, "maxFramesPerWindow": 0, "reviseOnNextNoNo": false },
  "rationale": "a few sentences: what you changed and why" }

Each question at most 600 characters. A reply that changes anything else, or is not valid JSON, is refused and you get one retry.
<!-- END DRAFT TEMPLATE -->
