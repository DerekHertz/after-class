---
created: 2026-11-02
status: research-complete-no-probe
project: After Class
tags: [jepa, v-jepa, vl-jepa, preprocessing, semantic-segmentation]
---
# JEPA preprocessing assessment for After Class

Research checked November 2, 2026. This is a source review and proposed design, not a live model benchmark or an implementation decision. No models were downloaded, installed, trained, or invoked. Runtime, GPU memory, accuracy, and cost for our lecture workload are unknown, not zero.

## Conclusion

JEPA can contribute to preprocessing, but **a visual change is not a teaching-topic change**. Start the MVP with transcript-led semantic boundary judgments, supported by visual evidence. Keep V-JEPA as an optional visual-feature experiment. VL-JEPA is particularly relevant research for streaming semantic representations, but usable official weights were not verified.

The user's objection is correct: deciding that the subject changed requires semantic interpretation. The useful product distinction is **limited online interpretation for segmentation** versus **deeper analysis of a completed watched chunk for tutoring**. Calling both preprocessing does not remove the interpretation involved. This is an architectural recommendation, not a settled user decision about adopting JEPA.

## What JEPA does

JEPA means Joint Embedding Predictive Architecture. In visual variants, an encoder represents observed image/video content as vectors; a predictor learns to estimate representations of hidden content. Training compares representations rather than reconstructing every pixel. Features can support downstream tasks, but an encoder is not automatically a conversational tutor or a calibrated topic-boundary detector. The original V-JEPA implementation explicitly separates its visual feature learning from text and pixel reconstruction. [Original V-JEPA repository](https://github.com/facebookresearch/jepa)

V-JEPA 2 uses video/image pretraining and supports visual understanding, anticipation, and additional action-conditioned robotics training. Its reported video-question-answering results involve **alignment with a language model**, rather than assuming the unaligned encoder answers language questions. Robotics planning is not needed for After Class. [V-JEPA 2 paper](https://arxiv.org/abs/2506.09985)

## Current relevant variants and availability

| Variant | Verified capability or artifact | Implication for After Class |
| --- | --- | --- |
| V-JEPA 2 | Visual encoder/predictor and task-specific probes | Candidate visual representations; needs a boundary rule or trained probe |
| V-JEPA 2.1 | Latest official V-JEPA release found in this review; stronger dense spatial/temporal features | More appropriate visual candidate than assuming the original 2025 release is latest |
| VL-JEPA | Vision-language research that predicts target-text embeddings from visual input and a text query | Closer conceptual match for streaming semantic monitoring; deployment availability unresolved |

The official repository announces V-JEPA 2.1 on March 16, 2026 and lists direct checkpoints for 80M, 300M, 1B, and 2B encoders at 384-pixel resolution. PyTorch, timm, and einops are listed; CUDA is strongly recommended. Its released probes address actions and anticipation, not lecture-topic segmentation. Repository HEAD verified with `git ls-remote`: `204698b45b3712590f06245fbfba32d3be539812`. [Pinned official README](https://github.com/facebookresearch/vjepa2/blob/204698b45b3712590f06245fbfba32d3be539812/README.md)

The V-JEPA 2.1 paper was submitted March 15 and revised June 11, 2026. It adds dense predictive losses, supervision at intermediate layers, and image/video tokenizers. Its evaluations cover recognition, spatial tasks, anticipation, and robotics; these establish relevant representation capabilities, not tested lecture segmentation, equation reading, or learner diagnosis. “Multi-modal” here includes images and videos; it does not establish audio transcription or transcript interpretation. [V-JEPA 2.1 paper](https://arxiv.org/abs/2603.14482)

VL-JEPA predicts semantic text embeddings rather than generating every answer token. Its paper describes sliding-window semantic streams and selective text decoding when embeddings change. It reports roughly 2.85 times fewer decoding operations in its experiment; that is not a demonstrated end-to-end cost or latency improvement for After Class. Neither the visual stream nor a query replaces capturing the lecturer's spoken content. [VL-JEPA paper, sections 2 and 4.6](https://arxiv.org/html/2512.10942v2)

Release check: the author-named `delong-chen/VL-JEPA` Hugging Face repository is manually gated and marked with a noncommercial research license. Its public metadata listed only `.gitattributes` and `README.md`, zero used storage, and no inference provider. This review did **not** verify downloadable official trained VL-JEPA weights or a working official inference package. A repository bearing the name is not proof of model availability. [Model page](https://huggingface.co/delong-chen/VL-JEPA), [public model metadata](https://huggingface.co/api/models/delong-chen/VL-JEPA)

## Why subject change is harder than scene change

These are our application requirements and counterexamples, not claims of failures measured in the papers:

| Observation | Plausible interpretation | What a review trigger needs to determine |
| --- | --- | --- |
| Slide changes; lecture continues a derivative example | Visual boundary | Same concept may still be developing |
| Same slide; lecturer switches from independence to conditional independence | Little visual change | A meaningful semantic transition may have occurred |
| One minus sign or quantifier changes | Small visual difference | A critical reasoning step may need preservation |
| Topic changes briefly for an analogy, then returns | Semantic difference | The prior teaching unit may still be incomplete |
| A second short video continues the same derivation | File boundary | Review may be better after the derivation finishes |

Embedding distance can supply a **candidate transition score**; it does not inherently encode “a useful stopping point for this learner.” A threshold would require lecture-specific evaluation and potentially a supervised probe. Visual compression may lose tiny but consequential symbols: this is a risk to test, not a demonstrated universal weakness of JEPA. Retain readable original frames and aligned transcript passages regardless of feature selection.

## Proposed place in the pipeline

```text
[code] Capture watched intervals, caption/ASR passages, and timestamped frames.
[code] Detect inexpensive visual changes; retain uncertain teaching frames.
[optional V-JEPA encoder] Extract clip features to propose visual transition candidates.
[Jev or another tested semantic model] Judge adjacent transcript windows and needed visual context:
    Is the discussion moving to a different concept?
    Has the preceding explanation reached a useful stopping point?
[code] Combine those judgments with duration and cooldown rules.
    Uncertain: keep collecting; use the agreed time fallback.
    Boundary accepted: close a chunk and prepare its interpretation job.
[reasoning model] Interpret the completed watched chunk with source references and capture gaps.
[retrieval/search] Load connected resources separately; link each to lecture concepts.
[user] Accept a review invitation; choose whether to take any prerequisite detour.
```

Jev is a proposed narrow judgment component, not a proven lecture segmenter. V-JEPA produces visual features rather than Jev-style typed probabilities; replacing one with the other requires additional logic. Ordinary model calls also do not load a persistent tutor's memory by magic: code stores evidence, prepares requests, and versions reusable results. A tutor needs a compatible visual model or trained adapter to consume JEPA tensors; appending their raw numbers to a text prompt is not meaningful visual grounding.

For the MVP, cache reusable source evidence and derived preprocessing by source identity/version, watched intervals, and processing configuration. Keep personal explanations and learning state separate. Cache keys and invalidation remain design work; repeated viewing is not permission to treat unwatched intervals as learned material.

## A bounded experiment before adopting JEPA

Recommended first corpus: 12–20 short lectures with slides, handwriting/equations, code edits, and demonstrations. Include at least one continuous topic across multiple clips and a semantic transition on an unchanged slide. Annotate useful review boundaries as acceptable intervals, not one supposedly perfect timestamp. Separately annotate visual steps whose loss would damage explanation.

Compare the same watched material across:

1. Video boundaries/time fallback plus inexpensive visual differences.
2. Transcript embeddings for candidates plus a narrow semantic boundary check.
3. The same semantic check with transcript and selected readable frames.
4. Arm 3 plus frozen V-JEPA 2.1 features, starting with the smallest suitable checkpoint.

The semantic checker can include Jev if approved for a live probe; use the same task definition and held-out lectures. Measure false/early review invitations, missed useful boundaries, detection delay, important visual-step retention, processing time, and total resource use. Keep a tuning split separate from evaluation. Set numerical acceptance criteria before the run. Adopt JEPA only if it adds useful performance at an acceptable measured cost; a richer representation alone does not justify another service.

## Implementation detail to verify before any probe

At the pinned repository SHA, `src/hub/backbones.py` sets its checkpoint base URL to `http://localhost:8300`, with the public download URL commented out. The code also defaults to 64-frame inputs and returns encoder/predictor modules. A future implementer should verify this loader path and use explicit verified checkpoint loading rather than assuming the README Hub example works unchanged. This was a source inspection, not an executed failure. Exact runtime memory depends on resolution, clip length, batch size, precision, and the module used; no hardware sizing claim is established here. [Pinned backbone implementation](https://github.com/facebookresearch/vjepa2/blob/204698b45b3712590f06245fbfba32d3be539812/src/hub/backbones.py)

## Decisions still open

No JEPA dependency is approved by this note. Still to settle: supported capture/browser path, semantic-boundary model and input scope, boundary tolerance and duration fallback, source retention, resource-search limits, cache invalidation, and the probe budget. The user already accepted limited boundary checks during viewing; on resumption, select the model and evidence contract for those checks rather than re-asking that settled principle. Grilling remains paused until the user resumes it.
