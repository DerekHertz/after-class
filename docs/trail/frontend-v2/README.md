# Reference fidelity correction

This supersedes the original frontend artwork in the first implementation stack. PR #42 is the visual source; Derek owns final visual approval on base PR #44. Nothing here authorizes merging or deployment.

## Preview

Use branch `codex/reference-fidelity` and run:

```sh
bun scripts/preview-ui.ts
```

Open http://127.0.0.1:8770/?scenario=review&clean=1 for the reference composition. Omit `clean=1` for scenario controls, simulated speech and the fake request ledger. This is the actual React UI and controllers with deterministic API data, not a live lecture or microphone session. No provider calls are made by the preview.

## Visual evidence

- [Paired full view](comparison-final.png): approved composition on left, revised browser UI on right, both normalized to1440×1024.
- [Paired character and typography detail](focused-comparison.png).
- [Last Desk](last-desk.png), [Projection Booth](projection-booth.png), [Study Bench](study-bench.png).
- [Mobile example](mobile-study-bench.png), [all room widths](mobile-checks.json), [scroll reachability](mobile-scroll-checks.json).
- [Root design QA](../../../design-qa.md) records iteration findings and fixes. Technical QA passed; this is not Derek's visual approval.

## What changed

The simplified vector room and companion drawings were replaced by fifteen transparent raster assets: six detailed companions and nine stage, paper and physical-control assets. Real text, evidence, inputs, buttons, links and scroll surfaces remain DOM. No full-screen mockup or invisible hitbox replacement is used.

Assets were generated with built-in imagegen, using the approved room and mascot studies. Prompt manifests are in [scene assets](../../../src/app/assets/scenes-v2/prompts.json), [companion batch A](../../../src/app/assets/companions-v2/prompts-a.json) and [batch B](../../../src/app/assets/companions-v2/prompts-b.json). Every production PNG is in those two directories; no Higgsfield generation jobs or new packages were used. Young Serif and DM Sans are self-hosted; upstream Feather controls retain MIT attribution. Production `/app/asset-notices.txt` carries all original notices.

The [Tinycharts reference](https://april-zhu.com/tinycharts) was inspected in the browser ([capture](tinycharts-reference.png)). Its state-driven illustrated scene informed interaction placement. This implementation uses its own generated assets, not copied Tinycharts artwork. Hover lift, perspective tilt, contact shadows, pressed physical keys and listening/saving character poses create depth; reduced motion disables these transforms. This remains a layered 2D interface, not a rotatable 3D world or equivalent Tinycharts animation system.

## Verification

- Full suite: 941 pass, 4 existing TODOs, 0 fail; typecheck, production app, extension and fixture builds pass.
- Independent exact-head code audit of68fc3c8:99 focused tests/357 assertions, PNG decoding/alpha, all18 production CSS asset URLs, controller continuity, action validity and speech ownership passed. Its missing MIT packaging finding was fixed; independent follow-up verified all original notices and real HTTP200 text/plain delivery.
- Independent visual fix-round found no remaining actionable P0/P1/P2 in the supplied desktop comparisons. Earlier Booth transcript overlap was fixed by shortening the content viewport above the projector reel.
- [All18 appearance combinations](combination-checks.json) retained the typed draft without extra API reads. Physical recorder and Composer share one simulated speech start/stop lifecycle.
- All three rooms had390px page width at390px viewport. Both clipped mobile regions scroll to their endpoints; dialogue189px, evidence162px. Browser console had no errors.
- Earlier controller checks remain documented in [the original verification guide](../frontend/README.md): pinned evidence, streaming, identical retry IDs, save recovery and notebook edits. Real microphone permissions, captured lectures and provider behavior remain unverified.

Expected source differences: fixture dialogue includes an extra explanation; citations follow actual backend evidence, so no timestamp is invented on a follow-up. Empty submission stays disabled. The generated fixture lecture diagram is explicitly labeled illustrative. Shared later component proportions apply across the three skins.

P3 follow-up: faint idle companion text and a redundant lower source label can be simplified on narrow screens. Essential status/actions remain available in the main controls. Final visual acceptance is Derek's.

Swarm slices covered asset production, faithful layout, independent code verification and independent visual comparison. Agents inherited the available parent model; model diversity and per-call dollar costs are unavailable in this runtime.
