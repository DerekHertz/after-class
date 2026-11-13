/**
 * The product's Jev setup: wordings, verdict thresholds, window sizes and routing.
 *
 * Source and approval: experiment 7, arm fable-1, round 1 (docs/experiments/07-jev-saves-the-tutor.md; the lab arm
 * config data/lab/lab-run-2/exp7/opt-fable-1-r1/arm-config.json, whose strings are copied here byte for byte).
 * Derek, chat 2026-11-06: "Yes, use round 1". Amendment text: docs/flows/after-class.md section B.
 *
 * frameRelevance and claimRelevance are NOT here and not in the product (they removed under 1% of frames in the
 * experiment and would add calls). Their tasks were retired with the lab tooling on 2026-11-13.
 *
 * The baseline wording QUESTIONS (version "1"), THRESHOLDS (0.7/0.3) and SEGMENTATION_DEFAULTS (30 s) are unchanged.
 */
import type { SegmentationConfig } from "./segmentation";
import type { RoutingOptions } from "./segmentation";

export const PRODUCT_JEV_SETUP = {
  /** Wording version label: distinct from the lab's "1" drafts, part of every product task version and memo key. */
  version: "exp7-fable-1-r1",
  questions: {
    newConcept:
      "Does state.passage itself switch to a different main subject from the one state.context was teaching: a different system, paper, module or theme, usually opened after state.context wrapped up the previous subject with a conclusion, or announced as what this lesson or module will cover? Answer no if the passage is the next section, mechanism, layer, component, implementation detail, example, history, quiz or recap of the subject in state.context, or if state.context already began or announced this subject (such as 'now let's look at X' or 'as I mentioned'): then any switch happened earlier.",
    stoppingPoint:
      "Could a review chunk end at the end of state.context without cutting a thought in half? Answer yes if state.context finished its point (a conclusion, summary, recap, transition, preview of what comes next, or a completed explanation), or if state.passage starts something new rather than completing what state.context left open. A final caption that is cut off or truncated does not count as unfinished. Answer no only if state.passage directly continues a step, derivation, list, example or argument that state.context was still in the middle of.",
    teachingChange:
      "Does state.after show teaching content that state.before did not: a new slide, newly written or revealed text, a new equation, figure, diagram element, annotation or code edit (use state.captions as a hint)? Answer no if the slide content is the same and only the cursor, pointer, highlight, camera, presenter or video controls changed, or if the content merely repeats what was already shown.",
    lessonFraming:
      "Is state.passage the opening of a lesson or module (a greeting, an announcement of what this lesson or module will cover, or a statement of its goals), or does state.context end with the closing of a lesson (a conclusion, a summary of what was learned, a closing remark, or a pointer to what the next lesson will study)? Answer no if both are ordinary content, including a transition to the next section, step or mechanism inside the same lesson.",
  },
  thresholds: { yesAtOrAbove: 0.5, noAtOrBelow: 0.3 },
  segmentation: { windowNewS: 45, contextS: 120, timeCapS: 480, maxFramesPerWindow: 2, reviseOnNextNoNo: false } satisfies SegmentationConfig,
  /** New concept yes + stopping point yes, OR new concept yes + lesson framing yes, closes the chunk. */
  routing: { lessonFramingCloses: true } satisfies RoutingOptions,
} as const;
