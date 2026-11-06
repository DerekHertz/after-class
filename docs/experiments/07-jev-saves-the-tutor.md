# Experiment 7: does Jev make the tutor's work cheaper without making it worse?

Experiment 7 is outside the five approved in `docs/flows/after-class.md`; Derek's adoption below covers it.

Status: ADOPTED by Derek on 2026-11-05 ("Adopt as written"): the design, bars and budget below, which were marked PROPOSED in the draft. No call has been made. The routing change in task 3 is tested here but changes the product only after Derek approves it in `docs/flows/after-class.md`. The build prerequisites (below) come first, each in its own verified PR.

## Why

Derek, 2026-11-05: "what can jev do cheaply so that the tutor just has to interpret. this could span various tasks. faster, reduced token use for the interpretation model (claude)", and "fable should be helping refine the input for jev".

Experiments 2 and 6 measured Jev alone against boundary bars. On the 43-clip set, Jev drops 91 to 96% of duplicate frames and loses no visual step, but no configuration passed both boundary bars; Jev with Fable's round-3 wording caught 5 of 5 held-out topic changes at 3.07 false closes per 15 minutes. This experiment asks the question that matters for the product: does Jev's preprocessing cut what the interpretation model (Claude Opus 5.5, the product default) reads and spends, without making the prepared review worse?

## Where the tutor's tokens go today (measured on the 43-clip set, 2026-11-05)

The product's interpretation step (`interpretTask`, Opus 5.5) receives, per chunk, every transcript passage and every kept frame (as an image) of the material not yet interpreted, plus, on a delta call that re-interprets part of the same chunk, the existing claims whose evidence lies inside that chunk revision (`src/backend/preparation/index.ts`); it does not receive the claims of earlier chunks. On the 43-clip set (both halves), Jev with experiment 6's Fable round-3 frame wording judged 872 frames and kept 91 (about 10%); 1 kept frame is a talking-head shot. With the product's own frame wording the held-out half dropped 91.3% of labeled duplicates (experiment 2 Run 2). At roughly 1,200 tokens per 1280x720 image (an estimate, not measured), frames are about 1.05M tokens raw and about 110k after Jev, against roughly 25k tokens of transcript for 113 minutes. The size of the existing-claims list on delta calls has not been measured. (Correction, 2026-11-05: the draft Derek adopted said earlier claims are re-sent with every chunk and grow with the lecture; that was wrong, see task 2.)

Derek, 2026-11-05: "for providing evidence, jev is significantly cheaper for catching those frames. i said we should stream data to the interpretation layer cheaply (maybe this involves jev). jev should have very well scoped tasks."; "i think we can use the existing data"; and on the task list: "task 1 to 3 but i think the intro or conclusion can aid in determining those boundaries".

## The Jev tasks under test (Derek chose tasks 1 to 3, 2026-11-05)

Each is one yes/no question with a narrow scope.

1. **Frame relevance.** For each kept frame: do the captions around it refer to what it shows? Only frames that are referred to go to the tutor. (Frames are about 80% of what the tutor reads after dedupe.)
2. **Earlier-claim relevance (kept by Derek, 2026-11-05: "Keep, measure it").** For each existing claim sent on a delta call: does it relate to the new material; only related claims are sent. Its premise in the adopted draft (that every earlier claim of the lecture is sent and grows with lecture length) was wrong: only claims inside the same chunk revision are sent, on delta calls. So the experiment first measures how many claims delta calls send and how many tokens they cost, then what the filter removes; it may save little or nothing, and that is a reportable result.
3. **Chunk boundaries, with intro and conclusion as evidence.** The boundary questions use the wording Fable wrote in experiment 6, and a new yes/no question per window asks whether the passage is a lesson introduction or the context ends in a conclusion or summary (Derek: "the intro or conclusion can aid in determining those boundaries"). How that answer enters the close decision is in Design item 6; it changes the product's routing table, so it needs Derek's approval in the flow doc before it ships.

Frame dedupe and the claim check stay as they are.

## Design (ADOPTED 2026-11-05)

1. **Data: the existing captures.** Fable refines the wording of the questions on the tuning clips only (clips 1 to 22 of the 43-clip set), as in experiment 6. Measurements are on clips 23 to 43, which are experiment 6's held-out half: it was scored once per arm for boundaries and those results are known. The tutor-token and quality measurements here are new and were never part of any tuning, so using that half for them is sound. Task 3's boundary result on it is NOT a clean held-out result, because the intro/conclusion routing was designed after experiment 6's held-out results were seen (including that 8 of Fable's 11 false closes fall within 6 s of a clip start); it is reported as exploratory, with no boundary bar. The 11-clip set is not used: experiment 2 run 1 tuned on its clips 1 to 7.
2. **Two arms, same captures, same tutor step.**
   - **Today:** the product as it is (Jev dedupe, product boundary wording, every kept frame, and on delta calls the existing claims inside the same chunk revision).
   - **Scoped Jev:** tasks 1 to 3 on top of dedupe, with the wording fixed before the run.
3. **The tutor's step.** The product's own `interpretTask` (Opus 5.5, effort high) prepares each chunk in both arms.
4. **What is measured.** Per arm: tutor input and output tokens (images and text separately), frames and earlier claims sent, interpretation calls, wall time, notional cost at the flow doc's Opus prices; Jev calls and latency.
5. **Quality.** Derek rates the two prepared reviews blind, topic by topic: better, same, or worse. Every claim citing a frame that task 1 removed is listed. The claim check runs on both arms.
6. **Routing for task 3 (ADOPTED for this experiment).** Close when new concept and stopping point are both yes, OR when new concept is yes and the intro/conclusion question is yes. Clip joins add nothing by themselves.

## Bars (ADOPTED 2026-11-05, set before any result)

- The scoped-Jev arm sends the tutor at most 50% of the Today arm's input tokens. Both arms already send only the frames Jev's dedupe kept, so this needs task 1 to remove a large share of the kept frames: roughly 40% or more if task 2 saves nothing, using this doc's estimated token counts (1,200 tokens per image, about 25k of transcript).
- Derek rates it the same or better on at least 80% of topics.
- No claim in the scoped-Jev arm loses a frame it needed (each case Derek marks as needed counts against it).

## Budget (ADOPTED 2026-11-05)

- Claude: Fable refining wording, 3 rounds, about 6 calls; tutor interpretation, about 30 calls per arm, ceiling 80 in all, counted in experiment 7's own ledger (experiment 6's ledger, capped at 250, has 67 left and is not used).
- Jev: tasks 1 and 2 at about one call per kept frame and per earlier claim per chunk, boundary questions per window, tuning rounds included; ceiling 4,000.
- Experiment 7 calls are separated from product calls by memo version, not by purpose (the database only allows the existing purposes); count them by version or use a separate database.

## Build prerequisites (items 1 and 2 built; 3 and 4 not built, experiment stopped 2026-11-06)

- BUILT (item 1): Jev tasks 1 and 2 and the intro/conclusion question as versioned tasks, and the task-3 routing as an experiment-only option. What exists, none of it wired into the product (`main.ts` is unchanged; the product's `QUESTIONS`, tasks, memo keys and routing table behave as before):
  - `frameRelevanceTask` (task 1): one kept frame image plus the captions within 15 s of it (`passagesNear`); yes or uncertain or failed keeps the frame, only a no drops it (`framesKept`).
  - `claimRelevanceTask` (task 2): one existing claim's text plus the new material's passages, no images; only a no drops the claim (`claimsKept`).
  - `lessonFramingTask` (task 3): `boundaryTask` with the intro/conclusion question as a third question in the same request, so it costs no extra round trip and the window's frames are sent once. The verdict is `lessonFraming` on the judgment.
  - Each takes an optional wording override; the default wording is version "1", any other wording is `arm-<hash>`, and the version is in the memo key.
  - Routing: `planChunks(..., routing)` with `{ lessonFramingCloses: true }` closes on new concept yes and stopping point yes, or new concept yes and lesson framing yes. Off by default; clip joins add nothing by themselves.
  - Draft default wordings (neutral first drafts by the builder; Fable refines them on clips 1 to 22; Derek has not approved them as product wording):
    - Frame relevance: "Do the captions in state.captions refer to what state.frame shows, so that someone reading only the captions would need to see the frame? Answer no if the captions never mention or point to anything visible in the frame, or if the frame only repeats what the captions already say in full."
    - Claim relevance: "Does state.claim relate to the material in state.passages, so that a tutor preparing that material would need the claim to avoid restating it or to supersede it? Answer no if the claim is about a different topic than state.passages."
    - Lesson framing: "Is state.passage the introduction of a lesson (for example a greeting, an announcement of what the lesson covers, or a statement of its goals), or does state.context end with the conclusion or summary of a lesson (for example a recap, a closing remark, or a statement that the lesson is over)? Answer no if both are ordinary lesson content."
- BUILT (item 2, as a draft; no call made): Fable wording refinement for these questions on clips 1 to 22 (extending the experiment 6 optimizer and its held-out guard). `jev-lab-optimize.ts propose --exp7` builds the prompt from a draft template (`docs/experiments/exp7-optimizer-prompt.md`, not approved; dry run only, a live run needs an approved copy with a matching SHA), `jev-lab.ts run --exp7` runs the six wordings with the lesson-framing routing and frame relevance over kept frames, and the Claude ceiling (80, its own ledger under `<lab>/exp7`) and Jev ceiling (4,000 across `<lab>/exp7/*`) are enforced in code. Evidence the lab cannot yet produce is shown as "not measured yet" in the prompt: no Jev call has asked the new questions, and the lab holds no claims.
  - Derek, 2026-11-05: "Yes, measure first": one Jev round on clips 1 to 22 with the starting configuration (arm measure-0) runs before Fable's round 1, so round 1 sees Jev's answers to the new questions; it counts against the 4,000 Jev calls and uses no Claude call.
- An interpretation runner that prepares the same chunks in both arms with the product's `interpretTask`, records tokens (images and text separately), frames and claims sent, calls and time, with Claude-call rails (ceiling 80) and Jev rails (ceiling 4,000).
- A blind side-by-side rating sheet for Derek, topic by topic, listing every claim whose frame task 1 removed.

## Open choices for Derek

- The false-close tolerance as a product rule, in Derek's words (his note, 2026-11-05: "honestly probably fine. the user may choose to review on a topic change anyways"). Not written as a rule until he states it.
- Whether the tutor should be Sonnet 5.5 in a later run (experiment 4 compares Sonnet and Opus).

## Results and stop (2026-11-06)

Experiment 7 stopped after the Fable wording arm was scored once on clips 23 to 43. Derek decided to stop here and use the app instead (chat, 2026-11-06, verbatim):

> "Oh, I was saying recall, like, as remember, not commenting on the benchmark that we are doing. So I was just saying, like, oh, like, remember I mentioned this. anyways, I think we should just try it in the current state. And as I'm using it, some of that information or data that we collect can be used to retune or kind of sharpen the classification that's passed to Jev. So yeah, I think we should amend it and just get into actually finishing the application so that I can use it."

> "it is way better for me to test as the user and collect data rather than sit in these experiments for days on end"

Not run, so not measured: the interpretation runner and the blind rating sheet were not built, so the first two bars (tutor input tokens, Derek's rating) and the third (no claim loses a needed frame) have no result. Task 2 (claim relevance) was never asked of Jev: the lab holds no claims. Nothing below is a claim about the tutor's tokens or quality.

What did run (live Jev, `data/lab/lab-run-2/exp7`; 2,053 of the 4,000 Jev calls and 3 of the 80 Claude calls):

- Measurement round (arm `measure-0`, Derek: "Yes, measure first"), clips 1 to 22, experiment 6's selected Fable configuration with the draft wordings: 544 calls. The draft frame-relevance question answered yes on all 37 kept frames; the intro/conclusion question answered yes on 10 of 20 clip-start windows, and its routing added one close, a false one.
- Fable wording arm (`fable-1`), three rounds on clips 1 to 22 (first-half tuning reports, not results):

| Round | Recall | False closes | Visual steps lost | Duplicates dropped | Frames asked frame relevance | Dropped by it |
|---|---|---|---|---|---|---|
| 1 | 3/4 | 10 | 0 | 79.8% | 105 | 3 |
| 2 | 1/4 | 0 | 0 | 84.9% | 84 | 5 |
| 3 | 2/4 | 0 | 0 | 89.3% | 66 | 6 |

- Decision 5's rule (most bars passed, then recall) selected round 1. Scored once on clips 23 to 43 (667 calls). These clips were already scored in experiments 2 and 6, so this is a reuse, not a fresh held-out test:

| Bar | Result |
|---|---|
| "≥70% of labeled boundaries detected within ±60s" | PASS, 4/5 (missed clip 34) |
| "≤1 false close per 15 min" | FAIL, 4 in 3221.466 s = 1.118 per 15 min (clips 25 at 3 s, 29 at 39 s, 35 at 2 s, 41 at 5 s) |
| "≤1 important visual step lost per lecture" | PASS, 0 lost |
| "≥50% duplicates dropped" | PASS, 277/424 = 65.33% |

- Frame relevance on clips 23 to 43: 161 kept frames asked, 1 dropped (a labeled duplicate), 7 uncertain and kept. Across all runs it never dropped a labeled visual step, and it removed under 10% of the frames it was asked about, far below the roughly 40% the token bar needed.
- For comparison on the same clips: experiment 2's baseline 2/5 and 0.559 per 15 min; experiment 6 Opus round 3 2/5 and 1.118; experiment 6 Fable round 3 5/5 and 3.073.

None of the experiment 7 wordings or the intro/conclusion routing is in the product; `main.ts` is unchanged. Moving any of them into the product needs Derek's approval (the routing change needs it in the flow doc).

## What it does not show

Learning effectiveness, other courses or lecturers, or accuracy beyond Derek's blind rating.
