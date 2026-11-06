# Experiment 7: does Jev make the tutor's work cheaper without making it worse?

Status: ADOPTED by Derek on 2026-11-05 ("Adopt as written"): the design, bars and budget below, which were marked PROPOSED in the draft. No call has been made. The routing change in task 3 is tested here but changes the product only after Derek approves it in `docs/flows/after-class.md`. The build prerequisites (below) come first, each in its own verified PR.

## Why

Derek, 2026-11-05: "what can jev do cheaply so that the tutor just has to interpret. this could span various tasks. faster, reduced token use for the interpretation model (claude)", and "fable should be helping refine the input for jev".

Experiments 2 and 6 measured Jev alone against boundary bars. On the 43-clip set, Jev drops 91 to 96% of duplicate frames and loses no visual step, but no configuration passed both boundary bars; Jev with Fable's round-3 wording caught 5 of 5 held-out topic changes at about 3 extra closes per 15 minutes. This experiment asks the question that matters for the product: does Jev's preprocessing cut what the interpretation model (Claude Opus 5.5, the product default) reads and spends, without making the prepared review worse?

## Where the tutor's tokens go today (measured on the 43-clip set, 2026-11-05)

The product's interpretation step (`interpretTask`, Opus 5.5) receives, per chunk, every transcript passage, every kept frame as an image, and every earlier claim of the lecture. On the 43-clip set Jev judged 872 frames and kept 91 (about 10%); 1 kept frame is a talking-head shot. At roughly 1,200 tokens per 1280x720 image (an estimate, not measured), frames are about 1.05M tokens raw and about 110k after Jev, against roughly 25k tokens of transcript for 113 minutes. Earlier claims are re-sent with every chunk, so they grow with the lecture.

Derek, 2026-11-05: "for providing evidence, jev is significantly cheaper for catching those frames. i said we should stream data to the interpretation layer cheaply (maybe this involves jev). jev should have very well scoped tasks."; "i think we can use the existing data"; and on the task list: "task 1 to 3 but i think the intro or conclusion can aid in determining those boundaries".

## The Jev tasks under test (Derek chose tasks 1 to 3, 2026-11-05)

Each is one yes/no question with a narrow scope.

1. **Frame relevance.** For each kept frame: do the captions around it refer to what it shows? Only frames that are referred to go to the tutor. (Frames are about 80% of what the tutor reads after dedupe.)
2. **Earlier-claim relevance.** For each earlier claim: does it relate to the new material? Only related claims are sent, so the tutor's context stops growing with lecture length.
3. **Chunk boundaries, with intro and conclusion as evidence.** The boundary questions use the wording Fable wrote in experiment 6, and a new yes/no question per window asks whether the passage is a lesson introduction or the context ends in a conclusion or summary (Derek: "the intro or conclusion can aid in determining those boundaries"). How that answer enters the close decision is in Design item 6; it changes the product's routing table, so it needs Derek's approval in the flow doc before it ships.

Frame dedupe and the claim check stay as they are.

## Design (ADOPTED 2026-11-05)

1. **Data: the existing captures.** Fable refines the wording of tasks 1 to 3 (and the intro/conclusion question) on the tuning clips only (clips 1 to 22 of the 43-clip set), as in experiment 6. Everything is measured on material never used for tuning: clips 23 to 43 of the 43-clip set and the 11-clip set.
2. **Two arms, same captures, same tutor step.**
   - **Today:** the product as it is (Jev dedupe, product boundary wording, every kept frame and every earlier claim sent).
   - **Scoped Jev:** tasks 1 to 3 on top of dedupe, with the wording fixed before the run.
3. **The tutor's step.** The product's own `interpretTask` (Opus 5.5, effort high) prepares each chunk in both arms.
4. **What is measured.** Per arm: tutor input and output tokens (images and text separately), frames and earlier claims sent, interpretation calls, wall time, notional cost at the flow doc's Opus prices; Jev calls and latency.
5. **Quality.** Derek rates the two prepared reviews blind, topic by topic: better, same, or worse. Every claim citing a frame that task 1 removed is listed. The claim check runs on both arms.
6. **Routing for task 3 (ADOPTED for this experiment).** Close when new concept and stopping point are both yes, OR when new concept is yes and the intro/conclusion question is yes. Clip joins add nothing by themselves.

## Bars (ADOPTED 2026-11-05, set before any result)

- The scoped-Jev arm sends the tutor at most 50% of the Today arm's input tokens.
- Derek rates it the same or better on at least 80% of topics.
- No claim in the scoped-Jev arm loses a frame it needed (each case Derek marks as needed counts against it).

## Budget (ADOPTED 2026-11-05)

- Claude: Fable refining wording, 3 rounds, about 6 calls; tutor interpretation, about 30 calls per arm, ceiling 80 in all.
- Jev: tasks 1 and 2 at about one call per kept frame and per earlier claim per chunk, boundary questions per window, tuning rounds included; ceiling 4,000.

## Build prerequisites (none built yet)

- Jev tasks 1 and 2 and the intro/conclusion question as product-style tasks with versioned wording, and the task-3 routing as an experiment-only option.
- Fable wording refinement for these questions on clips 1 to 22 (extending the experiment 6 optimizer and its held-out guard).
- An interpretation runner that prepares the same chunks in both arms with the product's `interpretTask`, records tokens (images and text separately), frames and claims sent, calls and time, with Claude-call rails (ceiling 80) and Jev rails (ceiling 4,000).
- A blind side-by-side rating sheet for Derek, topic by topic, listing every claim whose frame task 1 removed.

## Open choices for Derek

- The false-close tolerance as a product rule, in Derek's words (his note, 2026-11-05: "honestly probably fine. the user may choose to review on a topic change anyways"). Not written as a rule until he states it.
- Whether the tutor should be Sonnet 5.5 in a later run (experiment 4 compares Sonnet and Opus).

## What it does not show

Learning effectiveness, other courses or lecturers, or accuracy beyond Derek's blind rating.
