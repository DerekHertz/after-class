# Mechanical-control correction

The code is at `9030574` on preview branch `codex/mechanical-controls`, above the tactile-motion PR. Final visual acceptance stays on base PR #44, and nothing here merges or deploys. To view it, run `bun scripts/preview-ui.ts`, open http://127.0.0.1:8770/?scenario=review&clean=1 and choose Study Bench. The fixture does not exercise a real microphone or provider.

## Annotation fixes

User review showed that a flattened illustration cannot move its parts independently. The fix is separate raster layers and separate native key buttons.

1. **Source control.** The machine is a paper feeder, so the sheet retracts toward the upper roller and shows the frame opening. The fixed faceplate has a Lecture source label and a chevron. The accessible actions are Roll up lecture source and Unroll lecture source.
2. **Only the red key moves.** Body and key are separate layers, and the native button covers only the key. The Bench and Last Desk keys travel 7px while listening, and bodies have `transform: none`. The Booth's orange actuator travels 3px, with a 44px target and a static Voice legend on the plate.
3. **Speak label.** The Bench Speak and Stop label sits on the key's cream insert and moves with it. The Last Desk text sits on the orange key.
4. **Mascot roaming and emotes.** Left at lower priority, as requested. The existing breathing and poses remain.
5. **Paper feed.** A later annotation asked for content to roll upward instead of a spinning side fitting, so the rotating fitting is gone. Native scrolling stays, and a 14px mask on the upper edge appears once the content scrolls, so it feeds beneath that edge. Returning to the top removes the mask. Reduced motion keeps ordinary scrolling and the immediate pressed state.

The built-in imagegen tool generated seven transparent assets, body and key pairs for three rooms plus the paperless source-machine body. The prompts are in [control layers](../../../src/app/assets/controls-v3/prompts.json) and [source body](../../../src/app/assets/controls-v3/source-body.prompt.json). Generative edits keep registration close but are not pixel-exact. All content stays real DOM.

## Evidence

The [before and after](comparison.jpg) at 1440×1024 shows the main artwork and notebook style unchanged. Captures include the [final Bench](bench-final.jpg), the [pressed key](bench-pressed.jpg), the [retracted paper](paper-retracted.jpg), [Last Desk](last-desk-pressed.jpg), the Booth on [desktop](booth-fixed-desktop.jpg) and [mobile](booth-fixed-pressed.jpg), [Bench mobile](mobile-pressed.jpg) and the [content feed edge](content-feed-edge.jpg). [Room measurements](room-checks.json) and [browser checks](browser-checks.json) hold the numbers. The roller captures, `iteration-1.jpg` and `projection-booth-pressed.jpg` record rejected versions.

## Verification

- The suite had 941 pass, 4 existing TODOs and 0 failures, and typecheck and builds passed. An independent run after the final Booth layers passed 99 focused tests with 357 assertions and the production build.
- The independent code verdict on `9030574` was PASS. All 27 emitted non-data CSS asset URLs resolve under `/app/`.
- Native button centers activated all three recorders. The Bench key translated 0px 7px with the body at `transform: none`, and the Booth key 0px 3px. The mobile Bench target is 70×58px and the Booth target 44×44px.
- Rolling the source keeps the draft and does not start speech. With Reduce motion, transitions are 0s and the paper is static. The mobile page is 390px wide at a 390px viewport, with no console errors.
- For the feed edge at 1303×954, a `scrollTop` of 744 turned on the mask with no spinning layers, and Home returned to 0 with `mask: none`. Typecheck and 49 focused tests passed.
- The independent screenshot verdict was PASS after a fix to the Booth label, with no proven P0, P1 or P2. The owner's final visual approval is still pending.
