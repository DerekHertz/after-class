# Reference fidelity correction

For the newer tactile controls, living mascot and UI consistency review, see [the motion follow-up](../frontend-motion/README.md).

This correction replaces the original frontend artwork in the first implementation stack. PR #42 is the visual source, and the owner gives final visual approval on base PR #44. Nothing here authorizes merging or deployment.

## Preview

Use branch `codex/reference-fidelity` and run:

```sh
bun scripts/preview-ui.ts
```

Open http://127.0.0.1:8770/?scenario=review&clean=1 for the reference composition. Omit `clean=1` to get scenario controls, simulated speech and the fake request ledger. The preview runs the real React UI and controllers with deterministic API data, not a live lecture or microphone session. It makes no provider calls.

## Visual evidence

- The [paired full view](comparison-final.png) shows the approved composition on the left and the revised browser UI on the right, both normalized to 1440×1024.
- [Paired character and typography detail](focused-comparison.png).
- [Last Desk](last-desk.png), [Projection Booth](projection-booth.png), [Study Bench](study-bench.png).
- [Mobile example](mobile-study-bench.png), [all room widths](mobile-checks.json), [scroll reachability](mobile-scroll-checks.json).
- [Root design QA](../../../design-qa.md) records the findings and fixes from each iteration. Technical QA passed. That is not the owner's visual approval.

## What changed

Fifteen transparent raster assets replaced the simplified vector room and companion drawings. They are six detailed companions and nine stage, paper and physical-control assets. Real text, evidence, inputs, buttons, links and scroll areas stay DOM. The work uses no full-screen mockup and no invisible hitbox in place of real controls.

The built-in imagegen tool generated the assets from the approved room and mascot studies. The prompt manifests are in [scene assets](../../../src/app/assets/scenes-v2/prompts.json), [companion batch A](../../../src/app/assets/companions-v2/prompts-a.json) and [batch B](../../../src/app/assets/companions-v2/prompts-b.json). Every production PNG is in those two directories. The work used no Higgsfield generation jobs and no new packages. Young Serif and DM Sans are self-hosted, and the upstream Feather controls keep their MIT attribution. Production `/app/asset-notices.txt` carries all original notices.

The [Tinycharts reference](https://april-zhu.com/tinycharts) was inspected in the browser ([capture](tinycharts-reference.png)). Its state-driven illustrated scene guided where interactions sit. This implementation uses its own generated assets and copies no Tinycharts artwork. Hover lift, perspective tilt, contact shadows, pressed physical keys and listening and saving character poses add depth, and reduced motion turns these transforms off. The result is still a layered 2D interface. It is not a rotatable 3D world, and it does not match the Tinycharts animation system.

## Verification

- The full suite had 941 pass, 4 existing TODOs and 0 fail. Typecheck and the production app, extension and fixture builds pass.
- An independent code audit of exact head `68fc3c8` passed. It covered 99 focused tests with 357 assertions, PNG decoding and alpha, all 18 production CSS asset URLs, controller continuity, action validity and speech ownership. It found missing MIT packaging, which was fixed. An independent follow-up verified all original notices and real HTTP 200 `text/plain` delivery.
- An independent visual fix round found no remaining actionable P0, P1 or P2 in the supplied desktop comparisons. An earlier transcript overlap in the Booth was fixed by shortening the content viewport above the projector reel.
- [All 18 appearance combinations](combination-checks.json) kept the typed draft without extra API reads. The physical recorder and Composer share one simulated speech start and stop lifecycle.
- All three rooms had a 390px page width at a 390px viewport. Both clipped mobile regions scroll to their ends, dialogue at 189px and evidence at 162px. The browser console had no errors.
- [The original verification guide](../frontend/README.md) still documents the earlier controller checks: pinned evidence, streaming, identical retry IDs, save recovery and notebook edits. Real microphone permissions, captured lectures and provider behavior remain unverified.

Some differences from the source are expected. The fixture dialogue includes an extra explanation. Citations follow the real backend evidence, so a follow-up gets no invented timestamp. Empty submission stays disabled. The generated fixture lecture diagram carries an illustrative label. Later shared component proportions apply across the three skins.

One P3 follow-up remains. On narrow screens, faint idle companion text and a redundant lower source label could be simpler. The main controls still hold the essential status and actions. The owner gives final visual acceptance.

Swarm slices covered asset production, faithful layout, independent code verification and independent visual comparison. Agents inherited the available parent model. Model diversity and per-call dollar costs are unavailable in this runtime.
