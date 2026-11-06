# Experiment 7 (DRAFT for Derek's review): does Jev make the tutor's work cheaper without making it worse?

Status: draft, 2026-11-05. Nothing here is adopted and no call is made until Derek adopts it. Every item marked PROPOSED needs his OK.

## Why

Derek, 2026-11-05: "what can jev do cheaply so that the tutor just has to interpret. this could span various tasks. faster, reduced token use for the interpretation model (claude)", and "fable should be helping refine the input for jev".

Experiments 2 and 6 measured Jev alone against boundary bars. On the 43-clip set, Jev drops 91 to 96% of duplicate frames and loses no visual step, but no configuration passed both boundary bars; Jev with Fable's round-3 wording caught 5 of 5 held-out topic changes at about 3 extra closes per 15 minutes. This experiment asks the question that matters for the product: does Jev's preprocessing cut what the interpretation model (Claude Opus 5.5, the product default) reads and spends, without making the prepared review worse?

## Design (PROPOSED)

1. **Data.** Fresh lectures, never used in experiments 2 or 6: one playlist set of short clips (as before) and one single long lecture (Derek: titles and clip joins are not universal; "this may not be true for longer lectures!"). About 60 to 90 minutes of watched video in all, captured with the autostart build, tab visible.
2. **Two arms, same captures, same tutor.**
   - **Raw:** chunks close only on the time cap (8 min) and session end; every captured frame goes to the tutor.
   - **Jev:** the product pipeline with Jev chunking and frame dedupe, using a configuration fixed BEFORE the run: experiment 6's Fable round-3 wording and thresholds (Fable refining Jev's input, done once, offline). No tuning on the new data.
3. **The tutor's step.** The product's own `interpretTask` (Opus 5.5, effort high) prepares each chunk in both arms, through `claude -p` as usual.
4. **What is measured.** Per arm: tutor input and output tokens, frames sent, number of interpretation calls, wall time, notional cost at the flow doc's Opus prices; Jev calls and latency for the Jev arm.
5. **Quality.** Derek rates the two prepared reviews blind, topic by topic: Jev arm better, same, or worse. The claim check (experiment 3's Jev question) runs on both arms' claims and counts are reported.

## Bars (PROPOSED, set before any result)

- The Jev arm sends the tutor at most 60% of the Raw arm's input tokens.
- Derek rates the Jev arm the same or better on at least 80% of topics.

## Budget (PROPOSED)

- Claude (subscription, notional cost): about 12 interpretation calls for Raw (8-minute chunks over ~90 min) and about 25 for Jev (chunks at Jev closes), so about 40 in all, ceiling 60, plus up to 10 claim-check revisions.
- Jev: about 600 calls for chunking and frames, plus the claim checks; ceiling 1,500.

## Open choices for Derek

- The false-close tolerance as a product rule, in Derek's words (his note, 2026-11-05: "honestly probably fine. the user may choose to review on a topic change anyways"). Not written as a rule until he states it.
- Whether to add other cheap Jev tasks to the Jev arm (for example: mark quiz or talking-head stretches as low value, flag recap passages) or keep this run to chunking and dedupe.
- Sonnet 5.5 instead of Opus as the tutor in a later run (experiment 4 is that comparison).
- Whether Fable should also refine the new tasks' wording on a tuning part of the new data before the run (as in experiment 6).

## What it does not show

Learning effectiveness, other courses or lecturers, or accuracy beyond Derek's blind rating.
