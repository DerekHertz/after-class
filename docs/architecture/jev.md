# Is Jev worth keeping?

Status: written 2026-11-13 against `master` at `476d2a4`, for Derek to decide. No paid or live call was made for this review. No product code changed. The approved flow and R1 to R19 in `docs/flows/after-class.md` are unchanged.

Derek's question, verbatim: "is jev worth keeping? can what it does be written in code?"

## Recommendation

Keep Jev for now, and do not replace it task by task.

- Plain code cannot do any of the three Jev tasks on the evidence in the repo. For two of them the repo has no evidence either way. For boundaries, the one code rule the labels allow me to score is worse than Jev.
- Claude can take over the boundary questions and the claim check for a few dollars. Nothing in the repo measures Claude on either task.
- Frame dedupe decides the vendor. It is 88% of Jev's calls and 91% of its tokens in Derek's own use, and it is Jev's only measured pass. Claude would cost more to dedupe frames than the dedupe saves. While frame dedupe stays on Jev, the key, the rate limit and the terms conversation stay too, so moving the other two tasks removes no vendor.
- The fact that should settle it is TypeSafe's price. Jev read 26.9 million input tokens in five days of one person's use, 8 times what Claude read, and every one of those tokens is stored at unknown cost.

Two steps come before a final answer, and neither needs a paid model call.

1. Derek asks TypeSafe for price, rate limits and terms for serving other users. `plan.md` already lists this conversation.
2. With Derek's OK, an agent scores a code-only frame deduper against the signed labels and the stored lab frames. It is the only way to learn whether code can do the task that decides the vendor.

Then the rule is short. If TypeSafe's answer is acceptable, keep all three tasks on Jev. If it is not, or if the code deduper passes the frame bars, drop Jev whole. Frame dedupe then goes to code, and the boundary questions and the claim check go to Claude after one small paid comparison that needs Derek's OK.

## Per-task verdicts

| Task | What it decides | Plain code | Claude instead | Verdict |
| --- | --- | --- | --- | --- |
| Boundary, three questions per window | Whether a chunk closes at a topic change | No. Closing at every clip join gives 4.19 false closes per 15 min on the held-out clips, worse than every Jev arm. | Possible and cheap. Unmeasured. | Keep while Jev stays. First to move if Jev goes. |
| Frame change | Whether a candidate frame is new teaching content or a duplicate | Untested. Free to test offline. | Possible, but costs more than the dedupe saves. | Keep. This task decides the vendor. |
| Claim support | Whether a claim passed the evidence check that R3 requires | No. Code already checks references and cannot judge meaning. | Possible and cheap. Unmeasured, and the checker would share a vendor with the writer. | Keep while Jev stays. Move to Claude if Jev goes. Accuracy is unmeasured on both. |
| Topic grouping, draft PR #169 | Whether two topics are the same concept | The draft says looser string matching also merges distinct topics. Untested. | Possible. Unmeasured. | Not built. Hold approval of #169 until this decision. |

## Where Jev runs today

`src/backend/providers/jev.ts` is the HTTP adapter. `src/backend/providers/jev-tasks.ts` holds the three tasks, and `src/backend/jev-setup.ts` holds the wording, thresholds and routing that Derek approved on 2026-11-06. `buildTasks` in `src/backend/main.ts` wires them. Replay mode builds no Jev client.

### Boundary

- Input: about 120 s of caption context, about 45 s of new captions and at most 2 frames.
- Output: a probability for each of new concept, stopping point and lesson framing. Code turns each into yes, no or uncertain at 0.5 and 0.3.
- Use: `planChunks` in `src/backend/segmentation/core.ts` closes a chunk on yes and yes, or on new concept yes and lesson framing yes. Anything else continues, and the 8 minute time cap closes the chunk instead. A boundary close may invite a review.

### Frame change

- Input: the previous kept frame, the candidate frame and the captions within 15 s.
- Output: one probability. Yes keeps the frame, no hides it, and uncertain keeps it.
- Use: `src/backend/evidence/index.ts` asks once per candidate that the extension's pixel diff proposes. Kept frames go to the interpretation model as images and become the evidence the tutor can show.

### Claim support

- Input: one claim, its assumptions, its cited passages and its cited frames.
- Output: one probability, read at 0.7 and 0.3.
- Use: `src/backend/preparation/index.ts`. Yes marks the claim `supported_by_check`. No or uncertain sends it to one Claude revision and one recheck, then to unverified. R3: "A claim can be used to judge my answers only if it passed the evidence check."

## Evidence

### Lab results

All boundary and frame numbers come from one 43-clip set of one course, labelled by Derek, with `jev-1.13.0`. The bars are quoted from the flow doc. The held-out half is clips 23 to 43.

| Run | "≥70% of labeled boundaries detected within ±60s" | "≤1 false close per 15 min" | "≤1 important visual step lost per lecture" | "≥50% duplicates dropped" |
| --- | --- | --- | --- | --- |
| Experiment 2 run 2, baseline wording | 2 of 5, FAIL | 0.559, PASS | 0 of 13, PASS | 91.3%, PASS |
| Experiment 6, Opus wording | 2 of 5, FAIL | 1.118, FAIL | 0 of 13, PASS | 56.4%, PASS |
| Experiment 6, Fable wording | 5 of 5, PASS | 3.073, FAIL | 0 of 13, PASS | 91.0%, PASS |
| Experiment 7 round 1, the product setup | 4 of 5, PASS | 1.118, FAIL | 0 lost, PASS | 65.3%, PASS |

- No configuration passed both boundary bars. The product runs the last row on Derek's word, "Yes, use round 1", and the flow doc records that the false-close bar fails.
- Every configuration passed both frame bars. Frame dedupe is the only Jev task with a measured pass.
- Experiment 7's row reuses clips that experiments 2 and 6 had already scored, so it is not a clean held-out result. The experiment doc says so.
- Lab latency was 347 to 436 ms at p50 and 660 to 1,003 ms at p95 across the scored runs.
- Experiment 3, the claim-check audit, has no results file under `docs/experiments/`. `docs/trail/handoff-1.md` lists it as work still to do. Nobody has measured whether Jev's claim check is right.

Sources: `docs/experiments/02-jev-lab.md`, `06-model-optimized-jev.md` and `07-jev-saves-the-tutor.md`.

### Derek's own use, 6 to 11 November

I read these numbers on 2026-11-13 from a scratch copy of the live database in `~/afterclass-data`, then deleted the copy. They are live product data from two captures. The usage numbers group `usage_events` by `provider`, `purpose` and `outcome`. The verdict counts group `memo.output_json` by purpose, and the close counts group `chunk_revisions` by `provenance`.

| Jev task | Calls that finished | Input tokens | Mean call time | Verdicts |
| --- | --- | --- | --- | --- |
| Boundary | 207 | 1,387,947 | 739 ms | 5 chunks closed at a boundary |
| Frame change | 4,582 | 24,578,853 | 684 ms | 3,468 no, 659 uncertain, 455 yes |
| Claim support | 440 | 955,366 | 418 ms | 403 yes, 37 uncertain, 0 no |

- Jev finished 5,229 calls and read 26,922,166 input tokens. Twelve more frame calls were aborted. Every call is stored with cost unknown, as R17 requires.
- Claude made 218 calls in the same days and read 3,224,129 input tokens at a notional $33.66.
- Of 25 chunk closes, the time cap made 18, Jev's boundary answers made 5 and the end of a session made 2. The 207 boundary calls decided one close in five.
- Jev hid 76% of candidate frames. Nobody has audited whether a hidden frame was a teaching step in this data.
- The claim check never answered no. It answered yes on 92% of checks and uncertain on the other 37, and Claude ran 26 claim revisions. No audit says whether any of the 403 passes is wrong.

### Can plain code do it?

- Boundary. The repo holds no run of a code rule. The labels allow one piece of arithmetic. All 5 held-out boundaries sit at clip starts, and the held-out half has 20 clip joins. Closing at every join would detect 5 of 5 and make 15 false closes in 3,221 s, which is 4.19 per 15 min against a bar of 1. That is my arithmetic from the label positions in `02-jev-lab.md`, not a scored run. Derek also said of topic changes inside a clip, "this may not be true for longer lectures!", so a join rule has nothing to offer on a single long video. The time cap is the code path that already exists, and it already makes most closes.
- Frame change. The extension's pixel diff is the code that exists, and it is the source of the duplicates. The held-out half has 424 labelled duplicates and 13 labelled steps among its candidates. No experiment tried a stricter deterministic deduper, so there is no evidence for or against one. The signed labels and the frames are still in `data/lab`, and the lab scripts are at commit `1817f06`, so a code deduper can be scored against the same two frame bars with no paid call.
- Claim support. `src/backend/preparation/core.ts` already checks in code that every reference exists, lies in the chunk and that a visual claim cites a frame. Whether the cited words support the claim is a judgment about meaning. The repo has no code rule for it and no evidence that one could work.

### Can Claude do it?

`src/backend/providers/claude-api.ts` already sends images and returns output checked against a schema, so nothing blocks the plumbing. What the repo lacks is any measurement of Claude on these three questions.

- Accuracy is unmeasured for all three. Opus and Fable proposed the labels that Derek then verified, so scoring their proposals against those labels would flatter them. It would not be a fair test.
- Latency is unmeasured for a short structured call. Experiment 8 measured the time to the first streamed text of a tutor turn at a median of 4,442 ms on Opus and 1,334 ms on Sonnet. Jev's lab p50 was about 400 ms for a whole answer. Preparation runs in the background, so latency matters less than cost here.
- Jev returns a probability, and the product's thresholds and its uncertain band depend on that number. A schema can make Claude answer yes, no or uncertain, or state a confidence. Whether that confidence means anything is unmeasured.

Cost, at the list prices in the flow doc, $2 per million input tokens for Sonnet 5.5 and $4 for Opus 5.5. These figures apply Jev's reported token counts to Claude's prices. The two providers count tokens differently, so read them as rough sizes. The repo records no price for a smaller Claude model.

| Task, five days of Derek's use | Sonnet 5.5 input | Opus 5.5 input | Jev |
| --- | --- | --- | --- |
| Boundary, 207 calls | about $2.78 | about $5.55 | unknown |
| Frame change, 4,582 calls | about $49 | about $98 | unknown |
| Claim support, 440 calls | about $1.91 | about $3.82 | unknown |

Frame dedupe on Claude does not pay for itself. Experiment 7 estimated that dedupe cut the frames sent to interpretation on the 43-clip set from about 1.05 million tokens to about 110,000, at an unmeasured 1,200 tokens per image. That saving is about $3.76 of Opus input. Judging the same 872 frames on Sonnet, two images per call, would cost about $4.19 by the same image estimate before any captions, or about $9.35 by Jev's token counts. So the frame task has two sensible homes, Jev at a low price or code.

## What switching costs

Moving one task to Claude:

- A new task in the same `Task` shape with `provider: "claude"`, its own prompt and schema, and a new version string. The memo keys on the version, so stored Jev judgments stay readable and are never served for the new wording.
- `buildTasks` in `src/backend/main.ts` changes one line per task.
- The scheduler allows 4 Jev calls and 2 Claude calls at once. Frame checks at this volume would queue behind interpretation, and `decision.md` wants a share of the Claude limit held for live tutor turns.
- The claim verdict's `reason` field is `"jev" | "invalid_refs" | "error"` in `src/shared/domain.ts` and `src/shared/wire.ts`. Stored rows carry `"jev"`, so a new value is added and the old one stays.
- `grep -rlE 'provider: "jev"|JevClient|jev-tasks|jev-setup'` finds 8 TypeScript files under `src` and 12 files under `test`.

Dropping Jev whole also removes `jev.ts`, `jev-tasks.ts`, `jev-setup.ts`, `TYPESAFE_API_KEY` handling in `main.ts` and `docs/research/jev-api.md`. The `provider` check in `db.ts` can keep `'jev'` for old rows.

Flow and rules:

- No rule from R1 to R19 names Jev. R3 speaks of "the evidence check" and R17 covers any paid call, so no rule text changes.
- The flow doc has 5 lines tagged `[Jev]`, the 2026-11-06 amendment that quotes four Jev wordings and the thresholds, the Live-call scope sentence about `TYPESAFE_API_KEY`, and pass bars 2 and 3. Each needs an amendment that Derek approves. The wordings were tuned for Jev, and nothing shows they suit another model.
- `docs/flows/model/Preparation.tla` names Jev in comments and in two action names. The model lets a Jev step "give any answer the flow allows", so its behaviour does not change. `model/check.sh` is rerun after any flow amendment.
- The PRD and `decision.md` name Jev and need their lines updated.

Experiments that would need a run, each paid and each needing Derek's OK:

- A Claude arm on the 43-clip held-out half for the boundary and frame questions. Experiments 2, 6 and 7 have already scored that half, so the result would be a reuse and not a clean held-out test. A clean test needs newly captured and labelled lectures.
- The claim-check audit of experiment 3, which has never run for any checker.
- The lab scripts were removed from `master` after `1817f06`. A Claude arm has to be built on that commit.

The code deduper test is the exception. It makes no model call.

## The hosted product

For dropping Jev:

- One fewer key in Secrets Manager, one fewer organisation rate limit to share across workers, and one fewer vendor that can block launch. `plan.md` lists as a risk that "A provider's terms or limits do not allow serving other users."
- One fewer third party in the privacy notice. `decision.md` says TypeSafe receives captions and frames.
- A known price. Derek pays for model calls within a cap, and the budget gateway in phase 7 has to reserve against a cost. Jev's cost is unknown, and `plan.md` says "Unknown cost keeps its reservation." At 26.9 million input tokens per user per five days, an unknown price is the largest open number in the spend plan.
- Jev's image path needs the header `TypeSafe-Danger-Zone-Images`, and `docs/research/jev-api.md` records that TypeSafe says multimodal accuracy is lower than text-only. Frame checks are the bulk of the use.

For keeping Jev:

- It is built, tested and wired. Nothing in phases 0 to 8 needs Jev to change beyond the shared limiter and the user column that every provider gets.
- It is the only provider with a measured pass on any preprocessing task.
- It keeps 5,000 small calls per user off the Anthropic rate limit that the tutor turn depends on.

The resume angle is my opinion and not evidence. The asset is the pre-registered evaluation in experiments 2, 6 and 7, with signed labels, held-out halves and published failures. That work does not depend on which vendor answers. A comparison of Jev, Claude and plain code on the same labels would show more engineering judgment than either "uses a typed-judgment API" or "uses one vendor".

## What Jev gives that is hard to replace

- A probability per question. The yes threshold, the no threshold and the uncertain band between them drive three safe defaults in the flow. Uncertain boundaries continue, uncertain frames are kept and uncertain claims go to revision.
- An answer in about 400 ms with nothing to parse or repair. Lab runs made 1,080 and 2,889 calls with none failed.
- Several independent questions over one state in one request. The boundary task asks three and sends the frames once.
- A checker from a different vendor than the model that wrote the claim. Whether that independence catches more errors is unmeasured.

## Unverified

- TypeSafe's price, rate limits and terms. Nobody has asked.
- Claude's accuracy, latency and cost on any of the three tasks. The dollar figures above apply one provider's token counts to another's prices.
- Any code deduper's result on the frame bars.
- The accuracy of the claim check, for Jev or anything else. Zero no answers in 440 checks could mean the claims are good or the check is lenient.
- Whether a boundary close makes a better review than a time-cap close. The lab scored agreement with labels, not learning.
- Anything outside one computer-science course, one labeller and `jev-1.13.0`.
- The live numbers cover two captures by one user. They are not a forecast for other users.
