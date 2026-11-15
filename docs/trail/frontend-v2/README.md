# Reference fidelity correction

For the later tactile controls and living mascot, see [the motion follow-up](../frontend-motion/README.md).

This correction replaces the original frontend artwork in the first implementation stack. PR #42 is the visual source, and the owner gives final visual approval on base PR #44. Nothing here authorizes merging or deployment. To view it, switch to `codex/reference-fidelity`, run `bun scripts/preview-ui.ts` and open http://127.0.0.1:8770/?scenario=review&clean=1. The preview uses deterministic API data and makes no provider calls.

## What changed

Fifteen transparent raster assets replaced the simplified vector drawings, six companions and nine stage, paper and control assets. Text, evidence, inputs, buttons, links and scroll areas stay DOM, with no full-screen mockup or invisible hitbox. The built-in imagegen tool generated the assets from the approved studies, and the prompts are in [scene assets](../../../src/app/assets/scenes-v2/prompts.json), [companion batch A](../../../src/app/assets/companions-v2/prompts-a.json) and [batch B](../../../src/app/assets/companions-v2/prompts-b.json). Young Serif and DM Sans are self-hosted, and `/app/asset-notices.txt` carries all notices, including the MIT notice for the Feather controls.

The [Tinycharts reference](https://april-zhu.com/tinycharts) ([capture](tinycharts-reference.png)) guided where interactions sit, and no Tinycharts artwork is copied. Hover lift, tilt, contact shadows, pressed keys and character poses add depth, and reduced motion turns them off. The result is a layered 2D interface, not a 3D world.

Evidence: the [paired full view](comparison-final.png) at 1440×1024, the [character and typography detail](focused-comparison.png), the rooms ([Last Desk](last-desk.png), [Projection Booth](projection-booth.png), [Study Bench](study-bench.png)), [mobile](mobile-study-bench.png) with [width](mobile-checks.json) and [scroll](mobile-scroll-checks.json) checks, and [design QA](../../../design-qa.md).

## Verification

- The suite had 941 pass, 4 existing TODOs and 0 fail, and typecheck and all builds pass.
- An independent audit of head `68fc3c8` passed 99 focused tests with 357 assertions, covering PNG alpha, all 18 CSS asset URLs, controller continuity and speech ownership. It found missing MIT packaging, which was fixed and then confirmed served as HTTP 200 `text/plain`.
- An independent visual round found no remaining P0, P1 or P2 in the desktop comparisons.
- [All 18 appearance combinations](combination-checks.json) kept the typed draft without extra API reads.
- At a 390px viewport all three rooms were 390px wide, and the clipped dialogue and evidence regions scroll to their ends. The console had no errors.

Expected differences from the source include an extra fixture explanation, citations that follow real backend evidence, a disabled empty submit and an illustrative label on the fixture diagram.

Not resolved or not verified:

- One P3 remains. On narrow screens, faint idle companion text and a redundant source label could be simpler.
- Real microphone permissions, captured lectures and provider behavior are unverified. [The original verification guide](../frontend/README.md) holds the earlier controller checks.
- Technical QA passing is not the owner's visual approval, which is pending.
