# Experiment 9: can Jev tell when two topics are the same concept?

Status: DRAFT for Derek. Nothing in this file is approved yet. The cases, bars, call budget and flow lines below are the agent's drafts. No call has been made, and none will be made until Derek approves this protocol. Experiment 9 is outside the five approved in `docs/flows/after-class.md`, so it needs his OK.

## Why

Issue #150. The first live review on 2026-11-11 listed 35 topics, and several were the same concept under different names. Examples are "Plumbing mapper outputs to reducers" and "Plumbing mappers to reducers", three variants of "division of labor" and "runtime heavy lifting", and "Lesson outline", which is not a concept. The long list made the review look like it had left 32 topics untouched. Cluster screening (#147) and the dependents count (#149) both need the topics grouped first.

Each chunk is interpreted on its own and the model names its own topics. Topics merge today only when their labels match exactly after lowercasing (`normalizeLabel` in `src/backend/preparation/core.ts`). Looser string matching would also merge distinct topics, such as "Map phase" and "Name-count example: input and map phase". Judging that two names mean the same concept needs a model.

Jev fits because the question is narrow and typed. It is text only, answered yes or no with a probability, and takes about half a second. It was the first of the five Jev roles proposed on 2026-11-13. It needs no rule change.

## What the product would do

1. At review start, code picks candidate pairs from the frozen scope's topics. A pair is a candidate when the two labels share a rare word, meaning one that at most 3 topics in the scope contain, after stopwords are dropped and words are crudely stemmed. A pair is also a candidate when the two topics cite passages in adjacent chunks. Pairs written by the same interpretation call are skipped, because that call already chose to keep them apart.
2. Jev answers one question per candidate pair, with the two topics' labels, summaries and claim texts as its state:

   "Do state.a and state.b teach the same single concept, so that a learner reviewing one would be reviewing the other? Answer no if one is a part, step, example or special case of the other, or if either is not a concept, such as an outline or housekeeping."

3. Two topics merge only at a probability of 0.7 or above. Anything lower stays separate, which is what happens today. A failed call also leaves the pair separate.
4. Merging is complete-link. Before two groups join, every pair across them must be a confident yes, so a chain of near matches cannot pull unrelated topics together. Pairs inside a forming group that were not candidates are asked as well.
5. The grouping is a view. Topic ids in claims, observations and the notebook are not rewritten. The checklist shows a group as one entry, and the tutor treats it as one topic.

Each answer goes through the memo, so a rerun asks only pairs it has not asked before, and each call records a usage event (R17). Jev's cost is stored as unknown, as for every Jev call today.

### Rules this touches, quoted from the flow

- R7: "Once a review starts, its scope never grows; corrections can change claims inside it but can't add material." Grouping runs on the frozen scope only, so a group can never bring in material from outside it.
- R3: "A claim can be used to judge my answers only if it passed the evidence check." A group uses only its members' claims, and the same check applies to each one.

### Issue #150's open questions, with the draft's answers

- When grouping runs: at review start, on the frozen scope, for the R7 reason above. Running it once at preparation over the whole capture could group topics outside the scope.
- Whether it drops non-concepts such as "Lesson outline": not in this experiment. The pair question answers no for a non-concept, so it stays as its own entry. Dropping non-concepts is a separate question. The importance line in the open flow amendment, PR 155, says "A topic with nothing reviewable is not shown.", which may cover it.

## Draft flow lines for section D

These would go before "[code]  Show the topics in the frozen scope as a checklist." They are drafts in the flow's format for Derek to approve or reword, and they are not in the flow doc.

```text
[code]  At review start, pick candidate pairs of topics in the frozen scope that
        may be the same concept (a shared rare word, or adjacent chunks).
[Jev]   For each candidate pair: "Do these two teach the same single concept?"
[code]  Merge a pair only on a confident yes; anything else stays separate.
        A merged group is one checklist entry. Topic ids never change.
```

## Cases

The two lectures in Derek's database that have topics today: one with 90 topics and 286 claims, which includes the 35-topic scope of the 2026-11-11 review, and one with 42 topics and 128 claims. Both are read from a read-only copy of the database. More lectures can be added once they are captured.

### Labels

Labelling every pair by hand is not practical, since the two lectures have 4,005 and 861 pairs. Instead:

1. Opus 5.5 and Fable 5.2 each read one lecture's full topic list, with each topic's summary and claims, and propose groups of topics that are the same concept. That is 4 calls in all, on Derek's subscription.
2. Derek checks every proposed group, plus every group only one model proposed, and marks each one same concept or not. He can add groups that both models missed.
3. The groups Derek confirms are the true duplicates. Every other pair counts as not the same.
4. Must-not-merge cases are fixed in advance: "Map phase" and "Name-count example: input and map phase". Derek can add more before the run.

### Split

The 90-topic lecture is the tuning set, and the 42-topic lecture is the held-out set. The question wording, the candidate filter and the 0.7 threshold may be tuned on the tuning set, for at most 3 rounds. The held-out set is scored once, after tuning stops.

## Draft bars

These are the agent's drafts, set before any run. Derek may change them before the run, and nobody changes them after.

On the held-out lecture:

- The candidate filter keeps at least 95% of the true duplicate pairs.
- At least 95% of Jev's confident yes answers are right, with at most 1 false merge in all. If Jev gives fewer than 20 confident yes answers, the result is reported as too few to judge, not as a pass.
- At least 60% of the true duplicate pairs end up merged.
- At most 20% of the candidate pairs get an answer between 0.3 and 0.7.
- No must-not-merge pair is merged.

## Calls and cost

- Labels: 4 Claude calls, on Derek's subscription with a notional cost.
- Jev: one request per topic that has a candidate pair, so at most 90 plus 42 per round, and one question per candidate pair. The candidate count is not measured yet. For the 35-topic scope of the 2026-11-11 review it is estimated at 40 to 60 pairs. Up to 3 tuning rounds on the 90-topic lecture and 1 scoring run on the 42-topic lecture.
- The per-call price of Jev is not known. TypeSafe's API returns tokens only, and the docs read on 2026-11-13 give no price. Jev's cost is therefore reported as call and token counts, not dollars.
- In the product, a review start would add one Jev request per topic with a candidate pair, and nothing during the review.

## What this does not test

- Whether a grouped checklist makes a review better. That needs a live review afterwards.
- Lectures outside the one CS course captured so far, including marketing and psychology.
- Importance ordering, cluster screening and trace questions. Those are #149, #147 and #148.

## Procedure

Not written yet. The runner does not exist. Once Derek approves the protocol above, a runner in `scripts/experiments/` will read the copy, build candidate pairs, ask Jev and score against the labels, and this section will name its command.

## Results

None. No call has been made.
