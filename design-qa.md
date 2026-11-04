# Reference fidelity QA

final result: passed

This is technical reference QA; Derek's final visual verdict remains pending on PR #44.

## Comparison target and evidence

Source visual truth: `docs/design/component-review-2026-11-03/conversation-and-source.png`, plus approved room boards and `mascot-studies-2026-11-03` in PR #42. Source composition1487×1058px normalized to1440×1024 CSS pixels; implementation1440×1024 at1× browser capture. The small source aspect adjustment is explicit. Both show active Locks & deadlocks with open evidence. All18 independent room/companion choices were exercised.

Full-view combined input: `docs/trail/frontend-v2/comparison-final.png`. Focused combined input: `docs/trail/frontend-v2/focused-comparison.png`. Implementation captures: `last-desk.png`, `projection-booth.png`, `study-bench.png` in that directory. Mobile390×844 capture: `mobile-study-bench.png` (full-page1639px); no mobile reference was supplied, so mobile checks are usability checks.

## Findings and fidelity surfaces

No remaining actionable P0/P1/P2 in final desktop evidence; independent visual verifier concurs.

- Typography: Young Serif display and DM Sans body/control fonts replace generic approximations. Reviewed hierarchy, weights, wrapping and optical scale in the combined focused crop. Native text remains selectable. Source quote/caption sizes were increased after the first comparison.
- Layout: notebook begins near95px and extends to974px at the reference viewport; illustrated evidence occupies left region with character/physical recorder on desk. Actual scroll surfaces constrain overflowing content. Mobile uses notebook-first reading order. All rooms fit390px width; keyboard End reaches remaining dialogue and evidence, confirmed by scroll endpoints.
- Tokens: warm cream paper, ochre trim, cobalt interaction and mint/indigo room palettes follow the source. Shadows preserve object grounding. Disabled empty-answer control stays muted by real action validity.
- Assets: fifteen PNGs replace custom vector room/character approximations. Detail, crop, scale and transparent edges inspected; alpha validated independently. Room-specific microphones and spring key preserve identity. Standard control icons are upstream Feather, with bundled license notices.
- Copy/content: actual API-backed dialogue and provenance remain DOM. Extra fixture explanation changes vertical density; backend does not expose total-question count or follow-up evidence, so these are not invented. The illustrative lecture frame is labeled fixture, not source art. Contract-valid hint/options stay in the existing expandable actions.

## Comparison history

1. Prior implementation used simplified SVG artwork and failed the user's reference expectation. Replaced room/companion art with generated transparent detailed assets informed by approved studies. Initial correction capture: `iteration-1-last-desk.png`; combined evidence: `comparison-iteration-1.png`.
2. First comparison found undersized character/recorder and weak typography hierarchy. Increased asset scale, adjusted title/notebook positioning, sourced fonts, increased type and applied textured paper. `iteration-2-last-desk.png` records intermediate result; final full/focused comparisons record final result.
3. Independent review found P2 Booth source text over projector reel. Shortened source viewport to36.5% and frame to170px. Revised `projection-booth.png` shows caption ending around642px before reel starts around674px. Independent fix-round verified resolution.
4. Production code review found missing shipped MIT attribution. Build now emits original MIT/OFL notices and an absolute license link. Independent real HTTP test returned200 text/plain and preserved notices verbatim. No visual change from this packaging fix.

## Interactions and limits

Actual browser checks: all18 combinations retain draft with no extra API reads; physical prop starts shared simulated speech, Composer stops it; reduced-motion preference honored; all three mobile room widths390px; both scroll endpoints reachable. Console error check returned empty. Previous streaming, retry, source pinning and save recovery evidence remains in `docs/trail/frontend/README.md`.

P3 polish: faint idle companion caption and redundant lower source label at mobile. These do not hide persistent controls. No real microphone/provider/capture run in this fixture session. Layered object hover/press depth is implemented; no claim of full3D or Tinycharts-equivalent scene motion.

## Implementation checklist

- Detailed art, transparent edges and correct room objects: complete.
- Real controls/controller continuity: complete.
- Full and focused post-fix comparison: complete.
- Narrow width and scroll access: complete.
- License output and independent follow-up: complete.
- Final visual acceptance: reserved for Derek on PR #44.

## Tactile motion follow-up (2026-11-04)

final result: passed

Code `167caaa` preserves the chosen artwork/layout and adds object motion. Fresh combined comparison: `docs/trail/frontend-motion/reference-comparison.jpg`, source 1487×1058 normalized to 1440×1024; implementation 1440×1024 at 1×. Same active review/source-open state; original fixture-content differences above still apply. The full paired input was opened and inspected. Focused character/typography comparison from the previous round remains applicable because those assets and review type/layout were preserved; the new companion motion changes pose over time only.

All five fidelity surfaces rechecked: review typography, paper/grid rhythm and palette retained; notebook now shares Young Serif/DM Sans; source/drawer/character image quality retained; actual evidence/type/time copy replaces record IDs. Fresh screenshot evidence: `docs/trail/frontend-motion/{study-bench,08-notebook,09-mobile-listening}.jpg`. Settled notebook capture confirmed opacity 1 and resolved timestamp labels. Viewports 1440×1024 desktop and 390×844 mobile; final preview override reset.

New audit findings and post-fix evidence: masthead intercepted header pointer actions (P1); pointer Pause/Resume verified after empty masthead area passed events through. Mobile recorder overlapped drawer handle (P2); final 390px center hit is source-handle, drawer opens without speech. Notebook IDs/citation ambiguity (P2); visible IDs removed in favor of actual wording/rationale, citation timestamps resolved in08-notebook. Pending notebook animation could commit after Back in a completion ordering edge (P2); independently reproduced and fixed by invalidating pending navigation before cancel.

Physical drawer/speech/cover motion, repeated-key guard, active speech shutdown on pause, draft continuity, citation focus return, manual reduced motion, all three room skins and no console errors verified. Details and fresh screenshot sequence are in `docs/trail/frontend-motion/README.md`. No remaining actionable P0/P1/P2 established by the final checks; P3 notes remain in the guide. This technical verdict is separate from Derek's final visual acceptance.

## Annotated mechanical correction (2026-11-04)

final result: passed

Source target is the five user-supplied browser annotations on PR53 at 1676×954. Fresh implementation captures in `docs/trail/mechanical-controls/` use 1676×954 and 390×844; the combined before/after `comparison.jpg` uses previous PR53 and revised Study Bench at 1440×1024, 1×CSS pixels, captured through the browser. Both active/source-open states and notebook composition match; fixture content retained. Full comparison was opened and inspected. A separate focused montage was unnecessary: both control labels/actuators are legible in this combined input, and each generated component layer and full-resolution pressed capture was additionally opened for alignment inspection.

Five surfaces: fonts/hierarchy and cream/cobalt/mint tokens retained; notebook spacing and reading rhythm retained; key/body registration and transparency inspected; actual DOM Speak/Stop label aligned to the moving cap; source copy simplified to Lecture source with explicit Roll up/Unroll accessible actions. New physical assets preserve the approved ink/grain/detail direction. New source body removes paper only; fixed posts, rollers, chassis and table remain visually registered.

Iteration findings: prior whole-device compression and floating label(P1) replaced with independent body/key layers. Copied drawer-front movement(P2) removed in favor of sheet retraction. First native button covered the full sprite canvas, so centered pointer activation missed its clipped cap(P2); native button bounds now match the key, verified by real center clicks. Paper texture modulo 128 caused a discontinuity(P2); raw scrollTop now feeds it continuously. Booth intermediate live Stop label on a fixed plate(P2) replaced by static Voice legend and an icon on its independently moving orange actuator, with 44px native target. Fresh booth-fixed desktop/mobile captures were independently rechecked.

Evidence: `bench-pressed.jpg`, `last-desk-pressed.jpg`, `booth-fixed-desktop.jpg`, `booth-fixed-pressed.jpg`, `paper-retracted.jpg`, `mobile-pressed.jpg`, `browser-checks.json`. Native scrolling updates decorative grain/roller while evidence scrolls once and the typed draft stays intact. Reduced motion removes interpolation/decorative feed. Console error list empty. Full suite 941 pass, 4 pre-existing TODOs; independent exact code head `9030574` passed 99 focused checks, typecheck/build and effect probes.

No remaining actionable P0/P1/P2 proven in the final captures. Mascot roaming/emotes deliberately remain lower priority than these MVP controls, per the user’s annotation. Real microphone/provider behavior and final user visual acceptance remain outside technical QA.

### Content-feed clarification

final result: passed

Removed the rotating side-fitting layer after the user's clarification. Native content now feeds beneath a14px soft upper edge when scrolled; the mask disappears at scrollTop0. Source sheet retraction remains. Fresh1303×954 browser evidence: `docs/trail/mechanical-controls/content-feed-edge.jpg`. Fonts, spacing, tokens and image assets are unchanged; zero spinning layers remain. Typecheck and49 focused tests pass. This small cue does not claim a3D paper curl.
